// Tests : salutations sans appel LLM, questions de clarification (choix numérotés + « Autres »).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smallTalkReply, parseClarificationOptions, resolveClarification } from '../src/conversation.js';
import { finalizeAnswer } from '../src/finalizeAnswer.js';
import { makeChunk } from '../src/ragBoost.js';
import { SYSTEM_PROMPTS } from '../src/bot.js';

const MORNING = new Date('2026-09-30T08:00:00Z');   // 10 h à Paris
const EVENING = new Date('2026-09-30T18:30:00Z');   // 20 h 30 à Paris

test('smallTalkReply : salutation complète et chaleureuse, jamais un simple « bonjour »', () => {
  for (const m of ['bonjour', 'Bonjour !', 'BONJOUR', 'salut', 'Hello', 'bonjour à vous', 'Bonjour, comment ça va ?', 'coucou']) {
    const r = smallTalkReply(m, '', MORNING);
    assert.ok(r, m);
    assert.match(r, /^Bonjour ! Comment allez-vous aujourd'hui \? Je suis à votre disposition/);
  }
  assert.match(smallTalkReply('bonjour', 'Camille', MORNING), /^Bonjour Camille !/);
  assert.match(smallTalkReply('bonsoir', '', MORNING), /^Bonsoir !/);
  assert.match(smallTalkReply('salut', '', EVENING), /^Bonsoir !/);
});

test('smallTalkReply : remerciements et au revoir', () => {
  assert.match(smallTalkReply('merci', 'Camille'), /^Je vous en prie Camille, avec plaisir/);
  assert.match(smallTalkReply('Merci beaucoup !'), /^Je vous en prie/);
  assert.match(smallTalkReply('super merci'), /^Je vous en prie/);
  assert.match(smallTalkReply('Au revoir, merci'), /ce fut un plaisir/);
  assert.match(smallTalkReply('bonne journée'), /Belle journée/);
});

test('smallTalkReply : une vraie question n\'est jamais interceptée', () => {
  for (const m of ['Bonjour, quand sont les examens ?', 'merci de me dire comment poser une absence',
    'salut, comment fusionner deux fiches ?', 'Comment ça marche le kanban ?', 'ok et pour le BTS ?']) {
    assert.equal(smallTalkReply(m), null, m);
  }
});

const CLARIF = "De quel formulaire parlez-vous ?\n1. Formulaire de rentrée\n2. Formulaire de stage\n3. **Formulaire de démission**\n4. Autres (à préciser)";

test('parseClarificationOptions : choix numérotés, « Autres » repéré', () => {
  assert.deepEqual(parseClarificationOptions(CLARIF), [
    { n: 1, label: 'Formulaire de rentrée', other: false },
    { n: 2, label: 'Formulaire de stage', other: false },
    { n: 3, label: 'Formulaire de démission', other: false },
    { n: 4, label: 'Autres (à préciser)', other: true },
  ]);
});

test('resolveClarification : numéro, intitulé, « Autres » seul, précision libre', () => {
  const options = parseClarificationOptions(CLARIF);
  assert.deepEqual(resolveClarification('2', options), { type: 'option', label: 'Formulaire de stage' });
  assert.deepEqual(resolveClarification('2. Formulaire de stage', options), { type: 'option', label: 'Formulaire de stage' });
  assert.deepEqual(resolveClarification('le 3', options), { type: 'option', label: 'Formulaire de démission' });
  assert.deepEqual(resolveClarification('formulaire de rentree', options), { type: 'option', label: 'Formulaire de rentrée' });
  assert.deepEqual(resolveClarification('4', options), { type: 'other' });
  assert.deepEqual(resolveClarification('Autres', options), { type: 'other' });
  assert.deepEqual(resolveClarification('4. Autres (à préciser)', options), { type: 'other' });
  assert.deepEqual(resolveClarification('4. le formulaire de VAE', options), { type: 'free', text: 'le formulaire de VAE' });
  assert.deepEqual(resolveClarification('autre : le formulaire de VAE', options), { type: 'free', text: 'le formulaire de VAE' });
  assert.deepEqual(resolveClarification('celui pour la VAE', options), { type: 'free', text: 'celui pour la VAE' });
});

test('finalizeAnswer : aucune source ajoutée à une question de clarification', () => {
  const chunk = makeChunk('Formulaires.docx', 'Stage', 'Formulaire de stage à remplir avant le départ.', 0);
  const r = finalizeAnswer(`[CLARIFICATION] ${CLARIF}`, [chunk]);
  assert.deepEqual(r.files, []);
  assert.doesNotMatch(r.text, /D'après/);
});

test('prompts : règle de ton et de clarification dans les trois modes', () => {
  for (const [mode, p] of Object.entries(SYSTEM_PROMPTS)) {
    assert.match(p, /# TON ET CLARIFICATION/, mode);
    assert.match(p, /\[CLARIFICATION\]/, mode);
    assert.match(p, /« Autres \(à préciser\) »/, mode);
  }
});
