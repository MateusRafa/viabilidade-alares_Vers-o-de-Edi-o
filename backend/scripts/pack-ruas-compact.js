/**
 * Lê ruas.json, aplica as emendas e grava ruas.pack.
 * Este processo termina em seguida. O backend que atende a pesquisa só abre o pack.
 */
import fs from 'fs';
import path from 'path';
import { prepareGraph, writePackedGraphFile } from '../lib/routing/streetGraph.js';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dir = path.join(dataDir, 'ruas');
const jsonFile = path.join(dir, 'ruas.json');
const packFile = path.join(dir, 'ruas.pack');
const nextFile = `${packFile}.next`;

if (!fs.existsSync(jsonFile)) {
  console.warn('⚠️ [Ruas] ruas.json não está neste backend. Cópia compacta não foi gravada.');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const prep = prepareGraph(raw);
fs.mkdirSync(dir, { recursive: true });
writePackedGraphFile(nextFile, prep);
fs.renameSync(nextFile, packFile);
console.log(
  `🛣️ [Ruas] Cópia compacta gravada: ${prep.nodeCount} pontos, ${prep.edgeCount} trechos.`
);
