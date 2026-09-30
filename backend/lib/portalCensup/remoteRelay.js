/**
 * Relay da Sessão remota (app mobile ⇄ extensão no PC).
 *
 * Rota: wss://<backend>/ws/remote?role=host|viewer&usuario=<nome>
 *  - host   = extensão Portal CENSUP no Chrome com a Agenda
 *  - viewer = app Agenda Mobile Remoto
 *
 * Pareamento pelo usuário do Portal (mesmo modelo de confiança do X-Usuario).
 * Mensagens de texto são JSON; binárias (frames) são repassadas como estão.
 */
import { WebSocketServer } from 'ws';

const WS_PATH = '/ws/remote';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const MAX_VIEWERS_PER_USER = 3;

/** @type {Map<string, { usuario: string, host: import('ws').WebSocket | null, hostInfo: object | null, viewers: Map<string, import('ws').WebSocket> }>} */
const sessions = new Map();

let viewerSeq = 0;

function userKey(usuario) {
  return String(usuario || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function getSession(usuario) {
  const key = userKey(usuario);
  let session = sessions.get(key);
  if (!session) {
    session = { usuario: String(usuario).trim(), host: null, hostInfo: null, viewers: new Map() };
    sessions.set(key, session);
  }
  return session;
}

function dropSessionIfEmpty(usuario) {
  const key = userKey(usuario);
  const session = sessions.get(key);
  if (session && !session.host && session.viewers.size === 0) sessions.delete(key);
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function hostStatusPayload(session) {
  return {
    type: 'host-status',
    online: Boolean(session.host && session.host.readyState === session.host.OPEN),
    host: session.hostInfo || null,
    viewers: session.viewers.size,
    t: Date.now()
  };
}

function broadcastToViewers(session, payload) {
  for (const viewer of session.viewers.values()) sendJson(viewer, payload);
}

function parseJson(data) {
  try {
    const parsed = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function handleHost(ws, session) {
  if (session.host && session.host !== ws) {
    sendJson(session.host, { type: 'replaced', reason: 'Outro Chrome assumiu a sessão remota.' });
    try {
      session.host.close(4001, 'replaced');
    } catch {
      /* ignore */
    }
  }
  session.host = ws;
  session.hostInfo = { connectedAt: Date.now() };
  sendJson(ws, { type: 'welcome', role: 'host', viewers: session.viewers.size, t: Date.now() });
  broadcastToViewers(session, hostStatusPayload(session));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      for (const viewer of session.viewers.values()) {
        if (viewer.readyState === viewer.OPEN) viewer.send(data, { binary: true });
      }
      return;
    }
    const msg = parseJson(data);
    if (!msg) return;
    if (msg.type === 'ping') {
      sendJson(ws, { type: 'pong', t: msg.t ?? null, serverTime: Date.now() });
      return;
    }
    if (msg.type === 'hello') {
      session.hostInfo = {
        ...session.hostInfo,
        agent: String(msg.agent || 'extension').slice(0, 40),
        version: String(msg.version || '').slice(0, 20),
        agenda: msg.agenda && typeof msg.agenda === 'object' ? msg.agenda : null
      };
      broadcastToViewers(session, hostStatusPayload(session));
      return;
    }
    if (msg.type === 'keepalive') return;

    const target = msg.to ? session.viewers.get(String(msg.to)) : null;
    const outgoing = JSON.stringify({ ...msg, from: 'host' });
    if (target) {
      if (target.readyState === target.OPEN) target.send(outgoing);
    } else {
      for (const viewer of session.viewers.values()) {
        if (viewer.readyState === viewer.OPEN) viewer.send(outgoing);
      }
    }
  });

  ws.on('close', () => {
    if (session.host === ws) {
      session.host = null;
      session.hostInfo = null;
      broadcastToViewers(session, hostStatusPayload(session));
    }
    dropSessionIfEmpty(session.usuario);
  });
}

function handleViewer(ws, session) {
  if (session.viewers.size >= MAX_VIEWERS_PER_USER) {
    sendJson(ws, { type: 'error', error: 'Limite de dispositivos conectados atingido.' });
    ws.close(4003, 'too-many-viewers');
    return;
  }
  const viewerId = `v${++viewerSeq}`;
  session.viewers.set(viewerId, ws);
  sendJson(ws, { type: 'welcome', role: 'viewer', viewerId, t: Date.now() });
  sendJson(ws, hostStatusPayload(session));
  sendJson(session.host, { type: 'viewer-joined', viewerId, viewers: session.viewers.size });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = parseJson(data);
    if (!msg) return;
    if (msg.type === 'ping') {
      sendJson(ws, { type: 'pong', t: msg.t ?? null, serverTime: Date.now() });
      return;
    }
    if (msg.type === 'keepalive') return;
    if (!session.host || session.host.readyState !== session.host.OPEN) {
      sendJson(ws, { type: 'error', error: 'PC da Agenda offline.', replyTo: msg.id ?? null });
      return;
    }
    sendJson(session.host, { ...msg, from: viewerId });
  });

  ws.on('close', () => {
    session.viewers.delete(viewerId);
    sendJson(session.host, { type: 'viewer-left', viewerId, viewers: session.viewers.size });
    dropSessionIfEmpty(session.usuario);
  });
}

/** Status para a rota REST (app consulta antes de abrir o socket). */
export function getRemoteRelayStatus(usuario) {
  const session = sessions.get(userKey(usuario));
  if (!session) return { hostOnline: false, host: null, viewers: 0 };
  const payload = hostStatusPayload(session);
  return { hostOnline: payload.online, host: payload.host, viewers: payload.viewers };
}

/**
 * Anexa o relay ao servidor HTTP do Express.
 * @param {import('http').Server} server
 */
export function attachRemoteRelay(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      if (server.listeners('upgrade').length <= 1) socket.destroy();
      return;
    }

    const role = url.searchParams.get('role');
    const usuario = String(url.searchParams.get('usuario') || '').trim();
    if ((role !== 'host' && role !== 'viewer') || !usuario) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('error', (err) => {
        console.warn(`[RemoteRelay] socket ${role} erro:`, err?.message || err);
      });
      const session = getSession(usuario);
      if (role === 'host') handleHost(ws, session);
      else handleViewer(ws, session);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  console.log(`✅ [RemoteRelay] WebSocket pronto em ${WS_PATH}`);
  return wss;
}
