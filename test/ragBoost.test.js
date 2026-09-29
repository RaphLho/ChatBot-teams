// Tests unitaires de src/ragBoost.js — node:test, sans dépendance ni appel réseau.
// Lancement : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import * as XLSX from 'xlsx';
import {
  excelToChunks, docxToChunks, BM25Index, expandQuery, hybridRank, selectChunks, formatExtraits,
  trimHistory, checkCitations, AnswerCache, estimateTokens, ragOptionsFromEnv, retrieve, makeChunk,
} from '../src/ragBoost.js';

const workbook = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// Onglet « attributs en lignes » : les étapes sont en colonnes, comme dans CRM Kanban commercial.xlsx
const kanban = workbook({
  'Kanban prospects': [
    ['Étape du KANBAN', 'Nouvelle demande', 'Doc. générale envoyée', 'Doc. qualifiée envoyée', 'Relance J+30'],
    ['Déplacé par :', 'Automatiquement', 'Automatiquement', 'CDR', 'CDR'],
    ['Activité :', null, 'Qualifier le prospect', 'Vérifier la réception', 'Dernière relance'],
    ['Déclenchement de l\'activité :', null, '24h après', '48h après', '30 jours après'],
    ['Automatisation :', 'Ajout du CDF', null, 'Bascule après 7 jours', 'Email template J+30'],
  ],
});

test('excelToChunks : une fiche par colonne, valeurs attachées à la bonne colonne', () => {
  const chunks = excelToChunks(kanban, 'CRM.xlsx');
  assert.equal(chunks.length, 4);
  const doc = chunks.find((c) => c.section === 'Kanban prospects › Colonne « Doc. qualifiée envoyée »');
  assert.ok(doc, 'fiche de la colonne « Doc. qualifiée envoyée »');
  assert.match(doc.body, /Déclenchement de l'activité : 48h après/);
  assert.match(doc.body, /Automatisation : Bascule après 7 jours/);
  assert.doesNotMatch(doc.body, /24h après|30 jours/, 'aucune valeur d\'une autre colonne');
  assert.match(doc.body, /étape 3\/4 ; précédente « Doc. générale envoyée » ; suivante « Relance J\+30 »/);
  assert.equal(doc.source, 'CRM.xlsx › Kanban prospects › Colonne « Doc. qualifiée envoyée »');
  assert.ok(doc.embedText.startsWith(doc.source));
});

test('excelToChunks : cellules vides ignorées', () => {
  const first = excelToChunks(kanban, 'CRM.xlsx').find((c) => c.section.endsWith('« Nouvelle demande »'));
  assert.doesNotMatch(first.body, /Activité :|Déclenchement/);
  assert.match(first.body, /Automatisation : Ajout du CDF/);
});

test('excelToChunks : tableaux empilés dans un même onglet', () => {
  const buf = workbook({
    ALT: [
      ['Étape', 'A1', 'A2'], ['Déplacé par :', 'CDR', 'CDF'],
      ['Étape', 'B1'], ['Déplacé par :', 'AP'],
    ],
  });
  const sections = excelToChunks(buf, 'k.xlsx').map((c) => c.section);
  assert.deepEqual(sections, ['ALT (tableau 1) › Colonne « A1 »', 'ALT (tableau 1) › Colonne « A2 »', 'ALT (tableau 2) › Colonne « B1 »']);
});

test('excelToChunks : onglet « enregistrements » en « En-tête : valeur »', () => {
  const buf = workbook({
    Tickets: [['ID', 'Description', 'Solution'], [1, 'Portail inaccessible', ''], [2, 'Convention non envoyée', 'Relancer Sign Request']],
  });
  const chunks = excelToChunks(buf, 't.xlsx');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, 'Tickets');
  assert.match(chunks[0].body, /^ID : 1 ; Description : Portail inaccessible$/m);
  assert.match(chunks[0].body, /ID : 2 ; Description : Convention non envoyée ; Solution : Relancer Sign Request/);
});

test('docxToChunks : fil d\'Ariane par titres (si un .docx de test est disponible)', async (t) => {
  const file = process.env.RAG_TEST_DOCX;
  if (!file || !fs.existsSync(file)) return t.skip('RAG_TEST_DOCX non défini');
  const chunks = await docxToChunks(fs.readFileSync(file), 'test.docx');
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.source.startsWith('test.docx') && c.body.length <= 1400));
  assert.ok(chunks.some((c) => c.section), 'au moins un bloc rattaché à un titre');
});

const docs = [
  makeChunk('CRM.xlsx', 'Kanban prospects › Colonne « Relance J+30 »', 'Déclenchement : 30 jours après. Email template J+30.', 0),
  makeChunk('CRM.xlsx', 'Kanban prospects › Colonne « 3ème relance »', 'Déclenchement : 15 jours après. Mentionne la relance J+30 suivante.', 0),
  makeChunk('Procédure de rentrée.docx', 'Partie 1 › Import', 'Importer un étudiant dans Bo-MyCampus et Hyperplanning.', 0),
  makeChunk('Glossaire.docx', 'Rôles', 'CDR : chargé de recrutement. CDF : conseiller de formation.', 0),
];
const byId = new Map(docs.map((d) => [d.id, d]));

test('BM25Index : recherche lexicale et normalisation', () => {
  const bm25 = new BM25Index(docs);
  assert.equal(bm25.search('importer un etudiant bo-mycampus')[0].id, docs[2].id);
  assert.equal(bm25.search('chargé de recrutement')[0].id, docs[3].id);
  assert.deepEqual(bm25.search('xyzzy'), []);
});

test('BM25Index : titre exact entre guillemets > simple mention', () => {
  const hits = new BM25Index(docs).phraseHits('Que se passe-t-il en « Relance J+30 » ?');
  assert.equal(hits[0].id, docs[0].id);
  assert.equal(hits[0].score, 5);
  assert.equal(hits.find((h) => h.id === docs[1].id).score, 1);
});

test('expandQuery : sigles et alias', () => {
  assert.match(expandQuery('Que fait le CDR ?'), /chargé de recrutement/);
  assert.match(expandQuery('Dans le kanban initial, ...'), /INI/);
  assert.equal(expandQuery('Question sans sigle'), 'Question sans sigle');
});

test('hybridRank : fusion vectoriel + BM25 + guillemets', () => {
  const bm25 = new BM25Index(docs);
  // Le vectoriel préfère à tort la procédure de rentrée : les guillemets et BM25 corrigent.
  const vectorResults = [{ id: docs[2].id, score: 0.82 }, { id: docs[1].id, score: 0.8 }, { id: docs[0].id, score: 0.79 }];
  const fused = hybridRank({ query: 'Délai de la colonne « Relance J+30 » ?', vectorResults, bm25 });
  assert.equal(fused[0].id, docs[0].id);
  assert.equal(fused[0].phrase, 5);
  assert.equal(fused[0].vector, 0.79);
  assert.ok(fused[0].bm25 > 0);
});

test('selectChunks : budget de tokens et nombre de blocs respectés', () => {
  const many = Array.from({ length: 10 }, (_, i) => makeChunk('f.docx', `S${i}`, 'x'.repeat(720), i));
  const map = new Map(many.map((c) => [c.id, c]));
  const fused = many.map((c, i) => ({ id: c.id, score: 1 - i * 0.01, vector: 0.8, bm25: 1, phrase: 0 }));
  const sel = selectChunks(fused, map, { tokenBudget: 700, maxChunks: 5 });
  assert.ok(sel.tokens <= 700, `${sel.tokens} ≤ 700`);
  assert.equal(sel.chunks.length, 3);
  assert.equal(sel.tokens, sel.chunks.reduce((a, c) => a + estimateTokens(c.source + c.body) + 6, 0));
  assert.equal(selectChunks(fused, map, { tokenBudget: 1e6, maxChunks: 5 }).chunks.length, 5);
});

test('selectChunks : coupure relative et confiance', () => {
  const fused = [
    { id: docs[0].id, score: 1, vector: 0.6, bm25: null, phrase: 0 },
    { id: docs[1].id, score: 0.2, vector: 0.5, bm25: null, phrase: 0 },
  ];
  assert.equal(selectChunks(fused, byId, { relativeCut: 0.3 }).chunks.length, 1);
  assert.equal(selectChunks(fused, byId, { minVector: 0.7 }).confident, false);
  assert.equal(selectChunks(fused, byId, { minVector: null }).confident, true);
  assert.equal(selectChunks([], byId).confident, false);
});

test('retrieve + formatExtraits : extraits numérotés avec leur source', async () => {
  const sel = await retrieve({ question: 'colonne « Relance J+30 »', bm25: new BM25Index(docs), chunksById: byId });
  const extraits = formatExtraits(sel.chunks);
  assert.ok(extraits.startsWith('<EXTRAITS>\n[1] Source : CRM.xlsx › Kanban prospects › Colonne « Relance J+30 »\n'));
  assert.ok(extraits.endsWith('\n</EXTRAITS>'));
});

test('ragOptionsFromEnv : valeurs par défaut et surcharge', () => {
  assert.deepEqual(ragOptionsFromEnv({}), { tokenBudget: 1150, maxChunks: 5, exactCap: 3, relativeCut: 0.3, minVector: null });
  assert.equal(ragOptionsFromEnv({ RAG_MIN_VECTOR: '0.73' }).minVector, 0.73);
  assert.equal(ragOptionsFromEnv({ RAG_MIN_VECTOR: '' }).minVector, null);
});

test('trimHistory : 2 derniers échanges, citations retirées, réponses tronquées', () => {
  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push({ role: 'user', content: `Q${i}` });
    msgs.push({ role: 'assistant', content: `${'mot '.repeat(150)}\nD'après le document CRM.xlsx` });
  }
  const out = trimHistory(msgs, { maxTurns: 2, maxAssistantChars: 350 });
  assert.equal(out.length, 4);
  assert.equal(out[0].content, 'Q1');
  for (const m of out.filter((x) => x.role === 'assistant')) {
    assert.ok(m.content.length <= 351);
    assert.doesNotMatch(m.content, /D'après/);
  }
});

test('checkCitations : fichier inventé retiré, fichier réel conservé', () => {
  const r = checkCitations('Réponse.\nD\'après les documents CRM.xlsx, Inventé.docx', docs);
  assert.equal(r.text, 'Réponse.\nD\'après le document CRM.xlsx');
  assert.deepEqual(r.invalid, ['Inventé.docx']);
  assert.equal(r.suspect, true);
  const only = checkCitations('Réponse.\nD’après le document Inventé.pdf', docs);
  assert.equal(only.text, 'Réponse.');
  assert.equal(only.suspect, true);
});

test('checkCitations : nom de fichier contenant des virgules', () => {
  const chunks = [makeChunk('Les dépendances - Contacts, Prospects, Transactions, etc.docx', '', 'x', 0)];
  const r = checkCitations('Oui.\nD\'après le document Les dépendances - Contacts, Prospects, Transactions, etc.docx', chunks);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.suspect, false);
  assert.match(r.text, /Transactions, etc\.docx$/);
});

test('checkCitations : formule de repli non suspecte', () => {
  const r = checkCitations('[SANS_REPONSE] Je ne sais pas répondre à cette question.', docs);
  assert.equal(r.suspect, false);
});

test('AnswerCache : clé normalisée, versionnée par index, éviction et TTL', () => {
  const cache = new AnswerCache({ max: 2, ttlMs: 1000 });
  const k1 = cache.key({ mode: 'collaborateur', formation: '', question: 'Que fait le CDR ?', indexVersion: 'v1' });
  assert.equal(k1, cache.key({ mode: 'collaborateur', formation: '', question: 'que FAIT le cdr', indexVersion: 'v1' }));
  assert.notEqual(k1, cache.key({ mode: 'collaborateur', formation: '', question: 'Que fait le CDR ?', indexVersion: 'v2' }));
  assert.notEqual(k1, cache.key({ mode: 'etudiant', formation: '', question: 'Que fait le CDR ?', indexVersion: 'v1' }));
  cache.set(k1, 'a');
  assert.equal(cache.get(k1), 'a');
  cache.set('k2', 'b');
  cache.set('k3', 'c');
  assert.equal(cache.get(k1), null, 'plus ancienne entrée évincée');
  const expired = new AnswerCache({ ttlMs: -1 });
  expired.set('x', 'y');
  assert.equal(expired.get('x'), null);
});
