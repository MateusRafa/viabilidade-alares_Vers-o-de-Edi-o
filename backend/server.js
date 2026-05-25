import express from 'express';
import cors from 'cors';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import * as turf from '@turf/turf';
import { union as martinezUnion } from 'martinez-polygon-clipping';
import supabase, { testSupabaseConnection, checkTables, isSupabaseAvailable } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Log de configuração para debug
console.log('🔧 [Config] PORT:', PORT);
console.log('🔧 [Config] FRONTEND_URL:', process.env.FRONTEND_URL || 'Não configurado (permitindo todas as origens)');
console.log('🔧 [Config] DATA_DIR:', process.env.DATA_DIR || './data');

// Middleware CORS - Configuração robusta para produção
// Permitir todas as origens por padrão - DEVE SER O PRIMEIRO MIDDLEWARE
app.use((req, res, next) => {
  try {
    // Log para debug
    const origin = req.headers.origin;
    console.log('🌐 [CORS] Requisição recebida de origem:', origin || 'Sem origem (Postman/curl)');
    console.log('🌐 [CORS] Método:', req.method);
    console.log('🌐 [CORS] Path:', req.path);
    
    // Permitir todas as origens - SEMPRE definir headers CORS
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Content-Length, X-Usuario, x-usuario');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 horas
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    
    // Responder a requisições OPTIONS (preflight) imediatamente
    if (req.method === 'OPTIONS') {
      console.log('✅ [CORS] Preflight OPTIONS respondido para:', req.path);
      return res.status(200).end();
    }
    
    next();
  } catch (err) {
    console.error('❌ [CORS] Erro no middleware CORS:', err);
    // Mesmo com erro, tentar continuar
    next();
  }
});

// Usar também o middleware cors como backup
app.use(cors({
  origin: true, // Permitir todas as origens
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Content-Length', 'X-Usuario', 'x-usuario']
}));

// Configurar body parser com limites maiores e timeout maior
app.use(express.json({ 
  limit: '100mb',
  parameterLimit: 50000
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '100mb',
  parameterLimit: 50000
}));

// Middleware para logar requisições (debug)
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log(`📥 [Request] Origin: ${req.headers.origin || 'N/A'}`);
  console.log(`📥 [Request] Host: ${req.headers.host || 'N/A'}`);
  next();
});

// Função auxiliar para deletar todos os polígonos de cobertura
async function deleteAllCoveragePolygons() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      console.warn('⚠️ [Polygons] Supabase não disponível - não é possível deletar polígonos');
      return { success: false, error: 'Supabase não disponível' };
    }

    console.log('🗑️ [Polygons] Deletando todos os polígonos de cobertura...');
    
    // Verificar quantos polígonos existem
    const { count: countBefore } = await supabase
      .from('coverage_polygons')
      .select('*', { count: 'exact', head: true });
    
    console.log(`📊 [Polygons] Polígonos existentes antes da deleção: ${countBefore || 0}`);
    
    if (countBefore && countBefore > 0) {
      // Deletar todos os polígonos
      const { error: deleteError, count: deleteCount } = await supabase
        .from('coverage_polygons')
        .delete()
        .gte('created_at', '1970-01-01T00:00:00Z'); // Condição sempre verdadeira
      
      if (deleteError) {
        console.error('❌ [Polygons] Erro ao deletar polígonos:', deleteError);
        return { success: false, error: deleteError.message };
      }
      
      console.log(`✅ [Polygons] ${deleteCount || countBefore} polígono(s) deletado(s) com sucesso`);
      
      // Verificar que a deleção foi bem-sucedida
      const { count: countAfter } = await supabase
        .from('coverage_polygons')
        .select('*', { count: 'exact', head: true });
      
      if (countAfter && countAfter > 0) {
        console.warn(`⚠️ [Polygons] AINDA EXISTEM ${countAfter} polígonos após deleção!`);
      } else {
        console.log(`✅ [Polygons] Confirmação: Tabela coverage_polygons está vazia`);
      }
      
      return { success: true, deletedCount: deleteCount || countBefore };
    } else {
      console.log(`ℹ️ [Polygons] Tabela coverage_polygons já está vazia, nada para deletar`);
      return { success: true, deletedCount: 0 };
    }
  } catch (err) {
    console.error('❌ [Polygons] Erro ao deletar polígonos:', err);
    return { success: false, error: err.message };
  }
}

// Função auxiliar para inserir entrada/saída no Supabase
// Lida com nomes de tabelas que têm caracteres especiais
async function inserirEntradaSaida(nomeProjetista, tipo = 'entrada') {
  // Verificar se Supabase está disponível
  if (!supabase || !isSupabaseAvailable()) {
    console.error('❌ [Supabase] Supabase não disponível - não é possível salvar entrada/saída');
    return { success: false, error: 'Supabase não disponível' };
  }
  
  // Validar nome do projetista
  if (!nomeProjetista || !nomeProjetista.trim()) {
    console.error('❌ [Supabase] Nome do projetista inválido');
    return { success: false, error: 'Nome do projetista inválido' };
  }
  
  const nomeLimpo = nomeProjetista.trim();
  
  try {
    // Usar timezone do Brasil (America/Sao_Paulo) para garantir hora correta
    const dataAtual = new Date();
    
    // Obter componentes da data no timezone do Brasil
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    // Formatar data: YYYY-MM-DD
    const dataParts = dateFormatter.formatToParts(dataAtual);
    const ano = dataParts.find(p => p.type === 'year').value;
    const mes = dataParts.find(p => p.type === 'month').value;
    const dia = dataParts.find(p => p.type === 'day').value;
    const data = `${ano}-${mes}-${dia}`;
    
    // Formatar hora: HH:MM:SS
    const timeParts = timeFormatter.formatToParts(dataAtual);
    const horas = timeParts.find(p => p.type === 'hour').value;
    const minutos = timeParts.find(p => p.type === 'minute').value;
    const segundos = timeParts.find(p => p.type === 'second').value;
    const hora = `${horas}:${minutos}:${segundos}`;
    
    console.log(`🔍 [Supabase] inserirEntradaSaida chamada: ${nomeLimpo}, tipo: ${tipo}`);
    console.log(`🔍 [Supabase] Data: ${data}, Hora: ${hora}`);
    console.log(`🔍 [Supabase] Data/Hora UTC original: ${dataAtual.toISOString()}`);
    console.log(`🔍 [Supabase] Data/Hora Brasil: ${dataAtual.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log(`🔍 [Supabase] Supabase disponível: ${isSupabaseAvailable()}`);
    
    // Nome da tabela exato conforme criado no SQL
    const nomeTabela = 'Entrada/Saída_Projetistas';
    
    if (tipo === 'entrada') {
      // IMPORTANTE: Antes de inserir nova entrada, fechar qualquer registro anterior sem data_saida
      // Isso garante que não haja múltiplos registros abertos para o mesmo usuário
      console.log(`🔍 [Supabase] Verificando registros abertos para ${nomeLimpo}...`);
      
        // A função RPC inserir_entrada_projetista já fecha registros anteriores automaticamente
        // Não precisamos verificar manualmente aqui
      
      // Agora inserir nova entrada
      // PROBLEMA: O nome da tabela "Entrada/Saída_Projetistas" contém caracteres especiais
      // que causam erro PGRST125 no PostgREST. Usar função RPC como solução.
      console.log(`🔍 [Supabase] Inserindo nova entrada para ${nomeLimpo} usando função RPC...`);
      console.log(`🔍 [Supabase] Dados a inserir:`, {
        nome_projetista: nomeLimpo,
        data_entrada: data,
        hora_entrada: hora
      });
      
      // Usar função RPC para inserir (contorna problema com caracteres especiais no nome da tabela)
      const { data: insertData, error: insertError } = await supabase.rpc('inserir_entrada_projetista', {
        p_nome_projetista: nomeLimpo,
        p_data_entrada: data,
        p_hora_entrada: hora
      });
      
      if (insertError) {
        console.error('❌ [Supabase] Erro ao inserir entrada via RPC:', insertError);
        console.error('❌ [Supabase] Código do erro:', insertError.code);
        console.error('❌ [Supabase] Mensagem:', insertError.message);
        console.error('❌ [Supabase] Detalhes:', insertError.details);
        console.error('❌ [Supabase] Hint:', insertError.hint);
        console.error('❌ [Supabase] Erro completo:', JSON.stringify(insertError, null, 2));
        
        // Se a função RPC não existir, informar ao usuário
        if (insertError.code === 'PGRST116' || insertError.message?.includes('does not exist') || insertError.message?.includes('function')) {
          console.error('❌ [Supabase] FUNÇÃO RPC NÃO ENCONTRADA!');
          console.error('❌ [Supabase] Execute o SQL em backend/sql/create_rpc_functions.sql');
          console.error('❌ [Supabase] Isso é necessário porque o nome da tabela contém caracteres especiais');
        }
        
        return { success: false, error: insertError };
      }
      
      if (!insertData || insertData.length === 0) {
        console.error('❌ [Supabase] Inserção via RPC retornou sem dados');
        return { success: false, error: 'Inserção retornou sem dados' };
      }
      
      console.log(`✅ [Supabase] Entrada inserida com sucesso via RPC! ID: ${insertData[0].id}`);
      console.log(`✅ [Supabase] Registro completo:`, JSON.stringify(insertData[0], null, 2));
      return { success: true, data: insertData };
    } else {
      // Atualizar saída
      const nomeTabela = 'Entrada/Saída_Projetistas';
      const nomeLimpo = nomeProjetista.trim();
      
      // Usar função RPC para atualizar saída (contorna problema com caracteres especiais)
      console.log(`🔍 [Supabase] Atualizando saída para ${nomeLimpo} usando função RPC...`);
      console.log(`🔍 [Supabase] Dados a atualizar:`, {
        data_saida: data,
        hora_saida: hora
      });
      
      const { data: updateData, error: updateError } = await supabase.rpc('atualizar_saida_projetista', {
        p_nome_projetista: nomeLimpo,
        p_data_saida: data,
        p_hora_saida: hora
      });
      
      if (updateError) {
        console.error('❌ [Supabase] Erro ao atualizar saída via RPC:', updateError);
        console.error('❌ [Supabase] Código:', updateError.code);
        console.error('❌ [Supabase] Mensagem:', updateError.message);
        console.error('❌ [Supabase] Detalhes:', updateError.details);
        
        // Se a função RPC não existir, informar ao usuário
        if (updateError.code === 'PGRST116' || updateError.message?.includes('does not exist') || updateError.message?.includes('function')) {
          console.error('❌ [Supabase] FUNÇÃO RPC NÃO ENCONTRADA!');
          console.error('❌ [Supabase] Execute o SQL em backend/sql/create_rpc_functions.sql');
        }
        
        return { success: false, error: updateError };
      }
      
      if (!updateData || updateData.length === 0) {
        console.warn(`⚠️ [Supabase] Nenhum registro de entrada encontrado para ${nomeLimpo}`);
        return { success: false, error: 'Nenhum registro de entrada encontrado' };
      }
      
      console.log(`✅ [Supabase] Saída atualizada com sucesso via RPC! ID: ${updateData[0].id}`);
      console.log(`✅ [Supabase] Registro completo:`, JSON.stringify(updateData[0], null, 2));
      return { success: true, data: updateData };
    }
  } catch (err) {
    console.error('❌ [Supabase] Erro na função inserirEntradaSaida:', err);
    console.error('❌ [Supabase] Stack:', err.stack);
    return { success: false, error: err };
  }
}

// Criar pasta data se não existir
// Permite configurar via variável de ambiente (útil para Railway volumes)
// IMPORTANTE: Definir DATA_DIR ANTES de usar no multer
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Configurar multer para upload de arquivos
// OTIMIZAÇÃO DE MEMÓRIA: Usar diskStorage em vez de memoryStorage
// Isso evita carregar arquivos grandes na memória, prevenindo "Out of memory" no Railway
let upload;
try {
  // Criar pasta temporária para uploads
  const TEMP_DIR = path.join(DATA_DIR, 'temp');
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  
  upload = multer({ 
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, TEMP_DIR);
      },
      filename: (req, file, cb) => {
        // Nome único para evitar conflitos
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `upload-${uniqueSuffix}-${file.originalname}`);
      }
    }),
    limits: { 
      fileSize: 100 * 1024 * 1024, // 100MB limite
      files: 1,
      fields: 0
    }
  });
  console.log('✅ Multer configurado com diskStorage (otimizado para memória)');
} catch (err) {
  console.error('❌ Erro ao configurar multer:', err);
  console.error('Certifique-se de que o multer está instalado: npm install multer');
  process.exit(1);
}

// Caminhos para os arquivos Excel na pasta backend/data
const PROJETISTAS_FILE = path.join(DATA_DIR, 'projetistas.xlsx');
const BASE_CTOS_FILE = path.join(DATA_DIR, 'base.xlsx'); // Mantido para compatibilidade, mas não será mais usado
const TABULACOES_FILE = path.join(DATA_DIR, 'tabulacoes.xlsx');
const BASE_VI_ALA_FILE = path.join(DATA_DIR, 'base_VI ALA.xlsx');

// Função para formatar data no formato DD/MM/YYYY
function formatDateForFilename(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

// Função para encontrar o arquivo base_atual mais recente (assíncrona)
// IMPORTANTE: Esta função NUNCA retorna backups - apenas arquivos base_atual_*.xlsx
async function findCurrentBaseFile() {
  try {
    const files = await fsPromises.readdir(DATA_DIR);
    // Filtrar APENAS arquivos base_atual_*.xlsx (NUNCA backups que começam com backup_)
    const baseAtualFiles = files.filter(file => 
      file.startsWith('base_atual_') && file.endsWith('.xlsx') && !file.startsWith('backup_')
    );
    
    if (baseAtualFiles.length === 0) {
      console.log('📋 [Base] Nenhum arquivo base_atual encontrado');
      return null;
    }
    
    // Ordenar por data de modificação (mais recente primeiro)
    const filesWithStats = await Promise.all(
      baseAtualFiles.map(async (file) => {
        const filePath = path.join(DATA_DIR, file);
        const stats = await fsPromises.stat(filePath);
        return {
          name: file,
          path: filePath,
          mtime: stats.mtime
        };
      })
    );
    
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    const mostRecent = filesWithStats[0].path;
    console.log(`📋 [Base] Base atual encontrada: ${path.basename(mostRecent)} (mais recente de ${baseAtualFiles.length} arquivo(s))`);
    return mostRecent;
  } catch (err) {
    console.error('❌ [Base] Erro ao buscar arquivo base_atual:', err);
    return null;
  }
}

// Função para encontrar o arquivo backup mais recente (assíncrona)
// IMPORTANTE: Esta função é usada APENAS para limpeza de backups antigos
// NUNCA é usada para servir dados ao sistema - apenas para gerenciamento de arquivos
async function findBackupBaseFile() {
  try {
    const files = await fsPromises.readdir(DATA_DIR);
    const backupFiles = files.filter(file => 
      file.startsWith('backup_') && file.endsWith('.xlsx')
    );
    
    if (backupFiles.length === 0) {
      return null;
    }
    
    // Ordenar por data de modificação (mais recente primeiro)
    const filesWithStats = await Promise.all(
      backupFiles.map(async (file) => {
        const filePath = path.join(DATA_DIR, file);
        const stats = await fsPromises.stat(filePath);
        return {
          name: file,
          path: filePath,
          mtime: stats.mtime
        };
      })
    );
    
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    return filesWithStats[0].path;
  } catch (err) {
    console.error('Erro ao buscar arquivo backup:', err);
    return null;
  }
}

// Função para obter o caminho do arquivo base atual (usa base_atual ou fallback para base.xlsx)
// Versão síncrona para uso em rotas síncronas
// IMPORTANTE: Esta função NUNCA retorna backups - apenas arquivos base_atual_*.xlsx
function getCurrentBaseFilePathSync() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    // Filtrar APENAS arquivos base_atual_*.xlsx (NUNCA backups que começam com backup_)
    const baseAtualFiles = files.filter(file => 
      file.startsWith('base_atual_') && file.endsWith('.xlsx') && !file.startsWith('backup_')
    );
    
    if (baseAtualFiles.length > 0) {
      // Ordenar por data de modificação (mais recente primeiro)
      const filesWithStats = baseAtualFiles.map(file => ({
        name: file,
        path: path.join(DATA_DIR, file),
        mtime: fs.statSync(path.join(DATA_DIR, file)).mtime
      }));
      
      filesWithStats.sort((a, b) => b.mtime - a.mtime);
      const mostRecent = filesWithStats[0].path;
      console.log(`📋 [Base] Base atual (sync): ${path.basename(mostRecent)}`);
      return mostRecent;
    }
  } catch (err) {
    console.error('❌ [Base] Erro ao buscar base atual (sync):', err);
    // Ignorar erro e tentar fallback
  }
  
  // Fallback para compatibilidade com arquivo antigo (base.xlsx)
  // Este fallback é apenas para migração - não deve ser usado em produção
  if (fs.existsSync(BASE_CTOS_FILE)) {
    console.log('⚠️ [Base] Usando fallback base.xlsx (arquivo antigo)');
    return BASE_CTOS_FILE;
  }
  return null;
}

// Função assíncrona para obter o caminho do arquivo base atual
// IMPORTANTE: Esta função NUNCA retorna backups - apenas arquivos base_atual_*.xlsx
async function getCurrentBaseFilePath() {
  const currentBase = await findCurrentBaseFile();
  if (currentBase) {
    return currentBase;
  }
  // Fallback para compatibilidade com arquivo antigo (base.xlsx)
  // Este fallback é apenas para migração - não deve ser usado em produção
  try {
    await fsPromises.access(BASE_CTOS_FILE);
    console.log('⚠️ [Base] Usando fallback base.xlsx (arquivo antigo)');
    return BASE_CTOS_FILE;
  } catch {
    return null;
  }
}

// Armazenar sessões de usuários online (em memória)
// Formato: { 'nomeUsuario': { lastActivity: timestamp, loginTime: timestamp } }
const activeSessions = {};
// Armazenar histórico de logout (para mostrar quando ficou inativo)
// Formato: { 'nomeUsuario': { logoutTime: timestamp } }
const logoutHistory = {};
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutos de inatividade = offline

// Flag para controlar upload em andamento (pausa requisições de verificação de usuários)
let uploadInProgress = false;
let uploadPromise = null; // Promise que resolve quando upload termina

// Variáveis para rastrear progresso do upload e cálculo
let uploadProgress = {
  stage: 'idle', // 'idle', 'deleting', 'uploading', 'calculating', 'completed', 'error'
  uploadPercent: 0,
  calculationPercent: 0,
  message: '',
  totalRows: 0,
  processedRows: 0,
  importedRows: 0,
  calculationId: null,
  totalCTOs: 0,
  processedCTOs: 0
};

// Sistema de locks para operações críticas (prevenir race conditions)
const fileLocks = {
  projetistas: null,
  tabulacoes: null,
  vi_ala: null
};

// Função para executar operação com lock (garante execução sequencial)
async function withLock(lockName, operation) {
  const startTime = Date.now();
  const MAX_WAIT_TIME = 5000; // 5 segundos máximo de espera
  
  // Aguardar lock anterior ser liberado (com timeout)
  while (fileLocks[lockName]) {
    if (Date.now() - startTime > MAX_WAIT_TIME) {
      console.error(`❌ Timeout ao aguardar lock ${lockName} (${MAX_WAIT_TIME}ms)`);
      throw new Error(`Timeout ao aguardar lock ${lockName}`);
    }
    await fileLocks[lockName];
  }
  
  // Criar nova Promise para este lock
  let resolveLock;
  fileLocks[lockName] = new Promise(resolve => {
    resolveLock = resolve;
  });
  
  try {
    // Executar operação
    const result = await operation();
    return result;
  } catch (err) {
    console.error(`❌ Erro na operação com lock ${lockName}:`, err);
    throw err;
  } finally {
    // Liberar lock
    fileLocks[lockName] = null;
    if (resolveLock) {
      resolveLock();
    }
  }
}

// Limpar sessões inativas periodicamente
setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(usuario => {
    if (now - activeSessions[usuario].lastActivity > SESSION_TIMEOUT) {
      // Salvar timestamp de logout antes de remover
      logoutHistory[usuario] = { logoutTime: activeSessions[usuario].lastActivity };
      delete activeSessions[usuario];
      console.log(`🔴 Usuário ${usuario} marcado como offline (timeout)`);
    }
  });
}, 60000); // Verificar a cada minuto

// Limpar arquivos temporários antigos periodicamente (a cada 1 hora)
// Isso previne acúmulo de arquivos temporários em caso de erros
setInterval(async () => {
  try {
    const TEMP_DIR = path.join(DATA_DIR, 'temp');
    if (!fs.existsSync(TEMP_DIR)) {
      return;
    }
    
    const files = await fsPromises.readdir(TEMP_DIR);
    const now = Date.now();
    const MAX_AGE = 60 * 60 * 1000; // 1 hora
    
    for (const file of files) {
      if (file.startsWith('upload-')) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          const stats = await fsPromises.stat(filePath);
          const age = now - stats.mtime.getTime();
          
          if (age > MAX_AGE) {
            await fsPromises.unlink(filePath);
            console.log(`🗑️ [Cleanup] Arquivo temporário antigo removido: ${file}`);
          }
        } catch (err) {
          console.error(`❌ [Cleanup] Erro ao verificar/remover arquivo temporário ${file}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ [Cleanup] Erro ao limpar arquivos temporários:', err.message);
  }
}, 60 * 60 * 1000); // A cada 1 hora

// Migrar arquivos da localização antiga se necessário
const OLD_PROJETISTAS = path.join(__dirname, '../frontend/public/projetistas.xlsx');
const OLD_BASE = path.join(__dirname, '../frontend/public/base.xlsx');
if (fs.existsSync(OLD_PROJETISTAS) && !fs.existsSync(PROJETISTAS_FILE)) {
  fs.copyFileSync(OLD_PROJETISTAS, PROJETISTAS_FILE);
  console.log('✅ projetistas.xlsx migrado para backend/data/');
}
if (fs.existsSync(OLD_BASE) && !fs.existsSync(BASE_CTOS_FILE)) {
  fs.copyFileSync(OLD_BASE, BASE_CTOS_FILE);
  console.log('✅ base.xlsx migrado para backend/data/');
}

// Migrar base.xlsx antigo para o novo formato base_atual_DD-MM-YYYY.xlsx se necessário
// Isso deve ser feito após as funções estarem definidas (versão assíncrona para não bloquear)
(async () => {
  try {
    if (fs.existsSync(BASE_CTOS_FILE)) {
      const currentBase = getCurrentBaseFilePathSync();
      if (!currentBase) {
        const now = new Date();
        const dateStr = formatDateForFilename(now);
        const newBaseFileName = `base_atual_${dateStr}.xlsx`;
        const newBasePath = path.join(DATA_DIR, newBaseFileName);
        await fsPromises.copyFile(BASE_CTOS_FILE, newBasePath);
        console.log(`✅ base.xlsx migrado para novo formato: ${newBaseFileName}`);
      }
    }
  } catch (err) {
    console.error('Erro ao migrar base.xlsx para novo formato:', err);
  }
})();

// Função para ler CTOs do Supabase e converter para Excel (nova versão)
async function readCTOsFromSupabase() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      console.log('⚠️ [Supabase] Supabase não disponível, retornando null para fallback');
      return null; // Retorna null para indicar que deve usar fallback
    }
    
    console.log('📂 [Supabase] ===== CARREGANDO CTOs DO SUPABASE =====');
    console.log('📂 [Supabase] Verificando conexão e disponibilidade...');
    
    // Primeiro, contar quantas CTOs existem
    const { count, error: countError } = await supabase
      .from('ctos')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ [Supabase] Erro ao contar CTOs:', countError);
      return null; // Fallback para Excel
    }
    
    console.log(`📊 [Supabase] Total de CTOs no banco: ${count || 0}`);
    
    if (!count || count === 0) {
      console.log('⚠️ [Supabase] Nenhuma CTO encontrada no Supabase (retornando array vazio)');
      console.log('⚠️ [Supabase] Isso indica que Supabase está funcionando, mas a tabela está vazia');
      return []; // Retornar array vazio (não null) para indicar que Supabase está funcionando, mas vazio
    }
    
    // Buscar TODOS os registros usando paginação
    // Supabase tem limite de 1000 registros por query, então precisamos paginar
    const BATCH_SIZE = 1000; // Tamanho do lote (máximo do Supabase)
    let allData = [];
    let offset = 0;
    let hasMore = true;
    let batchNumber = 0;
    
    console.log(`📥 [Supabase] Buscando ${count} CTOs em lotes de ${BATCH_SIZE}...`);
    
    while (hasMore) {
      batchNumber++;
      console.log(`📥 [Supabase] Buscando lote ${batchNumber} (offset: ${offset}, limite: ${BATCH_SIZE})...`);
      
      const { data, error } = await supabase
        .from('ctos')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1); // range é inclusivo: [offset, offset + BATCH_SIZE - 1]
      
      if (error) {
        console.error(`❌ [Supabase] Erro ao buscar lote ${batchNumber}:`, error);
        console.error('❌ [Supabase] Código do erro:', error.code);
        console.error('❌ [Supabase] Mensagem:', error.message);
        if (error.details) {
          console.error('❌ [Supabase] Detalhes:', error.details);
        }
        if (error.hint) {
          console.error('❌ [Supabase] Dica:', error.hint);
        }
        // Se houver erro, retornar o que já foi carregado (se houver) ou null
        if (allData.length > 0) {
          console.warn(`⚠️ [Supabase] Erro ao buscar lote ${batchNumber}, retornando ${allData.length} CTOs já carregadas`);
          break; // Retornar dados parciais
        }
        return null; // Fallback para Excel
      }
      
      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }
      
      allData = allData.concat(data);
      console.log(`✅ [Supabase] Lote ${batchNumber} carregado: ${data.length} CTOs (total acumulado: ${allData.length})`);
      
      // Se retornou menos que o tamanho do lote, não há mais dados
      if (data.length < BATCH_SIZE) {
        hasMore = false;
        break;
      }
      
      offset += BATCH_SIZE;
      
      // Log de progresso a cada 10 lotes
      if (batchNumber % 10 === 0) {
        console.log(`📊 [Supabase] Progresso: ${allData.length} / ${count} CTOs carregadas (${Math.round((allData.length / count) * 100)}%)`);
      }
    }
    
    console.log(`✅ [Supabase] ${allData.length} CTOs carregadas do Supabase (de ${count} total)`);
    console.log('📊 [Supabase] Convertendo dados para formato Excel...');
    
    // Converter para formato Excel (mesma estrutura do arquivo)
    // IMPORTANTE: Garantir que valores numéricos sejam convertidos corretamente
    const excelData = (allData || []).map((row, index) => {
      // Converter latitude e longitude (críticos para o frontend)
      let latitude = row.latitude;
      if (latitude !== null && latitude !== undefined) {
        latitude = typeof latitude === 'number' ? latitude : parseFloat(latitude);
        if (isNaN(latitude)) latitude = '';
      } else {
        latitude = '';
      }
      
      let longitude = row.longitude;
      if (longitude !== null && longitude !== undefined) {
        longitude = typeof longitude === 'number' ? longitude : parseFloat(longitude);
        if (isNaN(longitude)) longitude = '';
      } else {
        longitude = '';
      }
      
      // Converter portas, ocupado, livre (números inteiros)
      let portas = row.portas;
      if (portas !== null && portas !== undefined) {
        portas = typeof portas === 'number' ? portas : parseInt(portas);
        if (isNaN(portas)) portas = '';
      } else {
        portas = '';
      }
      
      let ocupado = row.ocupado;
      if (ocupado !== null && ocupado !== undefined) {
        ocupado = typeof ocupado === 'number' ? ocupado : parseInt(ocupado);
        if (isNaN(ocupado)) ocupado = '';
      } else {
        ocupado = '';
      }
      
      let livre = row.livre;
      if (livre !== null && livre !== undefined) {
        livre = typeof livre === 'number' ? livre : parseInt(livre);
        if (isNaN(livre)) livre = '';
      } else {
        livre = '';
      }
      
      // Converter pct_ocup (número decimal)
      let pct_ocup = row.pct_ocup;
      if (pct_ocup !== null && pct_ocup !== undefined) {
        pct_ocup = typeof pct_ocup === 'number' ? pct_ocup : parseFloat(pct_ocup);
        if (isNaN(pct_ocup)) pct_ocup = '';
      } else {
        pct_ocup = '';
      }
      
      // Converter data_cadastro (formato string ou Date)
      let data_cadastro = row.data_cadastro;
      if (data_cadastro !== null && data_cadastro !== undefined) {
        if (data_cadastro instanceof Date) {
          // Se for Date, converter para string no formato YYYY-MM-DD
          data_cadastro = data_cadastro.toISOString().split('T')[0];
        } else if (typeof data_cadastro === 'string') {
          // Se for string, manter como está (já deve estar no formato correto)
          data_cadastro = data_cadastro;
        } else {
          data_cadastro = String(data_cadastro);
        }
      } else {
        data_cadastro = '';
      }
      
      // Converter outros campos (strings)
      const excelRow = {
        cid_rede: row.cid_rede ? String(row.cid_rede) : '',
        estado: row.estado ? String(row.estado) : '',
        pop: row.pop ? String(row.pop) : '',
        olt: row.olt ? String(row.olt) : '',
        slot: row.slot ? String(row.slot) : '',
        pon: row.pon ? String(row.pon) : '',
        id_cto: row.id_cto ? String(row.id_cto) : '',
        cto: row.cto ? String(row.cto) : '',
        latitude: latitude !== '' ? latitude : '',
        longitude: longitude !== '' ? longitude : '',
        status_cto: row.status_cto ? String(row.status_cto) : '',
        data_cadastro: data_cadastro,
        portas: portas !== '' ? portas : '',
        ocupado: ocupado !== '' ? ocupado : '',
        livre: livre !== '' ? livre : '',
        pct_ocup: pct_ocup !== '' ? pct_ocup : ''
      };
      
      // Log de amostra (primeiras 3 linhas)
      if (index < 3) {
        console.log(`📋 [Supabase] Exemplo linha ${index + 1}:`, {
          id_cto: excelRow.id_cto,
          cto: excelRow.cto,
          latitude: excelRow.latitude,
          longitude: excelRow.longitude,
          portas: excelRow.portas,
          ocupado: excelRow.ocupado
        });
      }
      
      return excelRow;
    });
    
    console.log(`✅ [Supabase] ${excelData.length} CTOs convertidas para formato Excel`);
    console.log('✅ [Supabase] ===== CONVERSÃO CONCLUÍDA =====');
    
    return excelData;
  } catch (err) {
    console.error('❌ [Supabase] ===== ERRO AO LER CTOs =====');
    console.error('❌ [Supabase] Erro:', err.message);
    console.error('❌ [Supabase] Tipo:', err.name);
    console.error('❌ [Supabase] Stack:', err.stack);
    return null; // Fallback para Excel
  }
}

// Nova rota OTIMIZADA: Buscar CTOs próximas por coordenadas (não carrega todas)
// Esta é a solução para resolver o problema de memória - busca apenas CTOs próximas
app.get('/api/ctos/nearby', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters = parseFloat(req.query.radius || 350); // Default 350m (margem para distância real via ruas)
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Latitude e longitude são obrigatórios' });
    }
    
    console.log(`🔍 [API] Buscando CTOs próximas de (${lat}, ${lng}) em raio de ${radiusMeters}m`);
    
    if (supabase && isSupabaseAvailable()) {
      try {
        // Calcular bounding box (caixa delimitadora) para filtrar eficientemente
        // Aproximação: 1 grau ≈ 111km, então radiusMeters/111000 graus
        const radiusDegrees = radiusMeters / 111000;
        const latMin = lat - radiusDegrees;
        const latMax = lat + radiusDegrees;
        const lngMin = lng - radiusDegrees;
        const lngMax = lng + radiusDegrees;
        
        // Buscar TODAS as CTOs dentro da bounding box (incluindo não ativas)
        const { data, error } = await supabase
          .from('ctos')
          .select('*')
          .gte('latitude', latMin)
          .lte('latitude', latMax)
          .gte('longitude', lngMin)
          .lte('longitude', lngMax);
          // Removido filtro de status - agora retorna CTOs ativas e não ativas
        
        if (error) {
          console.error('❌ [API] Erro ao buscar CTOs:', error);
          throw error;
        }
        
        // Função de cálculo de distância geodésica (Haversine)
        const calculateDistance = (lat1, lng1, lat2, lng2) => {
          const R = 6371000; // Raio da Terra em metros
          const dLat = (lat2 - lat1) * Math.PI / 180;
          const dLng = (lng2 - lng1) * Math.PI / 180;
          const a = 
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return R * c;
        };
        
        // SOLUÇÃO 5: Filtrar CTOs por ID (evitar duplicatas)
        // 1. Buscar TODOS os prédios dentro de um raio maior (500m) para pegar todos os IDs
        let condominiosTableExists = false;
        let prédiosIds = new Set(); // Set para verificação rápida O(1)
        let prédiosMap = new Map(); // Map para armazenar dados dos prédios por ID
        
        try {
          const { error: tableError } = await supabase
            .from('condominios')
            .select('id')
            .limit(1);
          
          if (!tableError || (tableError.code !== 'PGRST116' && !tableError.message.includes('does not exist'))) {
            condominiosTableExists = true;
            
            // Buscar TODOS os prédios dentro de um raio maior (500m) para pegar todos os IDs
            // Isso garante que pegamos todos os IDs, mesmo que o prédio esteja um pouco mais longe
            const radiusDegreesPrédios = 500 / 111000; // 500 metros em graus
            const latMinPrédios = lat - radiusDegreesPrédios;
            const latMaxPrédios = lat + radiusDegreesPrédios;
            const lngMinPrédios = lng - radiusDegreesPrédios;
            const lngMaxPrédios = lng + radiusDegreesPrédios;
            
            const { data: condominiosData, error: condominiosError } = await supabase
              .from('condominios')
              .select('*')
              .gte('latitude', latMinPrédios)
              .lte('latitude', latMaxPrédios)
              .gte('longitude', lngMinPrédios)
              .lte('longitude', lngMaxPrédios);
            
            if (!condominiosError && condominiosData) {
              // Criar Set com IDs dos prédios (para verificação rápida)
              // Adicionar como número, string e número convertido para garantir matching
              condominiosData.forEach(prédio => {
                if (prédio.id_equipamento) {
                  const id = prédio.id_equipamento;
                  const idNum = typeof id === 'number' ? id : parseInt(id);
                  const idStr = String(id);
                  
                  if (!isNaN(idNum)) {
                    // Adicionar em múltiplos formatos para garantir matching
                    prédiosIds.add(idNum);
                    prédiosIds.add(idStr);
                    prédiosIds.add(Number(idStr));
                    
                    // Armazenar dados do prédio no Map (para usar depois)
                    if (!prédiosMap.has(idNum)) {
                      prédiosMap.set(idNum, prédio);
                    }
                  }
                }
              });
              
              console.log(`🏢 [API] ${condominiosData.length} prédios encontrados, ${prédiosIds.size} IDs únicos para filtrar CTOs`);
            }
          }
        } catch (checkError) {
          console.warn('⚠️ [API] Erro ao verificar tabela condominios:', checkError.message);
        }
        
        // Filtrar por distância exata e calcular distâncias
        // SOLUÇÃO 5: Filtrar CTOs que têm ID igual aos prédios (evitar duplicatas)
        const nearbyCTOs = [];
        const ctosInternasPorPrédio = new Map(); // Agrupar CTOs internas por prédio
        
        for (const row of (data || [])) {
          // Validar coordenadas antes de calcular distância
          const rowLat = parseFloat(row.latitude);
          const rowLng = parseFloat(row.longitude);
          
          // Pular CTOs com coordenadas inválidas
          if (isNaN(rowLat) || isNaN(rowLng) || 
              rowLat < -90 || rowLat > 90 || 
              rowLng < -180 || rowLng > 180) {
            console.warn(`⚠️ [API] CTO ${row.id_cto || row.cto || 'sem nome'} tem coordenadas inválidas: (${row.latitude}, ${row.longitude})`);
            continue;
          }
          
          const distance = calculateDistance(lat, lng, rowLat, rowLng);
          
          if (distance > radiusMeters) continue;
          
          const ctoId = row.id_cto;
          const ctoIdNum = ctoId ? (typeof ctoId === 'number' ? ctoId : parseInt(ctoId)) : null;
          const ctoIdStr = ctoId ? String(ctoId) : null;
          
          // SOLUÇÃO 5: Verificar se esta CTO está na base de prédios (matching por ID)
          let is_condominio = false;
          let condominio_data = null;
          
          if (condominiosTableExists && prédiosIds.size > 0 && ctoIdNum && !isNaN(ctoIdNum)) {
            // Verificar se o ID da CTO está no Set de IDs dos prédios
            if (prédiosIds.has(ctoIdNum) || prédiosIds.has(ctoIdStr) || prédiosIds.has(Number(ctoIdStr))) {
              is_condominio = true;
              // Buscar dados do prédio do Map
              condominio_data = prédiosMap.get(ctoIdNum) || prédiosMap.get(Number(ctoIdStr));
              
              // Agrupar CTO interna por prédio (para adicionar depois aos prédios)
              if (!ctosInternasPorPrédio.has(ctoIdNum)) {
                ctosInternasPorPrédio.set(ctoIdNum, []);
              }
              
              ctosInternasPorPrédio.get(ctoIdNum).push({
                nome: row.cto || row.id_cto || '',
                id: row.id_cto || row.id?.toString() || '',
                vagas_total: row.portas || 0,
                clientes_conectados: row.ocupado || 0,
                portas_disponiveis: (row.portas || 0) - (row.ocupado || 0),
                status_cto: row.status_cto || '',
                cidade: row.cid_rede || '',
                pop: row.pop || ''
              });
              
              // NÃO adicionar esta CTO à lista de CTOs normais (é prédio, será filtrada)
              console.log(`🏢 [API] CTO ${ctoId} está na base de prédios (ID: ${ctoIdNum}), filtrando...`);
              continue; // PULAR esta CTO (não adicionar à lista)
            }
          }
          
          // Se chegou aqui, é CTO de rua (não está na base de prédios)
          const dataCadastro = row.data_cadastro || row.data_criacao || row.created_at || '';
          nearbyCTOs.push({
            nome: row.cto || row.id_cto || '',
            latitude: rowLat, // Já validado acima
            longitude: rowLng, // Já validado acima
            vagas_total: row.portas || 0,
            clientes_conectados: row.ocupado || 0,
            pct_ocup: row.pct_ocup || 0,
            cidade: row.cid_rede || '',
            pop: row.pop || '',
            id: row.id_cto || row.id?.toString() || '',
            id_cto: row.id_cto || row.id?.toString() || '',
            olt: row.olt || '',
            slot: row.slot || '',
            pon: row.pon || '',
            distancia_metros: Math.round(distance * 100) / 100,
            is_condominio: false, // Garantir que não é prédio
            condominio_data: null,
            status_cto_condominio: null,
            status_cto: row.status_cto || '', // Incluir status da CTO
            data_criacao: dataCadastro
          });
        }
        
        // Ordenar por distância (sem limite - retornar todas dentro do raio)
        nearbyCTOs.sort((a, b) => a.distancia_metros - b.distancia_metros);
        const finalCTOs = nearbyCTOs; // Retornar todas as CTOs dentro do raio
        
        const condominiosCount = finalCTOs.filter(cto => cto.is_condominio).length;
        console.log(`✅ [API] ${finalCTOs.length} CTOs encontradas próximas (de ${data?.length || 0} na bounding box)`);
        if (condominiosCount > 0) {
          console.log(`🏢 [API] ${condominiosCount} CTOs são de condomínios/prédios`);
        }
        
        // Sempre retornar resposta válida, mesmo quando não há CTOs
        return res.json({
          success: true,
          ctos: finalCTOs || [],
          count: finalCTOs?.length || 0
        });
      } catch (supabaseErr) {
        console.error('❌ [API] Erro ao buscar CTOs do Supabase:', supabaseErr);
        return res.status(500).json({ error: 'Erro ao buscar CTOs', details: supabaseErr.message });
      }
    } else {
      return res.status(503).json({ error: 'Supabase não disponível' });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/ctos/nearby:', err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
});

// ============================================
// ROTAS DE COBERTURA (Coverage Polygons)
// ============================================

// Rota para calcular polígonos de cobertura (processamento assíncrono)
// Rota para calcular polígonos de cobertura (INCREMENTAL - manual)
app.post('/api/coverage/calculate', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('🗺️ [API] Iniciando cálculo de polígonos de cobertura (INCREMENTAL)...');
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Supabase não disponível' 
      });
    }
    
    // Deletar polígonos antigos primeiro
    console.log('🗑️ [API] Deletando polígonos de cobertura antigos...');
    const polygonDeleteResult = await deleteAllCoveragePolygons();
    if (polygonDeleteResult.success) {
      console.log(`✅ [API] Polígonos deletados: ${polygonDeleteResult.deletedCount || 0} polígono(s)`);
    }
    
    // Limpar registros de cálculo em progresso
    try {
      const { error: clearProgressError } = await supabase
        .from('coverage_calculation_progress')
        .delete()
        .neq('calculation_id', '');
      
      if (clearProgressError) {
        console.warn(`⚠️ [API] Aviso ao limpar progresso: ${clearProgressError.message}`);
      }
    } catch (clearErr) {
      console.warn(`⚠️ [API] Erro ao limpar progresso (não crítico):`, clearErr.message);
    }
    
    // Gerar ID único para este cálculo
    const calculationId = `calc_inc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Contar total de CTOs válidas (com latitude/longitude válidas)
    // IMPORTANTE: Usar os mesmos filtros da busca para garantir contagem precisa
    const { count: totalCTOs, error: countError } = await supabase
      .from('ctos')
      .select('id', { count: 'exact', head: true })
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .gte('latitude', -90)
      .lte('latitude', 90)
      .gte('longitude', -180)
      .lte('longitude', 180);
    
    if (countError) {
      console.error('❌ [API] Erro ao contar CTOs válidas:', countError);
      // Tentar contar sem filtros como fallback
      const { count: totalAll } = await supabase
        .from('ctos')
        .select('id', { count: 'exact', head: true });
      console.warn(`⚠️ [API] Usando contagem total sem filtros: ${totalAll || 0}`);
    }
    
    console.log(`📊 [API] Total de CTOs válidas encontradas: ${totalCTOs || 0}`);
    
    // Verificar se há CTOs para processar
    if (!totalCTOs || totalCTOs === 0) {
      uploadProgress.stage = 'error';
      uploadProgress.message = 'Nenhuma CTO válida encontrada para processar';
      throw new Error('Nenhuma CTO válida encontrada');
    }
    
    // Inicializar progresso global
    uploadProgress = {
      stage: 'calculating',
      uploadPercent: 100, // Upload já está completo
      calculationPercent: 0,
      message: 'Iniciando cálculo da mancha de cobertura...',
      totalRows: 0,
      processedRows: 0,
      importedRows: 0,
      calculationId: calculationId,
      totalCTOs: totalCTOs || 0,
      processedCTOs: 0
    };
    
    // Retornar resposta imediata e processar em background
    res.json({
      success: true,
      message: 'Cálculo iniciado em background (INCREMENTAL). Use GET /api/upload-progress para verificar progresso.',
      status: 'processing',
      calculation_id: calculationId
    });
    
    // ============================================
    // FUNÇÕES ANTIGAS (TURF.JS) - NÃO MAIS USADAS
    // Mantidas apenas como referência
    // Agora usamos PostGIS para todos os cálculos
    // ============================================
    
    /*
    // Função auxiliar para converter GeoJSON para formato Martinez (array de coordenadas)
    const geojsonToMartinez = (geojson) => {
      if (!geojson || !geojson.geometry) return null;
      
      const coords = geojson.geometry.coordinates;
      if (!coords || coords.length === 0) return null;
      
      // Martinez espera: [[x, y], [x, y], ...] para cada ring
      // GeoJSON Polygon tem: [[[x, y], ...], ...] (array of rings)
      // Pegar apenas o ring externo (primeiro array)
      const ring = coords[0] || null;
      
      // VALIDAÇÃO CRÍTICA: Martinez requer pelo menos 4 pontos (LinearRing fechado)
      // Um polígono válido precisa de: ponto inicial, 2+ pontos intermediários, ponto final (igual ao inicial)
      if (!ring || ring.length < 4) {
        return null; // Polígono inválido para Martinez
      }
      
      return ring;
    };
    
    // Função auxiliar para converter resultado Martinez de volta para GeoJSON
    const martinezToGeojson = (martinezResult) => {
      if (!martinezResult || martinezResult.length === 0) return null;
      
      // Martinez retorna array de polígonos: [[[x, y], ...], ...]
      // Se tiver múltiplos polígonos, criar MultiPolygon
      // Se tiver apenas um, criar Polygon
      
      if (martinezResult.length === 1) {
        // Polygon único
        return turf.polygon([martinezResult[0]]);
      } else {
        // MultiPolygon
        return turf.multiPolygon(martinezResult.map(poly => [poly]));
      }
    };
    
    // DESABILITADO: Martinez está falhando muito devido à simplificação agressiva
    // Usando apenas Turf.js que funciona melhor com geometrias simplificadas
    const robustUnion = (poly1, poly2) => {
      try {
        return turf.union(poly1, poly2);
      } catch (err) {
        // Se Turf.js falhar, tentar simplificar antes de unir
        try {
          const simplified1 = turf.simplify(poly1, { tolerance: 0.0001, highQuality: true });
          const simplified2 = turf.simplify(poly2, { tolerance: 0.0001, highQuality: true });
          return turf.union(simplified1, simplified2);
        } catch (retryErr) {
          // Se ainda falhar, retornar null (será pulado)
          return null;
        }
      }
    };
    
    // Função auxiliar para validar e corrigir geometria
    const validateAndFixGeometry = (geometry) => {
      if (!geometry || !geometry.geometry) {
        return null;
      }
      
      try {
        // 1. Limpar coordenadas duplicadas (remove pontos muito próximos)
        let cleaned = turf.cleanCoords(geometry);
        
        // 2. Simplificar AGressivamente primeiro para reduzir problemas de precisão
        // Tolerância maior remove pontos muito próximos que causam erros de topologia
        // IMPORTANTE: Garantir que após simplificação ainda temos pelo menos 4 pontos
        cleaned = turf.simplify(cleaned, { tolerance: 0.0001, highQuality: true });
        
        // Verificar se ainda tem pelo menos 4 pontos após simplificação
        const coords = cleaned.geometry?.coordinates?.[0];
        if (coords && coords.length < 4) {
          // Se simplificação removeu muitos pontos, usar geometria original
          cleaned = geometry;
        }
        
        // 3. Tentar corrigir geometria inválida com buffer(0)
        try {
          // Verificar se é válido tentando calcular área
          const area = turf.area(cleaned);
          if (area <= 0 || !isFinite(area)) {
            throw new Error('Área inválida');
          }
        } catch (areaErr) {
          // Se calcular área falhar, tentar corrigir com buffer(0)
          try {
            cleaned = turf.buffer(cleaned, 0, { units: 'kilometers' });
            // Simplificar novamente após buffer
            cleaned = turf.simplify(cleaned, { tolerance: 0.0001, highQuality: true });
          } catch (bufferErr) {
            // Se buffer falhar, simplificar ainda mais agressivamente
            cleaned = turf.simplify(cleaned, { tolerance: 0.001, highQuality: true });
          }
        }
        
        // 4. Limpar coordenadas novamente após simplificação
        cleaned = turf.cleanCoords(cleaned);
        
        // 5. Verificação final: tentar calcular área novamente
        try {
          const finalArea = turf.area(cleaned);
          if (finalArea <= 0 || !isFinite(finalArea)) {
            return null; // Geometria ainda inválida
          }
        } catch (finalErr) {
          return null; // Não conseguiu corrigir
        }
        
        return cleaned;
      } catch (err) {
        // Não logar erros de validação para evitar rate limit
        return null;
      }
    };
    */
    
    // Processar em background - CÁLCULOS USANDO POSTGIS
    (async () => {
      const startTime = Date.now();
      let accumulatedPolygonGeoJSON = null; // Polígono acumulado (GeoJSON string)
      let processedCTOs = 0;
      // Lotes de 1000: Supabase tem limite padrão de 1000 registros por query
      // Cada query PostGIS processa 1000 CTOs diretamente
      // Query abre → processa 1000 CTOs → fecha → próxima query
      const batchSize = 1000; // Processar 1000 CTOs por query PostGIS (limite do Supabase)
      const bufferRadiusMeters = 250; // Raio do buffer em metros
      const simplificationTolerance = 0.0001; // Tolerância de simplificação
      
      try {
        console.log(`🔄 [API] Processando polígonos em background (ID: ${calculationId})...`);
        console.log(`🗺️ [API] Cálculos sendo feitos usando POSTGIS (via Supabase)`);
        console.log(`📊 [API] Total de CTOs: ${totalCTOs || 0}`);
        
        let lastId = 0; // Último ID processado (cursor-based pagination)
        let batchNumber = 0;
        let hasMore = true;
        
        // Loop: buscar e processar lotes até completar usando PostGIS
        // Usar paginação baseada em ID (cursor) ao invés de offset para evitar problemas
        while (hasMore) {
          batchNumber++;
          const batchStartTime = Date.now();
          
          // 1. Buscar lote de CTOs do Supabase (apenas IDs)
          // Paginação baseada em ID (cursor) - mais confiável que offset
          let query = supabase
            .from('ctos')
            .select('id', { count: 'exact' })
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .gte('latitude', -90)
            .lte('latitude', 90)
            .gte('longitude', -180)
            .lte('longitude', 180)
            .order('id', { ascending: true })
            .limit(batchSize);
          
          // Se não é o primeiro lote, buscar apenas IDs maiores que o último processado
          if (lastId > 0) {
            query = query.gt('id', lastId);
          }
          
          const { data: ctosBatch, error: fetchError } = await query;
          
          if (fetchError) {
            // Tratar timeout especificamente - continuar com próximo lote
            if (fetchError.code === '57014' || fetchError.message?.includes('timeout')) {
              console.warn(`⚠️ [API] Timeout ao buscar CTOs (lote ${batchNumber}). Tentando buscar próximo lote...`);
              // Não atualizar lastId - tentar novamente (pode ser problema temporário)
              // Mas se lastId não mudar, pode entrar em loop - adicionar segurança
              if (lastId > 0) {
                // Avançar um pouco o ID para não ficar preso
                lastId = lastId + 1000; // Pular alguns IDs para evitar loop
                console.warn(`⚠️ [API] Avançando lastId para ${lastId} para evitar loop`);
              }
              continue; // Continuar com próximo lote
            }
            console.error(`❌ [API] Erro ao buscar CTOs (lote ${batchNumber}):`, fetchError);
            uploadProgress.stage = 'error';
            uploadProgress.message = `Erro ao buscar CTOs: ${fetchError.message}`;
            throw fetchError;
          }
          
          if (!ctosBatch || ctosBatch.length === 0) {
            console.log(`✅ [API] Não há mais CTOs para processar (último ID: ${lastId}, total esperado: ${totalCTOs || 0}, processadas: ${processedCTOs})`);
            hasMore = false;
            break;
          }
          
          // Atualizar último ID processado (para próxima iteração)
          lastId = ctosBatch[ctosBatch.length - 1].id;
          
          // Log detalhado para debug
          if (batchNumber === 1 || batchNumber % 5 === 0) {
            console.log(`📦 [API] Lote ${batchNumber}: Processando ${ctosBatch.length} CTOs (ID: ${ctosBatch[0]?.id} a ${lastId}, total esperado: ${totalCTOs || 0}, processadas: ${processedCTOs})`);
          }
          
          // 2. Extrair IDs das CTOs
          const ctoIds = ctosBatch.map(cto => cto.id);
          
          // Verificar se retornou menos que o esperado (pode indicar fim dos dados)
          // IMPORTANTE: Supabase limita a 1000 registros por query, então 1000 é o máximo esperado
          if (ctosBatch.length < batchSize) {
            console.log(`📊 [API] Lote ${batchNumber} retornou ${ctosBatch.length} CTOs (menos que ${batchSize}). Verificando se há mais dados...`);
          }
          
          // 3. Chamar função PostGIS - processa 1000 CTOs diretamente
          // Query abre → processa 1000 CTOs → fecha → próxima query
          const { data: batchResult, error: batchError } = await supabase.rpc('calculate_coverage_polygon_batch', {
            p_cto_ids: ctoIds,
            p_buffer_radius_meters: bufferRadiusMeters
          });
          
          if (batchError) {
            console.error(`❌ [API] Erro ao calcular polígono do lote ${batchNumber}:`, batchError);
            // Continuar com próximo lote ao invés de quebrar
            processedCTOs += ctosBatch.length;
            // Não atualizar lastId - tentar novamente no próximo loop (pode ser problema temporário)
            continue;
          }
          
          if (!batchResult || batchResult.length === 0 || !batchResult[0].success) {
            const errorMsg = batchResult?.[0]?.error_message || 'Erro desconhecido ao calcular polígono do lote';
            console.warn(`⚠️ [API] Lote ${batchNumber} falhou: ${errorMsg}`);
            processedCTOs += ctosBatch.length;
            continue;
          }
          
          const batchPolygonGeoJSON = batchResult[0].geometry_geojson;
          
          if (!batchPolygonGeoJSON) {
            console.warn(`⚠️ [API] Lote ${batchNumber} não retornou polígono válido`);
            processedCTOs += ctosBatch.length;
            continue;
          }
          
          // 4. Unir com polígono acumulado usando PostGIS
          if (accumulatedPolygonGeoJSON === null) {
            accumulatedPolygonGeoJSON = batchPolygonGeoJSON;
          } else {
            // Chamar função PostGIS para unir polígonos
            const { data: unionResult, error: unionError } = await supabase.rpc('union_polygons_geojson', {
              p_geojson1: accumulatedPolygonGeoJSON,
              p_geojson2: batchPolygonGeoJSON
            });
            
            if (unionError || !unionResult || unionResult.length === 0 || !unionResult[0].success) {
              const errorMsg = unionResult?.[0]?.error_message || unionError?.message || 'Erro ao unir polígonos';
              console.warn(`⚠️ [API] Erro ao unir polígono do lote ${batchNumber} com acumulado: ${errorMsg}`);
              // Continuar com próximo lote
              processedCTOs += ctosBatch.length;
              continue;
            }
            
            accumulatedPolygonGeoJSON = unionResult[0].geometry_geojson;
          }
          
          // 5. Simplificar polígono acumulado periodicamente
          if (batchNumber % 5 === 0 && accumulatedPolygonGeoJSON) {
            const { data: simplifyResult, error: simplifyError } = await supabase.rpc('simplify_polygon_geojson', {
              p_geojson: accumulatedPolygonGeoJSON,
              p_tolerance: simplificationTolerance
            });
            
            if (!simplifyError && simplifyResult && simplifyResult.length > 0 && simplifyResult[0].success) {
              accumulatedPolygonGeoJSON = simplifyResult[0].geometry_geojson;
            }
          }
          
          processedCTOs += ctosBatch.length;
          
          // Atualizar progresso
          const progressPercent = Math.round((processedCTOs / (totalCTOs || 1)) * 100);
          uploadProgress.processedCTOs = processedCTOs;
          uploadProgress.totalCTOs = totalCTOs || 0;
          uploadProgress.calculationPercent = progressPercent;
          uploadProgress.message = `Calculando área de cobertura (PostGIS)... ${progressPercent}% (${processedCTOs}/${totalCTOs || 0} CTOs)`;
          
          const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(2);
          
          // Log detalhado para debug
          if (batchNumber === 1 || batchNumber % 5 === 0 || progressPercent >= 95) {
            console.log(`📦 [API] Lote ${batchNumber}: ${processedCTOs}/${totalCTOs || 0} CTOs (${progressPercent}%) - ${batchTime}s [PostGIS]`);
            console.log(`   └─ Último ID processado: ${lastId}, Próximo ID: > ${lastId}, Total esperado: ${totalCTOs || 0}`);
          }
          
          // Verificar se há mais dados
          // IMPORTANTE: Supabase limita a 1000 registros, então se retornou 1000, pode haver mais
          // Só parar se retornou 0 ou muito pouco (menos de 100 CTOs)
          if (ctosBatch.length === 0) {
            hasMore = false; // Não há mais dados
            console.log(`📊 [API] Lote ${batchNumber} retornou 0 CTOs - fim dos dados`);
          } else if (ctosBatch.length < 100) {
            // Se retornou menos de 100, provavelmente é o último lote
            hasMore = false;
            console.log(`📊 [API] Lote ${batchNumber} foi o último (retornou ${ctosBatch.length} < 100 CTOs)`);
          } else {
            // Se retornou 100 ou mais, continuar (pode haver mais dados)
            // Mesmo que retorne exatamente batchSize (1000), continuar até retornar menos
            hasMore = true;
          }
          
          // Delay maior para evitar sobrecarga e timeout
          // Delay aumenta com o número de lotes processados
          const delay = Math.min(200, 50 + (batchNumber * 5));
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        console.log(`✅ [API] Todos os lotes processados: ${batchNumber} lotes`);
        console.log(`📊 [API] Total processado: ${processedCTOs} CTOs de ${totalCTOs || 0} esperadas`);
        
        if (processedCTOs < (totalCTOs || 0)) {
          console.warn(`⚠️ [API] ATENÇÃO: Processou apenas ${processedCTOs} de ${totalCTOs || 0} CTOs!`);
          console.warn(`⚠️ [API] Diferença: ${(totalCTOs || 0) - processedCTOs} CTOs não foram processadas`);
          console.warn(`⚠️ [API] Isso pode indicar problema de paginação ou limite do Supabase`);
        }
        
        console.log(`🎉 [API] Finalizando cálculo...`);
        
        // 6. Simplificar polígono final usando PostGIS
        if (accumulatedPolygonGeoJSON) {
          const { data: simplifyResult, error: simplifyError } = await supabase.rpc('simplify_polygon_geojson', {
            p_geojson: accumulatedPolygonGeoJSON,
            p_tolerance: simplificationTolerance
          });
          
          if (!simplifyError && simplifyResult && simplifyResult.length > 0 && simplifyResult[0].success) {
            accumulatedPolygonGeoJSON = simplifyResult[0].geometry_geojson;
          } else if (simplifyError) {
            console.warn(`⚠️ [API] Erro ao simplificar polígono final (não crítico):`, simplifyError.message);
          }
        }
        
        // 7. Validar e salvar polígono no Supabase
        if (!accumulatedPolygonGeoJSON) {
          throw new Error('Nenhum polígono foi gerado');
        }
        
        // GeoJSON já está como string
        const geoJsonString = accumulatedPolygonGeoJSON;
        
        // Calcular área em km² usando PostGIS
        const { data: areaResult, error: areaError } = await supabase.rpc('calculate_polygon_area_km2', {
          p_geojson: geoJsonString
        });
        
        let areaKm2 = 0;
        if (!areaError && areaResult && areaResult.length > 0 && areaResult[0].success) {
          areaKm2 = parseFloat(areaResult[0].area_km2) || 0;
        } else {
          // Fallback: tentar calcular usando Turf.js se PostGIS falhar
          const errorMsg = areaResult?.[0]?.error_message || areaError?.message || 'Erro desconhecido';
          console.warn(`⚠️ [API] Erro ao calcular área com PostGIS, usando Turf.js como fallback: ${errorMsg}`);
          try {
            const geoJsonObj = JSON.parse(geoJsonString);
            const turfPolygon = turf.feature(geoJsonObj);
            areaKm2 = turf.area(turfPolygon) / 1000000;
            console.log(`✅ [API] Área calculada com Turf.js: ${areaKm2.toFixed(2)} km²`);
          } catch (turfErr) {
            console.warn(`⚠️ [API] Erro ao calcular área (PostGIS e Turf.js falharam):`, turfErr.message);
            areaKm2 = 0;
          }
        }
        
        // Obter próxima versão
        const { data: maxVersionData } = await supabase
          .from('coverage_polygons')
          .select('version')
          .order('version', { ascending: false })
          .limit(1);
        
        const nextVersion = (maxVersionData && maxVersionData[0]?.version) ? maxVersionData[0].version + 1 : 1;
        
        // Desativar versões antigas
        await supabase
          .from('coverage_polygons')
          .update({ is_active: false })
          .eq('is_active', true);
        
        // Salvar polígono final no Supabase usando função RPC que converte GeoJSON para PostGIS
        console.log(`💾 [API] Salvando polígono no Supabase...`);
        console.log(`   - GeoJSON tamanho: ${geoJsonString.length} caracteres`);
        console.log(`   - Total CTOs: ${processedCTOs}`);
        console.log(`   - Área: ${areaKm2.toFixed(2)} km²`);
        console.log(`   - Versão: ${nextVersion}`);
        
        let insertData = null;
        let polygonId = null;
        
        // Tentar usar função RPC primeiro
        const { data: rpcData, error: insertError } = await supabase.rpc('save_coverage_polygon_from_geojson', {
          p_geometry_geojson: geoJsonString,
          p_total_ctos: processedCTOs,
          p_area_km2: areaKm2,
          p_simplification_tolerance: simplificationTolerance,
          p_version: nextVersion
        });
        
        if (insertError) {
          console.error('❌ [API] Erro ao salvar polígono via RPC:', insertError);
          console.error('❌ [API] Código do erro:', insertError.code);
          console.error('❌ [API] Mensagem:', insertError.message);
          console.error('❌ [API] Detalhes:', insertError.details);
          console.error('❌ [API] Hint:', insertError.hint);
          
          // Se a função não existir, tentar inserir diretamente usando SQL
          if (insertError.code === 'PGRST116' || insertError.message?.includes('does not exist') || insertError.message?.includes('function')) {
            console.warn('⚠️ [API] Função save_coverage_polygon_from_geojson não encontrada. Tentando inserir via SQL direto...');
            
            // Usar SQL direto para inserir
            const sqlInsert = `
              INSERT INTO coverage_polygons (
                geometry,
                simplified_geometry,
                total_ctos,
                area_km2,
                simplification_tolerance,
                is_active,
                version
              ) VALUES (
                ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326),
                ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326),
                $2,
                $3,
                $4,
                true,
                $5
              )
              RETURNING id;
            `;
            
            const { data: sqlData, error: sqlError } = await supabase.rpc('exec_sql', {
              sql: sqlInsert,
              params: [geoJsonString, processedCTOs, areaKm2, simplificationTolerance, nextVersion]
            });
            
            if (sqlError) {
              // Última tentativa: inserir via .from() com GeoJSON (pode funcionar se Supabase aceitar)
              console.warn('⚠️ [API] SQL direto falhou. Tentando inserir via .from()...');
              
              const { data: directInsert, error: directError } = await supabase
                .from('coverage_polygons')
                .insert({
                  geometry: geoJsonString,
                  simplified_geometry: geoJsonString,
                  total_ctos: processedCTOs,
                  area_km2: areaKm2,
                  simplification_tolerance: simplificationTolerance,
                  is_active: true,
                  version: nextVersion
                })
                .select();
              
              if (directError) {
                console.error('❌ [API] Erro ao inserir diretamente:', directError);
                throw new Error(`Falha ao salvar polígono: ${directError.message}. Execute o SQL save_coverage_polygon_from_geojson.sql no Supabase.`);
              }
              
              console.log(`✅ [API] Polígono inserido diretamente! ID: ${directInsert?.[0]?.id || 'N/A'}`);
              polygonId = directInsert?.[0]?.id || null;
              insertData = [{ polygon_id: polygonId, success: true, message: 'Polígono salvo diretamente' }];
            } else {
              polygonId = sqlData?.[0]?.id || null;
              insertData = [{ polygon_id: polygonId, success: true, message: 'Polígono salvo via SQL' }];
            }
          } else {
            throw insertError;
          }
        } else {
          // Sucesso via RPC
          insertData = rpcData;
          polygonId = rpcData?.[0]?.polygon_id || null;
          
          // Verificar resposta da função RPC
          if (!insertData || insertData.length === 0) {
            console.error('❌ [API] Função RPC retornou resposta vazia:', insertData);
            throw new Error('Falha ao salvar polígono - função RPC retornou resposta vazia');
          }
          
          // Verificar se a função retornou sucesso
          if (insertData[0]?.success === false) {
            console.error('❌ [API] Função RPC retornou erro:', insertData[0]?.message);
            throw new Error(`Falha ao salvar polígono: ${insertData[0]?.message || 'Erro desconhecido'}`);
          }
          
          if (!polygonId && insertData[0]?.polygon_id) {
            polygonId = insertData[0].polygon_id;
          }
        }
        
        // Verificar se realmente foi salvo
        if (!insertData || insertData.length === 0 || (!insertData[0]?.success && !polygonId)) {
          console.error('❌ [API] Resposta inválida ao salvar polígono:', JSON.stringify(insertData, null, 2));
          throw new Error('Falha ao salvar polígono - resposta inválida');
        }
        
        // Verificar se foi realmente salvo no banco (aguardar um pouco para garantir commit)
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (polygonId) {
          const { data: verifyData, error: verifyError } = await supabase
            .from('coverage_polygons')
            .select('id, version, total_ctos, is_active, area_km2')
            .eq('id', polygonId)
            .single();
          
          if (verifyError) {
            console.error(`❌ [API] ERRO CRÍTICO: Polígono não encontrado no banco após salvar!`, verifyError);
            console.error(`   - Polygon ID retornado: ${polygonId}`);
            console.error(`   - Isso indica que o INSERT falhou silenciosamente`);
            throw new Error(`Polígono não foi salvo no banco. ID: ${polygonId}, Erro: ${verifyError.message}`);
          } else {
            console.log(`✅ [API] Polígono VERIFICADO no banco:`);
            console.log(`   - ID: ${verifyData.id}`);
            console.log(`   - Versão: ${verifyData.version}`);
            console.log(`   - Total CTOs: ${verifyData.total_ctos}`);
            console.log(`   - Área: ${verifyData.area_km2} km²`);
            console.log(`   - Ativo: ${verifyData.is_active}`);
          }
        } else {
          console.warn(`⚠️ [API] Polygon ID não foi retornado. Verificando último polígono inserido...`);
          
          // Buscar último polígono inserido
          const { data: lastPolygon, error: lastError } = await supabase
            .from('coverage_polygons')
            .select('id, version, total_ctos, is_active, area_km2')
            .eq('version', nextVersion)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          
          if (lastError || !lastPolygon) {
            console.error(`❌ [API] ERRO CRÍTICO: Nenhum polígono encontrado após salvar!`, lastError);
            throw new Error(`Polígono não foi salvo no banco. Verifique os logs do Supabase.`);
          } else {
            polygonId = lastPolygon.id;
            console.log(`✅ [API] Polígono encontrado no banco (busca alternativa):`);
            console.log(`   - ID: ${lastPolygon.id}`);
            console.log(`   - Versão: ${lastPolygon.version}`);
            console.log(`   - Total CTOs: ${lastPolygon.total_ctos}`);
            console.log(`   - Área: ${lastPolygon.area_km2} km²`);
          }
        }
        
        const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
        uploadProgress.stage = 'completed';
        uploadProgress.calculationPercent = 100;
        uploadProgress.message = 'Área de cobertura criada com sucesso!';
        
        console.log(`✅ [API] ===== POLÍGONOS CALCULADOS COM SUCESSO (POSTGIS)! =====`);
        console.log(`   - Polygon ID: ${polygonId || 'N/A'}`);
        console.log(`   - Total CTOs: ${processedCTOs}`);
        console.log(`   - Área: ${areaKm2.toFixed(2)} km²`);
        console.log(`   - Versão: ${nextVersion}`);
        console.log(`   - Tempo: ${processingTime}s`);
        console.log(`   - Lotes processados: ${batchNumber}`);
        console.log(`   - Método: PostGIS (via Supabase)`);
        console.log(`✅ [API] ==========================================`);
      } catch (err) {
        console.error('❌ [API] Erro no processamento em background:', err);
        uploadProgress.stage = 'error';
        uploadProgress.message = `Erro: ${err.message}`;
      }
    })();
    
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/coverage/calculate:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para verificar status do cálculo
app.get('/api/coverage/calculate-status', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Supabase não disponível' 
      });
    }
    
    const calculationId = req.query.calculation_id;
    
    // Se há calculation_id, verificar status do cálculo incremental
    if (calculationId) {
      try {
        const { data: statusData, error: statusError } = await supabase.rpc('get_coverage_calculation_status', {
          p_calculation_id: calculationId
        });
        
        if (!statusError && statusData && statusData.length > 0) {
          const status = statusData[0];
          return res.json({
            success: true,
            status: status.status === 'completed' ? 'completed' : 'processing',
            calculation_id: calculationId,
            processed_ctos: status.processed_ctos,
            total_ctos: status.total_ctos,
            progress_percent: status.progress_percent,
            error_message: status.error_message
          });
        }
      } catch (statusErr) {
        console.warn('⚠️ [API] Erro ao buscar status incremental:', statusErr);
        // Continuar para verificar polígono final
      }
    }
    
    // Buscar polígono ativo mais recente (cálculo já finalizado)
    const { data, error } = await supabase
      .from('coverage_polygons')
      .select('id, version, total_ctos, area_km2, created_at, is_active')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      console.error('❌ [API] Erro ao buscar status:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao buscar status' 
      });
    }
    
    if (!data) {
      return res.json({
        success: false,
        status: 'not_calculated',
        message: 'Nenhum polígono de cobertura encontrado. Execute POST /api/coverage/calculate primeiro.'
      });
    }
    
    res.json({
      success: true,
      status: 'completed',
      polygon_id: data.id,
      version: data.version,
      total_ctos: data.total_ctos,
      area_km2: data.area_km2,
      created_at: data.created_at
    });
    
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/coverage/calculate-status:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para obter polígono de cobertura ativo
app.get('/api/coverage/polygon', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const useSimplified = req.query.simplified !== 'false'; // Default: usar simplificado
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Supabase não disponível' 
      });
    }
    
    // Buscar polígono ativo
    const { data, error } = await supabase.rpc('get_active_coverage_polygon');
    
    if (error) {
      console.error('❌ [API] Erro ao buscar polígono:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao buscar polígono de cobertura', 
        details: error.message 
      });
    }
    
    if (!data || data.length === 0) {
      return res.json({ 
        success: false, 
        message: 'Nenhum polígono de cobertura encontrado. Execute o cálculo primeiro.' 
      });
    }
    
    const polygon = data[0];
    
    // Converter geometria para GeoJSON usando função SQL
    const { data: geoJsonData, error: geoJsonError } = await supabase.rpc('get_polygon_geojson', {
      p_polygon_id: polygon.id,
      p_use_simplified: useSimplified
    });
    
    let geometry = null;
    if (!geoJsonError && geoJsonData && geoJsonData.length > 0 && geoJsonData[0].geojson) {
      try {
        geometry = JSON.parse(geoJsonData[0].geojson);
      } catch (parseError) {
        console.warn('⚠️ [API] Erro ao fazer parse do GeoJSON:', parseError);
      }
    } else if (geoJsonError) {
      console.warn('⚠️ [API] Erro ao buscar GeoJSON:', geoJsonError);
    }
    
    res.json({
      success: true,
      id: polygon.id,
      geometry: geometry,
      total_ctos: polygon.total_ctos,
      area_km2: polygon.area_km2,
      version: polygon.version,
      created_at: polygon.created_at,
      is_simplified: useSimplified
    });
    
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/coverage/polygon:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno', 
      details: err.message 
    });
  }
});


// Rota para calcular polígono de cobertura para CTOs específicas (usado pelo AnaliseCobertura.svelte)
// Usa função SQL no Supabase (calculate_polygon_for_specific_ctos) - igual ao padrão do MapaConsulta.svelte
app.post('/api/coverage/calculate-polygon-for-ctos', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Supabase não disponível'
      });
    }
    
    const { ctos } = req.body;
    
    if (!ctos || !Array.isArray(ctos) || ctos.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Array de CTOs é obrigatório e não pode estar vazio'
      });
    }
    
    // Preparar array de CTOs para o Supabase (apenas latitude e longitude)
    const ctosForSupabase = ctos.map(cto => ({
      latitude: parseFloat(cto.latitude),
      longitude: parseFloat(cto.longitude)
    })).filter(cto => 
      !isNaN(cto.latitude) && !isNaN(cto.longitude) &&
      cto.latitude >= -90 && cto.latitude <= 90 &&
      cto.longitude >= -180 && cto.longitude <= 180
    );
    
    if (ctosForSupabase.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhuma CTO com coordenadas válidas encontrada'
      });
    }
    
    console.log(`🗺️ [API] Calculando polígono para ${ctosForSupabase.length} CTO(s) usando função SQL do Supabase...`);
    
    // Chamar função SQL do Supabase (igual ao padrão do MapaConsulta.svelte)
    const { data, error } = await supabase.rpc('calculate_polygon_for_specific_ctos', {
      p_ctos: ctosForSupabase
    });
    
    if (error) {
      console.error('❌ [API] Erro ao chamar função SQL do Supabase:', error);
      return res.status(500).json({
        success: false,
        error: 'Erro ao calcular polígono no Supabase',
        details: error.message
      });
    }
    
    if (!data || !data.success) {
      console.error('❌ [API] Função SQL retornou erro:', data);
      return res.status(500).json({
        success: false,
        error: data?.error || 'Erro desconhecido ao calcular polígono',
        details: data
      });
    }
    
    // A função SQL retorna geometry como JSONB (já é um objeto JSON)
    // Se for string, fazer parse
    let geometry = data.geometry;
    if (typeof geometry === 'string') {
      try {
        geometry = JSON.parse(geometry);
      } catch (parseErr) {
        console.error('❌ [API] Erro ao fazer parse do GeoJSON:', parseErr);
        return res.status(500).json({
          success: false,
          error: 'Erro ao processar GeoJSON retornado pelo Supabase'
        });
      }
    }
    
    console.log(`✅ [API] Polígono calculado com sucesso: ${data.total_ctos} CTO(s)`);
    
    // Retornar resposta no mesmo formato esperado pelo frontend
    res.json({
      success: true,
      geometry: geometry,
      total_ctos: data.total_ctos || ctosForSupabase.length,
      is_single_circle: data.is_single_circle || false
    });
    
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/coverage/calculate-polygon-for-ctos:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({
      success: false,
      error: 'Erro interno',
      details: err.message
    });
  }
});

// Rota para verificar se um ponto está dentro da cobertura
app.get('/api/coverage/check-point', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Latitude e longitude são obrigatórios' 
      });
    }
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({ 
        success: false, 
        error: 'Supabase não disponível' 
      });
    }
    
    // Verificar se ponto está coberto
    const { data, error } = await supabase.rpc('check_point_in_coverage', {
      p_latitude: lat,
      p_longitude: lng
    });
    
    if (error) {
      console.error('❌ [API] Erro ao verificar ponto:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao verificar ponto', 
        details: error.message 
      });
    }
    
    if (!data || data.length === 0) {
      return res.json({ 
        success: false, 
        is_covered: false, 
        message: 'Nenhum polígono de cobertura encontrado' 
      });
    }
    
    const result = data[0];
    
    res.json({
      success: true,
      is_covered: result.is_covered,
      polygon_id: result.polygon_id,
      distance_to_coverage_meters: result.distance_to_coverage_meters
    });
    
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/coverage/check-point:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para buscar CTOs por nome
// Função auxiliar para escapar caracteres especiais do padrão LIKE do PostgreSQL
// Escapa: %, _, \ (caracteres especiais do LIKE)
function escapeLikePattern(pattern) {
  if (!pattern) return pattern;
  // Escapar backslash primeiro (para não escapar os escapes subsequentes)
  return pattern
    .replace(/\\/g, '\\\\')  // Escapar \ como \\
    .replace(/%/g, '\\%')    // Escapar % como \%
    .replace(/_/g, '\\_');   // Escapar _ como \_
}

app.get('/api/ctos/search', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const nome = req.query.nome;
    
    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: 'Nome da CTO é obrigatório' });
    }
    
    // Limpar e escapar o nome para busca segura no LIKE
    const nomeLimpo = nome.trim();
    const nomeEscapado = escapeLikePattern(nomeLimpo);
    
    console.log(`🔍 [API] Buscando CTOs com nome: "${nomeLimpo}" (escaped: "${nomeEscapado}")`);
    
    if (supabase && isSupabaseAvailable()) {
      try {
        // Estratégia de busca: primeiro tentar busca exata, depois parcial mais precisa
        // Usar nomeEscapado para garantir que caracteres especiais como \ funcionem corretamente
        
        // ETAPA 1: Busca exata (case-insensitive)
        let { data, error } = await supabase
          .from('ctos')
          .select('*')
          .ilike('cto', nomeEscapado) // Busca exata (sem % no início e fim)
          .limit(100);
        
        if (error) {
          console.error('❌ [API] Erro ao buscar CTOs (exata):', error);
          throw error;
        }
        
        // Se encontrou resultados com busca exata, usar esses
        if (data && data.length > 0) {
          console.log(`✅ [API] ${data.length} CTO(s) encontrada(s) com busca EXATA para "${nomeLimpo}"`);
        } else {
          // ETAPA 2: Se não encontrou com busca exata, tentar busca parcial mais precisa
          // Usar padrão que evita pegar substrings no meio de números
          // Exemplo: "CTO \ ITA 131" não deve pegar "CTO \ ITA 1310"
          // Vamos usar busca que procura o nome completo como palavra (com espaços ou fim de string)
          const nomeEscapadoComBoundaries = `${nomeEscapado}(\\s|$|\\\\)`;
          
          // Tentar busca parcial, mas filtrar resultados para garantir que não pegue substrings indesejadas
          const { data: partialData, error: partialError } = await supabase
            .from('ctos')
            .select('*')
            .ilike('cto', `%${nomeEscapado}%`)
            .limit(200); // Buscar mais para filtrar depois
          
          if (partialError) {
            console.error('❌ [API] Erro ao buscar CTOs (parcial):', partialError);
            throw partialError;
          }
          
          // Filtrar resultados para garantir correspondência exata do nome (ignorando case)
          // Isso evita que "CTO \ ITA 131" pegue "CTO \ ITA 1310", "CTO \ ITA 1311", etc.
          if (partialData && partialData.length > 0) {
            const nomeLimpoLower = nomeLimpo.toLowerCase().trim();
            data = partialData.filter(row => {
              const ctoNome = (row.cto || '').toLowerCase().trim();
              
              // Verificar correspondência exata
              if (ctoNome === nomeLimpoLower) {
                return true;
              }
              
              // Verificar se o nome da CTO começa com o nome pesquisado
              if (ctoNome.startsWith(nomeLimpoLower)) {
                const charAfter = ctoNome[nomeLimpoLower.length];
                
                // Se não há caractere depois (fim de string), é válido
                if (!charAfter) {
                  return true;
                }
                
                // Se o caractere depois é espaço, barra invertida, ou qualquer coisa que NÃO seja dígito, é válido
                // Isso evita que "131" pegue "1310", "1311", etc.
                if (charAfter === ' ' || charAfter === '\\' || !/\d/.test(charAfter)) {
                  return true;
                }
                
                // Se o caractere depois é um dígito, rejeitar (evita pegar "1310" quando pesquisa "131")
                return false;
              }
              
              return false;
            });
            
            // Limitar a 100 resultados após filtro
            if (data.length > 100) {
              data = data.slice(0, 100);
            }
            
            console.log(`✅ [API] ${data.length} CTO(s) encontrada(s) com busca PARCIAL FILTRADA para "${nomeLimpo}" (de ${partialData.length} resultados iniciais)`);
          } else {
            data = [];
            console.log(`⚠️ [API] Nenhuma CTO encontrada para "${nomeLimpo}"`);
          }
        }
        
        if (error) {
          console.error('❌ [API] Erro ao buscar CTOs:', error);
          throw error;
        }
        
        // Formatar resultados
        const ctos = (data || []).map((row, index) => {
          const dataCadastro = row.data_cadastro || row.data_criacao || row.created_at || '';
          // Log apenas para as primeiras 3 CTOs para debug
          if (index < 3) {
            console.log(`🔍 [API] CTO ${index + 1} - ID: ${row.id_cto}, data_cadastro original:`, row.data_cadastro, 'tipo:', typeof row.data_cadastro);
          }
          return {
            nome: row.cto || row.id_cto || '',
            latitude: parseFloat(row.latitude),
            longitude: parseFloat(row.longitude),
            vagas_total: row.portas || 0,
            clientes_conectados: row.ocupado || 0,
            pct_ocup: row.pct_ocup || 0,
            cidade: row.cid_rede || '',
            pop: row.pop || '',
            id: row.id_cto || row.id?.toString() || '',
            id_cto: row.id_cto || row.id?.toString() || '',
            is_condominio: false,
            status_cto: row.status_cto || '',
            olt: row.olt || '',
            slot: row.slot || '',
            pon: row.pon || '',
            data_criacao: dataCadastro
          };
        });
        
        console.log(`✅ [API] ${ctos.length} CTOs encontradas com nome "${nome}"`);
        
        return res.json({
          success: true,
          ctos: ctos,
          count: ctos.length
        });
      } catch (supabaseErr) {
        console.error('❌ [API] Erro ao buscar CTOs do Supabase:', supabaseErr);
        return res.status(500).json({ error: 'Erro ao buscar CTOs', details: supabaseErr.message });
      }
    } else {
      return res.status(503).json({ error: 'Supabase não disponível' });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/ctos/search:', err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
});

// Rota para buscar total de portas por caminho de rede
app.get('/api/ctos/caminho-rede', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const olt = req.query.olt; // CHASSE (campo olt na tabela)
    const slot = req.query.slot; // PLACA (campo slot na tabela)
    const pon = req.query.pon; // OLT (campo pon na tabela)
    
    if (!olt || !slot || !pon) {
      return res.status(400).json({ 
        success: false,
        error: 'Parâmetros olt, slot e pon são obrigatórios' 
      });
    }
    
    console.log(`🔍 [API] Buscando total de portas para caminho de rede: ${olt} / ${slot} / ${pon}`);
    
    if (supabase && isSupabaseAvailable()) {
      try {
        // Buscar TODAS as CTOs com esse caminho de rede
        const { data, error } = await supabase
          .from('ctos')
          .select('portas')
          .eq('olt', olt)
          .eq('slot', slot)
          .eq('pon', pon);
        
        if (error) {
          console.error('❌ [API] Erro ao buscar CTOs do caminho de rede:', error);
          throw error;
        }
        
        // Calcular total de portas
        const totalPortas = (data || []).reduce((sum, cto) => {
          return sum + (parseInt(cto.portas || 0) || 0);
        }, 0);
        
        console.log(`✅ [API] Caminho de rede ${olt} / ${slot} / ${pon}: ${data?.length || 0} CTOs, ${totalPortas} portas totais`);
        
        return res.json({
          success: true,
          caminho_rede: {
            olt: olt,
            slot: slot,
            pon: pon
          },
          total_ctos: data?.length || 0,
          total_portas: totalPortas
        });
      } catch (supabaseErr) {
        console.error('❌ [API] Erro ao buscar CTOs do Supabase:', supabaseErr);
        return res.status(500).json({ 
          success: false,
          error: 'Erro ao buscar CTOs', 
          details: supabaseErr.message 
        });
      }
    } else {
      return res.status(503).json({ 
        success: false,
        error: 'Supabase não disponível' 
      });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/ctos/caminho-rede:', err);
    return res.status(500).json({ 
      success: false,
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota OTIMIZADA: Buscar totais de múltiplos caminhos de rede de uma vez
app.post('/api/ctos/caminhos-rede-batch', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const { caminhos } = req.body; // Array de objetos { olt, slot, pon }
    
    if (!Array.isArray(caminhos) || caminhos.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Parâmetro caminhos deve ser um array não vazio' 
      });
    }
    
    console.log(`🔍 [API] Buscando totais para ${caminhos.length} caminhos de rede em batch`);
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.status(503).json({ 
        success: false,
        error: 'Supabase não disponível' 
      });
    }
    
    try {
      // Buscar todos os caminhos de uma vez usando OR conditions
      // Construir query dinâmica para múltiplos caminhos
      const resultados = {};
      
      // Processar em lotes para evitar query muito grande
      const BATCH_SIZE = 50; // Processar até 50 caminhos por vez
      
      for (let i = 0; i < caminhos.length; i += BATCH_SIZE) {
        const batch = caminhos.slice(i, i + BATCH_SIZE);
        
        // Construir filtros OR para cada caminho no batch
        const orConditions = batch.map(caminho => {
          return `and.olt.eq.${caminho.olt},and.slot.eq.${caminho.slot},and.pon.eq.${caminho.pon}`;
        });
        
        // Para cada caminho no batch, fazer uma query separada (mais simples e confiável)
        const batchPromises = batch.map(async (caminho) => {
          // Construir chave incluindo CIDADE e POP para garantir unicidade completa
          const caminhoKey = `${caminho.cidade || 'N/A'}|${caminho.pop || 'N/A'}|${caminho.olt}|${caminho.slot}|${caminho.pon}`;
          
          try {
            // Filtrar por CIDADE (cid_rede), POP, OLT, SLOT e PON para garantir precisão e performance
            let query = supabase
              .from('ctos')
              .select('portas')
              .eq('olt', caminho.olt)
              .eq('slot', caminho.slot)
              .eq('pon', caminho.pon);
            
            // Adicionar filtro por CIDADE (cid_rede) se fornecido (melhora performance e precisão)
            if (caminho.cidade && caminho.cidade !== 'N/A') {
              query = query.eq('cid_rede', caminho.cidade);
            }
            
            // Adicionar filtro por POP se fornecido
            if (caminho.pop && caminho.pop !== 'N/A') {
              query = query.eq('pop', caminho.pop);
            }
            
            const { data, error } = await query;
            
            if (error) {
              console.error(`❌ [API] Erro ao buscar caminho ${caminhoKey}:`, error);
              return { caminhoKey, total_portas: 0, total_ctos: 0, error: error.message };
            }
            
            const totalPortas = (data || []).reduce((sum, cto) => {
              return sum + (parseInt(cto.portas || 0) || 0);
            }, 0);
            
            return {
              caminhoKey,
              caminho_rede: caminho,
              total_portas: totalPortas,
              total_ctos: data?.length || 0
            };
          } catch (err) {
            console.error(`❌ [API] Erro ao processar caminho ${caminhoKey}:`, err);
            return { caminhoKey, total_portas: 0, total_ctos: 0, error: err.message };
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // Adicionar resultados ao objeto final
        for (const result of batchResults) {
          resultados[result.caminhoKey] = result;
        }
      }
      
      console.log(`✅ [API] Batch completo: ${Object.keys(resultados).length} caminhos processados`);
      
      return res.json({
        success: true,
        resultados: resultados,
        total_caminhos: caminhos.length,
        caminhos_processados: Object.keys(resultados).length
      });
    } catch (supabaseErr) {
      console.error('❌ [API] Erro ao buscar caminhos do Supabase:', supabaseErr);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar caminhos',
        details: supabaseErr.message
      });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/ctos/caminhos-rede-batch:', err);
    return res.status(500).json({ 
      success: false,
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota OTIMIZADA: Buscar apenas prédios/condomínios dentro de 250m
app.get('/api/condominios/nearby', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters = parseFloat(req.query.radius || 250); // Default 250m
    
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Latitude e longitude são obrigatórios' });
    }
    
    console.log(`🏢 [API] Buscando prédios próximos de (${lat}, ${lng}) em raio de ${radiusMeters}m`);
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.json({
        success: true,
        condominios: [],
        count: 0,
        message: 'Supabase não disponível'
      });
    }
    
    try {
      // Verificar se a tabela condominios existe
      const { error: tableError } = await supabase
        .from('condominios')
        .select('id')
        .limit(1);
      
      if (tableError && (tableError.code === 'PGRST116' || tableError.message.includes('does not exist'))) {
        console.log('⚠️ [API] Tabela condominios não existe ainda');
        return res.json({
          success: true,
          condominios: [],
          count: 0,
          message: 'Tabela condominios não existe ainda'
        });
      }
      
      // Calcular bounding box
      const radiusDegrees = radiusMeters / 111000;
      const latMin = lat - radiusDegrees;
      const latMax = lat + radiusDegrees;
      const lngMin = lng - radiusDegrees;
      const lngMax = lng + radiusDegrees;
      
      // Buscar TODOS os condomínios dentro da bounding box
      const { data: condominiosData, error: condominiosError } = await supabase
        .from('condominios')
        .select('*')
        .gte('latitude', latMin)
        .lte('latitude', latMax)
        .gte('longitude', lngMin)
        .lte('longitude', lngMax);
      
      if (condominiosError) {
        console.error('❌ [API] Erro ao buscar condomínios:', condominiosError);
        return res.status(500).json({ 
          success: false,
          error: 'Erro ao buscar condomínios',
          details: condominiosError.message 
        });
      }
      
      // Função de cálculo de distância geodésica (Haversine)
      const calculateDistance = (lat1, lng1, lat2, lng2) => {
        const R = 6371000; // Raio da Terra em metros
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = 
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };
      
      // IMPORTANTE: Na base `condominios`, cada linha é uma CTO interna de um prédio
      // Agrupar por nome_predio + coordenadas para formar os prédios com suas CTOs
      
      // PASSO 1: Filtrar por distância e calcular distâncias
      const condominiosFiltrados = (condominiosData || [])
        .map(cond => {
          const distance = calculateDistance(lat, lng, parseFloat(cond.latitude), parseFloat(cond.longitude));
          return {
            ...cond,
            distancia_metros: Math.round(distance * 100) / 100
          };
        })
        .filter(cond => cond.distancia_metros <= radiusMeters);
      
      // PASSO 2: Agrupar CTOs por nome_predio + coordenadas (cada grupo = um prédio)
      const prédiosAgrupados = new Map(); // Map<"nome_predio|lat|lng", { prédio, ctos }>
      
      condominiosFiltrados.forEach(ctoInterna => {
        const nomePredio = String(ctoInterna.nome_predio || '').trim();
        const ctoLat = parseFloat(ctoInterna.latitude);
        const ctoLng = parseFloat(ctoInterna.longitude);
        
        if (!nomePredio || isNaN(ctoLat) || isNaN(ctoLng)) {
          return;
        }
        
        // Arredondar coordenadas para agrupar CTOs na mesma localização
        const latRounded = Math.round(ctoLat * 1000000) / 1000000;
        const lngRounded = Math.round(ctoLng * 1000000) / 1000000;
        const grupoKey = `${nomePredio}|${latRounded}|${lngRounded}`;
        
        if (!prédiosAgrupados.has(grupoKey)) {
          // Criar entrada do prédio (usar primeira CTO como referência)
          prédiosAgrupados.set(grupoKey, {
            prédio: {
              nome_predio: nomePredio,
              latitude: ctoLat,
              longitude: ctoLng,
              status_cto: ctoInterna.status_cto || null,
              distancia_metros: ctoInterna.distancia_metros
            },
            ctos: []
          });
        }
        
        // Adicionar esta CTO interna ao prédio
        prédiosAgrupados.get(grupoKey).ctos.push({
          nome: ctoInterna.nome_equipamento || ctoInterna.nome_equipamento_ozmap || ctoInterna.nome_equipamento_imanager || '',
          id: ctoInterna.id_equipamento ? String(ctoInterna.id_equipamento) : '',
          // Buscar dados da CTO na base `cto` se disponível
          vagas_total: 0, // Será preenchido se encontrar na base cto
          clientes_conectados: 0,
          portas_disponiveis: 0,
          status_cto: ctoInterna.status_cto || '',
          cidade: '',
          pop: ''
        });
      });
      
      // PASSO 3: Buscar dados completos das CTOs na base `cto` (se disponível)
      // Criar Set com IDs das CTOs internas para buscar na base `cto`
      const ctosIdsParaBuscar = new Set();
      prédiosAgrupados.forEach((grupo, key) => {
        grupo.ctos.forEach(cto => {
          if (cto.id && cto.id.trim() !== '') {
            const idNum = parseInt(cto.id);
            if (!isNaN(idNum)) {
              ctosIdsParaBuscar.add(idNum);
              ctosIdsParaBuscar.add(String(idNum));
            }
          }
        });
      });
      
      // PASSO 3: Buscar dados completos das CTOs na base `cto` (para preencher portas, etc.)
      // Criar Map de CTOs da base `cto` por ID para lookup rápido
      const ctosDaBaseCto = new Map(); // Map<id, cto>
      
      if (ctosIdsParaBuscar.size > 0) {
        // Calcular bounding box maior para buscar CTOs
        const radiusDegreesCTOs = 500 / 111000; // 500 metros
        const latMinCTOs = lat - radiusDegreesCTOs;
        const latMaxCTOs = lat + radiusDegreesCTOs;
        const lngMinCTOs = lng - radiusDegreesCTOs;
        const lngMaxCTOs = lng + radiusDegreesCTOs;
        
        const { data: ctosData, error: ctosError } = await supabase
          .from('ctos')
          .select('*')
          .gte('latitude', latMinCTOs)
          .lte('latitude', latMaxCTOs)
          .gte('longitude', lngMinCTOs)
          .lte('longitude', lngMaxCTOs);
          // Removido filtro de status - agora retorna CTOs ativas e não ativas
        
        if (!ctosError && ctosData) {
          // Criar Map de CTOs por ID para lookup rápido
          ctosData.forEach(cto => {
            const ctoId = cto.id_cto;
            if (ctoId) {
              const idNum = typeof ctoId === 'number' ? ctoId : parseInt(ctoId);
              if (!isNaN(idNum)) {
                ctosDaBaseCto.set(idNum, cto);
                ctosDaBaseCto.set(String(idNum), cto);
              }
            }
          });
        }
      }
      
      // PASSO 4: Preencher dados completos das CTOs internas (portas, etc.) e criar array final
      const nearbyCondominios = [];
      
      prédiosAgrupados.forEach((grupo, grupoKey) => {
        const prédio = grupo.prédio;
        const ctosCompletas = grupo.ctos.map(ctoInterna => {
          // Buscar dados completos na base `cto` se disponível
          const ctoId = ctoInterna.id ? parseInt(ctoInterna.id) : null;
          const ctoDaBase = ctoId && !isNaN(ctoId) ? (ctosDaBaseCto.get(ctoId) || ctosDaBaseCto.get(String(ctoId))) : null;
          
          if (ctoDaBase) {
            // Preencher com dados da base `cto`
            return {
              nome: ctoDaBase.cto || ctoInterna.nome || '',
              id: ctoInterna.id,
              vagas_total: ctoDaBase.portas || 0,
              clientes_conectados: ctoDaBase.ocupado || 0,
              portas_disponiveis: (ctoDaBase.portas || 0) - (ctoDaBase.ocupado || 0),
              status_cto: ctoDaBase.status_cto || ctoInterna.status_cto || '',
              cidade: ctoDaBase.cid_rede || '',
              pop: ctoDaBase.pop || ''
            };
          } else {
            // Usar dados da base `condominios` (sem portas)
            return {
              nome: ctoInterna.nome,
              id: ctoInterna.id,
              vagas_total: 0,
              clientes_conectados: 0,
              portas_disponiveis: 0,
              status_cto: ctoInterna.status_cto,
              cidade: '',
              pop: ''
            };
          }
        });
        
        nearbyCondominios.push({
          nome_predio: prédio.nome_predio,
          latitude: prédio.latitude,
          longitude: prédio.longitude,
          status_cto: prédio.status_cto,
          distancia_metros: prédio.distancia_metros,
          ctos_internas: ctosCompletas
        });
        
        console.log(`🏢 [API] Prédio "${prédio.nome_predio}" agrupado com ${ctosCompletas.length} CTOs internas`);
      });
      
      // Ordenar por distância
      nearbyCondominios.sort((a, b) => a.distancia_metros - b.distancia_metros);
      
      const totalCTOsInternas = nearbyCondominios.reduce((sum, prédio) => sum + (prédio.ctos_internas?.length || 0), 0);
      console.log(`🏢 [API] ${totalCTOsInternas} CTOs internas encontradas em ${nearbyCondominios.length} prédios`);
      
      console.log(`✅ [API] ${nearbyCondominios.length} prédios encontrados dentro de ${radiusMeters}m`);
      
      return res.json({
        success: true,
        condominios: nearbyCondominios,
        count: nearbyCondominios.length
      });
      
    } catch (supabaseErr) {
      console.error('❌ [API] Erro ao buscar condomínios do Supabase:', supabaseErr);
      return res.status(500).json({ 
        success: false,
        error: 'Erro ao buscar condomínios',
        details: supabaseErr.message 
      });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/condominios/nearby:', err);
    return res.status(500).json({ 
      success: false,
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para verificar se uma CTO está na base de condomínios
app.get('/api/condominios/check-cto', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const { nome_cto, id_equipamento, nome_ozmap, nome_imanager, latitude, longitude } = req.query;
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.json({
        success: true,
        is_condominio: false,
        message: 'Supabase não disponível, assumindo que não é condomínio'
      });
    }
    
    try {
      // Verificar se a tabela condominios existe
      const { error: tableError } = await supabase
        .from('condominios')
        .select('id')
        .limit(1);
      
      if (tableError && (tableError.code === 'PGRST116' || tableError.message.includes('does not exist'))) {
        console.log('⚠️ [API] Tabela condominios não existe ainda');
        return res.json({
          success: true,
          is_condominio: false,
          message: 'Tabela condominios não existe ainda'
        });
      }
      
      // Buscar por múltiplos critérios (nome do equipamento, ID, ou coordenadas próximas)
      // Fazer múltiplas queries e verificar se alguma retorna resultado
      let foundData = null;
      
      // Buscar por nome do equipamento OZMAP
      if (nome_ozmap && nome_ozmap !== '#N/D' && nome_ozmap.trim() !== '') {
        const { data: dataOzmap, error: errorOzmap } = await supabase
          .from('condominios')
          .select('*')
          .ilike('nome_equipamento_ozmap', `%${nome_ozmap}%`)
          .limit(1);
        
        if (!errorOzmap && dataOzmap && dataOzmap.length > 0) {
          foundData = dataOzmap[0];
        }
      }
      
      // Se não encontrou, buscar por nome do equipamento I-MANAGER
      if (!foundData && nome_imanager && nome_imanager !== '#N/D' && nome_imanager.trim() !== '') {
        const { data: dataImanager, error: errorImanager } = await supabase
          .from('condominios')
          .select('*')
          .ilike('nome_equipamento_imanager', `%${nome_imanager}%`)
          .limit(1);
        
        if (!errorImanager && dataImanager && dataImanager.length > 0) {
          foundData = dataImanager[0];
        }
      }
      
      // Se não encontrou, buscar por ID do equipamento
      if (!foundData && id_equipamento && id_equipamento !== '#N/D' && id_equipamento !== '#N/A') {
        const idNum = parseInt(id_equipamento);
        if (!isNaN(idNum)) {
          const { data: dataId, error: errorId } = await supabase
            .from('condominios')
            .select('*')
            .eq('id_equipamento', idNum)
            .limit(1);
          
          if (!errorId && dataId && dataId.length > 0) {
            foundData = dataId[0];
          }
        }
      }
      
      // Se não encontrou, buscar por coordenadas próximas (raio de 10m para considerar mesma localização)
      if (!foundData && latitude && longitude && !isNaN(parseFloat(latitude)) && !isNaN(parseFloat(longitude))) {
        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);
        const radiusDegrees = 10 / 111000; // 10 metros em graus
        
        const { data: dataCoords, error: errorCoords } = await supabase
          .from('condominios')
          .select('*')
          .gte('latitude', lat - radiusDegrees)
          .lte('latitude', lat + radiusDegrees)
          .gte('longitude', lng - radiusDegrees)
          .lte('longitude', lng + radiusDegrees)
          .limit(1);
        
        if (!errorCoords && dataCoords && dataCoords.length > 0) {
          foundData = dataCoords[0];
        }
      }
      
      const data = foundData ? [foundData] : [];
      const error = null;
      
      if (error) {
        console.error('❌ [API] Erro ao verificar condomínio:', error);
        return res.status(500).json({ 
          success: false,
          error: 'Erro ao verificar condomínio',
          details: error.message 
        });
      }
      
      const is_condominio = data && data.length > 0;
      
      console.log(`🔍 [API] CTO verificado: ${is_condominio ? 'É condomínio' : 'Não é condomínio'}`);
      if (is_condominio) {
        console.log(`📋 [API] Dados do condomínio:`, foundData);
      }
      
      return res.json({
        success: true,
        is_condominio: is_condominio,
        condominio_data: is_condominio ? foundData : null
      });
      
    } catch (supabaseErr) {
      console.error('❌ [API] Erro ao verificar condomínio no Supabase:', supabaseErr);
      return res.status(500).json({ 
        success: false,
        error: 'Erro ao verificar condomínio',
        details: supabaseErr.message 
      });
    }
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/condominios/check-cto:', err);
    return res.status(500).json({ 
      success: false,
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para servir o arquivo base.xlsx (tenta Supabase primeiro, fallback para Excel)
// IMPORTANTE: Esta rota NUNCA serve backups - apenas arquivos base_atual_*.xlsx
app.get('/api/base.xlsx', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('📥 [Base] ===== REQUISIÇÃO /api/base.xlsx RECEBIDA =====');
    console.log('📥 [Base] Timestamp:', new Date().toISOString());
    
    // Tentar usar Supabase primeiro (com streaming para grandes volumes)
    if (supabase && isSupabaseAvailable()) {
      try {
        console.log('✅ [Base] Usando dados do Supabase com STREAMING');
        
        // Primeiro, contar quantas CTOs existem
        const { count, error: countError } = await supabase
          .from('ctos')
          .select('*', { count: 'exact', head: true });
        
        if (countError) {
          console.error('❌ [Supabase] Erro ao contar CTOs:', countError);
          throw countError;
        }
        
        console.log(`📊 [Supabase] Total de CTOs no banco: ${count || 0}`);
        
        if (!count || count === 0) {
          console.log('⚠️ [Supabase] Nenhuma CTO encontrada, criando Excel vazio...');
          // Criar Excel vazio
          const workbook = new ExcelJS.Workbook();
          const worksheet = workbook.addWorksheet('CTOs');
          worksheet.columns = [
            { header: 'CID_REDE', key: 'cid_rede' },
            { header: 'ESTADO', key: 'estado' },
            { header: 'POP', key: 'pop' },
            { header: 'OLT', key: 'olt' },
            { header: 'SLOT', key: 'slot' },
            { header: 'PON', key: 'pon' },
            { header: 'ID_CTO', key: 'id_cto' },
            { header: 'CTO', key: 'cto' },
            { header: 'LATITUDE', key: 'latitude' },
            { header: 'LONGITUDE', key: 'longitude' },
            { header: 'STATUS_CTO', key: 'status_cto' },
            { header: 'DATA_CADASTRO', key: 'data_cadastro' },
            { header: 'PORTAS', key: 'portas' },
            { header: 'OCUPADO', key: 'ocupado' },
            { header: 'LIVRE', key: 'livre' },
            { header: 'PCT_OCUP', key: 'pct_ocup' }
          ];
          
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', 'attachment; filename="base.xlsx"');
          await workbook.xlsx.write(res);
          return;
        }
        
        // SOLUÇÃO OTIMIZADA: Usar XLSX que é mais eficiente em memória
        // Processar e acumular dados em lotes controlados com GC frequente
        
        // SOLUÇÃO FINAL: XLSX é mais eficiente, mas ainda precisamos controlar memória
        // Reduzir batch size e fazer GC muito mais frequente para evitar acúmulo
        
        const BATCH_SIZE = 5000; // Batch médio para equilibrar velocidade e memória
        let offset = 0;
        let hasMore = true;
        let batchNumber = 0;
        let totalProcessed = 0;
        const allRows = []; // Array para acumular linhas
        
        console.log(`📥 [Supabase] Buscando ${count} CTOs em lotes de ${BATCH_SIZE} e gerando Excel com XLSX...`);
        
        // Função auxiliar para converter tipos (otimizada - sem criar objetos desnecessários)
        const convertValue = (value, type = 'string') => {
          if (value === null || value === undefined) return '';
          if (type === 'number') {
            if (typeof value === 'number') return value;
            const num = parseFloat(value);
            return isNaN(num) ? '' : num;
          }
          if (type === 'int') {
            if (typeof value === 'number') return value;
            const num = parseInt(value);
            return isNaN(num) ? '' : num;
          }
          if (type === 'date') {
            if (value instanceof Date) return value.toISOString().split('T')[0];
            return String(value);
          }
          return String(value || '');
        };
        
        try {
          // Processar em lotes e acumular (XLSX gera Excel de forma eficiente quando tudo está pronto)
          while (hasMore) {
            batchNumber++;
            
            // Buscar lote do Supabase
            const { data, error } = await supabase
              .from('ctos')
              .select('*')
              .order('created_at', { ascending: false })
              .range(offset, offset + BATCH_SIZE - 1);
            
            if (error) {
              console.error(`❌ [Supabase] Erro ao buscar lote ${batchNumber}:`, error);
              throw error;
            }
            
            if (!data || data.length === 0) {
              hasMore = false;
              break;
            }
            
            // Converter lote e adicionar ao array
            for (const row of data) {
              allRows.push({
                'CID_REDE': convertValue(row.cid_rede),
                'ESTADO': convertValue(row.estado),
                'POP': convertValue(row.pop),
                'OLT': convertValue(row.olt),
                'SLOT': convertValue(row.slot),
                'PON': convertValue(row.pon),
                'ID_CTO': convertValue(row.id_cto),
                'CTO': convertValue(row.cto),
                'LATITUDE': convertValue(row.latitude, 'number'),
                'LONGITUDE': convertValue(row.longitude, 'number'),
                'STATUS_CTO': convertValue(row.status_cto),
                'DATA_CADASTRO': convertValue(row.data_cadastro, 'date'),
                'PORTAS': convertValue(row.portas, 'int'),
                'OCUPADO': convertValue(row.ocupado, 'int'),
                'LIVRE': convertValue(row.livre, 'int'),
                'PCT_OCUP': convertValue(row.pct_ocup, 'number')
              });
            }
            
            totalProcessed += data.length;
            
            // Log de progresso a cada 10 lotes
            if (batchNumber % 10 === 0 || totalProcessed === count) {
              const memUsage = process.memoryUsage();
              const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
              console.log(`📊 [Supabase] Progresso: ${totalProcessed} / ${count} CTOs (${Math.round((totalProcessed / count) * 100)}%) | Memória: ${memMB}MB`);
            }
            
            // Se retornou menos que o tamanho do lote, não há mais dados
            if (data.length < BATCH_SIZE) {
              hasMore = false;
              break;
            }
            
            offset += BATCH_SIZE;
            
            // GC a cada lote (muito frequente para evitar acúmulo)
            if (global.gc && batchNumber % 2 === 0) {
              global.gc();
            }
          }
          
          console.log(`📊 [Supabase] Dados carregados (${allRows.length} linhas). Gerando Excel com XLSX...`);
          const memBeforeGen = process.memoryUsage().heapUsed;
          
          // Gerar Excel usando XLSX (muito mais eficiente que ExcelJS)
          const worksheet = XLSX.utils.json_to_sheet(allRows);
          const workbook = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(workbook, worksheet, 'CTOs');
          
          // Gerar buffer do Excel
          const excelBuffer = XLSX.write(workbook, { 
            type: 'buffer', 
            bookType: 'xlsx'
          });
          
          // Limpar referências imediatamente
          allRows.length = 0;
          
          // GC após gerar Excel
          if (global.gc) {
            global.gc();
          }
          
          const memAfterGen = process.memoryUsage().heapUsed;
          console.log(`✅ [Supabase] Excel gerado: ${totalProcessed} CTOs | Arquivo: ${Math.round(excelBuffer.length / 1024 / 1024)}MB`);
          
          // Configurar headers
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', 'attachment; filename="base.xlsx"');
          res.setHeader('Content-Length', excelBuffer.length);
          
          // Enviar buffer
          res.send(excelBuffer);
          
          return;
        } catch (xlsxErr) {
          console.error('❌ [Supabase] Erro ao gerar Excel com XLSX:', xlsxErr);
          throw xlsxErr;
        }
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao gerar Excel do Supabase, usando fallback:', supabaseErr);
        console.error('❌ [Supabase] Stack:', supabaseErr.stack);
        // Continuar com fallback Excel
      }
    } else {
      console.log('⚠️ [Base] Supabase não disponível, tentando fallback Excel...');
    }
    
    // Fallback: servir arquivo Excel do disco
    console.log('📂 [Excel] Tentando encontrar arquivo Excel no disco...');
    const currentBasePath = getCurrentBaseFilePathSync();
    
    if (!currentBasePath || !fs.existsSync(currentBasePath)) {
      console.warn('⚠️ [Base] Nenhum arquivo base_atual_*.xlsx encontrado');
      console.warn('⚠️ [Base] Criando arquivo Excel vazio para evitar erro 404...');
      
      // Criar arquivo Excel vazio com estrutura básica
      const emptyData = [{
        cid_rede: '',
        estado: '',
        pop: '',
        olt: '',
        slot: '',
        pon: '',
        id_cto: '',
        cto: '',
        latitude: '',
        longitude: '',
        status_cto: '',
        data_cadastro: '',
        portas: '',
        ocupado: '',
        livre: '',
        pct_ocup: ''
      }];
      
      const worksheet = XLSX.utils.json_to_sheet(emptyData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'CTOs');
      
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      console.log('✅ [Base] Arquivo Excel vazio criado e enviado');
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="base.xlsx"');
      res.setHeader('Content-Length', excelBuffer.length);
      res.send(excelBuffer);
      return;
    }
    
    // Validação extra: garantir que não é um backup
    const fileName = path.basename(currentBasePath);
    if (fileName.startsWith('backup_')) {
      console.error('❌ [Base] ERRO CRÍTICO: Tentativa de servir backup como base atual!');
      return res.status(500).json({ error: 'Erro interno: arquivo de backup detectado' });
    }
    
    console.log(`📤 [Excel] Servindo arquivo: ${fileName}`);
    res.sendFile(path.resolve(currentBasePath));
  } catch (err) {
    console.error('❌ [Base] Erro ao servir base.xlsx:', err);
    console.error('❌ [Base] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao servir arquivo base.xlsx', details: err.message });
    }
  }
});

// Endpoint para retornar progresso do upload e cálculo
app.get('/api/upload-progress', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.json({
      success: true,
      ...uploadProgress
    });
  } catch (err) {
    console.error('❌ [API] Erro na rota /api/upload-progress:', err);
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno', 
      details: err.message 
    });
  }
});

// Rota para obter data da última atualização da base de dados
app.get('/api/base-last-modified', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    let lastModified = null;
    let hasData = false;
    let totalCTOs = 0; // Declarar fora do bloco para estar disponível em todo o escopo

    if (supabase && isSupabaseAvailable()) {
      // Primeiro verificar se existe dados na tabela ctos
      const { count, error: countError } = await supabase
        .from('ctos')
        .select('*', { count: 'exact', head: true });

      if (countError) {
        console.warn('⚠️ [API] Erro ao contar CTOs do Supabase:', countError.message);
      } else {
        totalCTOs = count || 0;
        hasData = totalCTOs > 0;
        console.log(`📊 [API] Total de CTOs no Supabase: ${totalCTOs}`);
      }

      // Se houver dados, tentar obter a data da última modificação
      if (hasData) {
        const { data, error } = await supabase
          .from('upload_history')
          .select('uploaded_at')
          .order('uploaded_at', { ascending: false })
          .limit(1);

        if (error) {
          console.warn('⚠️ [API] Erro ao buscar lastModified do Supabase:', error.message);
          // Fallback: buscar última CTO inserida
        } else if (data && data.length > 0 && data[0].uploaded_at) {
          lastModified = data[0].uploaded_at;
          console.log('✅ [API] LastModified do Supabase (upload_history):', lastModified);
        }
        
        // Se ainda não tem lastModified mas tem dados, usar data atual como fallback
        if (!lastModified && hasData) {
          // Buscar última CTO inserida para usar sua data de criação
          const { data: lastCto, error: ctoError } = await supabase
            .from('ctos')
            .select('created_at')
            .order('created_at', { ascending: false })
            .limit(1);
          
          if (!ctoError && lastCto && lastCto.length > 0 && lastCto[0].created_at) {
            lastModified = lastCto[0].created_at;
            console.log('✅ [API] LastModified usando created_at da última CTO:', lastModified);
          } else {
            // Último fallback: usar data atual
            lastModified = new Date().toISOString();
            console.log('⚠️ [API] LastModified não encontrado, usando data atual como fallback');
          }
        }
      }
    }

    // Se Supabase não está disponível, verificar arquivo local
    if (!supabase || !isSupabaseAvailable()) {
      const currentBasePath = await findCurrentBaseFile();
      if (currentBasePath && fs.existsSync(currentBasePath)) {
        const stats = await fsPromises.stat(currentBasePath);
        lastModified = stats.mtime.toISOString();
        hasData = true;
        console.log('✅ [API] LastModified do arquivo local:', lastModified);
      } else {
        hasData = false;
        console.log('ℹ️ [API] Nenhuma base de dados encontrada (arquivo local não existe).');
      }
    } else if (!lastModified && hasData) {
      // Se Supabase está disponível, tem dados mas não tem lastModified, tentar arquivo local como fallback
      const currentBasePath = await findCurrentBaseFile();
      if (currentBasePath && fs.existsSync(currentBasePath)) {
        const stats = await fsPromises.stat(currentBasePath);
        lastModified = stats.mtime.toISOString();
        console.log('✅ [API] LastModified do arquivo local (fallback):', lastModified);
      }
    }

    // Se não há dados na tabela ctos (ou arquivo local), retornar indicando isso
    if (!hasData) {
      return res.json({ success: true, hasData: false, message: 'Não consta nenhuma base de dados', total_ctos: 0 });
    }

    // Se tem dados mas não tem lastModified, usar data atual como fallback
    if (!lastModified) {
      lastModified = new Date().toISOString();
      console.log('⚠️ [API] LastModified não encontrado, usando data atual como fallback:', lastModified);
    }

    // Sempre retornar lastModified quando há dados
    console.log(`✅ [API] Retornando: hasData=${hasData}, lastModified=${lastModified}, totalCTOs=${totalCTOs}`);
    res.json({ success: true, lastModified, hasData: true, total_ctos: totalCTOs });
  } catch (err) {
    console.error('❌ [API] Erro ao obter lastModified:', err);
    console.error('❌ [API] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const errorOrigin = req.headers.origin;
    if (errorOrigin) {
      res.setHeader('Access-Control-Allow-Origin', errorOrigin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Retornar erro mas ainda tentar retornar dados se possível
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: 'Erro ao obter data de atualização', 
        details: err.message,
        hasData: false,
        total_ctos: 0
      });
    } else {
      // Se já enviou resposta, apenas logar o erro
      console.warn('⚠️ [API] Resposta já enviada, não foi possível retornar erro');
    }
  }
});

// Rota para deletar todos os dados da base de dados CTO (apenas Admin)
app.delete('/api/base/delete', requireAdmin, async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    console.log('🗑️ [API] ===== INICIANDO DELEÇÃO DE BASE DE DADOS =====');

    let deletedFromSupabase = false;
    let deletedCount = 0;

    // Deletar polígonos de cobertura primeiro
    console.log('🗑️ [API] Deletando polígonos de cobertura...');
    const polygonDeleteResult = await deleteAllCoveragePolygons();
    if (polygonDeleteResult.success) {
      console.log(`✅ [API] Polígonos deletados: ${polygonDeleteResult.deletedCount || 0} polígono(s)`);
    } else {
      console.warn(`⚠️ [API] Aviso ao deletar polígonos: ${polygonDeleteResult.error}`);
      // Continuar mesmo se falhar - não é crítico
    }
    
    // Limpar registros de cálculo em progresso (se existirem)
    if (supabase && isSupabaseAvailable()) {
      try {
        console.log('🗑️ [API] Limpando registros de cálculo em progresso...');
        const { error: clearProgressError } = await supabase
          .from('coverage_calculation_progress')
          .delete()
          .neq('calculation_id', ''); // Deletar todos os registros
        
        if (clearProgressError) {
          console.warn(`⚠️ [API] Aviso ao limpar progresso: ${clearProgressError.message}`);
        } else {
          console.log(`✅ [API] Registros de cálculo limpos`);
        }
      } catch (clearErr) {
        console.warn(`⚠️ [API] Erro ao limpar progresso (não crítico):`, clearErr.message);
      }
    }

    // Tentar deletar do Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        console.log('🗑️ [API] Deletando CTOs do Supabase...');
        
        // Primeiro, verificar quantos registros existem
        const { count: countBefore } = await supabase
          .from('ctos')
          .select('*', { count: 'exact', head: true });
        
        console.log(`📊 [API] Registros existentes antes da deleção: ${countBefore || 0}`);
        
        if (countBefore && countBefore > 0) {
          // Deletar TODOS os registros usando uma condição que sempre seja verdadeira
          let deleteSuccess = false;
          
          try {
            const { error: deleteError, count: countResult } = await supabase
              .from('ctos')
              .delete()
              .gte('created_at', '1970-01-01T00:00:00Z'); // Condição sempre verdadeira
            
            if (deleteError) {
              throw deleteError;
            }
            
            deletedCount = countResult || countBefore;
            deleteSuccess = true;
            console.log(`✅ [API] CTOs deletadas: ${deletedCount} registros`);
          } catch (deleteError) {
            console.warn('⚠️ [API] Método 1 falhou, tentando método alternativo...', deleteError.message);
            
            // Método alternativo: Deletar usando neq com UUID impossível
            try {
              const { error: deleteError2, count: countResult2 } = await supabase
                .from('ctos')
                .delete()
                .neq('id', '00000000-0000-0000-0000-000000000000');
              
              if (deleteError2) {
                throw deleteError2;
              }
              
              deletedCount = countResult2 || countBefore;
              deleteSuccess = true;
              console.log(`✅ [API] CTOs deletadas (método alternativo): ${deletedCount} registros`);
            } catch (deleteError2) {
              console.error('❌ [API] Método alternativo também falhou:', deleteError2);
              
              // Método 3: Deletar em lotes (última tentativa)
              console.log('⚠️ [API] Tentando deletar em lotes...');
              let deletedInBatches = 0;
              let batchSize = 1000;
              let hasMore = true;
              
              while (hasMore) {
                const { data: batch, error: batchError } = await supabase
                  .from('ctos')
                  .select('id')
                  .limit(batchSize);
                
                if (batchError) {
                  throw batchError;
                }
                
                if (!batch || batch.length === 0) {
                  hasMore = false;
                  break;
                }
                
                const idsToDelete = batch.map(row => row.id);
                const { error: batchDeleteError } = await supabase
                  .from('ctos')
                  .delete()
                  .in('id', idsToDelete);
                
                if (batchDeleteError) {
                  throw batchDeleteError;
                }
                
                deletedInBatches += idsToDelete.length;
                console.log(`🗑️ [API] Lote deletado: ${idsToDelete.length} registros (total: ${deletedInBatches})`);
                
                if (batch.length < batchSize) {
                  hasMore = false;
                }
              }
              
              deletedCount = deletedInBatches;
              deleteSuccess = true;
              console.log(`✅ [API] CTOs deletadas em lotes: ${deletedCount} registros`);
            }
          }
          
          // Verificar que a deleção foi bem-sucedida
          const { count: countAfter } = await supabase
            .from('ctos')
            .select('*', { count: 'exact', head: true });
          
          if (countAfter && countAfter > 0) {
            console.warn(`⚠️ [API] AINDA EXISTEM ${countAfter} registros após deleção!`);
            console.warn(`⚠️ [API] Isso pode indicar um problema. Continuando...`);
          } else {
            console.log(`✅ [API] Confirmação: Tabela ctos está vazia (${countAfter || 0} registros)`);
          }
          
          deletedFromSupabase = true;
        } else {
          console.log(`ℹ️ [API] Tabela ctos já está vazia, nada para deletar`);
          deletedFromSupabase = true;
        }
      } catch (supabaseErr) {
        console.error('❌ [API] ===== ERRO NA DELEÇÃO SUPABASE =====');
        console.error('❌ [API] Erro ao deletar do Supabase:', supabaseErr.message);
        console.error('❌ [API] Tipo do erro:', supabaseErr.name);
        console.error('❌ [API] Stack:', supabaseErr.stack);
        if (supabaseErr.details) {
          console.error('❌ [API] Detalhes:', supabaseErr.details);
        }
        if (supabaseErr.hint) {
          console.error('❌ [API] Dica:', supabaseErr.hint);
        }
        // Continuar para tentar deletar arquivos locais (fallback)
      }
    } else {
      console.log('⚠️ [API] Supabase não disponível, pulando deleção do Supabase');
    }

    // Deletar arquivos locais também (se existirem)
    try {
      const allFiles = await fsPromises.readdir(DATA_DIR);
      const allBaseAtualFiles = allFiles.filter(file => 
        file.startsWith('base_atual_') && file.endsWith('.xlsx')
      );
      
      if (allBaseAtualFiles.length > 0) {
        console.log(`🗑️ [API] Deletando ${allBaseAtualFiles.length} arquivo(s) local(is)...`);
        
        for (const file of allBaseAtualFiles) {
          const filePath = path.join(DATA_DIR, file);
          try {
            await fsPromises.unlink(filePath);
            console.log(`✅ [API] Arquivo local removido: ${file}`);
          } catch (err) {
            console.error(`❌ [API] Erro ao remover arquivo local ${file}:`, err.message);
          }
        }
      } else {
        console.log('ℹ️ [API] Nenhum arquivo local encontrado para deletar');
      }
    } catch (fileErr) {
      console.warn('⚠️ [API] Erro ao deletar arquivos locais (não crítico):', fileErr.message);
    }

    console.log(`✅ [API] ===== DELEÇÃO CONCLUÍDA =====`);
    
    if (deletedFromSupabase) {
      res.json({
        success: true,
        message: `Base de dados deletada com sucesso! ${deletedCount > 0 ? `${deletedCount} CTOs removidas.` : 'Tabela já estava vazia.'}`,
        deletedCount
      });
    } else {
      res.json({
        success: true,
        message: 'Tentativa de deleção realizada. Verifique os logs para detalhes.',
        deletedCount: 0
      });
    }
  } catch (err) {
    console.error('❌ [API] Erro ao deletar base de dados:', err);
    console.error('❌ [API] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({
      success: false,
      error: `Erro ao deletar base de dados: ${err.message || 'Erro desconhecido'}`
    });
  }
});

// Função para ler projetistas do Supabase (nova versão)
async function readProjetistasFromSupabase() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return null; // Retorna null para indicar que deve usar fallback
    }
    
    console.log('📂 [Supabase] Carregando projetistas do Supabase...');
    
    const { data, error } = await supabase
      .from('projetistas')
      .select('nome, senha, tipo')
      .order('nome', { ascending: true });
    
    if (error) {
      console.error('❌ [Supabase] Erro ao ler projetistas:', error);
      return null; // Fallback para Excel
    }
    
    const projetistas = (data || []).map(p => ({
      nome: p.nome || '',
      senha: p.senha || '',
      tipo: p.tipo || 'user' // Default para 'user' se não existir
    }));
    
    console.log(`✅ [Supabase] ${projetistas.length} projetistas carregados do Supabase`);
    if (projetistas.length > 0) {
      console.log(`📋 [Supabase] Projetistas: ${projetistas.map(p => p.nome).join(', ')}`);
    }
    
    return projetistas;
  } catch (err) {
    console.error('❌ [Supabase] Erro ao ler projetistas:', err);
    return null; // Fallback para Excel
  }
}

// Função para ler projetistas do Excel (fallback)
function readProjetistasFromExcel() {
  try {
    if (!fs.existsSync(PROJETISTAS_FILE)) {
      console.log(`⚠️ Arquivo de projetistas não encontrado: ${PROJETISTAS_FILE}`);
      return [];
    }
    
    console.log(`📂 [Excel] Carregando projetistas de: ${PROJETISTAS_FILE}`);
    
    const workbook = XLSX.readFile(PROJETISTAS_FILE);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    console.log(`📊 [Excel] Colunas encontradas no Excel: ${Object.keys(data[0] || {})}`);
    
    // Procurar colunas 'nome', 'senha' e 'tipo' (case insensitive)
    const nomeCol = data.length > 0 ? Object.keys(data[0]).find(col => col.toLowerCase().trim() === 'nome') : 'nome';
    const senhaCol = data.length > 0 ? Object.keys(data[0]).find(col => col.toLowerCase().trim() === 'senha') : 'senha';
    const tipoCol = data.length > 0 ? Object.keys(data[0]).find(col => col.toLowerCase().trim() === 'tipo') : 'tipo';
    
    const projetistas = data
      .map(row => {
        const nome = row.nome || row.Nome || row[nomeCol] || '';
        const senha = row.senha || row.Senha || row[senhaCol] || '';
        const tipo = row.tipo || row.Tipo || row[tipoCol] || 'user'; // Default para 'user'
        if (nome && nome.trim() !== '') {
          return {
            nome: nome.trim(),
            senha: senha ? senha.trim() : '',
            tipo: tipo ? tipo.trim().toLowerCase() : 'user' // Normalizar para lowercase
          };
        }
        return null;
      })
      .filter(p => p !== null);
    
    console.log(`✅ [Excel] ${projetistas.length} projetistas carregados do Excel`);
    if (projetistas.length > 0) {
      console.log(`📋 [Excel] Projetistas: ${projetistas.map(p => p.nome).join(', ')}`);
    }
    
    return projetistas;
  } catch (err) {
    console.error('❌ [Excel] Erro ao ler projetistas:', err);
    return [];
  }
}

// Função para ler projetistas (tenta Supabase primeiro, fallback para Excel)
// Mantém compatibilidade: função síncrona para uso em rotas síncronas
function readProjetistas() {
  // Para uso síncrono, sempre usa Excel (compatibilidade)
  // Rotas assíncronas devem usar readProjetistasAsync()
  return readProjetistasFromExcel();
}

// Função assíncrona para ler projetistas (tenta Supabase primeiro)
async function readProjetistasAsync() {
  // Tentar Supabase primeiro
  const supabaseData = await readProjetistasFromSupabase();
  if (supabaseData !== null) {
    return supabaseData;
  }
  
  // Fallback para Excel
  return readProjetistasFromExcel();
}

// Função para salvar projetistas no Supabase (nova versão)
async function saveProjetistasToSupabase(projetistas) {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return false; // Indica que deve usar fallback
    }
    
    console.log('💾 [Supabase] Salvando projetistas no Supabase...');
    
    // Normalizar dados
    const dataToSave = projetistas.map(p => {
      if (typeof p === 'string') {
        return { nome: p.trim(), senha: '', tipo: 'user' };
      }
      return {
        nome: (p.nome || '').trim(),
        senha: (p.senha || '').trim(),
        tipo: (p.tipo || 'user').trim().toLowerCase() // Default para 'user' e normalizar
      };
    }).filter(p => p.nome); // Remover vazios
    
    // Deletar todos os projetistas existentes e inserir os novos
    // (Isso garante sincronização completa)
    const { error: deleteError } = await supabase
      .from('projetistas')
      .delete()
      .neq('id', 0); // Deletar todos (condição sempre verdadeira)
    
    if (deleteError) {
      console.error('❌ [Supabase] Erro ao limpar projetistas:', deleteError);
      return false;
    }
    
    // Inserir todos os projetistas
    if (dataToSave.length > 0) {
      const { error: insertError } = await supabase
        .from('projetistas')
        .insert(dataToSave);
      
      if (insertError) {
        console.error('❌ [Supabase] Erro ao inserir projetistas:', insertError);
        return false;
      }
    }
    
    console.log(`✅ [Supabase] ${dataToSave.length} projetistas salvos no Supabase`);
    if (dataToSave.length > 0) {
      const nomes = dataToSave.map(p => p.nome).join(', ');
      console.log(`📋 [Supabase] Projetistas: ${nomes}`);
    }
    
    return true; // Sucesso
  } catch (err) {
    console.error('❌ [Supabase] Erro ao salvar projetistas:', err);
    return false; // Fallback para Excel
  }
}

// Função para salvar projetistas no Excel (fallback)
async function saveProjetistasToExcel(projetistas) {
  return await withLock('projetistas', async () => {
    try {
      // Criar dados para o Excel (com nome, senha e tipo)
      const data = projetistas.map(p => {
        if (typeof p === 'string') {
          // Compatibilidade: se for string antiga, converter para objeto
          return { nome: p, senha: '', tipo: 'user' };
        }
        return { 
          nome: p.nome || '', 
          senha: p.senha || '', 
          tipo: (p.tipo || 'user').trim().toLowerCase() // Default para 'user' e normalizar
        };
      });
      
      // Criar workbook
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Projetistas');
      
      // Salvar arquivo (atualiza a base de dados)
      XLSX.writeFile(workbook, PROJETISTAS_FILE);
      console.log(`✅ [Excel] Base de dados atualizada! Projetistas salvos no Excel: ${projetistas.length} projetistas`);
      console.log(`📁 [Excel] Arquivo: ${PROJETISTAS_FILE}`);
      if (projetistas.length > 0) {
        const nomes = projetistas.map(p => typeof p === 'string' ? p : p.nome).join(', ');
        console.log(`📋 [Excel] Projetistas na base: ${nomes}`);
      }
    } catch (err) {
      console.error('❌ [Excel] Erro ao salvar projetistas:', err);
      throw err;
    }
  });
}

// Função para salvar projetistas (tenta Supabase primeiro, fallback para Excel)
async function saveProjetistas(projetistas) {
  // Tentar Supabase primeiro
  const saved = await saveProjetistasToSupabase(projetistas);
  if (saved) {
    return; // Sucesso no Supabase
  }
  
  // Fallback para Excel
  console.log('⚠️ [Save] Usando fallback Excel para salvar projetistas');
  await saveProjetistasToExcel(projetistas);
}

// Função para ler tabulações do Supabase (nova versão)
async function readTabulacoesFromSupabase() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return null; // Retorna null para indicar que deve usar fallback
    }
    
    console.log('📂 [Supabase] Carregando tabulações do Supabase...');
    
    const { data, error } = await supabase
      .from('tabulacoes')
      .select('nome')
      .order('nome', { ascending: true });
    
    if (error) {
      console.error('❌ [Supabase] Erro ao ler tabulações:', error);
      return null; // Fallback para Excel
    }
    
    const tabulacoes = (data || []).map(t => (t.nome || '').trim()).filter(nome => nome);
    
    console.log(`✅ [Supabase] ${tabulacoes.length} tabulações carregadas do Supabase`);
    if (tabulacoes.length > 0) {
      console.log(`📋 [Supabase] Tabulações: ${tabulacoes.join(', ')}`);
    }
    
    return tabulacoes;
  } catch (err) {
    console.error('❌ [Supabase] Erro ao ler tabulações:', err);
    return null; // Fallback para Excel
  }
}

// Função para ler tabulações do Excel (fallback)
async function readTabulacoesFromExcel() {
  try {
    if (!fs.existsSync(TABULACOES_FILE)) {
      // Valores padrão se o arquivo não existir
      const defaultTabulacoes = [
        'Aprovado Com Portas',
        'Aprovado Com Alívio de Rede/Cleanup',
        'Aprovado Prédio Não Cabeado',
        'Aprovado - Endereço não Localizado',
        'Fora da Área de Cobertura'
      ];
      await saveTabulacoesToExcel(defaultTabulacoes);
      return defaultTabulacoes;
    }
    
    console.log(`📂 [Excel] Carregando tabulações de: ${TABULACOES_FILE}`);
    
    const workbook = XLSX.readFile(TABULACOES_FILE);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    console.log(`📊 [Excel] Colunas encontradas no Excel: ${Object.keys(data[0] || {})}`);
    
    const nomeCol = data.length > 0 ? Object.keys(data[0]).find(col => col.toLowerCase().trim() === 'nome') : 'nome';
    
    const tabulacoes = data
      .map(row => row.nome || row.Nome || row[nomeCol] || '')
      .filter(nome => nome && nome.trim() !== '')
      .map(nome => nome.trim());
    
    console.log(`✅ [Excel] ${tabulacoes.length} tabulações carregadas do Excel`);
    if (tabulacoes.length > 0) {
      console.log(`📋 [Excel] Tabulações: ${tabulacoes.join(', ')}`);
    }
    
    return tabulacoes;
  } catch (err) {
    console.error('❌ [Excel] Erro ao ler tabulações:', err);
    // Retornar valores padrão em caso de erro
    return [
      'Aprovado Com Portas',
      'Aprovado Com Alívio de Rede/Cleanup',
      'Aprovado Prédio Não Cabeado',
      'Aprovado - Endereço não Localizado',
      'Fora da Área de Cobertura'
    ];
  }
}

// Função para ler tabulações (tenta Supabase primeiro, fallback para Excel)
async function readTabulacoes() {
  // Tentar Supabase primeiro
  const supabaseData = await readTabulacoesFromSupabase();
  if (supabaseData !== null) {
    return supabaseData;
  }
  
  // Fallback para Excel
  return await readTabulacoesFromExcel();
}

// Função para salvar tabulações no Supabase (nova versão)
async function saveTabulacoesToSupabase(tabulacoes) {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return false; // Indica que deve usar fallback
    }
    
    console.log('💾 [Supabase] Salvando tabulações no Supabase...');
    
    // Normalizar dados
    const dataToSave = tabulacoes
      .map(nome => (nome || '').trim())
      .filter(nome => nome) // Remover vazios
      .map(nome => ({ nome }));
    
    // Deletar todas as tabulações existentes e inserir as novas
    // (Isso garante sincronização completa)
    const { error: deleteError } = await supabase
      .from('tabulacoes')
      .delete()
      .neq('id', 0); // Deletar todos (condição sempre verdadeira)
    
    if (deleteError) {
      console.error('❌ [Supabase] Erro ao limpar tabulações:', deleteError);
      return false;
    }
    
    // Inserir todas as tabulações
    if (dataToSave.length > 0) {
      const { error: insertError } = await supabase
        .from('tabulacoes')
        .insert(dataToSave);
      
      if (insertError) {
        console.error('❌ [Supabase] Erro ao inserir tabulações:', insertError);
        return false;
      }
    }
    
    console.log(`✅ [Supabase] ${dataToSave.length} tabulações salvas no Supabase`);
    if (dataToSave.length > 0) {
      const nomes = dataToSave.map(t => t.nome).join(', ');
      console.log(`📋 [Supabase] Tabulações: ${nomes}`);
    }
    
    return true; // Sucesso
  } catch (err) {
    console.error('❌ [Supabase] Erro ao salvar tabulações:', err);
    return false; // Fallback para Excel
  }
}

// Função para salvar tabulações no Excel (fallback)
async function saveTabulacoesToExcel(tabulacoes) {
  return await withLock('tabulacoes', async () => {
    try {
      // Criar dados para o Excel
      const data = tabulacoes.map(nome => ({ nome }));
      
      // Criar workbook
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Tabulações');
      
      // Salvar arquivo (atualiza a base de dados)
      XLSX.writeFile(workbook, TABULACOES_FILE);
      console.log(`✅ [Excel] Base de dados atualizada! Tabulações salvas no Excel: ${tabulacoes.length} tabulações`);
      console.log(`📁 [Excel] Arquivo: ${TABULACOES_FILE}`);
      if (tabulacoes.length > 0) {
        console.log(`📋 [Excel] Tabulações na base: ${tabulacoes.join(', ')}`);
      }
    } catch (err) {
      console.error('❌ [Excel] Erro ao salvar tabulações:', err);
      throw err;
    }
  });
}

// Função para salvar tabulações (tenta Supabase primeiro, fallback para Excel)
async function saveTabulacoes(tabulacoes) {
  // Tentar Supabase primeiro
  const saved = await saveTabulacoesToSupabase(tabulacoes);
  if (saved) {
    return; // Sucesso no Supabase
  }
  
  // Fallback para Excel
  console.log('⚠️ [Save] Usando fallback Excel para salvar tabulações');
  await saveTabulacoesToExcel(tabulacoes);
}

// Função para formatar data para DD/MM/YYYY
function formatDateForExcel(dateString) {
  if (!dateString) return '';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString; // Retornar original se não for data válida
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (err) {
    return dateString; // Retornar original em caso de erro
  }
}

// Função interna para verificar e criar base_VI_ALA.xlsx (sem lock, para uso interno)
async function _ensureVIALABaseInternal() {
  try {
    // Usar fsPromises para verificação assíncrona
    try {
      await fsPromises.access(BASE_VI_ALA_FILE);
      // Arquivo existe, retornar
      return true;
    } catch (accessErr) {
      // Arquivo não existe, criar
      console.log('📝 Arquivo base_VI ALA.xlsx não existe, criando...');
      
      // Criar base com colunas padrão
      const headers = [
        'VI ALA',
        'ALA',
        'DATA',
        'PROJETISTA',
        'CIDADE',
        'ENDEREÇO',
        'LATITUDE',
        'LONGITUDE',
        'TABULAÇÃO FINAL',
        'HORA'
      ];
      
      const worksheet = XLSX.utils.aoa_to_sheet([headers]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'VI ALA');
      
      // Usar writeFile síncrono (XLSX não tem versão assíncrona, mas é rápido)
      XLSX.writeFile(workbook, BASE_VI_ALA_FILE);
      console.log('✅ Base VI ALA criada com sucesso');
      return true;
    }
  } catch (err) {
    console.error('❌ Erro ao verificar/criar base VI ALA:', err);
    throw err;
  }
}

// Função para verificar e criar base_VI_ALA.xlsx se não existir (com lock para uso externo)
async function ensureVIALABase() {
  return await withLock('vi_ala', async () => {
    return await _ensureVIALABaseInternal();
  });
}

// Função para ler VI ALAs do Supabase (nova versão)
async function readVIALABaseFromSupabase() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return null; // Retorna null para indicar que deve usar fallback
    }
    
    console.log('📂 [Supabase] Carregando VI ALAs do Supabase...');
    
    // Primeiro, contar quantos registros existem
    const { count, error: countError } = await supabase
      .from('vi_ala')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ [Supabase] Erro ao contar VI ALAs:', countError);
      return null; // Fallback para Excel
    }
    
    console.log(`📊 [Supabase] Total de VI ALAs no banco: ${count || 0}`);
    
    if (!count || count === 0) {
      console.log('⚠️ [Supabase] Nenhum VI ALA encontrado no Supabase (retornando array vazio)');
      return []; // Retornar array vazio (não null) para indicar que Supabase está funcionando, mas vazio
    }
    
    // Buscar TODOS os registros usando paginação
    // Supabase tem limite de 1000 registros por query, então precisamos paginar
    const BATCH_SIZE = 1000; // Tamanho do lote (máximo do Supabase)
    let allData = [];
    let offset = 0;
    let hasMore = true;
    let batchNumber = 0;
    
    console.log(`📥 [Supabase] Buscando ${count} VI ALAs em lotes de ${BATCH_SIZE}...`);
    
    while (hasMore) {
      batchNumber++;
      console.log(`📥 [Supabase] Buscando lote ${batchNumber} (offset: ${offset}, limite: ${BATCH_SIZE})...`);
      
      const { data, error } = await supabase
        .from('vi_ala')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1); // range é inclusivo: [offset, offset + BATCH_SIZE - 1]
      
      if (error) {
        console.error(`❌ [Supabase] Erro ao buscar lote ${batchNumber}:`, error);
        console.error('❌ [Supabase] Código do erro:', error.code);
        console.error('❌ [Supabase] Mensagem:', error.message);
        // Se houver erro, retornar o que já foi carregado (se houver) ou null
        if (allData.length > 0) {
          console.warn(`⚠️ [Supabase] Erro ao buscar lote ${batchNumber}, retornando ${allData.length} VI ALAs já carregados`);
          break; // Retornar dados parciais
        }
        return null; // Fallback para Excel
      }
      
      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }
      
      allData = allData.concat(data);
      console.log(`✅ [Supabase] Lote ${batchNumber} carregado: ${data.length} VI ALAs (total acumulado: ${allData.length})`);
      
      // Se retornou menos que o tamanho do lote, não há mais dados
      if (data.length < BATCH_SIZE) {
        hasMore = false;
        break;
      }
      
      offset += BATCH_SIZE;
      
      // Log de progresso a cada 10 lotes
      if (batchNumber % 10 === 0) {
        console.log(`📊 [Supabase] Progresso: ${allData.length} / ${count} VI ALAs carregados (${Math.round((allData.length / count) * 100)}%)`);
      }
    }
    
    console.log(`✅ [Supabase] ${allData.length} VI ALAs carregados do Supabase (de ${count} total)`);
    
    // Converter para formato compatível com Excel (mesma estrutura)
    const records = allData.map(row => {
      // Usar created_at se disponível (tem timestamp completo), senão usar data
      let dataFormatada = '';
      if (row.created_at) {
        // Usar created_at que tem timestamp completo (vem em UTC do Supabase)
        // Converter para timezone do Brasil (America/Sao_Paulo)
        const dateObj = new Date(row.created_at);
        
        // Usar toLocaleString com timezone do Brasil para converter corretamente
        const dateBr = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).formatToParts(dateObj);
        
        const day = dateBr.find(part => part.type === 'day').value;
        const month = dateBr.find(part => part.type === 'month').value;
        const year = dateBr.find(part => part.type === 'year').value;
        const hour = dateBr.find(part => part.type === 'hour').value;
        const minute = dateBr.find(part => part.type === 'minute').value;
        
        dataFormatada = `${day}/${month}/${year} ${hour}:${minute}`;
      } else if (row.data) {
        // Se não tiver created_at, usar data (pode estar em formato YYYY-MM-DD)
        const dataStr = String(row.data);
        if (dataStr.match(/^\d{4}-\d{2}-\d{2}/)) {
          // Formato YYYY-MM-DD, converter para DD/MM/YYYY
          const partes = dataStr.split(' ')[0].split('-');
          if (partes.length === 3) {
            // Combinar data com hora se houver
            if (row.hora && row.hora.trim() !== '') {
              // Remover 'h' do final se houver (ex: "20:30h" -> "20:30")
              const horaFormatada = row.hora.replace(/h$/, '');
              dataFormatada = `${partes[2]}/${partes[1]}/${partes[0]} ${horaFormatada}`;
            } else {
              dataFormatada = `${partes[2]}/${partes[1]}/${partes[0]}`;
            }
          }
        } else {
          dataFormatada = dataStr;
        }
      }
      
      return {
        'VI ALA': row.vi_ala || '',
        'ALA': row.ala || '',
        'DATA': dataFormatada,
        'PROJETISTA': row.projetista || '',
        'CIDADE': row.cidade || '',
        'ENDEREÇO': row.endereco || '',
        'LATITUDE': row.latitude || '',
        'LONGITUDE': row.longitude || '',
        'TABULAÇÃO FINAL': row.tabulacao_final || row['tabulacao final'] || '',
        'HORA': row.hora || ''
      };
    });
    
    console.log(`✅ [Supabase] ${records.length} VI ALAs carregados do Supabase`);
    
    return records;
  } catch (err) {
    console.error('❌ [Supabase] Erro ao ler VI ALAs:', err);
    return null; // Fallback para Excel
  }
}

// Função interna para ler base_VI_ALA.xlsx (sem lock, para uso interno)
async function _readVIALABaseInternal() {
  // Tentar Supabase primeiro
  const supabaseData = await readVIALABaseFromSupabase();
  if (supabaseData !== null) {
    return supabaseData;
  }
  
  // Fallback para Excel
  try {
    if (!fs.existsSync(BASE_VI_ALA_FILE)) {
      await _ensureVIALABaseInternal();
      return [];
    }
    
    // Usar fsPromises para operações assíncronas
    const fileBuffer = await fsPromises.readFile(BASE_VI_ALA_FILE);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    return data || [];
  } catch (err) {
    console.error('❌ [Excel] Erro ao ler base VI ALA:', err);
    throw err;
  }
}

// Função para ler base_VI_ALA.xlsx (com lock para uso externo)
async function readVIALABase() {
  return await withLock('vi_ala', async () => {
    return await _readVIALABaseInternal();
  });
}

// Função para obter o próximo VI ALA do Supabase (nova versão)
async function getNextVIALAFromSupabase() {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return null; // Retorna null para indicar que deve usar fallback
    }
    
    console.log('🔍 [Supabase] Obtendo próximo VI ALA do Supabase...');
    
    // Tentar usar a função SQL primeiro (mais eficiente)
    try {
      const { data, error } = await supabase.rpc('get_next_vi_ala_number');
      
      if (error) {
        // Se a função não existir, buscar manualmente
        throw error;
      }
      
      // data pode ser 0 (primeiro número), então verificar explicitamente
      const nextNumber = (data !== null && data !== undefined) ? data : 1;
      const nextVIALA = `VI ALA-${String(nextNumber).padStart(7, '0')}`;
      
      console.log(`✅ [Supabase] Próximo VI ALA gerado: ${nextVIALA} (número: ${nextNumber})`);
      return nextVIALA;
    } catch (rpcError) {
      // Fallback: buscar manualmente TODOS os registros para encontrar o maior número
      console.log('⚠️ [Supabase] Função SQL não disponível, buscando manualmente TODOS os registros...');
      
      // Buscar todos os registros em lotes para garantir que pegamos o maior número
      let maxNumber = 0;
      let offset = 0;
      const BATCH_SIZE = 1000;
      let hasMore = true;
      let totalProcessed = 0;
      
      // Primeiro, contar total de registros para saber quantos processar
      const { count: totalCount } = await supabase
        .from('vi_ala')
        .select('*', { count: 'exact', head: true });
      
      console.log(`📊 [Supabase] Total de VI ALAs no banco: ${totalCount || 0}`);
      
      while (hasMore) {
        const { data, error } = await supabase
          .from('vi_ala')
          .select('vi_ala')
          .order('created_at', { ascending: false })
          .range(offset, offset + BATCH_SIZE - 1);
        
        if (error) {
          console.error('❌ [Supabase] Erro ao buscar VI ALAs:', error);
          break;
        }
        
        // Processar lote atual
        if (data && data.length > 0) {
          for (const row of data) {
            const viAla = row.vi_ala || '';
            if (viAla && typeof viAla === 'string') {
              // Extrair número do VI ALA (formato: "VI ALA-0000001" ou "VI ALA - 0000001")
              const match = viAla.match(/VI\s*ALA[-\s]*(\d+)/i);
              if (match) {
                const number = parseInt(match[1], 10);
                if (!isNaN(number) && number > maxNumber) {
                  maxNumber = number;
                }
              }
            }
          }
          totalProcessed += data.length;
        }
        
        // Verificar se há mais registros
        if (!data || data.length < BATCH_SIZE) {
          hasMore = false;
        } else {
          offset += BATCH_SIZE;
        }
      }
      
      const nextNumber = maxNumber + 1;
      const nextVIALA = `VI ALA-${String(nextNumber).padStart(7, '0')}`;
      
      console.log(`✅ [Supabase] Próximo VI ALA gerado: ${nextVIALA} (max encontrado: ${maxNumber}, próximo: ${nextNumber}, registros processados: ${totalProcessed}/${totalCount || 0})`);
      return nextVIALA;
    }
  } catch (err) {
    console.error('❌ [Supabase] Erro ao obter próximo VI ALA:', err);
    return null; // Fallback para Excel
  }
}

// Função para obter o próximo VI ALA do Excel (fallback)
async function getNextVIALAFromExcel() {
  const startTime = Date.now();
  try {
    console.log('🔍 [Excel] Obtendo próximo VI ALA do Excel...');
    
    // Verificar/criar base (rápido, sem lock para evitar travamento)
    try {
      await fsPromises.access(BASE_VI_ALA_FILE);
      console.log('✅ [Excel] Arquivo existe');
    } catch {
      console.log('📝 [Excel] Arquivo não existe, criando...');
      const headers = ['VI ALA', 'ALA', 'DATA', 'PROJETISTA', 'CIDADE', 'ENDEREÇO', 'LATITUDE', 'LONGITUDE'];
      const worksheet = XLSX.utils.aoa_to_sheet([headers]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'VI ALA');
      XLSX.writeFile(workbook, BASE_VI_ALA_FILE);
      console.log('✅ [Excel] Arquivo criado');
    }
    
    // Ler dados (rápido)
    console.log('📖 [Excel] Lendo dados...');
    const fileBuffer = await fsPromises.readFile(BASE_VI_ALA_FILE);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet) || [];
    
    console.log(`📊 [Excel] Total de registros: ${data.length}`);
    
    // Encontrar maior número
    let maxNumber = 0;
    if (data.length > 0) {
      for (const row of data) {
        const viAla = row['VI ALA'] || '';
        if (viAla && typeof viAla === 'string') {
          const match = viAla.match(/VI\s*ALA[-\s]*(\d+)/i);
          if (match) {
            const number = parseInt(match[1], 10);
            if (!isNaN(number) && number > maxNumber) {
              maxNumber = number;
            }
          }
        }
      }
    }
    
    // Gerar próximo
    const nextNumber = maxNumber + 1;
    const nextVIALA = `VI ALA-${String(nextNumber).padStart(7, '0')}`;
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ [Excel] Próximo gerado: ${nextVIALA} (max: ${maxNumber}, próximo: ${nextNumber}) em ${elapsed}ms`);
    
    return nextVIALA;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ [Excel] Erro após ${elapsed}ms:`, err);
    throw err;
  }
}

// Função para obter o próximo VI ALA (tenta Supabase primeiro, fallback para Excel)
async function getNextVIALA() {
  // Tentar Supabase primeiro
  const supabaseResult = await getNextVIALAFromSupabase();
  if (supabaseResult !== null) {
    return supabaseResult;
  }
  
  // Fallback para Excel
  return await getNextVIALAFromExcel();
}

function parseVIALARecordDate(record) {
  let dataConvertida = null;
  if (record['DATA']) {
    const dataStr = String(record['DATA']).trim();
    if (dataStr.includes('/')) {
      const partes = dataStr.split(' ')[0].split('/');
      if (partes.length === 3) {
        const dia = partes[0].padStart(2, '0');
        const mes = partes[1].padStart(2, '0');
        const ano = partes[2];
        dataConvertida = `${ano}-${mes}-${dia}`;
      }
    } else if (dataStr.match(/^\d{4}-\d{2}-\d{2}/)) {
      dataConvertida = dataStr.split(' ')[0];
    }

    if (!dataConvertida) {
      const dateObj = new Date(dataStr);
      if (!isNaN(dateObj.getTime())) {
        dataConvertida = dateObj.toISOString().split('T')[0];
      }
    }
  }

  if (!dataConvertida) {
    dataConvertida = new Date().toISOString().split('T')[0];
  }

  return dataConvertida;
}

function parseVIALARecordCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function getMissingSupabaseColumn(errorMessage) {
  if (!errorMessage) return null;
  const match = String(errorMessage).match(/Could not find the '([^']+)' column/i);
  return match ? match[1] : null;
}

async function insertVIALAIntoSupabase(dataToSave) {
  const payload = { ...dataToSave };
  const maxAttempts = 12;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await supabase
      .from('vi_ala')
      .insert([payload]);

    if (!error) {
      return { success: true, payload };
    }

    const missingColumn = getMissingSupabaseColumn(error.message);
    if (missingColumn && Object.prototype.hasOwnProperty.call(payload, missingColumn)) {
      console.warn(`⚠️ [Supabase] Coluna '${missingColumn}' não existe em vi_ala, removendo do insert (tentativa ${attempt})...`);
      delete payload[missingColumn];
      continue;
    }

    return {
      success: false,
      error: error.message || 'Erro ao inserir VI ALA no Supabase',
      code: error.code || null
    };
  }

  return {
    success: false,
    error: 'Não foi possível inserir VI ALA após remover colunas inexistentes'
  };
}

async function insertVIALABatchIntoSupabase(records) {
  if (!records.length) {
    return { success: true, count: 0 };
  }

  const payload = records.map((record) => ({ ...record }));
  const maxAttempts = 12;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await supabase
      .from('vi_ala')
      .insert(payload);

    if (!error) {
      return { success: true, count: payload.length };
    }

    const missingColumn = getMissingSupabaseColumn(error.message);
    if (missingColumn && payload.some((record) => Object.prototype.hasOwnProperty.call(record, missingColumn))) {
      console.warn(`⚠️ [Supabase] Coluna '${missingColumn}' não existe em vi_ala, removendo do lote (tentativa ${attempt})...`);
      for (const record of payload) {
        delete record[missingColumn];
      }
      continue;
    }

    return {
      success: false,
      error: error.message || 'Erro ao inserir lote de VI ALAs no Supabase',
      code: error.code || null
    };
  }

  return {
    success: false,
    error: 'Não foi possível inserir lote de VI ALAs após remover colunas inexistentes'
  };
}

function buildVIALARecordForSupabase(record) {
  const tabulacaoFinalValue = record['TABULAÇÃO FINAL'];

  return {
    vi_ala: record['VI ALA'] || '',
    ala: record['ALA'] || null,
    data: parseVIALARecordDate(record),
    projetista: record['PROJETISTA'] || null,
    cidade: record['CIDADE'] || null,
    endereco: record['ENDEREÇO'] || null,
    latitude: parseVIALARecordCoordinate(record['LATITUDE']),
    longitude: parseVIALARecordCoordinate(record['LONGITUDE']),
    tabulacao_final: (tabulacaoFinalValue && String(tabulacaoFinalValue).trim() !== '')
      ? String(tabulacaoFinalValue).trim()
      : null
  };
}

function buildVIALARecordFromRequest(body, viAla) {
  const {
    ala,
    data,
    hora,
    projetista,
    cidade,
    endereco,
    latitude,
    longitude,
    tabulacaoFinal
  } = body;

  return {
    'VI ALA': viAla.trim(),
    'ALA': ala || '',
    'DATA': data || '',
    'HORA': hora || '',
    'PROJETISTA': projetista || '',
    'CIDADE': cidade || '',
    'ENDEREÇO': endereco || '',
    'LATITUDE': latitude || '',
    'LONGITUDE': longitude || '',
    'TABULAÇÃO FINAL': tabulacaoFinal || ''
  };
}

// Função para salvar registro VI ALA no Supabase (nova versão)
async function saveVIALARecordToSupabase(record) {
  try {
    if (!supabase || !isSupabaseAvailable()) {
      return { success: false, error: 'Supabase não disponível', useFallback: true };
    }

    console.log('💾 [Supabase] Salvando registro VI ALA no Supabase...');
    console.log('💾 [Supabase] Dados recebidos:', JSON.stringify(record, null, 2));

    const dataToSave = buildVIALARecordForSupabase(record);

    if (!dataToSave.vi_ala) {
      return { success: false, error: 'VI ALA é obrigatório', useFallback: false };
    }

    console.log('💾 [Supabase] Dados formatados para salvar:', JSON.stringify(dataToSave, null, 2));

    const insertResult = await insertVIALAIntoSupabase(dataToSave);

    if (!insertResult.success) {
      console.error('❌ [Supabase] Erro ao inserir VI ALA:', insertResult.error);
      return {
        success: false,
        error: insertResult.error,
        code: insertResult.code || null,
        useFallback: false
      };
    }

    console.log(`✅ [Supabase] Registro VI ALA salvo: ${dataToSave.vi_ala}`);
    if (insertResult.payload) {
      console.log('✅ [Supabase] Colunas efetivamente salvas:', Object.keys(insertResult.payload).join(', '));
    }
    return { success: true, storage: 'supabase' };
  } catch (err) {
    console.error('❌ [Supabase] Erro ao salvar registro VI ALA:', err);
    return {
      success: false,
      error: err.message || 'Erro inesperado ao salvar VI ALA',
      useFallback: false
    };
  }
}

// Função para salvar registro na base_VI_ALA.xlsx (fallback)
async function saveVIALARecordToExcel(record) {
  return await withLock('vi_ala', async () => {
    try {
      await _ensureVIALABaseInternal();
      const data = await _readVIALABaseInternal();
      const viAlaKey = String(record['VI ALA'] || '').trim();
      const alreadyExists = viAlaKey && data.some((row) => String(row['VI ALA'] || '').trim() === viAlaKey);

      if (!alreadyExists) {
        data.push(record);
      }

      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'VI ALA');

      XLSX.writeFile(workbook, BASE_VI_ALA_FILE);
      console.log('✅ [Excel] Registro VI ALA salvo:', record['VI ALA']);

      return true;
    } catch (err) {
      console.error('❌ [Excel] Erro ao salvar registro VI ALA:', err);
      throw err;
    }
  });
}

// Função para salvar registro VI ALA (tenta Supabase primeiro, fallback para Excel)
async function saveVIALARecord(record) {
  const supabaseResult = await saveVIALARecordToSupabase(record);

  if (supabaseResult.success) {
    console.log('💾 [Save] Atualizando arquivo Excel após salvar no Supabase...');
    try {
      await saveVIALARecordToExcel(record);
      console.log('✅ [Save] Arquivo Excel atualizado com sucesso');
    } catch (excelErr) {
      console.warn('⚠️ [Save] Erro ao atualizar Excel (não crítico):', excelErr.message);
    }
    return { success: true, storage: 'supabase' };
  }

  if (isSupabaseAvailable()) {
    throw new Error(supabaseResult.error || 'Falha ao salvar VI ALA no Supabase');
  }

  console.log('⚠️ [Save] Supabase indisponível, usando fallback Excel para salvar VI ALA');
  await saveVIALARecordToExcel(record);
  return { success: true, storage: 'excel' };
}

// Gera o próximo VI ALA e salva o registro em uma única operação no backend
async function registerVIALARecord(body) {
  const maxAttempts = 3;
  let lastError = 'Não foi possível registrar VI ALA';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const nextVIALA = await getNextVIALA();
    if (!nextVIALA) {
      throw new Error('Não foi possível gerar próximo VI ALA');
    }

    const record = buildVIALARecordFromRequest(body, nextVIALA);
    console.log(`📝 [Register] Tentativa ${attempt}/${maxAttempts} para registrar ${nextVIALA}`);

    try {
      const saveResult = await saveVIALARecord(record);
      return {
        success: true,
        viAla: nextVIALA,
        storage: saveResult.storage || 'supabase'
      };
    } catch (err) {
      lastError = err.message || lastError;
      const isDuplicate = /duplicate key|unique constraint|23505/i.test(lastError);

      if (isDuplicate && attempt < maxAttempts) {
        console.warn(`⚠️ [Register] VI ALA ${nextVIALA} já existe, tentando próximo número...`);
        continue;
      }

      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

// Rota para listar projetistas
app.get('/api/projetistas', async (req, res) => {
  try {
    // Usar versão assíncrona que tenta Supabase primeiro
    const projetistas = await readProjetistasAsync();
    // Retornar apenas os nomes para compatibilidade com frontend (sem senhas)
    const nomesProjetistas = projetistas.map(p => typeof p === 'string' ? p : p.nome);
    res.json({ success: true, projetistas: nomesProjetistas });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para adicionar projetista (apenas Admin)
app.post('/api/projetistas', requireAdmin, async (req, res) => {
  try {
    const { nome, senha } = req.body;
    
    if (!nome || !nome.trim()) {
      return res.status(400).json({ success: false, error: 'Nome do projetista é obrigatório' });
    }
    
    if (!senha || !senha.trim()) {
      return res.status(400).json({ success: false, error: 'Senha é obrigatória' });
    }
    
    const nomeLimpo = nome.trim();
    const senhaLimpa = senha.trim();
    
    // Tentar adicionar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Verificar se já existe
        const { data: existing } = await supabase
          .from('projetistas')
          .select('nome')
          .ilike('nome', nomeLimpo)
          .limit(1);
        
        if (existing && existing.length > 0) {
          return res.json({ success: false, error: 'Projetista já existe' });
        }
        
        // Inserir no Supabase (novo usuário sempre começa como 'user')
        const { error } = await supabase
          .from('projetistas')
          .insert([{ nome: nomeLimpo, senha: senhaLimpa, tipo: 'user' }]);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Projetista '${nomeLimpo}' adicionado no Supabase`);
        
        // Buscar todos para retornar
        const projetistas = await readProjetistasAsync();
        const nomesProjetistas = projetistas.map(p => p.nome);
        
        return res.json({ success: true, projetistas: nomesProjetistas, message: 'Projetista adicionado com sucesso' });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao adicionar projetista, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let projetistas = readProjetistas();
    
    // Verificar se já existe (comparar por nome)
    const existe = projetistas.some(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === nomeLimpo.toLowerCase();
    });
    
    if (existe) {
      return res.json({ success: false, error: 'Projetista já existe' });
    }
    
    // Adicionar novo projetista com senha (novo usuário sempre começa como 'user')
    projetistas.push({ nome: nomeLimpo, senha: senhaLimpa, tipo: 'user' });
    
    // Ordenar alfabeticamente por nome
    projetistas.sort((a, b) => {
      const nomeA = typeof a === 'string' ? a : a.nome;
      const nomeB = typeof b === 'string' ? b : b.nome;
      return nomeA.localeCompare(nomeB);
    });
    
    // Salvar no Excel
    await saveProjetistas(projetistas);
    
    // Retornar apenas os nomes para compatibilidade com frontend
    const nomesProjetistas = projetistas.map(p => typeof p === 'string' ? p : p.nome);
    
    res.json({ success: true, projetistas: nomesProjetistas, message: 'Projetista adicionado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para deletar projetista (apenas Admin)
app.delete('/api/projetistas/:nome', requireAdmin, async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    console.log(`🔍 Tentando deletar projetista: '${nomeDecoded}'`);
    
    // Tentar deletar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Buscar projetista para verificar se existe
        const { data: existing } = await supabase
          .from('projetistas')
          .select('nome')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          const projetistas = await readProjetistasAsync();
          const nomesAntes = projetistas.map(p => p.nome);
          return res.json({ 
            success: false, 
            projetistas: nomesAntes, 
            message: 'Projetista não encontrado' 
          });
        }
        
        // Deletar do Supabase
        const { error } = await supabase
          .from('projetistas')
          .delete()
          .ilike('nome', nomeDecoded);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Projetista '${nomeDecoded}' deletado do Supabase`);
        
        // Buscar todos para retornar
        const projetistas = await readProjetistasAsync();
        const nomesProjetistas = projetistas.map(p => p.nome);
        
        return res.json({ 
          success: true, 
          projetistas: nomesProjetistas, 
          message: `Projetista '${nomeDecoded}' deletado com sucesso` 
        });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao deletar projetista, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let projetistas = readProjetistas();
    
    const nomesAntes = projetistas.map(p => typeof p === 'string' ? p : p.nome);
    console.log(`📋 [Excel] Projetistas antes da exclusão: ${nomesAntes.join(', ')}`);
    
    // Verificar se existe (comparar por nome)
    const existe = projetistas.some(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj === nomeDecoded;
    });
    
    if (!existe) {
      console.log(`⚠️ Projetista '${nomeDecoded}' não encontrado na base de dados`);
      return res.json({ 
        success: false, 
        projetistas: nomesAntes, 
        message: 'Projetista não encontrado' 
      });
    }
    
    // Remover da lista
    const projetistasAntes = projetistas.length;
    projetistas = projetistas.filter(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj !== nomeDecoded;
    });
    const projetistasDepois = projetistas.length;
    
    console.log(`📊 [Excel] Projetistas antes: ${projetistasAntes}, depois: ${projetistasDepois}`);
    
    // Salvar na planilha Excel (atualiza a base de dados)
    await saveProjetistas(projetistas);
    
    console.log(`✅ Projetista '${nomeDecoded}' deletado e base de dados atualizada!`);
    
    // Retornar apenas os nomes para compatibilidade
    const nomesProjetistas = projetistas.map(p => typeof p === 'string' ? p : p.nome);
    
    res.json({ 
      success: true, 
      projetistas: nomesProjetistas, 
      message: `Projetista '${nomeDecoded}' deletado com sucesso da base de dados` 
    });
  } catch (err) {
    console.error('❌ Erro ao deletar projetista:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Middleware de autorização para verificar se o usuário é Admin
async function requireAdmin(req, res, next) {
  try {
    // Tentar obter usuário do body, header ou query (flexível para diferentes métodos HTTP)
    // Headers HTTP são case-insensitive, mas Node.js pode retornar em diferentes casos
    // Buscar header em diferentes variações de case
    let headerUsuario = null;
    const headerKeys = Object.keys(req.headers);
    for (const key of headerKeys) {
      if (key.toLowerCase() === 'x-usuario') {
        headerUsuario = req.headers[key];
        break;
      }
    }
    
    const usuario = req.body?.usuario || headerUsuario || req.query.usuario;
    
    console.log('🔍 [Auth] Verificando autorização admin:', {
      bodyUsuario: req.body?.usuario,
      headerUsuario: headerUsuario,
      queryUsuario: req.query.usuario,
      usuarioFinal: usuario
    });
    
    if (!usuario || !usuario.trim()) {
      console.error('❌ [Auth] Usuário não fornecido na requisição');
      return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
    }
    
    const usuarioLimpo = usuario.trim();
    
    // Buscar tipo do usuário
    let tipoUsuario = 'user'; // Default
    
    if (supabase && isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('projetistas')
          .select('tipo')
          .ilike('nome', usuarioLimpo)
          .limit(1);
        
        if (!error && data && data.length > 0) {
          tipoUsuario = (data[0].tipo || 'user').toLowerCase();
        }
      } catch (err) {
        console.error('❌ [Auth] Erro ao buscar tipo do usuário no Supabase:', err);
        // Continuar com fallback
      }
    }
    
    // Fallback: buscar do Excel (sempre verificar se não encontrou no Supabase)
    if (tipoUsuario === 'user' || !tipoUsuario) {
      try {
        const projetistas = await readProjetistasAsync();
        const projetista = projetistas.find(p => {
          const nomeProj = typeof p === 'string' ? p : p.nome;
          return nomeProj.toLowerCase() === usuarioLimpo.toLowerCase();
        });
        
        if (projetista && typeof projetista !== 'string') {
          tipoUsuario = (projetista.tipo || 'user').toLowerCase();
          console.log(`📋 [Auth] Tipo encontrado no Excel para '${usuarioLimpo}': ${tipoUsuario}`);
        } else if (projetista) {
          console.log(`⚠️ [Auth] Projetista '${usuarioLimpo}' encontrado mas sem tipo definido (usando default: user)`);
        } else {
          console.warn(`⚠️ [Auth] Projetista '${usuarioLimpo}' não encontrado em nenhuma fonte`);
        }
      } catch (excelErr) {
        console.error('❌ [Auth] Erro ao buscar tipo do Excel:', excelErr);
      }
    }
    
    // Verificar se é admin
    console.log(`🔍 [Auth] Tipo do usuário '${usuarioLimpo}': ${tipoUsuario}`);
    if (tipoUsuario !== 'admin') {
      console.warn(`⚠️ [Auth] Acesso negado para usuário '${usuarioLimpo}' (tipo: ${tipoUsuario})`);
      return res.status(403).json({ success: false, error: 'Acesso negado. Apenas administradores podem realizar esta ação.' });
    }
    
    console.log(`✅ [Auth] Usuário '${usuarioLimpo}' autorizado como admin`);
    
    // Adicionar tipo ao request para uso posterior
    req.userTipo = tipoUsuario;
    next();
  } catch (err) {
    console.error('❌ [Auth] Erro no middleware de autorização:', err);
    return res.status(500).json({ success: false, error: 'Erro ao verificar permissões' });
  }
}

// Rota para autenticar usuário (validar login)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    
    if (!usuario || !usuario.trim()) {
      return res.status(400).json({ success: false, error: 'Usuário é obrigatório' });
    }
    
    if (!senha || !senha.trim()) {
      return res.status(400).json({ success: false, error: 'Senha é obrigatória' });
    }
    
    const usuarioLimpo = usuario.trim();
    const senhaLimpa = senha.trim();
    
    let projetistaEncontrado = null;
    let tipoUsuario = 'user'; // Default
    
    // Tentar buscar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('projetistas')
          .select('nome, senha, tipo')
          .ilike('nome', usuarioLimpo)
          .limit(1);
        
        if (error) {
          throw error;
        }
        
        if (!data || data.length === 0) {
          return res.json({ success: false, error: 'Usuário ou senha incorretos' });
        }
        
        projetistaEncontrado = data[0];
        if (projetistaEncontrado.senha !== senhaLimpa) {
          return res.json({ success: false, error: 'Usuário ou senha incorretos' });
        }
        
        tipoUsuario = (projetistaEncontrado.tipo || 'user').toLowerCase();
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao validar login, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel se não encontrou no Supabase
    if (!projetistaEncontrado) {
      const projetistas = await readProjetistasAsync();
      
      // Buscar projetista pelo nome (case insensitive)
      projetistaEncontrado = projetistas.find(p => {
        const nomeProj = typeof p === 'string' ? p : p.nome;
        return nomeProj.toLowerCase() === usuarioLimpo.toLowerCase();
      });
      
      if (!projetistaEncontrado) {
        return res.json({ success: false, error: 'Usuário ou senha incorretos' });
      }
      
      // Verificar senha
      const senhaProj = typeof projetistaEncontrado === 'string' ? '' : projetistaEncontrado.senha;
      if (senhaProj !== senhaLimpa) {
        return res.json({ success: false, error: 'Usuário ou senha incorretos' });
      }
      
      // Obter tipo do usuário
      if (typeof projetistaEncontrado !== 'string') {
        tipoUsuario = (projetistaEncontrado.tipo || 'user').toLowerCase();
      }
    }
    
    // Registrar usuário como online
    const now = Date.now();
    activeSessions[usuarioLimpo] = {
      lastActivity: now,
      loginTime: now,
      tipo: tipoUsuario
    };
    // Remover do histórico de logout se existir
    if (logoutHistory[usuarioLimpo]) {
      delete logoutHistory[usuarioLimpo];
    }
    
    // Salvar entrada no Supabase usando função auxiliar
    // IMPORTANTE: Sempre tentar salvar, mesmo que haja erro anterior
    console.log(`🔍 [Login] ==========================================`);
    console.log(`🔍 [Login] INICIANDO SALVAMENTO NO SUPABASE`);
    console.log(`🔍 [Login] Usuário: ${usuarioLimpo}`);
    console.log(`🔍 [Login] Supabase disponível: ${isSupabaseAvailable()}`);
    console.log(`🔍 [Login] Cliente Supabase: ${supabase ? 'OK' : 'NULL'}`);
    console.log(`🔍 [Login] ==========================================`);
    
    try {
      const resultadoEntrada = await inserirEntradaSaida(usuarioLimpo, 'entrada');
      
      console.log(`🔍 [Login] Resultado do salvamento:`, {
        success: resultadoEntrada.success,
        hasError: !!resultadoEntrada.error,
        hasData: !!(resultadoEntrada.data && resultadoEntrada.data.length > 0)
      });
      
      if (resultadoEntrada.success) {
        const dataEntrada = new Date().toISOString().split('T')[0];
        const horaEntrada = new Date().toTimeString().split(' ')[0];
        console.log(`✅ [Login] ==========================================`);
        console.log(`✅ [Login] ENTRADA SALVA COM SUCESSO!`);
        console.log(`✅ [Login] Usuário: ${usuarioLimpo}`);
        console.log(`✅ [Login] Data: ${dataEntrada} Hora: ${horaEntrada}`);
        if (resultadoEntrada.data && resultadoEntrada.data.length > 0) {
          console.log(`✅ [Login] ID do registro: ${resultadoEntrada.data[0].id}`);
          console.log(`✅ [Login] Registro completo:`, JSON.stringify(resultadoEntrada.data[0], null, 2));
        }
        console.log(`✅ [Login] ==========================================`);
      } else {
        console.error('❌ [Login] ==========================================');
        console.error('❌ [Login] ERRO AO SALVAR ENTRADA!');
        console.error('❌ [Login] Usuário:', usuarioLimpo);
        console.error('❌ [Login] Erro:', resultadoEntrada.error);
        if (resultadoEntrada.error && typeof resultadoEntrada.error === 'object') {
          console.error('❌ [Login] Código:', resultadoEntrada.error.code);
          console.error('❌ [Login] Mensagem:', resultadoEntrada.error.message);
          console.error('❌ [Login] Detalhes:', resultadoEntrada.error.details);
          console.error('❌ [Login] Erro completo:', JSON.stringify(resultadoEntrada.error, null, 2));
        }
        console.error('❌ [Login] ==========================================');
        // Não falhar o login se houver erro ao salvar entrada
      }
    } catch (err) {
      console.error('❌ [Login] ==========================================');
      console.error('❌ [Login] EXCEÇÃO AO TENTAR SALVAR ENTRADA!');
      console.error('❌ [Login] Tipo:', err.name);
      console.error('❌ [Login] Mensagem:', err.message);
      console.error('❌ [Login] Stack:', err.stack);
      console.error('❌ [Login] ==========================================');
      // Não falhar o login se houver erro ao salvar entrada
    }
    
    console.log(`🟢 Usuário ${usuarioLimpo} (${tipoUsuario}) fez login`);
    
    res.json({ 
      success: true, 
      message: 'Login realizado com sucesso',
      tipo: tipoUsuario,
      usuario: usuarioLimpo
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para atualizar senha do projetista
app.put('/api/projetistas/:nome/password', async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    const { senha } = req.body;
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    if (!senha || !senha.trim()) {
      return res.status(400).json({ success: false, error: 'Senha é obrigatória' });
    }
    
    if (senha.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 4 caracteres' });
    }
    
    // Tentar atualizar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Buscar projetista
        const { data: existing } = await supabase
          .from('projetistas')
          .select('id, nome')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
        }
        
        // Atualizar senha
        const { error } = await supabase
          .from('projetistas')
          .update({ senha: senha.trim() })
          .eq('id', existing[0].id);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Senha do projetista '${nomeDecoded}' atualizada no Supabase`);
        return res.json({ success: true, message: 'Senha atualizada com sucesso' });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao atualizar senha, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let projetistas = readProjetistas();
    
    // Buscar projetista pelo nome (case insensitive)
    const projetistaIndex = projetistas.findIndex(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === nomeDecoded.toLowerCase();
    });
    
    if (projetistaIndex === -1) {
      return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
    }
    
    // Atualizar senha
    const projetista = projetistas[projetistaIndex];
    if (typeof projetista === 'string') {
      projetistas[projetistaIndex] = { nome: projetista, senha: senha.trim() };
    } else {
      projetistas[projetistaIndex] = { ...projetista, senha: senha.trim() };
    }
    
    // Salvar no Excel
    await saveProjetistas(projetistas);
    
    console.log(`✅ Senha do projetista '${nomeDecoded}' atualizada com sucesso`);
    
    res.json({ success: true, message: 'Senha atualizada com sucesso' });
  } catch (err) {
    console.error('❌ Erro ao atualizar senha:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para atualizar nome do projetista
app.put('/api/projetistas/:nome/name', async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    const { novoNome } = req.body;
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    if (!novoNome || !novoNome.trim()) {
      return res.status(400).json({ success: false, error: 'Novo nome é obrigatório' });
    }
    
    const novoNomeLimpo = novoNome.trim();
    
    if (novoNomeLimpo.length < 2) {
      return res.status(400).json({ success: false, error: 'O novo nome deve ter pelo menos 2 caracteres' });
    }
    
    // Tentar atualizar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Verificar se novo nome já existe
        const { data: nomeExiste } = await supabase
          .from('projetistas')
          .select('nome')
          .ilike('nome', novoNomeLimpo)
          .limit(1);
        
        if (nomeExiste && nomeExiste.length > 0 && nomeExiste[0].nome.toLowerCase() !== nomeDecoded.toLowerCase()) {
          return res.status(400).json({ success: false, error: 'Este nome já está em uso por outro usuário' });
        }
        
        // Buscar projetista
        const { data: existing } = await supabase
          .from('projetistas')
          .select('id, nome, senha')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
        }
        
        // Atualizar nome
        const { error } = await supabase
          .from('projetistas')
          .update({ nome: novoNomeLimpo })
          .eq('id', existing[0].id);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Nome do projetista '${nomeDecoded}' atualizado para '${novoNomeLimpo}' no Supabase`);
        
        // Atualizar sessões ativas se o usuário estiver logado
        if (activeSessions[nomeDecoded]) {
          const sessionData = activeSessions[nomeDecoded];
          delete activeSessions[nomeDecoded];
          activeSessions[novoNomeLimpo] = sessionData;
          console.log(`🔄 Sessão ativa atualizada: '${nomeDecoded}' → '${novoNomeLimpo}'`);
        }
        
        // Atualizar histórico de logout se existir
        if (logoutHistory[nomeDecoded]) {
          logoutHistory[novoNomeLimpo] = logoutHistory[nomeDecoded];
          delete logoutHistory[nomeDecoded];
        }
        
        return res.json({ success: true, message: 'Nome atualizado com sucesso', novoNome: novoNomeLimpo });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao atualizar nome, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let projetistas = readProjetistas();
    
    // Verificar se o novo nome já existe (case insensitive)
    const nomeJaExiste = projetistas.some(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === novoNomeLimpo.toLowerCase() && 
             nomeProj.toLowerCase() !== nomeDecoded.toLowerCase();
    });
    
    if (nomeJaExiste) {
      return res.status(400).json({ success: false, error: 'Este nome já está em uso por outro usuário' });
    }
    
    // Buscar projetista pelo nome (case insensitive)
    const projetistaIndex = projetistas.findIndex(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === nomeDecoded.toLowerCase();
    });
    
    if (projetistaIndex === -1) {
      return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
    }
    
    // Atualizar nome
    const projetista = projetistas[projetistaIndex];
    if (typeof projetista === 'string') {
      projetistas[projetistaIndex] = { nome: novoNomeLimpo, senha: '' };
    } else {
      projetistas[projetistaIndex] = { ...projetista, nome: novoNomeLimpo };
    }
    
    // Ordenar alfabeticamente por nome
    projetistas.sort((a, b) => {
      const nomeA = typeof a === 'string' ? a : a.nome;
      const nomeB = typeof b === 'string' ? b : b.nome;
      return nomeA.localeCompare(nomeB);
    });
    
    // Salvar no Excel
    await saveProjetistas(projetistas);
    
    // Atualizar sessões ativas se o usuário estiver logado
    if (activeSessions[nomeDecoded]) {
      const sessionData = activeSessions[nomeDecoded];
      // Remover sessão antiga
      delete activeSessions[nomeDecoded];
      // Criar sessão com novo nome
      activeSessions[novoNomeLimpo] = sessionData;
      console.log(`🔄 Sessão ativa atualizada: '${nomeDecoded}' → '${novoNomeLimpo}'`);
    }
    
    // Atualizar histórico de logout se existir
    if (logoutHistory[nomeDecoded]) {
      logoutHistory[novoNomeLimpo] = logoutHistory[nomeDecoded];
      delete logoutHistory[nomeDecoded];
    }
    
    console.log(`✅ Nome do projetista '${nomeDecoded}' atualizado para '${novoNomeLimpo}' com sucesso`);
    
    res.json({ success: true, message: 'Nome atualizado com sucesso', novoNome: novoNomeLimpo });
  } catch (err) {
    console.error('❌ Erro ao atualizar nome:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para alterar tipo de usuário (apenas Admin)
app.put('/api/projetistas/:nome/role', requireAdmin, async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    const { tipo } = req.body;
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    if (!tipo || !tipo.trim()) {
      return res.status(400).json({ success: false, error: 'Tipo é obrigatório' });
    }
    
    const tipoLimpo = tipo.trim().toLowerCase();
    
    // Validar tipo (apenas 'admin' ou 'user')
    if (tipoLimpo !== 'admin' && tipoLimpo !== 'user') {
      return res.status(400).json({ success: false, error: 'Tipo deve ser "admin" ou "user"' });
    }
    
    // Obter o usuário que está fazendo a requisição (do middleware requireAdmin já validou que é admin)
    const usuarioRequisicao = req.body?.usuario || req.headers['x-usuario'] || req.query.usuario || '';
    const usuarioRequisicaoLimpo = usuarioRequisicao.trim().toLowerCase();
    
    // IMPEDIR que um usuário altere seu próprio tipo (segurança)
    if (usuarioRequisicaoLimpo && nomeDecoded.toLowerCase() === usuarioRequisicaoLimpo) {
      return res.status(403).json({ 
        success: false, 
        error: 'Você não pode alterar seu próprio tipo de usuário. Peça a outro administrador para fazer isso.' 
      });
    }
    
    // Tentar atualizar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Buscar projetista
        const { data: existing } = await supabase
          .from('projetistas')
          .select('id, nome, tipo')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
        }
        
        // Atualizar tipo
        const { error } = await supabase
          .from('projetistas')
          .update({ tipo: tipoLimpo })
          .ilike('nome', nomeDecoded);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Tipo do projetista '${nomeDecoded}' atualizado para '${tipoLimpo}' no Supabase`);
        
        // Atualizar sessão ativa se o usuário estiver logado
        if (activeSessions[nomeDecoded]) {
          activeSessions[nomeDecoded].tipo = tipoLimpo;
        }
        
        return res.json({ 
          success: true, 
          message: `Tipo do usuário atualizado para '${tipoLimpo}' com sucesso`,
          tipo: tipoLimpo
        });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao atualizar tipo, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let projetistas = await readProjetistasAsync();
    
    // Buscar projetista pelo nome (case insensitive)
    const projetistaIndex = projetistas.findIndex(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === nomeDecoded.toLowerCase();
    });
    
    if (projetistaIndex === -1) {
      return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
    }
    
    // Atualizar tipo
    const projetista = projetistas[projetistaIndex];
    if (typeof projetista === 'string') {
      projetistas[projetistaIndex] = { nome: projetista, senha: '', tipo: tipoLimpo };
    } else {
      projetistas[projetistaIndex] = { ...projetista, tipo: tipoLimpo };
    }
    
    // Salvar no Excel
    await saveProjetistas(projetistas);
    
    // Atualizar sessão ativa se o usuário estiver logado
    if (activeSessions[nomeDecoded]) {
      activeSessions[nomeDecoded].tipo = tipoLimpo;
    }
    
    console.log(`✅ Tipo do projetista '${nomeDecoded}' atualizado para '${tipoLimpo}' com sucesso`);
    
    res.json({ 
      success: true, 
      message: `Tipo do usuário atualizado para '${tipoLimpo}' com sucesso`,
      tipo: tipoLimpo
    });
  } catch (err) {
    console.error('❌ Erro ao atualizar tipo:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// IDs das ferramentas — fonte: /shared/portal-tools.json
let PORTAL_TOOL_IDS = [
  'viabilidade-alares',
  'analise-cobertura',
  'calculadora-orcamento',
  'mapa-consulta',
  'dashboard-censup',
  'formulario-engenharia'
];

try {
  const portalToolsPath = path.join(__dirname, 'portal-tools.json');
  const portalToolsRaw = fs.readFileSync(portalToolsPath, 'utf8');
  const portalToolsList = JSON.parse(portalToolsRaw);
  if (Array.isArray(portalToolsList) && portalToolsList.length > 0) {
    PORTAL_TOOL_IDS = portalToolsList.map((t) => t.id).filter(Boolean);
    console.log(`✅ [Portal] ${PORTAL_TOOL_IDS.length} ferramentas carregadas de portal-tools.json`);
  }
} catch (portalToolsErr) {
  console.warn('⚠️ [Portal] Usando lista padrão de ferramentas:', portalToolsErr.message);
}

function mergePortalToolPermissions(permissions = {}) {
  const merged = { ...(permissions || {}) };
  PORTAL_TOOL_IDS.forEach((toolId) => {
    if (merged[toolId] === undefined) {
      merged[toolId] = true;
    }
  });
  return merged;
}

function buildPortalPermissionsPayload(permissions = {}) {
  const merged = mergePortalToolPermissions(permissions);
  const payload = {};
  PORTAL_TOOL_IDS.forEach((toolId) => {
    payload[toolId] = merged[toolId] === true;
  });
  return payload;
}

// Endpoint para obter permissões de ferramentas de um projetista
// Permite que o usuário veja suas próprias permissões ou admin veja qualquer usuário
app.get('/api/projetistas/:nome/permissions', async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Verificar se o usuário tem permissão para ver essas permissões
    const usuarioRequisicao = req.body?.usuario || req.headers['x-usuario'] || req.query.usuario || '';
    const usuarioRequisicaoLimpo = usuarioRequisicao.trim().toLowerCase();
    
    // Verificar se é admin ou se está consultando suas próprias permissões
    let isAdmin = false;
    if (usuarioRequisicaoLimpo) {
      if (supabase && isSupabaseAvailable()) {
        try {
          const { data } = await supabase
            .from('projetistas')
            .select('tipo')
            .ilike('nome', usuarioRequisicaoLimpo)
            .limit(1);
          
          if (data && data.length > 0) {
            isAdmin = (data[0].tipo || 'user').toLowerCase() === 'admin';
          }
        } catch (err) {
          console.error('Erro ao verificar tipo de usuário:', err);
        }
      }
    }
    
    // Se não é admin e não está consultando suas próprias permissões, negar acesso
    if (!isAdmin && usuarioRequisicaoLimpo && nomeDecoded.toLowerCase() !== usuarioRequisicaoLimpo) {
      return res.status(403).json({ 
        success: false, 
        error: 'Você não tem permissão para ver as permissões de outro usuário' 
      });
    }
    
    let permissions = {}; // Permissões padrão: todas as ferramentas habilitadas
    
    // Tentar buscar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('projetistas')
          .select('permissoes_ferramentas')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!error && data && data.length > 0 && data[0].permissoes_ferramentas) {
          // Se há permissões salvas, usar elas
          permissions = typeof data[0].permissoes_ferramentas === 'string' 
            ? JSON.parse(data[0].permissoes_ferramentas)
            : data[0].permissoes_ferramentas;
        }
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao buscar permissões, usando fallback:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: buscar do Excel (se houver campo de permissões)
    // Mesclar com registry: ferramentas novas habilitadas por padrão
    permissions = mergePortalToolPermissions(permissions);

    res.json({
      success: true,
      permissions
    });
  } catch (err) {
    console.error('❌ Erro ao buscar permissões:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint para salvar permissões de ferramentas de um projetista
app.put('/api/projetistas/:nome/permissions', requireAdmin, async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    const { permissions } = req.body;
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ success: false, error: 'Permissões inválidas' });
    }

    const permissionsToSave = buildPortalPermissionsPayload(permissions);
    
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Tentar salvar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Verificar se o projetista existe
        const { data: existing } = await supabase
          .from('projetistas')
          .select('id, nome')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
        }
        
        // Atualizar permissões (salvar como JSON string)
        const { error } = await supabase
          .from('projetistas')
          .update({ permissoes_ferramentas: JSON.stringify(permissionsToSave) })
          .ilike('nome', nomeDecoded);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Permissões de ferramentas do projetista '${nomeDecoded}' atualizadas no Supabase`);
        
        return res.json({ 
          success: true, 
          message: 'Permissões de ferramentas atualizadas com sucesso',
          permissions: permissionsToSave
        });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao salvar permissões, usando fallback:', supabaseErr);
        // Continuar com fallback Excel (ou apenas retornar sucesso se não houver fallback)
      }
    }
    
    // Fallback: salvar no Excel (se necessário implementar)
    // Por enquanto, apenas retornar sucesso
    
    res.json({ 
      success: true, 
      message: 'Permissões de ferramentas atualizadas com sucesso',
      permissions: permissionsToSave
    });
  } catch (err) {
    console.error('❌ Erro ao salvar permissões:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para buscar dados completos de um projetista específico (apenas Admin)
// IMPORTANTE: Esta rota deve vir DEPOIS de rotas mais específicas como /permissions
app.get('/api/projetistas/:nome', requireAdmin, async (req, res) => {
  try {
    const nomeEncoded = req.params.nome;
    const nomeDecoded = decodeURIComponent(nomeEncoded).trim();
    
    if (!nomeDecoded) {
      return res.status(400).json({ success: false, error: 'Nome do projetista não pode estar vazio' });
    }
    
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Buscar projetista no Supabase
    if (supabase && isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('projetistas')
          .select('nome, senha, tipo')
          .ilike('nome', nomeDecoded)
          .limit(1);
        
        if (error) {
          throw error;
        }
        
        if (data && data.length > 0) {
          return res.json({ 
            success: true, 
            projetista: {
              nome: data[0].nome || '',
              senha: data[0].senha || '',
              tipo: data[0].tipo || 'user'
            }
          });
        }
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao buscar projetista, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    const projetistas = readProjetistas();
    const projetista = projetistas.find(p => {
      const nomeProj = typeof p === 'string' ? p : p.nome;
      return nomeProj.toLowerCase() === nomeDecoded.toLowerCase();
    });
    
    if (projetista) {
      const dadosProjetista = typeof projetista === 'string' 
        ? { nome: projetista, senha: '', tipo: 'user' }
        : { 
            nome: projetista.nome || '', 
            senha: projetista.senha || '', 
            tipo: projetista.tipo || 'user' 
          };
      
      return res.json({ success: true, projetista: dadosProjetista });
    }
    
    return res.status(404).json({ success: false, error: 'Projetista não encontrado' });
  } catch (err) {
    console.error('Erro ao buscar projetista:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Função para validar estrutura do arquivo Excel (ultra-otimizada para não travar)
// OTIMIZAÇÃO: Aceita tanto Buffer (memória) quanto caminho de arquivo (disco)
// Função para processar Excel em STREAMING REAL usando exceljs (para arquivos grandes)
// Esta função usa streaming reader que processa linha por linha SEM carregar arquivo na memória
// Função para normalizar chaves (extraída para uso compartilhado)
function normalizeKey(key) {
  const lower = String(key || '').toLowerCase().trim();
  const mapping = {
    'cid_rede': 'cid_rede', 'cid rede': 'cid_rede', 'estado': 'estado', 'pop': 'pop',
    'olt': 'olt', 'slot': 'slot', 'pon': 'pon', 'id_cto': 'id_cto', 'id cto': 'id_cto', 'cto': 'cto',
    'latitude': 'latitude', 'lat': 'latitude', 'longitude': 'longitude', 'long': 'longitude', 'lng': 'longitude',
    'status_cto': 'status_cto', 'status cto': 'status_cto', 'data_cadastro': 'data_cadastro', 'data cadastro': 'data_cadastro',
    'portas': 'portas', 'ocupado': 'ocupado', 'livre': 'livre', 'pct_ocup': 'pct_ocup', 'pct ocup': 'pct_ocup'
  };
  return mapping[lower] || lower;
}

/**
 * Gera chave_unica para uma CTO
 * Concatena todas as colunas (exceto id_cto) de forma normalizada
 * Esta chave é usada para detectar mudanças em CTOs existentes durante atualização da base
 * 
 * @param {Object} cto - Objeto com dados da CTO
 * @param {string|null} cto.cid_rede - CID da rede
 * @param {string|null} cto.estado - Estado
 * @param {string|null} cto.pop - POP
 * @param {string|null} cto.olt - OLT
 * @param {string|null} cto.slot - Slot
 * @param {string|null} cto.pon - PON
 * @param {string|null} cto.cto - Nome da CTO
 * @param {number|null} cto.latitude - Latitude
 * @param {number|null} cto.longitude - Longitude
 * @param {string|null} cto.status_cto - Status da CTO
 * @param {string|null} cto.data_cadastro - Data de cadastro (formato YYYY-MM-DD ou MM/YYYY)
 * @param {number|null} cto.portas - Número de portas
 * @param {number|null} cto.ocupado - Portas ocupadas
 * @param {number|null} cto.livre - Portas livres
 * @param {number|null} cto.pct_ocup - Percentual de ocupação
 * @returns {string} - Chave única normalizada (concatenação de todas as colunas)
 */
function generateChaveUnica(cto) {
  // Função auxiliar para normalizar valores
  const normalize = (value) => {
    // Se for null ou undefined, retornar string vazia
    if (value === null || value === undefined) {
      return '';
    }
    
    // Converter para string
    let str = String(value);
    
    // Remover espaços em branco no início e fim
    str = str.trim();
    
    // Normalizar números decimais (virgula → ponto)
    // Exemplo: "31,25" → "31.25"
    str = str.replace(',', '.');
    
    // Converter para maiúsculas (case-insensitive)
    // Isso garante que "ATIVADO" e "ativado" sejam iguais
    str = str.toUpperCase();
    
    return str;
  };
  
  // Função auxiliar para normalizar data
  const normalizeDate = (value) => {
    if (!value) return '';
    
    // Se for string no formato "MM/YYYY", converter para "YYYY-MM-01"
    if (typeof value === 'string') {
      const mmYYYYMatch = value.trim().match(/^(\d{1,2})\/(\d{4})$/);
      if (mmYYYYMatch) {
        const mes = mmYYYYMatch[1].padStart(2, '0');
        const ano = mmYYYYMatch[2];
        return `${ano}-${mes}-01`;
      }
      
      // Se já estiver no formato "YYYY-MM-DD", manter
      if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return value;
      }
    }
    
    // Se for Date, converter para YYYY-MM-DD
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    
    // Converter para string e normalizar
    return normalize(value);
  };
  
  // Ordem das colunas na concatenação (mesma ordem sempre)
  // IMPORTANTE: id_cto NÃO entra na chave_unica
  const columns = [
    cto.cid_rede,        // CID_REDE
    cto.estado,          // ESTADO
    cto.pop,             // POP
    cto.olt,             // OLT
    cto.slot,            // SLOT
    cto.pon,             // PON
    cto.cto,             // CTO (nome)
    cto.latitude,        // LATITUDE
    cto.longitude,       // LONGITUDE
    cto.status_cto,      // STATUS_CTO
    cto.data_cadastro,   // DATA_CADASTRO (normalizar formato)
    cto.portas,          // PORTAS
    cto.ocupado,         // OCUPADO
    cto.livre,           // LIVRE
    cto.pct_ocup         // PCT_OCUP
  ];
  
  // Normalizar e concatenar todas as colunas
  const normalizedValues = columns.map((value, index) => {
    // Se for data_cadastro (índice 10), usar normalização especial
    if (index === 10) {
      return normalizeDate(value);
    }
    // Para os demais, usar normalização padrão
    return normalize(value);
  });
  
  const chaveUnica = normalizedValues.join('');
  
  return chaveUnica;
}

/**
 * Carrega todos os IDs e chaves_unicas do Supabase (paginado)
 * Esta função é usada para comparar CTOs existentes com as novas do Excel
 * 
 * @param {Object} supabaseClient - Cliente Supabase
 * @param {Function} progressCallback - Callback opcional para atualizar progresso (recebe { loaded, total, percent })
 * @returns {Promise<Map<string, string|null>>} - Map<id_cto, chave_unica>
 * @throws {Error} - Se houver erro ao carregar do Supabase
 */
async function loadExistingCTOs(supabaseClient, progressCallback = null) {
  const existingCTOs = new Map(); // Map<id_cto, chave_unica>
  let lastId = null;
  let hasMore = true;
  let batchNumber = 0;
  const startTime = Date.now();
  
  console.log('📥 [Upload] Carregando CTOs existentes do Supabase...');
  console.log('📥 [Upload] Usando paginação baseada em cursor (id_cto) para evitar timeout...');
  
  try {
    while (hasMore) {
      batchNumber++;
      
      // Buscar lote de 1000 CTOs (limite do Supabase)
      const query = supabaseClient
        .from('ctos')
        .select('id_cto, chave_unica')
        .order('id_cto', { ascending: true })
        .limit(1000);
      
      // Se já temos um lastId, buscar apenas IDs maiores
      if (lastId) {
        query.gt('id_cto', lastId);
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error(`❌ [Upload] Erro ao buscar lote ${batchNumber} do Supabase:`, error);
        throw new Error(`Erro ao carregar CTOs existentes (lote ${batchNumber}): ${error.message}`);
      }
      
      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }
      
      // Adicionar ao Map
      for (const row of data) {
        // id_cto é obrigatório, mas chave_unica pode ser NULL (para CTOs antigas)
        if (row.id_cto) {
          existingCTOs.set(String(row.id_cto), row.chave_unica || null);
        }
      }
      
      // Atualizar lastId para próxima iteração
      lastId = data[data.length - 1].id_cto;
      
      // Atualizar progresso (se callback fornecido)
      // Estimar total baseado no padrão: se retornou 1000, provavelmente há mais
      const estimatedTotal = data.length === 1000 ? existingCTOs.size * 1.2 : existingCTOs.size;
      const loadPercent = Math.min(10, Math.round((existingCTOs.size / estimatedTotal) * 10));
      
      if (progressCallback) {
        progressCallback({
          loaded: existingCTOs.size,
          total: estimatedTotal,
          percent: loadPercent,
          batchNumber: batchNumber
        });
      }
      
      // Log de progresso a cada 10 lotes ou no primeiro lote
      if (batchNumber === 1 || batchNumber % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`📥 [Upload] Lote ${batchNumber}: ${data.length} CTO(s) carregada(s) (total: ${existingCTOs.size}, tempo: ${elapsed}s)`);
      }
      
      // Se retornou menos de 1000, é o último lote
      if (data.length < 1000) {
        hasMore = false;
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ [Upload] Total de CTOs carregadas do Supabase: ${existingCTOs.size} (${batchNumber} lote(s), ${totalTime}s)`);
    
    // Estatísticas sobre chaves_unicas
    let ctosComChave = 0;
    let ctosSemChave = 0;
    for (const [id, chave] of existingCTOs) {
      if (chave) {
        ctosComChave++;
      } else {
        ctosSemChave++;
      }
    }
    
    if (ctosSemChave > 0) {
      console.log(`⚠️ [Upload] ATENÇÃO: ${ctosSemChave} CTO(s) sem chave_unica (precisam ser migradas)`);
      console.log(`ℹ️ [Upload] Execute o script SQL migrate_chave_unica.sql para calcular chaves_unicas`);
    }
    
    console.log(`📊 [Upload] Estatísticas: ${ctosComChave} com chave_unica, ${ctosSemChave} sem chave_unica`);
    
    return existingCTOs;
    
  } catch (err) {
    console.error('❌ [Upload] Erro ao carregar CTOs existentes:', err);
    throw err;
  }
}

/**
 * Deleta CTOs que saíram da base (Cenário 1)
 * CTOs que existem no Supabase mas não existem no Excel novo devem ser deletadas
 * 
 * @param {Object} supabaseClient - Cliente Supabase
 * @param {string[]} idsToDelete - Array de id_cto para deletar
 * @param {Function} progressCallback - Callback opcional para atualizar progresso (recebe { deleted, total, percent })
 * @returns {Promise<Object>} - { deleted: number } - Quantidade de CTOs deletadas
 * @throws {Error} - Se houver erro ao deletar
 */
async function deleteCTOsInBatches(supabaseClient, idsToDelete, progressCallback = null) {
  if (!idsToDelete || idsToDelete.length === 0) {
    console.log('ℹ️ [Upload] Nenhuma CTO para deletar (Cenário 1)');
    return { deleted: 0 };
  }
  
  console.log(`🗑️ [Upload] ===== DELETANDO CTOs QUE SAÍRAM DA BASE (Cenário 1) =====`);
  console.log(`🗑️ [Upload] Total de CTOs para deletar: ${idsToDelete.length}`);
  
  const DELETE_BATCH_SIZE = 1000; // Limite do Supabase para operações .in()
  let totalDeleted = 0;
  let batchNumber = 0;
  const startTime = Date.now();
  
  try {
    for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH_SIZE) {
      batchNumber++;
      const batch = idsToDelete.slice(i, i + DELETE_BATCH_SIZE);
      
      // Deletar lote usando .in() para deletar múltiplos IDs de uma vez
      const { error, count } = await supabaseClient
        .from('ctos')
        .delete()
        .in('id_cto', batch)
        .select('id_cto', { count: 'exact', head: true });
      
      if (error) {
        console.error(`❌ [Upload] Erro ao deletar lote ${batchNumber}:`, error);
        throw new Error(`Erro ao deletar CTOs (lote ${batchNumber}): ${error.message}`);
      }
      
      // count pode ser null, então usar batch.length como fallback
      const deletedInBatch = count !== null ? count : batch.length;
      totalDeleted += deletedInBatch;
      
      // Atualizar progresso (se callback fornecido)
      const progressPercent = Math.round((totalDeleted / idsToDelete.length) * 100);
      if (progressCallback) {
        progressCallback({
          deleted: totalDeleted,
          total: idsToDelete.length,
          percent: progressPercent
        });
      }
      
      // Log de progresso
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`🗑️ [Upload] Lote ${batchNumber}: ${deletedInBatch} CTO(s) deletada(s) | Total: ${totalDeleted}/${idsToDelete.length} (${progressPercent}%) | Tempo: ${elapsed}s`);
      
      // Pequeno delay entre lotes para não sobrecarregar o banco
      if (i + DELETE_BATCH_SIZE < idsToDelete.length) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms de delay
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Upload] ===== DELEÇÃO CONCLUÍDA =====`);
    console.log(`✅ [Upload] Total deletado: ${totalDeleted} CTO(s) em ${batchNumber} lote(s) (${totalTime}s)`);
    
    // Verificar se todas foram deletadas
    if (totalDeleted < idsToDelete.length) {
      const diff = idsToDelete.length - totalDeleted;
      console.warn(`⚠️ [Upload] ATENÇÃO: ${diff} CTO(s) não foram deletadas (pode ser que já não existiam no banco)`);
    }
    
    return { deleted: totalDeleted };
    
  } catch (err) {
    console.error('❌ [Upload] Erro ao deletar CTOs:', err);
    throw err;
  }
}

/**
 * Atualiza CTOs que mudaram (Cenário 3)
 * CTOs que existem no Supabase mas têm chave_unica diferente devem ser atualizadas
 * 
 * @param {Object} supabaseClient - Cliente Supabase
 * @param {Object[]} ctosToUpdate - Array de objetos CTO para atualizar (deve incluir chave_unica)
 * @param {Function} progressCallback - Callback opcional para atualizar progresso (recebe { updated, total, percent })
 * @returns {Promise<Object>} - { updated: number, errors: number } - Quantidade de CTOs atualizadas e erros
 * @throws {Error} - Se houver erro ao atualizar
 */
async function updateCTOsInBatches(supabaseClient, ctosToUpdate, progressCallback = null) {
  if (!ctosToUpdate || ctosToUpdate.length === 0) {
    console.log('ℹ️ [Upload] Nenhuma CTO para atualizar (Cenário 3)');
    return { updated: 0 };
  }
  
  console.log(`🔄 [Upload] ===== ATUALIZANDO CTOs QUE MUDARAM (Cenário 3) =====`);
  console.log(`🔄 [Upload] Total de CTOs para atualizar: ${ctosToUpdate.length}`);
  
  const UPDATE_BATCH_SIZE = 1000; // Processar em lotes de 1000
  let totalUpdated = 0;
  let totalErrors = 0;
  let batchNumber = 0;
  const startTime = Date.now();
  
  try {
    // Processar em lotes
    for (let i = 0; i < ctosToUpdate.length; i += UPDATE_BATCH_SIZE) {
      batchNumber++;
      const batch = ctosToUpdate.slice(i, i + UPDATE_BATCH_SIZE);
      
      // Supabase não suporta UPDATE em lote direto com múltiplos IDs diferentes
      // Precisamos fazer UPDATE individual ou usar uma função SQL
      // Vamos fazer UPDATE individual para cada CTO do lote
      let batchUpdated = 0;
      let batchErrors = 0;
      
      for (const cto of batch) {
        try {
          // Verificar se id_cto existe
          if (!cto.id_cto) {
            console.warn(`⚠️ [Upload] CTO sem id_cto, pulando atualização:`, cto);
            batchErrors++;
            continue;
          }
          
          // Preparar objeto de atualização (todas as colunas + chave_unica)
          const updateData = {
            cid_rede: cto.cid_rede,
            estado: cto.estado,
            pop: cto.pop,
            olt: cto.olt,
            slot: cto.slot,
            pon: cto.pon,
            cto: cto.cto,
            latitude: cto.latitude,
            longitude: cto.longitude,
            status_cto: cto.status_cto,
            data_cadastro: cto.data_cadastro,
            portas: cto.portas,
            ocupado: cto.ocupado,
            livre: cto.livre,
            pct_ocup: cto.pct_ocup,
            chave_unica: cto.chave_unica // Atualizar chave_unica também
          };
          
          // Atualizar CTO individual
          const { error } = await supabaseClient
            .from('ctos')
            .update(updateData)
            .eq('id_cto', cto.id_cto);
          
          if (error) {
            console.error(`❌ [Upload] Erro ao atualizar CTO ${cto.id_cto}:`, error.message);
            batchErrors++;
            // Continuar mesmo se uma falhar (não quebrar todo o processo)
          } else {
            batchUpdated++;
          }
        } catch (ctoErr) {
          console.error(`❌ [Upload] Erro ao processar CTO ${cto.id_cto}:`, ctoErr.message);
          batchErrors++;
        }
      }
      
      totalUpdated += batchUpdated;
      totalErrors += batchErrors;
      
      // Atualizar progresso (se callback fornecido)
      const progressPercent = Math.round((totalUpdated / ctosToUpdate.length) * 100);
      if (progressCallback) {
        progressCallback({
          updated: totalUpdated,
          total: ctosToUpdate.length,
          percent: progressPercent
        });
      }
      
      // Log de progresso
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`🔄 [Upload] Lote ${batchNumber}: ${batchUpdated} atualizada(s), ${batchErrors} erro(s) | Total: ${totalUpdated}/${ctosToUpdate.length} (${progressPercent}%) | Tempo: ${elapsed}s`);
      
      // Pequeno delay entre lotes para não sobrecarregar o banco
      if (i + UPDATE_BATCH_SIZE < ctosToUpdate.length) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms de delay
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Upload] ===== ATUALIZAÇÃO CONCLUÍDA =====`);
    console.log(`✅ [Upload] Total atualizado: ${totalUpdated} CTO(s) em ${batchNumber} lote(s) (${totalTime}s)`);
    
    if (totalErrors > 0) {
      console.warn(`⚠️ [Upload] ATENÇÃO: ${totalErrors} CTO(s) tiveram erro ao atualizar`);
    }
    
    // Verificar se todas foram atualizadas
    if (totalUpdated < ctosToUpdate.length) {
      const diff = ctosToUpdate.length - totalUpdated;
      console.warn(`⚠️ [Upload] ATENÇÃO: ${diff} CTO(s) não foram atualizadas (erros ou CTOs não encontradas)`);
    }
    
    return { updated: totalUpdated, errors: totalErrors };
    
  } catch (err) {
    console.error('❌ [Upload] Erro ao atualizar CTOs:', err);
    throw err;
  }
}

/**
 * Insere CTOs novas (Cenário 2)
 * CTOs que não existem no Supabase devem ser inseridas
 * 
 * @param {Object} supabaseClient - Cliente Supabase
 * @param {Object[]} ctosToInsert - Array de objetos CTO para inserir (deve incluir chave_unica)
 * @param {Function} progressCallback - Callback opcional para atualizar progresso (recebe { inserted, total, percent })
 * @returns {Promise<Object>} - { inserted: number } - Quantidade de CTOs inseridas
 * @throws {Error} - Se houver erro ao inserir
 */
async function insertCTOsInBatches(supabaseClient, ctosToInsert, progressCallback = null) {
  if (!ctosToInsert || ctosToInsert.length === 0) {
    console.log('ℹ️ [Upload] Nenhuma CTO nova para inserir (Cenário 2)');
    return { inserted: 0 };
  }
  
  console.log(`➕ [Upload] ===== INSERINDO CTOs NOVAS (Cenário 2) =====`);
  console.log(`➕ [Upload] Total de CTOs novas para inserir: ${ctosToInsert.length}`);
  
  // Reduzir tamanho do lote para evitar timeout do Supabase/Cloudflare
  // 1000 é mais seguro que 2500 para evitar erros 500
  const INSERT_BATCH_SIZE = 1000;
  let totalInserted = 0;
  let batchNumber = 0;
  const startTime = Date.now();
  const MAX_RETRIES = 3; // Número máximo de tentativas por lote
  
  // Função auxiliar para inserir lote com retry
  const insertBatchWithRetry = async (batch, batchNum, retryCount = 0) => {
    try {
      // Garantir que todas as CTOs do lote tenham chave_unica
      const batchWithChave = batch.map(cto => {
        if (!cto.chave_unica) {
          cto.chave_unica = generateChaveUnica(cto);
        }
        return cto;
      });
      
      // Inserir lote no Supabase
      const { error, data } = await supabaseClient
        .from('ctos')
        .insert(batchWithChave)
        .select('id_cto');
      
      if (error) {
        // Se for erro 500 (Cloudflare/Supabase) e ainda temos tentativas, retry
        if ((error.message.includes('500') || error.message.includes('timeout') || error.message.includes('Cloudflare')) && retryCount < MAX_RETRIES) {
          const waitTime = (retryCount + 1) * 2000; // 2s, 4s, 6s
          console.warn(`⚠️ [Upload] Erro temporário no lote ${batchNum} (tentativa ${retryCount + 1}/${MAX_RETRIES}). Aguardando ${waitTime}ms antes de retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return insertBatchWithRetry(batch, batchNum, retryCount + 1);
        }
        throw error;
      }
      
      return data ? data.length : batchWithChave.length;
    } catch (err) {
      // Se ainda temos tentativas e é erro temporário, retry
      if (retryCount < MAX_RETRIES && (err.message.includes('500') || err.message.includes('timeout') || err.message.includes('Cloudflare'))) {
        const waitTime = (retryCount + 1) * 2000;
        console.warn(`⚠️ [Upload] Erro temporário no lote ${batchNum} (tentativa ${retryCount + 1}/${MAX_RETRIES}). Aguardando ${waitTime}ms antes de retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return insertBatchWithRetry(batch, batchNum, retryCount + 1);
      }
      throw err;
    }
  };
  
  try {
    for (let i = 0; i < ctosToInsert.length; i += INSERT_BATCH_SIZE) {
      batchNumber++;
      const batch = ctosToInsert.slice(i, i + INSERT_BATCH_SIZE);
      
      try {
        // Inserir lote com retry automático
        const insertedInBatch = await insertBatchWithRetry(batch, batchNumber);
        totalInserted += insertedInBatch;
        
        // Atualizar progresso (se callback fornecido)
        const progressPercent = Math.round((totalInserted / ctosToInsert.length) * 100);
        if (progressCallback) {
          progressCallback({
            inserted: totalInserted,
            total: ctosToInsert.length,
            percent: progressPercent
          });
        }
        
        // Log de progresso
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`➕ [Upload] Lote ${batchNumber}: ${insertedInBatch} CTO(s) inserida(s) | Total: ${totalInserted}/${ctosToInsert.length} (${progressPercent}%) | Tempo: ${elapsed}s`);
        
        // Delay maior entre lotes para não sobrecarregar o Supabase/Cloudflare
        if (i + INSERT_BATCH_SIZE < ctosToInsert.length) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms de delay (aumentado de 100ms)
        }
      } catch (batchError) {
        // Se falhar após todas as tentativas, logar erro mas continuar com próximo lote
        console.error(`❌ [Upload] Erro ao inserir lote ${batchNumber} após ${MAX_RETRIES} tentativas:`, batchError.message);
        console.error(`❌ [Upload] Pulando lote ${batchNumber} e continuando com próximo...`);
        // Continuar com próximo lote ao invés de quebrar tudo
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgRate = totalInserted > 0 ? (totalInserted / (totalTime / 60)).toFixed(0) : 0;
    console.log(`✅ [Upload] ===== INSERÇÃO CONCLUÍDA =====`);
    console.log(`✅ [Upload] Total inserido: ${totalInserted} CTO(s) em ${batchNumber} lote(s) (${totalTime}s, média: ~${avgRate} CTOs/min)`);
    
    // Verificar se todas foram inseridas
    if (totalInserted < ctosToInsert.length) {
      const diff = ctosToInsert.length - totalInserted;
      console.warn(`⚠️ [Upload] ATENÇÃO: ${diff} CTO(s) não foram inseridas (pode ser erro de validação ou duplicatas)`);
    }
    
    return { inserted: totalInserted };
    
  } catch (err) {
    console.error('❌ [Upload] Erro ao inserir CTOs novas:', err);
    throw err;
  }
}

// Função para validar colunas do arquivo Excel
async function validateExcelColumns(filePath) {
  try {
    // Lista de colunas esperadas (mesmas que são usadas no processExcelStreaming)
    const requiredColumns = [
      'cid_rede',
      'estado',
      'pop',
      'olt',
      'slot',
      'pon',
      'id_cto',
      'cto',
      'latitude',
      'longitude',
      'status_cto',
      'data_cadastro',
      'portas',
      'ocupado',
      'livre',
      'pct_ocup'
    ];

    console.log('🔍 [Validação] Validando colunas do arquivo Excel...');
    
    // Ler apenas a primeira linha (cabeçalho) usando streaming
    const stream = fs.createReadStream(filePath);
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      worksheets: 'emit'
    });
    
    let headersFound = new Set();
    let foundFirstWorksheet = false;
    
    // Processar workbook em streaming até encontrar o cabeçalho
    for await (const worksheetReaderItem of workbookReader) {
      if (foundFirstWorksheet) break; // Só processar a primeira planilha
      foundFirstWorksheet = true;
      
      // Ler apenas a primeira linha
      for await (const row of worksheetReaderItem) {
        // Processar cabeçalho
        row.eachCell((cell, colNumber) => {
          const headerValue = cell.value ? String(cell.value).trim() : '';
          if (headerValue) {
            const normalizedKey = normalizeKey(headerValue);
            headersFound.add(normalizedKey);
          }
        });
        break; // Só precisamos da primeira linha
      }
      break; // Só precisamos da primeira planilha
    }
    
    // Verificar quais colunas estão faltando
    const missingColumns = requiredColumns.filter(col => !headersFound.has(col));
    
    if (missingColumns.length > 0) {
      console.log(`❌ [Validação] Colunas faltando: ${missingColumns.join(', ')}`);
      
      // Formatar mensagem de erro mais amigável e clara
      let errorMessage;
      if (missingColumns.length === 1) {
        errorMessage = `O arquivo está faltando a coluna obrigatória: ${missingColumns[0]}`;
      } else {
        // Formatar lista de colunas de forma mais legível
        const columnsList = missingColumns.join(', ');
        errorMessage = `O arquivo está faltando ${missingColumns.length} colunas obrigatórias: ${columnsList}. Por favor, verifique se todas as colunas necessárias estão presentes no arquivo.`;
      }
      
      return {
        valid: false,
        missingColumns: missingColumns,
        error: errorMessage
      };
    }
    
    console.log('✅ [Validação] Todas as colunas obrigatórias foram encontradas');
    return {
      valid: true,
      foundColumns: Array.from(headersFound)
    };
  } catch (err) {
    console.error('❌ [Validação] Erro ao validar colunas:', err);
    return {
      valid: false,
      error: `Erro ao validar colunas do arquivo: ${err.message}`
    };
  }
}

async function processExcelStreaming(filePath, supabaseClient, existingCTOsMap = null, progressCallback = null) {
  let totalRows = 0;
  let totalValid = 0;
  let totalInvalid = 0;
  let importedRows = 0;
  const BATCH_SIZE = 2500; // Tamanho otimizado para velocidade (Supabase suporta até 5000, mas 2500 é o ponto ideal)
  let currentBatch = [];
  let batchNumber = 0;
  let headers = {};
  let isFirstRow = true;
  const startTime = Date.now();
  
  // NOVO: Listas para os 3 cenários de atualização inteligente
  const ctosToInsert = [];  // Cenário 2: CTOs novas (não existem no Supabase)
  const ctosToUpdate = [];  // Cenário 3: CTOs atualizadas (existem mas mudaram)
  const idsInExcel = new Set(); // Para identificar CTOs deletadas (Cenário 1)
  
  // Contadores para estatísticas
  let ctosUnchanged = 0; // CTOs que não mudaram
  let ctosNew = 0; // CTOs novas
  let ctosChanged = 0; // CTOs atualizadas
  
  // Contadores detalhados de invalidação
  let invalidCoords = 0; // CTOs com coordenadas inválidas
  let invalidProcessing = 0; // CTOs com erro ao processar
  let invalidSamples = []; // Amostras de CTOs inválidas (máximo 10)
  
  // Função auxiliar para converter data
  const parseDate = (value) => {
    if (!value) return null;
    
    // Se for Date, converter para string
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    
    // Se for string, verificar formato MM/YYYY primeiro
    if (typeof value === 'string') {
      const str = value.trim();
      
      // Verificar se já está no formato MM/YYYY (ex: "04/2023")
      const mmYYYYMatch = str.match(/^(\d{1,2})\/(\d{4})$/);
      if (mmYYYYMatch) {
        const mes = mmYYYYMatch[1].padStart(2, '0');
        const ano = mmYYYYMatch[2];
        // Converter para YYYY-MM-01 (primeiro dia do mês) para armazenar no Supabase
        // Quando exibir, será convertido de volta para MM/YYYY no frontend
        return `${ano}-${mes}-01`;
      }
      
      // Tentar outros formatos de data
      const date = new Date(str);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
      
      // Se não conseguiu converter, retornar null (não armazenar data inválida)
      console.warn(`⚠️ [parseDate] Formato de data não reconhecido: "${str}"`);
      return null;
    }
    
    // Se for número, pode ser Excel serial date
    if (typeof value === 'number') {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + value * 86400000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
    
    return null;
  };
  
  // Função para inserir lote no Supabase (MODO LEGADO - usado apenas se existingCTOsMap não for fornecido)
  const insertBatch = async (batch) => {
    if (batch.length === 0) return;
    
    batchNumber++;
    const { error } = await supabaseClient
      .from('ctos')
      .insert(batch);
    
    if (error) {
      console.error(`❌ [Streaming] Erro ao importar lote ${batchNumber}:`, error);
      throw error;
    }
    
    importedRows += batch.length;
    
    // Log apenas a cada 5 lotes para não sobrecarregar (melhor performance)
    if (batchNumber % 5 === 0 || batchNumber === 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = elapsed > 0 ? (importedRows / elapsed).toFixed(0) : '0';
      console.log(`✅ [Streaming] Lote ${batchNumber}: ${batch.length} CTOs | Total: ${importedRows} | Taxa: ${rate} CTOs/s`);
    }
    
    // GC apenas a cada 20 lotes (não a cada lote para não perder velocidade)
    if (batchNumber % 20 === 0 && global.gc) {
      global.gc();
    }
  };
  
  // NOVO: Função para processar CTO com comparação inteligente
  const processCTOWithComparison = (cto) => {
    // Gerar chave_unica para esta CTO (se ainda não foi gerada)
    if (!cto.chave_unica) {
      cto.chave_unica = generateChaveUnica(cto);
    }
    const chaveUnica = cto.chave_unica;
    
    // Adicionar ID ao Set (para identificar CTOs deletadas depois - Cenário 1)
    if (cto.id_cto) {
      idsInExcel.add(String(cto.id_cto));
    }
    
    // Se não temos Map de CTOs existentes, usar modo legado (inserir tudo)
    if (!existingCTOsMap) {
      currentBatch.push(cto);
      if (currentBatch.length >= BATCH_SIZE) {
        // Não inserir aqui, apenas acumular para inserir depois
        // Isso será feito no final se não houver comparação
      }
      return;
    }
    
    // Verificar se CTO existe no Supabase
    const existingChaveUnica = existingCTOsMap.get(String(cto.id_cto));
    
    if (!existingChaveUnica && existingChaveUnica !== null) {
      // CENÁRIO 2: CTO nova (não existe no Supabase)
      ctosToInsert.push(cto);
      ctosNew++;
    } else if (existingChaveUnica !== null && existingChaveUnica !== chaveUnica) {
      // CENÁRIO 3: CTO atualizada (existe mas chave_unica mudou)
      ctosToUpdate.push(cto);
      ctosChanged++;
    } else {
      // CTO não mudou (existe e chave_unica é igual)
      ctosUnchanged++;
    }
  };
  
  try {
    console.log('📖 [Streaming] Lendo arquivo Excel em modo STREAMING REAL (sem carregar na memória)...');
    
    // Usar streaming reader do exceljs - NÃO carrega arquivo inteiro na memória
    const stream = fs.createReadStream(filePath);
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
      sharedStrings: 'cache', // Cache para melhor performance (com 4GB de memória pode usar cache)
      hyperlinks: 'ignore', // Ignorar hyperlinks
      styles: 'ignore', // Ignorar estilos
      worksheets: 'emit' // Emitir worksheets como streams
    });
    
    let worksheetReader = null;
    let processedRows = 0;
    
    // Processar workbook em streaming
    for await (const worksheetReaderItem of workbookReader) {
      worksheetReader = worksheetReaderItem;
      console.log(`📋 [Streaming] Processando planilha: ${worksheetReader.name}`);
      
      // Processar cada linha do worksheet em streaming
      for await (const row of worksheetReader) {
        // Primeira linha = cabeçalho
        if (isFirstRow) {
          isFirstRow = false;
          // Processar cabeçalho
          row.eachCell((cell, colNumber) => {
            const headerValue = cell.value ? String(cell.value).trim() : '';
            if (headerValue) {
              headers[colNumber] = normalizeKey(headerValue);
            }
          });
          console.log(`📋 [Streaming] Colunas detectadas: ${Object.keys(headers).length}`);
          continue; // Pular cabeçalho
        }
        
        // Processar linha de dados
        totalRows++;
        processedRows++;
        
        try {
          const rowData = {};
          
          // Ler apenas células com valores
          row.eachCell((cell, colNumber) => {
            if (headers[colNumber] && cell.value !== null && cell.value !== undefined) {
              rowData[headers[colNumber]] = cell.value;
            }
          });
          
          let lat = rowData.latitude;
          let lng = rowData.longitude;
          
          // Converter coordenadas
          if (typeof lat === 'string') {
            lat = lat.replace(',', '.');
            lat = parseFloat(lat);
          }
          if (typeof lng === 'string') {
            lng = lng.replace(',', '.');
            lng = parseFloat(lng);
          }
          
          const cto = {
            cid_rede: rowData.cid_rede || null,
            estado: rowData.estado || null,
            pop: rowData.pop || null,
            olt: rowData.olt || null,
            slot: rowData.slot || null,
            pon: rowData.pon || null,
            id_cto: rowData.id_cto || null,
            cto: rowData.cto || null,
            latitude: (lat && !isNaN(lat)) ? lat : null,
            longitude: (lng && !isNaN(lng)) ? lng : null,
            status_cto: rowData.status_cto || null,
            data_cadastro: parseDate(rowData.data_cadastro),
            portas: rowData.portas ? parseInt(rowData.portas) : null,
            ocupado: rowData.ocupado ? parseInt(rowData.ocupado) : null,
            livre: rowData.livre ? parseInt(rowData.livre) : null,
            pct_ocup: rowData.pct_ocup ? parseFloat(rowData.pct_ocup) : null
          };
          
          // Validar coordenadas
          if (cto.latitude && cto.longitude && 
              !isNaN(cto.latitude) && !isNaN(cto.longitude) &&
              cto.latitude >= -90 && cto.latitude <= 90 &&
              cto.longitude >= -180 && cto.longitude <= 180) {
            totalValid++;
            
            // SEMPRE gerar chave_unica (mesmo no modo legado)
            // Isso garante que todas as CTOs inseridas tenham chave_unica
            cto.chave_unica = generateChaveUnica(cto);
            
            // NOVO: Processar CTO com comparação inteligente
            if (existingCTOsMap) {
              // Modo inteligente: comparar e classificar
              processCTOWithComparison(cto);
            } else {
              // Modo legado: inserir tudo (compatibilidade)
              // chave_unica já foi gerada acima
              currentBatch.push(cto);
              
              // Inserir lote quando atingir tamanho
              if (currentBatch.length >= BATCH_SIZE) {
                await insertBatch(currentBatch);
                currentBatch = []; // Limpar batch explicitamente
              }
            }
          } else {
            // Coordenadas inválidas
            totalInvalid++;
            invalidCoords++;
            
            // Guardar amostra para log (máximo 10)
            if (invalidSamples.length < 10) {
              invalidSamples.push({
                id_cto: cto.id_cto || 'N/A',
                cto: cto.cto || 'N/A',
                motivo: 'Coordenadas inválidas',
                latitude: cto.latitude,
                longitude: cto.longitude,
                detalhes: !cto.latitude || !cto.longitude 
                  ? 'Latitude ou longitude ausente'
                  : isNaN(cto.latitude) || isNaN(cto.longitude)
                  ? 'Latitude ou longitude não é número'
                  : cto.latitude < -90 || cto.latitude > 90
                  ? `Latitude fora do range válido: ${cto.latitude}`
                  : `Longitude fora do range válido: ${cto.longitude}`
              });
            }
          }
        } catch (rowErr) {
          // Erro ao processar linha
          totalInvalid++;
          invalidProcessing++;
          
          // Guardar amostra para log (máximo 10)
          if (invalidSamples.length < 10) {
            invalidSamples.push({
              id_cto: rowData?.id_cto || 'N/A',
              cto: rowData?.cto || 'N/A',
              motivo: 'Erro ao processar linha',
              erro: rowErr.message || String(rowErr)
            });
          }
        }
        
        // Atualizar progresso a cada 5000 linhas processadas (menos frequente = menos overhead)
        // NÃO enviar uploadPercent - deixar o frontend calcular baseado em processedRows/totalRows
        if (processedRows % 5000 === 0 && progressCallback) {
          // Usar totalRows real se disponível, senão estimar conservadoramente
          // Mas NÃO enviar uploadPercent - o frontend calculará baseado no estágio
          const estimatedTotal = totalRows > 0 ? totalRows : Math.max(processedRows, processedRows * 1.2);
          progressCallback({
            processedRows,
            totalRows: estimatedTotal,
            importedRows,
            // NÃO enviar uploadPercent - será calculado pelo frontend: 5% + (processedRows/totalRows * 75%)
            message: `Processando arquivo... ${processedRows}${totalRows > 0 ? `/${totalRows}` : ''} linhas`
          });
        }
        
        // Log de progresso a cada 20000 linhas (menos frequente = mais rápido)
        if (processedRows % 20000 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const memUsage = process.memoryUsage();
          const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
          console.log(`📊 [Streaming] ${processedRows} linhas processadas | ${importedRows} importadas | ${memMB}MB | ${elapsed}s`);
        }
      }
    }
    
    // Inserir lote restante (apenas no modo legado)
    if (!existingCTOsMap && currentBatch.length > 0) {
      await insertBatch(currentBatch);
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgRate = totalRows > 0 ? (importedRows / (totalTime / 60)).toFixed(0) : 0;
    
    // Logs diferentes dependendo do modo
    if (existingCTOsMap) {
      // Modo inteligente: mostrar estatísticas de comparação
      console.log(`📊 [Streaming] Processamento concluído: ${totalRows} linhas, ${totalValid} válidas, ${totalInvalid} inválidas`);
      console.log(`📊 [Streaming] Análise de mudanças:`);
      console.log(`   ➕ CTOs novas: ${ctosNew}`);
      console.log(`   🔄 CTOs atualizadas: ${ctosChanged}`);
      console.log(`   ✅ CTOs não alteradas: ${ctosUnchanged}`);
      console.log(`   📋 Total de IDs no Excel: ${idsInExcel.size}`);
      
      // Detalhes de CTOs inválidas
      if (totalInvalid > 0) {
        console.log(`📊 [Streaming] Detalhes de CTOs inválidas:`);
        console.log(`   🗺️ Coordenadas inválidas: ${invalidCoords}`);
        console.log(`   ⚠️ Erros ao processar: ${invalidProcessing}`);
        
        if (invalidSamples.length > 0) {
          console.log(`📋 [Streaming] Amostra de CTOs inválidas (${invalidSamples.length} de ${totalInvalid}):`);
          invalidSamples.forEach((sample, idx) => {
            console.log(`   ${idx + 1}. ID: ${sample.id_cto}, CTO: ${sample.cto}`);
            console.log(`      Motivo: ${sample.motivo}`);
            if (sample.detalhes) {
              console.log(`      Detalhes: ${sample.detalhes}`);
            }
            if (sample.erro) {
              console.log(`      Erro: ${sample.erro}`);
            }
          });
        }
      }
      
      // Atualizar progresso final (NÃO enviar uploadPercent - frontend calculará)
      if (progressCallback) {
        progressCallback({
          processedRows: totalRows,
          totalRows: totalRows,
          importedRows: ctosNew + ctosChanged, // Total que precisa ser processado
          // NÃO enviar uploadPercent - será calculado pelo frontend como 80% (fim do processamento)
          message: 'Análise concluída! Identificadas mudanças.'
        });
      }
      
      return {
        totalRows,
        validRows: totalValid,
        invalidRows: totalInvalid,
        importedRows: ctosNew + ctosChanged, // Total que precisa ser processado
        ctosToInsert,    // NOVO: Lista de CTOs novas
        ctosToUpdate,    // NOVO: Lista de CTOs atualizadas
        idsInExcel,      // NOVO: Set de IDs no Excel (para identificar deletadas)
        ctosUnchanged    // NOVO: Quantidade de CTOs não alteradas
      };
    } else {
      // Modo legado: comportamento original
      console.log(`📊 [Streaming] Processamento concluído: ${totalRows} linhas, ${totalValid} válidas, ${totalInvalid} inválidas`);
      console.log(`✅ [Streaming] ${importedRows} CTOs importadas no Supabase em ${totalTime}s (média: ~${avgRate} CTOs/min)`);
      
      // Detalhes de CTOs inválidas
      if (totalInvalid > 0) {
        console.log(`📊 [Streaming] Detalhes de CTOs inválidas:`);
        console.log(`   🗺️ Coordenadas inválidas: ${invalidCoords}`);
        console.log(`   ⚠️ Erros ao processar: ${invalidProcessing}`);
        
        if (invalidSamples.length > 0) {
          console.log(`📋 [Streaming] Amostra de CTOs inválidas (${invalidSamples.length} de ${totalInvalid}):`);
          invalidSamples.forEach((sample, idx) => {
            console.log(`   ${idx + 1}. ID: ${sample.id_cto}, CTO: ${sample.cto}`);
            console.log(`      Motivo: ${sample.motivo}`);
            if (sample.detalhes) {
              console.log(`      Detalhes: ${sample.detalhes}`);
            }
            if (sample.erro) {
              console.log(`      Erro: ${sample.erro}`);
            }
          });
        }
      }
      
      // Atualizar progresso final (NÃO enviar uploadPercent - frontend calculará)
      if (progressCallback) {
        progressCallback({
          processedRows: totalRows,
          totalRows: totalRows,
          importedRows,
          // NÃO enviar uploadPercent - será calculado pelo frontend
          message: 'Base de dados carregada!'
        });
      }
      
      return {
        totalRows,
        validRows: totalValid,
        invalidRows: totalInvalid,
        importedRows
      };
    }
  } catch (err) {
    console.error('❌ [Streaming] Erro ao processar Excel:', err);
    throw err;
  }
}

// Validação ultra-leve: apenas verifica se é um arquivo Excel válido
// A validação detalhada será feita durante o processamento em streaming
function validateExcelStructure(filePathOrBuffer) {
  try {
    const isFilePath = typeof filePathOrBuffer === 'string';
    
    // Para arquivos muito grandes, fazer apenas validação básica
    // Verificar se o arquivo existe (se for caminho)
    if (isFilePath && !fs.existsSync(filePathOrBuffer)) {
      return { valid: false, error: 'Arquivo não encontrado' };
    }
    
    // Verificar extensão do arquivo (se for caminho)
    if (isFilePath && !filePathOrBuffer.match(/\.(xlsx|xls)$/i)) {
      return { valid: false, error: 'Arquivo deve ter extensão .xlsx ou .xls' };
    }
    
    // Para arquivos grandes, apenas verificar se é um Excel válido usando exceljs (mais eficiente)
    // Não carregar tudo na memória
    return {
      valid: true,
      totalRows: 0, // Será calculado durante processamento
      validRows: 0,
      invalidRows: 0
    };
  } catch (err) {
    return {
      valid: false,
      error: `Erro ao validar arquivo: ${err.message}`
    };
  }
}

// Rota GET para /api/upload-base (retorna erro informativo)
app.get('/api/upload-base', (req, res) => {
  console.log('⚠️ [Upload] Requisição GET recebida em /api/upload-base (deveria ser POST)');
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(405).json({
    success: false,
    error: 'Método não permitido. Use POST para fazer upload de arquivos.',
    method: req.method,
    allowedMethods: ['POST']
  });
});

// Rota para upload e atualização da base de dados
app.post('/api/upload-base', (req, res, next) => {
  console.log('📥 [Upload] Requisição POST recebida para upload de base de dados');
  console.log('📥 [Upload] Método:', req.method);
  console.log('📥 [Upload] Origin:', req.headers.origin);
  console.log('📥 [Upload] Content-Type:', req.headers['content-type']);
  console.log('📥 [Upload] Path:', req.path);
  console.log('📥 [Upload] URL completa:', req.url);
  
  // Garantir headers CORS ANTES de qualquer processamento
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  // Configurar timeout maior para uploads grandes (2 minutos = 120 segundos)
  // Railway tem timeout de gateway de ~30s, mas precisamos tempo para receber arquivo grande
  req.setTimeout(2 * 60 * 1000); // 2 minutos para receber o arquivo
  res.setTimeout(2 * 60 * 1000); // 2 minutos para enviar resposta
  
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('❌ Erro no multer:', err);
      console.error('❌ Código do erro:', err.code);
      console.error('❌ Mensagem do erro:', err.message);
      
      let errorMessage = err.message;
      
      // Melhorar mensagem de erro para arquivo muito grande
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxSizeMB = 100;
        errorMessage = `Arquivo muito grande. O tamanho máximo permitido é ${maxSizeMB}MB. Seu arquivo excede esse limite.`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        errorMessage = 'Nome do campo do arquivo incorreto. Use "file" como nome do campo.';
      }
      
      // Garantir headers CORS na resposta de erro
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      
      return res.status(400).json({
        success: false,
        error: errorMessage,
        errorCode: err.code
      });
    }
    next();
  });
}, async (req, res) => {
  // Obter origin novamente para garantir que está disponível
  const origin = req.headers.origin;
  
  try {
    if (!req.file) {
      // Garantir headers CORS
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      
      return res.status(400).json({ 
        success: false, 
        error: 'Nenhum arquivo foi enviado' 
      });
    }

    // Verificar se é um arquivo Excel
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    
    if (!allowedMimes.includes(req.file.mimetype) && !req.file.originalname.match(/\.(xlsx|xls)$/i)) {
      // Garantir headers CORS
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      
      return res.status(400).json({
        success: false,
        error: 'Formato de arquivo inválido. Apenas arquivos Excel (.xlsx ou .xls) são aceitos.'
      });
    }

    // Obter informações do arquivo
    const tempFilePath = req.file.path;
    const fileSize = req.file.size;
    const fileName = req.file.originalname;
    
    console.log(`📤 Arquivo recebido: ${fileName} (${fileSize} bytes)`);
    console.log(`📋 Tipo MIME: ${req.file.mimetype}`);
    console.log(`💾 Arquivo salvo temporariamente em: ${tempFilePath}`);

    // Garantir headers CORS na resposta ANTES de qualquer processamento
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Inicializar progresso ANTES de validar (começar do zero)
    uploadProgress = {
      stage: 'idle', // Começar como 'idle' para garantir que frontend mostre 0%
      uploadPercent: 0,
      calculationPercent: 0,
      message: 'Validando colunas do arquivo...',
      totalRows: 0,
      processedRows: 0,
      importedRows: 0,
      calculationId: null,
      totalCTOs: 0,
      processedCTOs: 0
    };
    
    // Criar promise para controlar quando upload termina (ANTES da validação)
    let resolveUpload;
    uploadPromise = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    uploadInProgress = true;
    console.log('⏸️ [Upload] Flag de upload ativada - requisições /api/users/online serão pausadas');
    
    // RESPONDER IMEDIATAMENTE para evitar timeout do Railway
    // Processar validação e processamento em background
    res.json({
      success: true,
      message: `Upload recebido! Validando e processando arquivo em background...`,
      processing: true,
      fileSize: fileSize,
      fileName: fileName
    });
    
    console.log(`💾 [Upload] Arquivo salvo temporariamente em: ${tempFilePath} (${fileSize} bytes)`);
    
    // Validar colunas do arquivo ANTES de processar (0% a 5%)
    console.log('🔍 [Upload] Validando colunas do arquivo...');
    uploadProgress.message = 'Validando colunas do arquivo...';
    uploadProgress.uploadPercent = 0;
    
    // Simular progresso durante validação (0% a 5%)
    const validationStartTime = Date.now();
    const validationProgressInterval = setInterval(() => {
      const elapsed = Date.now() - validationStartTime;
      // Estimar progresso baseado no tempo (máximo 5% durante validação)
      const estimatedProgress = Math.min(5, Math.round((elapsed / 2000) * 5)); // Assume validação leva ~2s
      uploadProgress.uploadPercent = estimatedProgress;
    }, 100); // Atualizar a cada 100ms para progresso suave
    
    const validationResult = await validateExcelColumns(tempFilePath);
    clearInterval(validationProgressInterval);
    
    if (!validationResult.valid) {
      // Deletar arquivo temporário em caso de erro de validação
      try {
        await fsPromises.unlink(tempFilePath);
        console.log('🗑️ [Upload] Arquivo temporário removido após erro de validação');
      } catch (unlinkErr) {
        console.warn('⚠️ [Upload] Erro ao remover arquivo temporário:', unlinkErr.message);
      }
      
      // Atualizar progresso com erro
      uploadProgress.stage = 'error';
      uploadProgress.message = validationResult.error || 'Erro ao validar colunas do arquivo';
      uploadProgress.uploadPercent = 0;
      uploadInProgress = false;
      if (resolveUpload) resolveUpload();
      
      return; // Já respondemos, então apenas retornar
    }
    
    console.log('✅ [Upload] Validação de colunas concluída com sucesso');
    uploadProgress.uploadPercent = 5; // Validação completa (5%)
    uploadProgress.message = 'Validação concluída. Carregando CTOs existentes...';
    
    (async () => {
      let tempFileDeleted = false;
      try {
        console.log('🔍 [Background] Iniciando processamento do arquivo...');
        console.log('ℹ️ [Background] Validação será feita durante processamento em chunks (economiza memória)');

    // Obter data atual para nomear arquivos
    const now = new Date();
    const dateStr = formatDateForFilename(now);
    
        // Tentar importar para Supabase ANTES de salvar arquivo Excel
        let supabaseImported = false;
        let importedRows = 0;
        let totalRows = 0;
        if (supabase && isSupabaseAvailable()) {
          try {
            console.log('📤 [Background] ===== INICIANDO IMPORTAÇÃO SUPABASE =====');
            console.log('📤 [Background] Usando processamento em STREAMING (exceljs) para arquivos grandes...');
            
            // NOVO FLUXO: Carregar CTOs existentes para comparação inteligente
            // POLÍGONOS NÃO SÃO TRATADOS AQUI - apenas no botão "Criar Nova Mancha de Cobertura"
            uploadProgress.stage = 'idle'; // Manter como 'idle' durante carregamento
            uploadProgress.uploadPercent = 5; // Já estamos em 5% (validação completa)
            uploadProgress.processedRows = 0;
            uploadProgress.totalRows = 0;
            uploadProgress.message = 'Carregando CTOs existentes para comparação inteligente...';
            console.log('📥 [Background] ===== INICIANDO ATUALIZAÇÃO INTELIGENTE =====');
            console.log('📥 [Background] Carregando CTOs existentes do Supabase para comparação...');
            
            // Carregar CTOs existentes (IDs e chaves_unicas)
            // Callback para atualizar progresso durante carregamento (mantém em 5% - validação já completa)
            const loadProgressCallback = (progress) => {
              // Manter em 5% durante carregamento (validação já completou 5%)
              uploadProgress.uploadPercent = 5;
              uploadProgress.message = `Carregando CTOs existentes... ${progress.loaded} CTO(s)`;
            };
            
            const existingCTOsMap = await loadExistingCTOs(supabase, loadProgressCallback);
            console.log(`✅ [Background] CTOs existentes carregadas: ${existingCTOsMap.size}`);
            
            // Atualizar progresso após carregamento completo (ainda em 5%, próximo passo é processar Excel)
            uploadProgress.uploadPercent = 5;
            uploadProgress.message = 'CTOs existentes carregadas. Processando arquivo...';
            
            // Processar Excel com comparação inteligente
            uploadProgress.message = 'Processando arquivo e comparando com base existente...';
            uploadProgress.stage = 'processing';
            
            // Callback para atualizar progresso
            // NÃO usar uploadPercent do processExcelStreaming (está em escala 0-100% do Excel, não do total)
            // O frontend calculará o percentual total baseado em processedRows/totalRows
            const progressCallback = (progress) => {
              uploadProgress.processedRows = progress.processedRows;
              uploadProgress.totalRows = progress.totalRows;
              uploadProgress.importedRows = progress.importedRows;
              // NÃO definir uploadPercent aqui - deixar o frontend calcular baseado em processedRows/totalRows
              // uploadProgress.uploadPercent será calculado pelo frontend: 5% + (processedRows/totalRows * 75%)
              uploadProgress.message = progress.message || `Processando arquivo... ${progress.processedRows}/${progress.totalRows} linhas`;
            };
            
            // Processar Excel com comparação (passar existingCTOsMap)
            const result = await processExcelStreaming(tempFilePath, supabase, existingCTOsMap, progressCallback);
            totalRows = result.totalRows;
            
            // Garantir que ao final do processamento, o percentual seja 80%
            uploadProgress.processedRows = totalRows;
            uploadProgress.totalRows = totalRows;
            uploadProgress.uploadPercent = 80; // Fim do estágio de processamento (5-80%)
            
            // NOVO: Identificar CTOs deletadas (Cenário 1)
            // CTOs que existem no Supabase mas não existem no Excel
            uploadProgress.message = 'Identificando CTOs que saíram da base...';
            const idsToDelete = [];
            for (const [idCto, chaveUnica] of existingCTOsMap) {
              if (!result.idsInExcel.has(idCto)) {
                // ID existe no Supabase mas não no Excel → deletar
                idsToDelete.push(idCto);
              }
            }
            
            console.log('📊 [Background] ===== ANÁLISE DE MUDANÇAS CONCLUÍDA =====');
            console.log(`📊 [Background] Total de linhas no Excel: ${result.totalRows}`);
            console.log(`📊 [Background] CTOs válidas: ${result.validRows}`);
            console.log(`📊 [Background] CTOs inválidas: ${result.invalidRows}`);
            console.log(`📊 [Background] CTOs novas (Cenário 2): ${result.ctosToInsert.length}`);
            console.log(`📊 [Background] CTOs atualizadas (Cenário 3): ${result.ctosToUpdate.length}`);
            console.log(`📊 [Background] CTOs deletadas (Cenário 1): ${idsToDelete.length}`);
            console.log(`📊 [Background] CTOs não alteradas: ${result.ctosUnchanged}`);
            
            // POLÍGONOS NÃO SÃO TRATADOS AQUI
            // Polígonos são tratados apenas no botão "Criar Nova Mancha de Cobertura"
            // O usuário deve recalcular os polígonos manualmente após atualizar a base
            
            // NOVO: Executar os 3 cenários
            let deleteResult = { deleted: 0 };
            let updateResult = { updated: 0, errors: 0 };
            let insertResult = { inserted: 0 };
            
            // Cenário 1: DELETAR CTOs que saíram
            if (idsToDelete.length > 0) {
              uploadProgress.message = `Deletando ${idsToDelete.length} CTO(s) que saíram da base...`;
              uploadProgress.stage = 'deleting';
              uploadProgress.uploadPercent = 80; // Início do estágio de deleção
              uploadProgress.processedRows = 0; // Reset para novo estágio
              uploadProgress.totalRows = idsToDelete.length; // Total de CTOs a deletar
              
              // Callback para atualizar progresso durante deleção
              const deleteProgressCallback = (progress) => {
                uploadProgress.processedRows = progress.deleted;
                uploadProgress.totalRows = progress.total;
                uploadProgress.uploadPercent = 80 + Math.round((progress.percent / 100) * 5); // 80% a 85%
                // NÃO incluir percentual na mensagem - o frontend calculará e mostrará o percentual total
                uploadProgress.message = `Deletando ${idsToDelete.length} CTO(s) que saíram da base...`;
              };
              
              deleteResult = await deleteCTOsInBatches(supabase, idsToDelete, deleteProgressCallback);
              uploadProgress.uploadPercent = 85; // Fim do estágio de deleção
              uploadProgress.processedRows = idsToDelete.length; // Garantir que está completo
            }
            
            // Cenário 2: INSERIR CTOs novas
            if (result.ctosToInsert.length > 0) {
              uploadProgress.message = `Inserindo ${result.ctosToInsert.length} CTO(s) nova(s)...`;
              uploadProgress.stage = 'inserting';
              uploadProgress.uploadPercent = 85; // Início do estágio de inserção
              uploadProgress.processedRows = 0; // Reset para novo estágio
              uploadProgress.totalRows = result.ctosToInsert.length; // Total de CTOs a inserir
              
              // Callback para atualizar progresso durante inserção
              const insertProgressCallback = (progress) => {
                uploadProgress.processedRows = progress.inserted;
                uploadProgress.totalRows = progress.total;
                uploadProgress.uploadPercent = 85 + Math.round((progress.percent / 100) * 5); // 85% a 90%
                // NÃO incluir percentual na mensagem - o frontend calculará e mostrará o percentual total
                uploadProgress.message = `Inserindo ${result.ctosToInsert.length} CTO(s) nova(s)...`;
              };
              
              insertResult = await insertCTOsInBatches(supabase, result.ctosToInsert, insertProgressCallback);
              uploadProgress.uploadPercent = 90; // Fim do estágio de inserção
              uploadProgress.processedRows = result.ctosToInsert.length; // Garantir que está completo
            }
            
            // Cenário 3: ATUALIZAR CTOs que mudaram
            if (result.ctosToUpdate.length > 0) {
              uploadProgress.message = `Atualizando ${result.ctosToUpdate.length} CTO(s) que mudaram...`;
              uploadProgress.stage = 'updating';
              uploadProgress.uploadPercent = 90; // Início do estágio de atualização
              uploadProgress.processedRows = 0; // Reset para novo estágio
              uploadProgress.totalRows = result.ctosToUpdate.length; // Total de CTOs a atualizar
              
              // Callback para atualizar progresso durante atualização
              const updateProgressCallback = (progress) => {
                uploadProgress.processedRows = progress.updated;
                uploadProgress.totalRows = progress.total;
                uploadProgress.uploadPercent = 90 + Math.round((progress.percent / 100) * 5); // 90% a 95%
                // NÃO incluir percentual na mensagem - o frontend calculará e mostrará o percentual total
                uploadProgress.message = `Atualizando ${result.ctosToUpdate.length} CTO(s) que mudaram...`;
              };
              
              updateResult = await updateCTOsInBatches(supabase, result.ctosToUpdate, updateProgressCallback);
              uploadProgress.uploadPercent = 95; // Fim do estágio de atualização
              uploadProgress.processedRows = result.ctosToUpdate.length; // Garantir que está completo
            }
            
            // Calcular total processado
            importedRows = deleteResult.deleted + insertResult.inserted + updateResult.updated;
            
            // Log resumo final
            console.log('📊 [Background] ===== RESUMO DA ATUALIZAÇÃO INTELIGENTE =====');
            console.log(`📊 [Background] Total de linhas processadas: ${totalRows}`);
            console.log(`📊 [Background] CTOs válidas: ${result.validRows}`);
            console.log(`📊 [Background] CTOs inválidas: ${result.invalidRows}`);
            console.log(`➕ [Background] CTOs novas inseridas: ${insertResult.inserted}`);
            console.log(`🔄 [Background] CTOs atualizadas: ${updateResult.updated} (${updateResult.errors} erro(s))`);
            console.log(`🗑️ [Background] CTOs deletadas: ${deleteResult.deleted}`);
            console.log(`✅ [Background] CTOs não alteradas: ${result.ctosUnchanged}`);
            console.log(`📊 [Background] Total de operações: ${importedRows} (${insertResult.inserted} inserções + ${updateResult.updated} atualizações + ${deleteResult.deleted} deleções)`);
            console.log('📊 [Background] ===========================================');
            
            // Atualizar progresso final do upload
            uploadProgress.stage = 'completed';
            uploadProgress.uploadPercent = 100;
            uploadProgress.processedRows = totalRows;
            uploadProgress.totalRows = totalRows;
            uploadProgress.importedRows = importedRows;
            uploadProgress.totalCTOs = importedRows;
            uploadProgress.message = 'Base de dados atualizada com sucesso!';
            
            // Registrar no histórico de uploads
            if (importedRows > 0 || idsToDelete.length > 0 || result.ctosToUpdate.length > 0) {
              supabaseImported = true;
              
              try {
                const { error: historyError } = await supabase
                  .from('upload_history')
                  .insert([{
                    file_name: fileName,
                    file_size: fileSize,
                    total_rows: totalRows,
                    valid_rows: result.validRows,
                    uploaded_by: req.body?.usuario || req.user?.nome || 'Sistema'
                  }]);
                
                if (historyError) {
                  console.warn('⚠️ [Background] Erro ao registrar histórico (não crítico):', historyError);
                } else {
                  console.log('✅ [Background] Histórico de upload registrado');
                }
              } catch (historyErr) {
                console.warn('⚠️ [Background] Erro ao registrar histórico (não crítico):', historyErr.message);
              }
              
              // CÁLCULO AUTOMÁTICO REMOVIDO - Agora é feito manualmente via botão "Criar Nova Mancha de Cobertura"
              console.log(`✅ [Background] ===== ATUALIZAÇÃO INTELIGENTE CONCLUÍDA =====`);
              console.log(`✅ [Background] Operações realizadas: ${importedRows} (${insertResult.inserted} inserções + ${updateResult.updated} atualizações + ${deleteResult.deleted} deleções)`);
            } else {
              console.warn('⚠️ [Background] Nenhuma mudança detectada na base de dados');
              console.warn(`⚠️ [Background] Total de linhas: ${totalRows}, Válidas: ${result.validRows}, Inválidas: ${result.invalidRows}`);
            }
          } catch (supabaseErr) {
            console.error('❌ [Background] ===== ERRO NA IMPORTAÇÃO SUPABASE =====');
            console.error('❌ [Background] Erro ao importar para Supabase:', supabaseErr.message);
            console.error('❌ [Background] Tipo do erro:', supabaseErr.name);
            console.error('❌ [Background] Stack:', supabaseErr.stack);
            if (supabaseErr.details) {
              console.error('❌ [Background] Detalhes:', supabaseErr.details);
            }
            if (supabaseErr.hint) {
              console.error('❌ [Background] Dica:', supabaseErr.hint);
            }
            console.error('❌ [Background] Continuando com salvamento Excel (fallback)...');
            // Continuar com salvamento Excel (não quebrar o fluxo)
          }
        } else {
          console.log('⚠️ [Background] Supabase não disponível, pulando importação');
        }
        
        // Processar operações de arquivo de forma sequencial e segura
        console.log('📂 [Background] Procurando arquivos existentes...');
        
        // 1. Encontrar TODAS as bases antigas (base_atual_*.xlsx)
        const allFiles = await fsPromises.readdir(DATA_DIR);
        const allBaseAtualFiles = allFiles.filter(file => 
          file.startsWith('base_atual_') && file.endsWith('.xlsx')
        );
        
        console.log(`📋 [Background] Encontradas ${allBaseAtualFiles.length} base(s) antiga(s) para substituir`);
        
        // 2. Encontrar a base atual mais recente (se existir) para fazer backup
        const currentBasePath = await findCurrentBaseFile();
        
        // 3. Se existe base atual, criar backup ANTES de deletar
    if (currentBasePath) {
      const backupFileName = `backup_${dateStr}.xlsx`;
      const newBackupPath = path.join(DATA_DIR, backupFileName);
          
          // Criar backup da base atual (renomear ou copiar)
          try {
            await fsPromises.rename(currentBasePath, newBackupPath);
            console.log(`💾 [Background] Base atual movida para backup: ${backupFileName}`);
          } catch (err) {
            console.warn('⚠️ [Background] Erro ao renomear, tentando copiar...', err.message);
            try {
              await fsPromises.copyFile(currentBasePath, newBackupPath);
              console.log(`💾 [Background] Backup criado por cópia: ${backupFileName}`);
            } catch (copyErr) {
              console.error('❌ [Background] Erro ao copiar para backup:', copyErr);
              // Continuar mesmo se backup falhar
            }
          }
        }
        
        // 5. DELETAR TODAS as bases antigas (base_atual_*.xlsx)
        // Isso garante que não fiquem múltiplas bases antigas
        // IMPORTANTE: Não deletar a base atual se ela ainda existir (caso backup foi feito por cópia)
        for (const oldFile of allBaseAtualFiles) {
          const oldFilePath = path.join(DATA_DIR, oldFile);
          
          // Se esta é a base atual e ainda existe (backup foi feito por cópia), pular
          if (currentBasePath && oldFilePath === currentBasePath && fs.existsSync(currentBasePath)) {
            console.log(`⏭️ [Background] Pulando base atual (já tem backup): ${oldFile}`);
            continue;
          }
          
          try {
            await fsPromises.unlink(oldFilePath);
            console.log(`🗑️ [Background] Base antiga removida: ${oldFile}`);
          } catch (err) {
            console.error(`❌ [Background] Erro ao remover base antiga ${oldFile}:`, err.message);
            // Continuar mesmo se uma falhar
          }
        }
        
        // Se a base atual ainda existe após backup (foi copiada, não renomeada), deletá-la agora
        if (currentBasePath && fs.existsSync(currentBasePath)) {
          try {
            await fsPromises.unlink(currentBasePath);
            console.log(`🗑️ [Background] Base atual original removida após backup: ${path.basename(currentBasePath)}`);
          } catch (err) {
            console.error(`❌ [Background] Erro ao remover base atual original:`, err.message);
            // Continuar mesmo se falhar
          }
        }
        
        // 6. Limpar backups antigos (manter apenas os 3 mais recentes)
        const allBackupFiles = allFiles.filter(file => 
          file.startsWith('backup_') && file.endsWith('.xlsx')
        );
        
        if (allBackupFiles.length > 3) {
          // Obter stats de todos os backups
          const backupFilesWithStats = await Promise.all(
            allBackupFiles.map(async (file) => {
              const filePath = path.join(DATA_DIR, file);
              const stats = await fsPromises.stat(filePath);
              return {
                name: file,
                path: filePath,
                mtime: stats.mtime
              };
            })
          );
          
          // Ordenar por data (mais recente primeiro)
          backupFilesWithStats.sort((a, b) => b.mtime - a.mtime);
          
          // Deletar backups antigos (manter apenas os 3 mais recentes)
          const backupsToDelete = backupFilesWithStats.slice(3);
          for (const backup of backupsToDelete) {
            try {
              await fsPromises.unlink(backup.path);
              console.log(`🗑️ [Background] Backup antigo removido: ${backup.name}`);
            } catch (err) {
              console.error(`❌ [Background] Erro ao remover backup antigo ${backup.name}:`, err.message);
            }
          }
        }
        
        // 7. Salvar NOVA base como base_atual_DD-MM-YYYY.xlsx
        // OTIMIZAÇÃO: Mover arquivo temporário em vez de copiar (mais rápido e usa menos memória)
    const newBaseFileName = `base_atual_${dateStr}.xlsx`;
    const newBasePath = path.join(DATA_DIR, newBaseFileName);
    
        console.log(`💾 [Background] Movendo arquivo temporário para: ${newBaseFileName} (${fileSize} bytes)`);
        
        // Mover arquivo temporário para a localização final (mais eficiente que copiar)
        try {
          await fsPromises.rename(tempFilePath, newBasePath);
          tempFileDeleted = true; // Arquivo foi movido, não precisa deletar
          console.log(`✅ [Background] Arquivo movido com sucesso (sem usar memória extra)`);
        } catch (renameErr) {
          // Se renomear falhar (pode ser por estar em volumes diferentes), copiar
          console.warn('⚠️ [Background] Erro ao renomear, copiando arquivo...', renameErr.message);
          await fsPromises.copyFile(tempFilePath, newBasePath);
          // Deletar arquivo temporário após copiar
          await fsPromises.unlink(tempFilePath);
          tempFileDeleted = true;
          console.log(`✅ [Background] Arquivo copiado e temporário removido`);
        }
        
        console.log(`✅ [Background] Nova base de dados salva com sucesso: ${newBaseFileName}`);
        console.log(`✅ [Background] Processamento concluído`);
        if (supabaseImported) {
          console.log(`✅ [Background] ${importedRows} CTOs importadas no Supabase`);
        } else {
          console.log(`⚠️ [Background] Importação Supabase não realizada (usando apenas Excel)`);
        }
        console.log(`✅ [Background] Base antiga substituída - sistema agora usa: ${newBaseFileName}`);
      } catch (err) {
        console.error('❌ [Background] Erro ao processar arquivo em background:', err);
        console.error('❌ [Background] Stack:', err.stack);
        
        // Garantir que arquivo temporário seja deletado mesmo em caso de erro
        if (!tempFileDeleted && tempFilePath) {
          try {
            await fsPromises.unlink(tempFilePath);
            console.log('🗑️ [Background] Arquivo temporário removido após erro');
          } catch (unlinkErr) {
            console.error('❌ [Background] Erro ao remover arquivo temporário após erro:', unlinkErr);
          }
        }
        // Não podemos retornar erro ao cliente (já respondemos), apenas logar
      } finally {
        // Sempre liberar flag e resolver promise quando upload terminar
        uploadInProgress = false;
        if (resolveUpload) {
          resolveUpload();
          console.log('✅ [Upload] Flag de upload desativada - requisições /api/users/online retomadas');
        }
        uploadPromise = null;
      }
    })();
  } catch (err) {
    console.error('❌ Erro ao fazer upload da base de dados:', err);
    console.error('❌ Stack trace:', err.stack);
    
    // Garantir headers CORS mesmo em caso de erro
    const errorOrigin = req.headers.origin;
    if (errorOrigin) {
      res.setHeader('Access-Control-Allow-Origin', errorOrigin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Garantir que sempre retorna JSON
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: `Erro ao processar arquivo: ${err.message || 'Erro desconhecido'}`
      });
    }
  }
});

// Rota para listar tabulações
app.get('/api/tabulacoes', async (req, res) => {
  try {
    const tabulacoes = await readTabulacoes();
    res.json({ success: true, tabulacoes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para adicionar tabulação
app.post('/api/tabulacoes', async (req, res) => {
  try {
    const { nome } = req.body;
    
    if (!nome || !nome.trim()) {
      return res.status(400).json({ success: false, error: 'Nome da tabulação é obrigatório' });
    }
    
    const nomeLimpo = nome.trim();
    
    // Tentar adicionar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Verificar se já existe
        const { data: existing } = await supabase
          .from('tabulacoes')
          .select('nome')
          .ilike('nome', nomeLimpo)
          .limit(1);
        
        if (existing && existing.length > 0) {
          const tabulacoes = await readTabulacoes();
          return res.json({ success: true, tabulacoes, message: 'Tabulação já existe' });
        }
        
        // Inserir no Supabase
        const { error } = await supabase
          .from('tabulacoes')
          .insert([{ nome: nomeLimpo }]);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Tabulação '${nomeLimpo}' adicionada no Supabase`);
        
        // Buscar todas para retornar
        const tabulacoes = await readTabulacoes();
        
        return res.json({ success: true, tabulacoes, message: 'Tabulação adicionada com sucesso' });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao adicionar tabulação, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let tabulacoes = await readTabulacoes();
    
    // Verificar se já existe
    if (tabulacoes.includes(nomeLimpo)) {
      return res.json({ success: true, tabulacoes, message: 'Tabulação já existe' });
    }
    
    // Adicionar nova tabulação
    tabulacoes.push(nomeLimpo);
    tabulacoes.sort(); // Ordenar alfabeticamente
    
    // Salvar
    await saveTabulacoes(tabulacoes);
    
    res.json({ success: true, tabulacoes, message: 'Tabulação adicionada com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para deletar tabulação
app.delete('/api/tabulacoes/:nome', async (req, res) => {
  try {
    const nome = decodeURIComponent(req.params.nome);
    
    if (!nome || !nome.trim()) {
      return res.status(400).json({ success: false, error: 'Nome da tabulação é obrigatório' });
    }
    
    const nomeLimpo = nome.trim();
    
    // Tentar deletar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Buscar tabulação para verificar se existe
        const { data: existing } = await supabase
          .from('tabulacoes')
          .select('nome')
          .ilike('nome', nomeLimpo)
          .limit(1);
        
        if (!existing || existing.length === 0) {
          return res.status(404).json({ success: false, error: 'Tabulação não encontrada' });
        }
        
        // Deletar do Supabase
        const { error } = await supabase
          .from('tabulacoes')
          .delete()
          .ilike('nome', nomeLimpo);
        
        if (error) {
          throw error;
        }
        
        console.log(`✅ [Supabase] Tabulação '${nomeLimpo}' deletada do Supabase`);
        
        // Buscar todas para retornar
        const tabulacoes = await readTabulacoes();
        
        return res.json({ success: true, tabulacoes, message: 'Tabulação deletada com sucesso' });
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao deletar tabulação, usando fallback Excel:', supabaseErr);
        // Continuar com fallback Excel
      }
    }
    
    // Fallback: usar Excel
    let tabulacoes = await readTabulacoes();
    
    // Verificar se existe
    const index = tabulacoes.indexOf(nomeLimpo);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Tabulação não encontrada' });
    }
    
    // Remover tabulação
    tabulacoes.splice(index, 1);
    
    // Salvar
    await saveTabulacoes(tabulacoes);
    
    res.json({ success: true, tabulacoes, message: 'Tabulação deletada com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Rota para logout
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { usuario } = req.body;
    
    if (usuario && usuario.trim()) {
      const usuarioLimpo = usuario.trim();
      if (activeSessions[usuarioLimpo]) {
        // Salvar timestamp de logout antes de remover
        logoutHistory[usuarioLimpo] = { logoutTime: Date.now() };
        
        // Salvar saída no Supabase (atualizar o registro mais recente sem data_saida)
        // Salvar saída no Supabase usando função auxiliar
        const resultadoSaida = await inserirEntradaSaida(usuarioLimpo, 'saida');
        if (resultadoSaida.success) {
          const dataSaida = new Date().toISOString().split('T')[0];
          const horaSaida = new Date().toTimeString().split(' ')[0];
          console.log(`✅ [Supabase] Saída salva para ${usuarioLimpo}: ${dataSaida} ${horaSaida}`);
          if (resultadoSaida.data && resultadoSaida.data.length > 0) {
            console.log(`✅ [Supabase] Registro atualizado: ID ${resultadoSaida.data[0].id}`);
          }
        } else {
          console.error('❌ [Supabase] Erro ao salvar saída:', resultadoSaida.error);
          // Não falhar o logout se houver erro ao salvar saída
        }
        
        delete activeSessions[usuarioLimpo];
        console.log(`🔴 Usuário ${usuarioLimpo} fez logout`);
      }
    }
    
    res.json({ success: true, message: 'Logout realizado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para obter lista de usuários online com informações de timestamp
// Rota para buscar histórico de entrada/saída dos projetistas
app.get('/api/projetistas/entrada-saida', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    let entradaSaidaData = [];
    
    // Tentar buscar no Supabase primeiro
    if (supabase && isSupabaseAvailable()) {
      try {
        // Usar função RPC para buscar dados (contorna problema com caracteres especiais)
        console.log(`🔍 [API] Buscando dados de entrada/saída usando função RPC...`);
        
        const { data, error } = await supabase.rpc('buscar_entrada_saida_projetistas', {
          p_limit: 1000
        });
        
        if (error) {
          console.error('❌ [Supabase] Erro ao buscar entrada/saída:', error);
          console.error('❌ [Supabase] Código do erro:', error.code);
          console.error('❌ [Supabase] Mensagem:', error.message);
          console.error('❌ [Supabase] Detalhes:', error.details);
          
          // Se a função RPC não existir, informar ao usuário
          if (error.code === 'PGRST116' || error.message?.includes('does not exist') || error.message?.includes('function')) {
            console.error('❌ [Supabase] FUNÇÃO RPC NÃO ENCONTRADA!');
            console.error('❌ [Supabase] Execute o SQL em backend/sql/create_rpc_functions.sql');
          }
          
          // Se o erro for de tipo incompatível
          if (error.code === '42804') {
            console.error('❌ [Supabase] ERRO DE TIPO INCOMPATÍVEL!');
            console.error('❌ [Supabase] A função RPC precisa ser recriada com os tipos corretos.');
            console.error('❌ [Supabase] Execute o SQL atualizado em backend/sql/create_rpc_functions.sql');
          }
          
          throw error;
        }
        
        if (data && data.length > 0) {
          entradaSaidaData = data;
          console.log(`✅ [API] ${data.length} registro(s) de entrada/saída encontrado(s)`);
        } else {
          console.log(`⚠️ [API] Nenhum registro encontrado`);
        }
      } catch (supabaseErr) {
        console.error('❌ [Supabase] Erro ao buscar entrada/saída:', supabaseErr);
        // Continuar com array vazio se houver erro
      }
    } else {
      console.warn('⚠️ [API] Supabase não disponível, retornando array vazio');
    }
    
    res.json({ 
      success: true, 
      entradaSaida: entradaSaidaData 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/users/online', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Se upload estiver em andamento, aguardar até terminar (com timeout)
    if (uploadInProgress && uploadPromise) {
      console.log('⏸️ [Users/Online] Upload em andamento, aguardando conclusão...');
      const MAX_WAIT_TIME = 5 * 60 * 1000; // 5 minutos máximo de espera
      const startWait = Date.now();
      
      try {
        // Aguardar upload terminar (com timeout)
        await Promise.race([
          uploadPromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout aguardando upload')), MAX_WAIT_TIME)
          )
        ]);
        console.log(`✅ [Users/Online] Upload concluído, processando requisição (aguardou ${Date.now() - startWait}ms)`);
      } catch (waitErr) {
        if (waitErr.message === 'Timeout aguardando upload') {
          console.warn(`⚠️ [Users/Online] Timeout aguardando upload (${MAX_WAIT_TIME}ms), retornando dados atuais`);
          // Continuar mesmo se timeout (retornar dados atuais)
        } else {
          console.warn(`⚠️ [Users/Online] Erro ao aguardar upload: ${waitErr.message}, retornando dados atuais`);
          // Continuar mesmo se erro (retornar dados atuais)
        }
      }
    }
    
    const now = Date.now();
    const onlineUsers = [];
    const usersInfo = {};
    
    // Filtrar apenas usuários ativos (não expirados)
    Object.keys(activeSessions).forEach(usuario => {
      if (now - activeSessions[usuario].lastActivity <= SESSION_TIMEOUT) {
        onlineUsers.push(usuario);
        usersInfo[usuario] = {
          status: 'online',
          loginTime: activeSessions[usuario].loginTime
        };
      } else {
        // Salvar timestamp de logout antes de remover
        logoutHistory[usuario] = { logoutTime: activeSessions[usuario].lastActivity };
        delete activeSessions[usuario];
      }
    });
    
    // Adicionar informações de usuários offline (que já fizeram logout ou nunca fizeram login)
    // Primeiro, adicionar todos do histórico de logout
    Object.keys(logoutHistory).forEach(usuario => {
      if (!usersInfo[usuario]) {
        usersInfo[usuario] = {
          status: 'offline',
          logoutTime: logoutHistory[usuario].logoutTime
        };
      }
    });
    
    // Garantir que todos os projetistas tenham informação de status
    // Se um projetista não está online nem no histórico, significa que nunca fez login
    // Nesse caso, não adicionamos informação (será tratado no frontend)
    
    res.json({ success: true, onlineUsers, usersInfo });
  } catch (err) {
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Rota para atualizar atividade do usuário (heartbeat)
app.post('/api/users/heartbeat', (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    const { usuario } = req.body;
    
    if (usuario && usuario.trim()) {
      const usuarioLimpo = usuario.trim();
      if (activeSessions[usuarioLimpo]) {
        activeSessions[usuarioLimpo].lastActivity = Date.now();
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Rota para verificar/criar base_VI_ALA.xlsx
app.get('/api/vi-ala/ensure-base', async (req, res) => {
  try {
    await ensureVIALABase();
    res.json({ success: true, message: 'Base VI ALA verificada/criada com sucesso' });
  } catch (err) {
    console.error('Erro ao verificar/criar base VI ALA:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota de teste para verificar se o servidor está respondendo
app.get('/api/vi-ala/test', (req, res) => {
  console.log('📥 [API] Teste recebido');
  res.json({ success: true, message: 'Servidor está respondendo', timestamp: new Date().toISOString() });
});

// Rota de teste simples para verificar CORS e conectividade
app.get('/api/test', (req, res) => {
  console.log('📥 [API] Teste de conectividade recebido');
  console.log('📥 [API] Origin:', req.headers.origin);
  
  // Garantir headers CORS
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  res.json({ 
    success: true, 
    message: 'Backend está funcionando!', 
    timestamp: new Date().toISOString(),
    origin: req.headers.origin || 'N/A'
  });
});

// Rota para verificar quantas CTOs existem no Supabase (debug)
app.get('/api/debug/ctos-count', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('🔍 [Debug] Verificando quantidade de CTOs no Supabase...');
    
    if (!supabase || !isSupabaseAvailable()) {
      return res.json({
        success: false,
        error: 'Supabase não disponível',
        count: 0,
        source: 'none'
      });
    }
    
    // Contar CTOs
    const { count, error: countError } = await supabase
      .from('ctos')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ [Debug] Erro ao contar CTOs:', countError);
      return res.json({
        success: false,
        error: countError.message,
        count: 0,
        source: 'supabase_error'
      });
    }
    
    // Buscar algumas CTOs de exemplo (primeiras 5)
    const { data: sampleData, error: sampleError } = await supabase
      .from('ctos')
      .select('id_cto, cto, latitude, longitude, portas, ocupado')
      .limit(5);
    
    const sample = sampleError ? [] : (sampleData || []);
    
    console.log(`✅ [Debug] Total de CTOs no Supabase: ${count || 0}`);
    console.log(`📋 [Debug] Exemplos: ${sample.length} CTOs`);
    
    res.json({
      success: true,
      count: count || 0,
      source: 'supabase',
      sample: sample.map(row => ({
        id_cto: row.id_cto,
        cto: row.cto,
        latitude: row.latitude,
        longitude: row.longitude,
        hasCoords: !!(row.latitude && row.longitude && !isNaN(row.latitude) && !isNaN(row.longitude))
      }))
    });
  } catch (err) {
    console.error('❌ [Debug] Erro ao verificar CTOs:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({
      success: false,
      error: err.message,
      count: 0,
      source: 'error'
    });
  }
});

// Rota para testar conexão com Supabase
app.get('/api/test-supabase', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('🔍 [API] Testando conexão com Supabase...');
    
    // Testar conexão
    const connectionTest = await testSupabaseConnection();
    
    // Verificar tabelas
    const tablesCheck = await checkTables();
    
    res.json({
      success: connectionTest.success,
      connection: connectionTest,
      tables: tablesCheck,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ [API] Erro ao testar Supabase:', err);
    
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Rota raiz - retorna informações da API
app.get('/', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.json({
    success: true,
    message: 'API Viabilidade Alares - Backend',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      test: '/api/test',
      upload: '/api/upload-base',
      login: '/api/auth/login',
      logout: '/api/auth/logout',
      users: '/api/users/online',
      projetistas: '/api/projetistas',
      tabulacoes: '/api/tabulacoes',
      viAla: {
        next: '/api/vi-ala/next',
        register: '/api/vi-ala/register',
        save: '/api/vi-ala/save',
        list: '/api/vi-ala/list',
        download: '/api/vi-ala.xlsx'
      }
    }
  });
});

// Rota de health check
app.get('/health', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rota para obter próximo VI ALA (busca o mais recente no Supabase e retorna próximo)
app.get('/api/vi-ala/next', async (req, res) => {
  const requestStartTime = Date.now();
  
  // Garantir headers CORS
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Content-Type', 'application/json');
  
  console.log('📥 [API] ===== REQUISIÇÃO RECEBIDA /api/vi-ala/next =====');
  console.log('📥 [API] Timestamp:', new Date().toISOString());
  
  try {
    console.log('⏱️ [API] Buscando próximo VI ALA do Supabase...');
    
    // Buscar próximo VI ALA (tenta Supabase primeiro, fallback Excel)
    const nextVIALA = await getNextVIALA();
    
    if (!nextVIALA) {
      throw new Error('Não foi possível gerar próximo VI ALA');
    }
    
    const elapsedTime = Date.now() - requestStartTime;
    console.log(`✅ [API] Próximo VI ALA gerado: ${nextVIALA} (${elapsedTime}ms)`);
    
    if (!res.headersSent) {
      res.json({ success: true, viAla: nextVIALA });
    }
  } catch (err) {
    const elapsedTime = Date.now() - requestStartTime;
    console.error(`❌ [API] Erro (${elapsedTime}ms):`, err.message);
    console.error('❌ [API] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Rota para registrar VI ALA (gera próximo número e salva no Supabase em uma operação)
app.post('/api/vi-ala/register', async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    console.log('📥 [API] Requisição recebida para registrar VI ALA');
    console.log('📦 [API] Body recebido do frontend:', JSON.stringify(req.body, null, 2));

    const result = await registerVIALARecord(req.body);

    console.log(`✅ [API] VI ALA registrado: ${result.viAla} (${result.storage})`);
    res.json({
      success: true,
      viAla: result.viAla,
      storage: result.storage,
      message: 'Registro salvo com sucesso'
    });
  } catch (err) {
    console.error('❌ [API] Erro ao registrar VI ALA:', err);
    console.error('❌ [API] Stack trace:', err.stack);

    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Rota para salvar registro VI ALA (Supabase primeiro, fallback Excel)
app.post('/api/vi-ala/save', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('📥 [API] Requisição recebida para salvar VI ALA');
    console.log('📦 [API] Body recebido do frontend:', JSON.stringify(req.body, null, 2));
    
    const { viAla, ala, data, hora, projetista, cidade, endereco, latitude, longitude, tabulacaoFinal } = req.body;
    
    console.log('📋 [API] Tabulação Final recebida:', tabulacaoFinal);
    console.log('📋 [API] Tipo da tabulação:', typeof tabulacaoFinal);
    console.log('📋 [API] Hora recebida:', hora);
    
    if (!viAla || viAla.trim() === '') {
      console.warn('⚠️ [API] VI ALA não fornecido ou vazio');
      return res.status(400).json({ success: false, error: 'VI ALA é obrigatório' });
    }
    
    // Converter formato frontend para formato interno (Excel)
    const record = {
      'VI ALA': viAla.trim(),
      'ALA': ala || '',
      'DATA': data || '',
      'HORA': hora || '', // Nova coluna: hora separada
      'PROJETISTA': projetista || '',
      'CIDADE': cidade || '',
      'ENDEREÇO': endereco || '',
      'LATITUDE': latitude || '',
      'LONGITUDE': longitude || '',
      'TABULAÇÃO FINAL': tabulacaoFinal || ''
    };
    
    console.log('💾 [API] Salvando registro:', JSON.stringify(record, null, 2));
    console.log('💾 [API] Tabulação Final no record:', record['TABULAÇÃO FINAL']);
    
    const saveResult = await saveVIALARecord(record);
    
    console.log(`✅ [API] Registro salvo com sucesso (${saveResult.storage})`);
    res.json({
      success: true,
      storage: saveResult.storage,
      message: 'Registro salvo com sucesso'
    });
  } catch (err) {
    console.error('❌ [API] Erro ao salvar registro VI ALA:', err);
    console.error('❌ [API] Stack trace:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Rota para listar VI ALAs (os 10 mais recentes)
app.get('/api/vi-ala/list', async (req, res) => {
  try {
    console.log('📥 [API] Requisição recebida para listar VI ALAs');
    
    // Garantir que a base existe
    await _ensureVIALABaseInternal();
    
    // Ler dados da base
    const data = await _readVIALABaseInternal();
    console.log(`📊 [API] Total de registros na base: ${data.length}`);
    
    // Converter para formato esperado pelo frontend
    const viAlas = data.map((row, index) => {
      const viAla = row['VI ALA'] || '';
      // Extrair número do VI ALA
      let numero = 0;
      if (viAla && typeof viAla === 'string') {
        const match = viAla.match(/VI\s*ALA[-\s]*(\d+)/i);
        if (match) {
          numero = parseInt(match[1], 10);
        }
      }
      
      return {
        id: viAla,
        numero: numero,
        numero_ala: row['ALA'] || '',
        projetista: row['PROJETISTA'] || '',
        cidade: row['CIDADE'] || '',
        endereco: row['ENDEREÇO'] || '',
        data_geracao: row['DATA'] || '',
        latitude: row['LATITUDE'] || '',
        longitude: row['LONGITUDE'] || '',
        tabulacao_final: row['TABULAÇÃO FINAL'] || '',
        hora: row['HORA'] || ''
      };
    });
    
    // Ordenar por número (mais recente primeiro)
    viAlas.sort((a, b) => b.numero - a.numero);
    
    // Limitar aos 10 mais recentes
    const recentViAlas = viAlas.slice(0, 10);
    
    console.log(`✅ [API] Retornando ${recentViAlas.length} VI ALAs (de ${viAlas.length} total)`);
    
    res.json({ success: true, viAlas: recentViAlas });
  } catch (err) {
    console.error('❌ [API] Erro ao listar VI ALAs:', err);
    console.error('❌ [API] Stack:', err.stack);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Função auxiliar para parsear data do formato "DD/MM/YYYY HH:MM" ou "DD/MM/YYYY" ou "YYYY-MM-DD"
function parseDateFromString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  
  try {
    const trimmed = dateStr.trim();
    
    // Tentar formato PostgreSQL DATE primeiro (YYYY-MM-DD) - formato do Supabase
    if (trimmed.match(/^\d{4}-\d{2}-\d{2}/)) {
      const dateOnly = trimmed.split(' ')[0]; // Pega só a data, ignora hora se houver
      const [year, month, day] = dateOnly.split('-');
      const date = new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10)
      );
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // Formato: "DD/MM/YYYY HH:MM" ou "DD/MM/YYYY"
    const parts = trimmed.split(' ');
    const datePart = parts[0]; // "DD/MM/YYYY"
    const timePart = parts[1] || '00:00'; // "HH:MM" ou "00:00"
    
    const [day, month, year] = datePart.split('/');
    const [hour, minute] = timePart.split(':');
    
    if (!day || !month || !year) {
      return null;
    }
    
    // Criar objeto Date (mês é 0-indexed no JavaScript)
    const date = new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour || '0', 10),
      parseInt(minute || '0', 10)
    );
    
    // Verificar se a data é válida
    if (isNaN(date.getTime())) {
      return null;
    }
    
    return date;
  } catch (err) {
    console.warn('⚠️ [parseDateFromString] Erro ao parsear data:', dateStr, err);
    return null;
  }
}

// Função auxiliar para agrupar por período
function getPeriodKey(date, period) {
  if (!date) return null;
  
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate();
  const hour = date.getHours(); // 0-23
  const week = getWeekNumber(date);
  const quarter = Math.floor((month - 1) / 3) + 1;
  const semester = month <= 6 ? 1 : 2;
  
  switch (period.toUpperCase()) {
    case 'HORA':
      const minute = date.getMinutes(); // Incluir minutos
      return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    case 'DIA':
      return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    case 'SEMANA':
      return `Sem ${week}/${year}`;
    case 'MÊS':
    case 'MES':
      return `${String(month).padStart(2, '0')}/${year}`;
    case 'TRIMESTRE':
      return `T${quarter}/${year}`;
    case 'SEMESTRE':
      return `S${semester}/${year}`;
    case 'ANUAL':
    case 'ANO':
      return String(year);
    default:
      return null;
  }
}

// Função auxiliar para calcular número da semana
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Rota para obter estatísticas por tabulação (gráfico de pizza)
app.get('/api/vi-ala/stats', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json');
    
    console.log('📥 [API] Requisição recebida para estatísticas de VI ALAs');
    
    // Garantir que a base existe
    await _ensureVIALABaseInternal();
    
    // Ler dados da base
    const data = await _readVIALABaseInternal();
    console.log(`📊 [API] Total de registros na base: ${data.length}`);
    
    // Agrupar por tabulação
    const statsByTabulacao = {};
    let total = 0;
    
    for (const row of data) {
      const tabulacao = row['TABULAÇÃO FINAL'] || 'Não Informado';
      if (!statsByTabulacao[tabulacao]) {
        statsByTabulacao[tabulacao] = 0;
      }
      statsByTabulacao[tabulacao]++;
      total++;
    }
    
    // Converter para formato de array para gráfico de pizza
    const stats = Object.entries(statsByTabulacao).map(([tabulacao, count]) => ({
      label: tabulacao,
      value: count,
      percentage: total > 0 ? ((count / total) * 100).toFixed(2) : '0.00'
    }));
    
    // Ordenar por quantidade (maior primeiro)
    stats.sort((a, b) => b.value - a.value);
    
    console.log(`✅ [API] Retornando estatísticas de ${stats.length} tabulações (total: ${total} registros)`);
    
    res.json({
      success: true,
      stats: stats,
      total: total
    });
  } catch (err) {
    console.error('❌ [API] Erro ao obter estatísticas:', err);
    console.error('❌ [API] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota para obter timeline de VI ALAs (gráfico de linha)
app.get('/api/vi-ala/timeline', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json');
    
    const { period = 'DIA' } = req.query; // DIA, SEMANA, MÊS, TRIMESTRE, SEMESTRE, ANUAL
    
    console.log(`📥 [API] Requisição recebida para timeline de VI ALAs (período: ${period})`);
    
    // Validar período
    const validPeriods = ['HORA', 'DIA', 'SEMANA', 'MÊS', 'MES', 'TRIMESTRE', 'SEMESTRE', 'ANUAL', 'ANO'];
    if (!validPeriods.includes(period.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: `Período inválido. Use: ${validPeriods.join(', ')}`
      });
    }
    
    // Garantir que a base existe
    await _ensureVIALABaseInternal();
    
    // Ler dados da base
    const data = await _readVIALABaseInternal();
    console.log(`📊 [API] Total de registros na base: ${data.length}`);
    
    // Obter filtros de data (opcional)
    const startDateFilter = req.query.startDate;
    const endDateFilter = req.query.endDate;
    
    // Agrupar por período
    const timelineByPeriod = {};
    
    console.log(`📊 [API] Filtros de data: startDate=${startDateFilter || 'N/A'}, endDate=${endDateFilter || 'N/A'}`);
    
    for (const row of data) {
      const dateStr = row['DATA'] || '';
      if (!dateStr) {
        console.log('⚠️ [API] Registro sem data:', row['VI ALA']);
        continue;
      }
      
      console.log(`📅 [API] Processando registro ${row['VI ALA']} com data: "${dateStr}"`);
      
      const date = parseDateFromString(dateStr);
      if (!date) {
        console.warn(`⚠️ [API] Não foi possível parsear data: "${dateStr}" do registro ${row['VI ALA']}`);
        continue;
      }
      
      // Aplicar filtros de data se fornecidos
      if (startDateFilter) {
        const startDate = new Date(startDateFilter + 'T00:00:00');
        // Comparar apenas dia, mês e ano (ignorar hora)
        const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        if (dateOnly < startDateOnly) {
          console.log(`⏭️ [API] Registro ${row['VI ALA']} antes da data inicial: ${dateOnly.toISOString().split('T')[0]} < ${startDateOnly.toISOString().split('T')[0]}`);
          continue;
        }
      }
      
      if (endDateFilter) {
        const endDate = new Date(endDateFilter + 'T23:59:59');
        // Comparar apenas dia, mês e ano (ignorar hora)
        const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const endDateOnly = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
        if (dateOnly > endDateOnly) {
          console.log(`⏭️ [API] Registro ${row['VI ALA']} depois da data final: ${dateOnly.toISOString().split('T')[0]} > ${endDateOnly.toISOString().split('T')[0]}`);
          continue;
        }
      }
      
      console.log(`✅ [API] Registro ${row['VI ALA']} passou no filtro de data`);
      
      const periodKey = getPeriodKey(date, period);
      if (!periodKey) continue;
      
      if (!timelineByPeriod[periodKey]) {
        timelineByPeriod[periodKey] = 0;
      }
      timelineByPeriod[periodKey]++;
    }
    
    // Converter para array e ordenar por período
    const timeline = Object.entries(timelineByPeriod).map(([periodKey, count]) => ({
      period: periodKey,
      count: count
    }));
    
    // Ordenar por período (cronologicamente)
    timeline.sort((a, b) => {
      // Converter período para data para ordenação
      const dateA = parsePeriodToDate(a.period, period);
      const dateB = parsePeriodToDate(b.period, period);
      if (!dateA || !dateB) return 0;
      return dateA.getTime() - dateB.getTime();
    });
    
    console.log(`✅ [API] Retornando timeline com ${timeline.length} períodos`);
    
    res.json({
      success: true,
      period: period.toUpperCase(),
      timeline: timeline,
      total: timeline.reduce((sum, item) => sum + item.count, 0)
    });
  } catch (err) {
    console.error('❌ [API] Erro ao obter timeline:', err);
    console.error('❌ [API] Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// Função auxiliar para converter período de volta para data (para ordenação)
function parsePeriodToDate(periodKey, periodType) {
  try {
    switch (periodType.toUpperCase()) {
      case 'HORA':
        // Formato: "DD/MM/YYYY HH:MM"
        const horaMatch = periodKey.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
        if (horaMatch) {
          const [, day, month, year, hour, minute] = horaMatch;
          return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), parseInt(hour, 10), parseInt(minute, 10));
        }
        return null;
      case 'DIA':
        // Formato: "DD/MM/YYYY"
        const [day, month, year] = periodKey.split('/');
        return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
      case 'SEMANA':
        // Formato: "Sem W/YYYY"
        const weekMatch = periodKey.match(/Sem (\d+)\/(\d+)/);
        if (weekMatch) {
          const week = parseInt(weekMatch[1], 10);
          const year = parseInt(weekMatch[2], 10);
          // Aproximação: primeira semana começa em 1 de janeiro
          const date = new Date(year, 0, 1);
          date.setDate(date.getDate() + (week - 1) * 7);
          return date;
        }
        return null;
      case 'MÊS':
      case 'MES':
        // Formato: "MM/YYYY"
        const [monthMes, yearMes] = periodKey.split('/');
        return new Date(parseInt(yearMes, 10), parseInt(monthMes, 10) - 1, 1);
      case 'TRIMESTRE':
        // Formato: "TQ/YYYY"
        const trimMatch = periodKey.match(/T(\d+)\/(\d+)/);
        if (trimMatch) {
          const quarter = parseInt(trimMatch[1], 10);
          const yearTrim = parseInt(trimMatch[2], 10);
          const monthTrim = (quarter - 1) * 3;
          return new Date(yearTrim, monthTrim, 1);
        }
        return null;
      case 'SEMESTRE':
        // Formato: "SS/YYYY"
        const semMatch = periodKey.match(/S(\d+)\/(\d+)/);
        if (semMatch) {
          const semester = parseInt(semMatch[1], 10);
          const yearSem = parseInt(semMatch[2], 10);
          const monthSem = (semester - 1) * 6;
          return new Date(yearSem, monthSem, 1);
        }
        return null;
      case 'ANUAL':
      case 'ANO':
        // Formato: "YYYY"
        return new Date(parseInt(periodKey, 10), 0, 1);
      default:
        return null;
    }
  } catch (err) {
    return null;
  }
}

// Rota para baixar o arquivo base_VI ALA.xlsx completo
app.get('/api/vi-ala.xlsx', async (req, res) => {
  try {
    // Garantir headers CORS
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    console.log('📥 Requisição para baixar base_VI ALA.xlsx');
    
    // Ler dados (tenta Supabase primeiro, fallback para Excel)
    const data = await _readVIALABaseInternal();
    
    // Criar worksheet com os dados
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'VI ALA');
    
    // Gerar buffer do arquivo Excel
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    // Configurar headers para download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="base_VI ALA.xlsx"');
    res.setHeader('Content-Length', excelBuffer.length);
    
    console.log(`✅ Arquivo Excel gerado com ${data.length} registros`);
    
    // Enviar arquivo
    res.send(excelBuffer);
  } catch (err) {
    console.error('❌ Erro ao gerar/servir base_VI ALA.xlsx:', err);
    console.error('❌ Stack:', err.stack);
    
    // Garantir headers CORS mesmo em erro
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao gerar arquivo base_VI ALA.xlsx' });
    }
  }
});

// Rota para upload da base VI ALA
app.post('/api/vi-ala/upload-base', upload.single('file'), async (req, res) => {
  // Garantir headers CORS
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'Nenhum arquivo foi enviado' 
      });
    }

    // Verificar se é um arquivo Excel
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    
    if (!allowedMimes.includes(req.file.mimetype) && !req.file.originalname.match(/\.(xlsx|xls)$/i)) {
      // Limpar arquivo temporário
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        error: 'Formato de arquivo inválido. Apenas arquivos Excel (.xlsx ou .xls) são aceitos.'
      });
    }

    console.log(`📤 [Upload VI ALA] Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);
    
    // Ler dados do arquivo Excel
    const fileBuffer = await fsPromises.readFile(req.file.path);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Ler cabeçalho diretamente da planilha para garantir que detectamos todas as colunas
    // Usar range para pegar a primeira linha completa
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const headerRow = [];
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
      const cell = worksheet[cellAddress];
      const headerValue = cell ? String(cell.v || '').trim() : '';
      if (headerValue) {
        headerRow.push(headerValue);
      }
    }
    const headers = headerRow;
    
    // Ler dados (usar defval para garantir que células vazias sejam tratadas)
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    
    // Limpar arquivo temporário
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    if (!data || data.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'O arquivo Excel está vazio ou não contém dados válidos.'
      });
    }
    
    // Validar colunas esperadas (verificar no cabeçalho, não nos dados)
    // HORA é opcional (para compatibilidade com arquivos antigos)
    const requiredColumns = ['VI ALA', 'ALA', 'DATA', 'PROJETISTA', 'CIDADE', 'ENDEREÇO', 'LATITUDE', 'LONGITUDE', 'TABULAÇÃO FINAL'];
    const expectedColumns = [...requiredColumns, 'HORA'];
    // Verificar apenas colunas obrigatórias (HORA é opcional)
    const hasAllRequiredColumns = requiredColumns.every(col => headers.includes(col));
    
    if (!hasAllRequiredColumns) {
      const missingColumns = requiredColumns.filter(col => !headers.includes(col));
      return res.status(400).json({
        success: false,
        error: `O arquivo não contém todas as colunas necessárias. Colunas faltando: ${missingColumns.join(', ')}`
      });
    }
    
    // Normalizar dados: garantir que todos os campos existam, mesmo que vazios
    // Se VI ALA estiver vazio, usar ALA como identificação padrão
    const normalizedData = data.map(row => {
      const normalized = {};
      expectedColumns.forEach(col => {
        // Aceitar valores vazios, null, undefined - converter tudo para string vazia se necessário
        const value = row[col];
        normalized[col] = (value === null || value === undefined || value === '') ? '' : String(value);
      });
      
      // Se HORA não existir no arquivo (compatibilidade com arquivos antigos), deixar vazio
      if (!normalized['HORA']) {
        normalized['HORA'] = '';
      }
      
      // Se VI ALA estiver vazio mas ALA tiver valor, usar ALA como VI ALA
      if (!normalized['VI ALA'] || normalized['VI ALA'].trim() === '') {
        if (normalized['ALA'] && normalized['ALA'].trim() !== '') {
          normalized['VI ALA'] = normalized['ALA'];
        }
      }
      
      return normalized;
    });
    
    console.log(`📊 [Upload VI ALA] Processando ${data.length} registros...`);
    
    // Salvar dados no Supabase (se disponível) ou Excel (fallback)
    let savedCount = 0;
    let errors = [];
    
    // Se Supabase estiver disponível, salvar lá
    if (supabase && isSupabaseAvailable()) {
      console.log('💾 [Upload VI ALA] Salvando no Supabase...');
      
      // Processar dados normalizados (aceita valores vazios)
      // Usar os dados já normalizados que garantem que todos os campos existem
      const recordsToInsert = normalizedData.map(row => ({
        vi_ala: row['VI ALA'],
        ala: row['ALA'],
        data: row['DATA'],
        projetista: row['PROJETISTA'],
        cidade: row['CIDADE'],
        endereco: row['ENDEREÇO'],
        latitude: row['LATITUDE'],
        longitude: row['LONGITUDE'],
        tabulacao_final: row['TABULAÇÃO FINAL']
      }));
      
      // Inserir em lotes para evitar timeout
      const batchSize = 100;
      for (let i = 0; i < recordsToInsert.length; i += batchSize) {
        const batch = recordsToInsert.slice(i, i + batchSize);
        const batchResult = await insertVIALABatchIntoSupabase(batch);

        if (!batchResult.success) {
          console.error(`❌ [Upload VI ALA] Erro ao inserir lote ${i / batchSize + 1}:`, batchResult.error);
          errors.push(`Erro no lote ${i / batchSize + 1}: ${batchResult.error}`);
        } else {
          savedCount += batchResult.count || batch.length;
        }
      }
      
      console.log(`✅ [Upload VI ALA] ${savedCount} registros salvos no Supabase`);
    } else {
      // Fallback: salvar no Excel (usar dados já normalizados)
      console.log('💾 [Upload VI ALA] Salvando no Excel (fallback)...');
      
      // Salvar no Excel usando lock
      await withLock('vi_ala', async () => {
        const worksheet = XLSX.utils.json_to_sheet(normalizedData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'VI ALA');
        XLSX.writeFile(workbook, BASE_VI_ALA_FILE);
      });
      
      savedCount = normalizedData.length;
      console.log(`✅ [Upload VI ALA] ${savedCount} registros salvos no Excel`);
    }
    
    return res.json({
      success: true,
      message: `Base de dados atualizada com sucesso! ${savedCount} registros processados.`,
      recordsProcessed: savedCount,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (err) {
    console.error('❌ [Upload VI ALA] Erro ao processar upload:', err);
    console.error('❌ [Upload VI ALA] Stack:', err.stack);
    
    // Limpar arquivo temporário em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {
        console.error('❌ [Upload VI ALA] Erro ao limpar arquivo temporário:', unlinkErr);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao processar upload do arquivo'
    });
  }
});

// Rota catch-all para rotas não encontradas (sempre retorna JSON)
app.use((req, res) => {
  console.log(`⚠️ [404] Rota não encontrada: ${req.method} ${req.path}`);
  res.status(404).json({ 
    success: false, 
    error: 'Rota não encontrada',
    path: req.path,
    method: req.method
  });
});

// Tratamento de erros global
app.use((err, req, res, next) => {
  console.error('❌ [Error] Erro não tratado:', err);
  console.error('❌ [Error] Stack:', err.stack);
  
  // Garantir headers CORS mesmo em erro global
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (!res.headersSent) {
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Erro interno do servidor' 
    });
  }
});

// Tratamento de erros não capturados do processo
process.on('uncaughtException', (err) => {
  console.error('❌ [Fatal] Erro não capturado:', err);
  console.error('❌ [Fatal] Stack:', err.stack);
  // Não encerrar o processo, apenas logar
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Fatal] Promise rejeitada não tratada:', reason);
  // Não encerrar o processo, apenas logar
});

// Iniciar servidor - escutar em 0.0.0.0 para aceitar conexões externas (Railway)
try {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor rodando em http://0.0.0.0:${PORT}`);
  console.log(`📁 Pasta de dados: ${DATA_DIR}`);
  console.log(`📁 Arquivo projetistas: ${PROJETISTAS_FILE}`);
  console.log(`📁 Arquivo base CTOs: ${BASE_CTOS_FILE}`);
  console.log(`📁 Arquivo tabulações: ${TABULACOES_FILE}`);
    console.log(`✅ Servidor iniciado com sucesso!`);
    
    // Testar conexão com Supabase na inicialização (não bloqueia)
    (async () => {
      try {
        console.log('🔍 [Startup] Testando conexão com Supabase...');
        const connectionTest = await testSupabaseConnection();
        if (connectionTest.success) {
          console.log('✅ [Startup] Conexão com Supabase OK!');
          
          // Verificar tabelas
          const tablesCheck = await checkTables();
          const existingTables = Object.entries(tablesCheck)
            .filter(([_, status]) => status.exists)
            .map(([table, _]) => table);
          
          if (existingTables.length > 0) {
            console.log(`✅ [Startup] Tabelas encontradas: ${existingTables.join(', ')}`);
          } else {
            console.log('⚠️ [Startup] Nenhuma tabela encontrada. Execute o schema SQL no Supabase.');
          }
        } else {
          console.log('⚠️ [Startup] Conexão com Supabase falhou:', connectionTest.error);
          console.log('⚠️ [Startup] Verifique as variáveis de ambiente SUPABASE_URL e SUPABASE_SERVICE_KEY');
        }
      } catch (err) {
        console.error('❌ [Startup] Erro ao testar Supabase:', err.message);
        console.log('⚠️ [Startup] O servidor continuará funcionando, mas Supabase pode não estar disponível');
      }
    })();
  });
  
  // Configurar timeout do servidor (2 minutos para uploads grandes)
  // Railway pode ter timeout de gateway, mas aumentamos o máximo possível
  server.timeout = 2 * 60 * 1000; // 2 minutos (120 segundos)
  server.keepAliveTimeout = 120000; // 2 minutos
  server.headersTimeout = 121000; // 2 minutos + 1 segundo
  
  // Tratamento de erros do servidor
  server.on('error', (err) => {
    console.error('❌ [Server] Erro no servidor:', err);
  });
  
} catch (err) {
  console.error('❌ [Fatal] Erro ao iniciar servidor:', err);
  console.error('❌ [Fatal] Stack:', err.stack);
  process.exit(1);
}
