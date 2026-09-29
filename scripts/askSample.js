// askSample.js — Test RÉEL du bot (appelle mistral-small : consomme des tokens)
// ------------------------------------------------------------------
// Usage :
//   node scripts/askSample.js <dossier_documents> <Questions_Reponses.xlsx> [N=21] [sortie.csv]
//
// Construit la base à partir des documents locaux (mêmes blocs que la production, rangés comme
// le dossier « Collaborateur »), puis pose les N premières questions au vrai RAGBot en mode
// Collaborateur, chacune comme une conversation neuve (pas d'historique, pas de cache).
// Écrit un CSV (séparateur ;) : question, réponse attendue, réponse du bot, sources envoyées,
// tokens, et une colonne « Note » à remplir (bien / partiel / faux).
//
// Coût : ≈ 2 900 tokens mistral-small par question (≈ 61 000 pour 21 questions). Les embeddings
// des blocs sont repris de .eval-embeddings.json (créé par eval:retrieval --vector) quand ils y
// sont ; sinon ils sont calculés (≈ 105 000 tokens mistral-embed).
// ------------------------------------------------------------------
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { Mistral } from '@mistralai/mistralai';
import { fileToChunks } from '../src/ingestion.js';
import { LocalRamVectorStore } from '../src/vectorStore.js';
import RAGBot from '../src/bot.js';
import botStats from '../src/stats.js';

const [dir, qaFile, nArg = '21', out = 'test-reel.csv'] = process.argv.slice(2);
if (!dir || !qaFile) { console.error('Usage: node scripts/askSample.js <dossier> <qa.xlsx> [N] [sortie.csv]'); process.exit(1); }
if (!process.env.MISTRAL_API_KEY) { console.error('MISTRAL_API_KEY manquante (.env)'); process.exit(1); }

// Les statistiques du serveur (data/global_stats.json) ne doivent pas être modifiées par ce test.
const statsFile = path.resolve('data/global_stats.json');
const statsBackup = fs.existsSync(statsFile) ? fs.readFileSync(statsFile) : null;
process.on('exit', () => { if (statsBackup) fs.writeFileSync(statsFile, statsBackup); });

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const chunks = [];
for (const f of walk(dir)) {
  if (path.resolve(f) === path.resolve(qaFile)) continue;
  const rel = path.relative(dir, f).split(path.sep).join('/');
  try {
    chunks.push(...(await fileToChunks(fs.readFileSync(f), path.extname(f).toLowerCase(), `Collaborateur/${rel}`)));
  } catch { /* format non pris en charge */ }
}

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const store = new LocalRamVectorStore(client);
const cache = fs.existsSync('.eval-embeddings.json') ? JSON.parse(fs.readFileSync('.eval-embeddings.json', 'utf8')) : {};
const cached = chunks.filter((c) => cache[c.embedText]).map((c) => ({ ...c, embedding: cache[c.embedText] }));
const missing = chunks.filter((c) => !cache[c.embedText]);
if (missing.length) await store.addDocuments(missing);
store.setDocuments([...cached, ...store.documents]);

const bot = new RAGBot(store, client);
const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(qaFile)).Sheets[XLSX.read(fs.readFileSync(qaFile)).SheetNames[0]]);
const csv = [['#', 'Question', 'Réponse attendue', 'Réponse du bot', 'Sources envoyées', 'Tokens prompt', 'Tokens réponse', 'Note (bien/partiel/faux)']];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
for (const [i, r] of rows.slice(0, Number(nArg)).entries()) {
  const answer = await bot.askQuestion(r['Question'], `test_reel_${i}`, 'collaborateur', null);
  const entry = botStats.history.filter((e) => e.userId === `test_reel_${i}`).pop() || {};
  console.log(`#${i + 1} ${entry.local || ''} ${entry.promptTokens || 0}+${entry.completionTokens || 0} tokens`);
  csv.push([i + 1, r['Question'], r['Réponse attendue'], answer, entry.rag?.top ? `${entry.rag.chunks} bloc(s)` : '', entry.promptTokens, entry.completionTokens, '']);
}
fs.writeFileSync(out, '﻿' + csv.map((l) => l.map(esc).join(';')).join('\n'));
const s = botStats.session;
console.log(`\n${out} écrit. Total mistral-small : ${s.chatPromptTokens} + ${s.chatCompletionTokens} tokens ; mistral-embed : ${s.embedTokens}.`);
