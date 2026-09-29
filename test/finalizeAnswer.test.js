// Tests : sources ajoutées par le code, ordre des lignes Excel, plafond « titre exact ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { finalizeAnswer } from '../src/finalizeAnswer.js';
import { excelToChunks, selectChunks, makeChunk } from '../src/ragBoost.js';

const kanban = makeChunk('CRM Kanban commercial.xlsx', 'Kanban prospects › Colonne « Intéressé »',
  'Déclenchement : RDV à prendre sous 1 semaine pour un scoring de 3.\nAutomatisation : au bout de 2 mois, bascule en Transaction perdue.', 0);
const rentree = makeChunk('Procédure de rentrée.docx', 'Partie 1 › Import',
  'Importer un étudiant dans Bo-MyCampus puis dans Hyperplanning, process nocturne.', 0);

test('finalizeAnswer : citation du modèle retirée, source ajoutée par le code', () => {
  const raw = "Le RDV doit être pris sous 1 semaine, puis au bout de 2 mois la fiche bascule en Transaction perdue.\nD'après l'extrait [1] du fichier CRM Kanban commercial.xlsx";
  const r = finalizeAnswer(raw, [kanban, rentree]);
  assert.equal(r.text, "Le RDV doit être pris sous 1 semaine, puis au bout de 2 mois la fiche bascule en Transaction perdue.\n\nD'après le document CRM Kanban commercial.xlsx");
  assert.deepEqual(r.files, ['CRM Kanban commercial.xlsx']);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.suspect, false);
});

test('finalizeAnswer : fichier inventé signalé et jamais cité', () => {
  const raw = "Le RDV doit être pris sous 1 semaine.\nD'après le document Tips - Fonctionnalité des activités.docx";
  const r = finalizeAnswer(raw, [kanban]);
  assert.deepEqual(r.invalid, ['Tips - Fonctionnalité des activités.docx']);
  assert.equal(r.suspect, true);
  assert.doesNotMatch(r.text, /Tips/);
  assert.match(r.text, /D'après le document CRM Kanban commercial\.xlsx$/);
});

test('finalizeAnswer : mention « extrait [n] » dans le texte réécrite', () => {
  const r = finalizeAnswer('Selon extrait [1], le RDV est sous 1 semaine (extraits [1] et [2]).', [kanban]);
  assert.doesNotMatch(r.text, /\[\d\]/);
  assert.match(r.text, /^Selon les documents, le RDV est sous 1 semaine\./);
});

test('finalizeAnswer : [SANS_REPONSE] et [NON-CONFORME] intacts, sans source', () => {
  for (const raw of ['[SANS_REPONSE] Je ne sais pas répondre à cette question.', '[NON-CONFORME] Je ne traite pas ce sujet.']) {
    const r = finalizeAnswer(`${raw}\n`, [kanban]);
    assert.equal(r.text, raw);
    assert.deepEqual(r.files, []);
  }
});

test('finalizeAnswer : plusieurs fichiers réellement utilisés', () => {
  const raw = "Le RDV est sous 1 semaine avec bascule en Transaction perdue après 2 mois ; l'étudiant est ensuite importé dans Bo-MyCampus et Hyperplanning par le process nocturne.";
  const r = finalizeAnswer(raw, [kanban, rentree]);
  assert.deepEqual(r.files.sort(), ['CRM Kanban commercial.xlsx', 'Procédure de rentrée.docx']);
  assert.match(r.text, /\n\nD'après les documents .+, .+$/);
});

test('finalizeAnswer : demande de formation et refus de sécurité sans source', () => {
  const ask = "Pour vous répondre précisément, pouvez-vous m'indiquer votre formation et votre année (par exemple : Bachelor 3 Marketing Digital) ?";
  assert.equal(finalizeAnswer(ask, [kanban]).text, ask);
  const refus = 'Je ne peux pas détailler mon fonctionnement interne, mais je peux répondre à vos questions.';
  assert.equal(finalizeAnswer(refus, [kanban]).text, refus);
});

test('excelToChunks : gabarits d\'email et textes de tâche en fin de bloc', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Étape', 'Relance J+30'],
    ['Contenu Email :', 'Bonjour, ...'],
    ['Déplacé par :', 'CDR'],
    ['Texte de la tâche :', 'Relancer le prospect'],
    ['Déclenchement de l\'activité :', '30 jours après'],
    ['Automatisation :', 'Email template J+30'],
  ]), 'Kanban prospects');
  const [chunk] = excelToChunks(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'k.xlsx');
  const labels = chunk.body.split('\n').slice(1).map((l) => l.split(' : ')[0]);
  assert.deepEqual(labels, ['Déplacé par', 'Déclenchement de l\'activité', 'Automatisation', 'Contenu Email', 'Texte de la tâche']);
});

test('selectChunks : 3 blocs max avec titre exact, 5 sinon', () => {
  const many = Array.from({ length: 8 }, (_, i) => makeChunk('f.xlsx', `K${i} › Colonne « X »`, 'court', i));
  const map = new Map(many.map((c) => [c.id, c]));
  const fused = (phrase) => many.map((c, i) => ({ id: c.id, score: 1 - i * 0.01, vector: 0.8, bm25: 1, phrase: i === 0 ? phrase : 0 }));
  assert.equal(selectChunks(fused(5), map).chunks.length, 3);
  assert.equal(selectChunks(fused(3), map).chunks.length, 5);
  assert.equal(selectChunks(fused(0), map).chunks.length, 5);
  assert.equal(selectChunks(fused(5), map, { exactCap: 2 }).chunks.length, 2);
});

test('selectChunks : le plafond ne descend pas sous le nombre d\'expressions citées', () => {
  const many = Array.from({ length: 8 }, (_, i) => makeChunk('f.xlsx', `K${i} › Colonne « X »`, 'court', i));
  const map = new Map(many.map((c) => [c.id, c]));
  const fused = many.map((c, i) => ({ id: c.id, score: 1 - i * 0.01, vector: 0.8, bm25: 1, phrase: i < 4 ? 5 : 0 }));
  assert.equal(selectChunks(fused, map, { quoted: 4 }).chunks.length, 4);
  assert.equal(selectChunks(fused, map, { quoted: 9 }).chunks.length, 5);
});
