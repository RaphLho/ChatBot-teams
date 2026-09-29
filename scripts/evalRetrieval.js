// evalRetrieval.js — Mesure la qualité de la recherche SANS appeler le LLM
// ------------------------------------------------------------------
// Usage :
//   npm run eval:retrieval -- <dossier_documents> <Questions_Reponses.xlsx> [--vector] [--json <fichier>]
//
// Pour chaque question du fichier (colonnes « Question » / « Réponse attendue »),
// on lance la recherche et on mesure la « couverture » : part des termes
// significatifs de la réponse attendue présents dans les extraits sélectionnés.
// Une couverture faible = le LLM ne pouvait pas bien répondre, quel que soit le prompt.
//
// Le découpage (src/ingestion.js) et la chaîne de recherche (retrieve, src/ragBoost.js) sont
// ceux de la production, avec les mêmes paramètres (variables RAG_*) : l'évaluation mesure
// ce que voit réellement le bot.
//
// Coût : 0 token LLM. Avec --vector, 1 embedding par bloc et par question (mistral-embed,
// ≈ 130 000 tokens au premier lancement), mis en cache dans .eval-embeddings.json, donc payé
// une seule fois tant que les documents ne changent pas.
// ------------------------------------------------------------------
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { fileToChunks } from '../src/ingestion.js';
import { BM25Index, retrieve, ragOptionsFromEnv, tokenize, normalize } from '../src/ragBoost.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const [dir, qaFile] = args.filter((a, i) => !a.startsWith('--') && (jsonIdx < 0 || i !== jsonIdx + 1));
if (!dir || !qaFile) {
  console.error('Usage: npm run eval:retrieval -- <dossier> <qa.xlsx> [--vector] [--json <fichier>]');
  process.exit(1);
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// --- Découpage : mêmes blocs que la production ---
const chunks = [];
for (const f of walk(dir)) {
  if (path.resolve(f) === path.resolve(qaFile)) continue;
  const ext = path.extname(f).toLowerCase();
  try {
    chunks.push(...(await fileToChunks(fs.readFileSync(f), ext, f.split(path.sep).join('/'))));
  } catch (e) {
    if (!/Format non pris en charge/.test(e.message)) console.warn(`⚠️  ${path.basename(f)} : ${e.message}`);
  }
}
const chunksById = new Map(chunks.map((c) => [c.id, c]));
const bm25 = new BM25Index(chunks);
const options = ragOptionsFromEnv();

// --- Embeddings optionnels (mistral-embed), avec cache disque ---
let vectorSearch = null;
if (flags.has('--vector')) {
  if (!process.env.MISTRAL_API_KEY) { console.error('MISTRAL_API_KEY manquante (.env)'); process.exit(1); }
  const { Mistral } = await import('@mistralai/mistralai');
  const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
  const cacheFile = '.eval-embeddings.json';
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  let spent = 0;
  const embed = async (texts) => {
    const todo = [...new Set(texts.filter((t) => !cache[t]))];
    for (let i = 0; i < todo.length; i += 32) {
      const r = await client.embeddings.create({ model: 'mistral-embed', inputs: todo.slice(i, i + 32) });
      spent += r.usage?.promptTokens || r.usage?.totalTokens || 0;
      r.data.forEach((d, j) => { cache[todo[i + j]] = d.embedding; });
    }
    if (todo.length) fs.writeFileSync(cacheFile, JSON.stringify(cache));
    return texts.map((t) => cache[t]);
  };
  const vecs = await embed(chunks.map((c) => c.embedText));
  const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; } return s / Math.sqrt(na * nb); };
  vectorSearch = async (q) => {
    const [qv] = await embed([q]);
    return chunks.map((c, i) => ({ id: c.id, score: cos(qv, vecs[i]) }))
      .sort((a, b) => b.score - a.score).slice(0, 30);
  };
  process.on('exit', () => console.log(`\nTokens d'embedding dépensés pendant ce lancement : ${spent}`));
}

// Expressions entre guillemets de la question qui sont le titre exact d'une colonne de kanban
const flat = (s) => normalize(s).replace(/[^a-z0-9+]+/g, ' ').trim();
const columnTitles = new Set(chunks
  .map((c) => (c.section || '').match(/Colonne « (.+) »$/)?.[1]).filter(Boolean).map(flat));
const quotedColumns = (q) => [...String(q).matchAll(/[«“"]\s*([^»”"]{3,80}?)\s*[»”"]/g)]
  .map((m) => flat(m[1])).filter((p) => columnTitles.has(p));

// --- Évaluation ---
const wb = XLSX.read(fs.readFileSync(qaFile), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
const results = [];
for (const [i, r] of rows.entries()) {
  const question = r['Question'];
  const expected = r['Réponse attendue'] || r['Reponse attendue'] || '';
  if (!question) continue;
  const sel = await retrieve({ question, bm25, chunksById, vectorSearch, options });
  const ctx = new Set(tokenize(sel.chunks.map((c) => c.embedText).join(' ')));
  const terms = [...new Set(tokenize(expected))].filter((t) => t.length > 3);
  const cov = terms.length ? terms.filter((t) => ctx.has(t)).length / terms.length : 1;
  const cols = quotedColumns(question);
  const topSection = flat(sel.chunks[0]?.section || '');
  results.push({
    n: i + 1, cov, tok: sel.tokens, nChunks: sel.chunks.length, confident: sel.confident,
    topVector: sel.top?.vector ?? null, question, top: sel.chunks[0]?.source || '—',
    quoted: cols.length > 0, quotedFirst: cols.length > 0 && cols.some((p) => topSection.endsWith(`colonne ${p}`)),
  });
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quoted = results.filter((x) => x.quoted);
console.log(`\nMode : ${vectorSearch ? 'hybride (vectoriel + lexical)' : 'lexical seul'} ; paramètres ${JSON.stringify(options)}`);
console.log(`Blocs indexés : ${chunks.length}`);
console.log(`Questions : ${results.length}`);
console.log(`Couverture moyenne : ${(100 * avg(results.map((x) => x.cov))).toFixed(1)} %`);
console.log(`Tokens d'extraits envoyés / question : ${Math.round(avg(results.map((x) => x.tok)))} (${avg(results.map((x) => x.nChunks)).toFixed(1)} blocs)`);
console.log(`Questions citant une colonne de kanban entre guillemets : bonne colonne en premier ${quoted.filter((x) => x.quotedFirst).length}/${quoted.length}`);
console.log(`Questions « confiantes » : ${results.filter((x) => x.confident).length}/${results.length}`);

const weakest = [...results].sort((a, b) => a.cov - b.cov);
console.log('\n10 questions les moins bien couvertes :');
for (const x of weakest.slice(0, 10)) console.log(`  ${(100 * x.cov).toFixed(0).padStart(3)} %  #${x.n} ${x.question.slice(0, 90)}\n        → ${x.top}`);

if (vectorSearch) {
  // Distribution du score vectoriel du premier bloc (celui qui sert au seuil RAG_MIN_VECTOR)
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  const show = (label, xs) => console.log(`  ${label.padEnd(26)} n=${String(xs.length).padStart(3)}  min ${pct(xs, 0).toFixed(3)}  p10 ${pct(xs, 0.1).toFixed(3)}  p25 ${pct(xs, 0.25).toFixed(3)}  médiane ${pct(xs, 0.5).toFixed(3)}  max ${pct(xs, 1).toFixed(3)}`);
  const withVec = results.filter((x) => x.topVector !== null);
  const good = withVec.filter((x) => x.cov >= 0.5).map((x) => x.topVector);
  const bad = withVec.filter((x) => x.cov < 0.5).map((x) => x.topVector);
  console.log('\nScore vectoriel (cosinus) du premier bloc :');
  show('bien couvertes (≥ 50 %)', good);
  show('mal couvertes (< 50 %)', bad);
  console.log(`  premier bloc sans score vectoriel (BM25/guillemets seuls) : ${results.length - withVec.length}`);
  if (good.length) {
    // Toutes les questions du jeu ont une réponse dans les documents : le seuil doit laisser
    // passer (quasiment) toutes les bonnes questions. On propose le 2e centile moins une marge.
    const proposal = Math.floor((pct(good, 0.02) - 0.02) * 100) / 100;
    console.log(`\nProposition (non activée) : RAG_MIN_VECTOR=${proposal.toFixed(2)}`);
    console.log('  À valider sur quelques questions hors documents avant activation : le jeu de test ne contient que des questions avec réponse.');
  }
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
