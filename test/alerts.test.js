// Tests : alertes Bitrix (changements d'état de l'IA, disponibilité de Mistral, envoi webhook).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiControl } from '../src/aiControl.js';
import {
  sendBitrixMessage, describeAiTransition, describeStartup, createMistralMonitor,
} from '../src/alerts.js';

function recorder() {
  const ctl = createAiControl({ file: null });
  const events = [];
  ctl.onChange(e => events.push(e));
  return { ctl, events };
}

test('aiControl.onChange : arrêt puis réactivation manuels', () => {
  const { ctl, events } = recorder();
  ctl.setEnabled(false);
  ctl.setEnabled(false); // déjà arrêtée : pas de nouvel événement
  ctl.setEnabled(true);
  assert.deepEqual(events.map(e => [e.from, e.to, e.cause]), [[null, 'stopped', 'manual'], ['stopped', null, 'manual']]);
  assert.match(describeAiTransition(events[0]), /IA arrêtée manuellement/);
  assert.match(describeAiTransition(events[1]), /IA relancée.*réactivation manuelle/);
});

test('aiControl.onChange : limite atteinte puis levée (remise à zéro, désactivation)', () => {
  const { ctl, events } = recorder();
  ctl.setLimit({ enabled: true, type: 'messages', max: 2, period: 'total' });
  ctl.record({ messages: 1 });
  assert.equal(events.length, 0);
  ctl.record({ messages: 1 });
  ctl.record({ messages: 1 }); // déjà coupée : un seul événement
  assert.deepEqual(events.map(e => [e.from, e.to, e.cause]), [[null, 'limit', 'usage']]);
  assert.match(describeAiTransition(events[0]), /Limite d'utilisation atteinte[\s\S]*2 \/ 2 messages/);

  ctl.resetCounter();
  assert.match(describeAiTransition(events[1]), /IA relancée.*compteur remis à zéro/);
  ctl.record({ messages: 2 });
  ctl.setLimit({ enabled: false });
  assert.match(describeAiTransition(events[3]), /IA relancée.*limite désactivée/);
});

test('aiControl.onChange : reprise automatique à la nouvelle période', () => {
  let date = new Date('2026-09-30T10:00:00');
  const ctl = createAiControl({ file: null, now: () => date });
  const events = [];
  ctl.onChange(e => events.push(e));
  ctl.setLimit({ enabled: true, type: 'tokens', max: 10, period: 'day' });
  ctl.record({ tokens: 10 });
  date = new Date('2026-10-01T00:05:00');
  assert.equal(ctl.blockReason(), null);
  assert.deepEqual(events.map(e => [e.to, e.cause]), [['limit', 'usage'], [null, 'period']]);
  assert.match(describeAiTransition(events[1]), /nouvelle période/);
});

test('aiControl.onChange : réactivation alors que la limite est toujours atteinte', () => {
  const { ctl, events } = recorder();
  ctl.setLimit({ enabled: true, type: 'messages', max: 1, period: 'month' });
  ctl.setEnabled(false);
  ctl.record({ messages: 1 });
  ctl.setEnabled(true);
  const last = events.at(-1);
  assert.deepEqual([last.from, last.to], ['stopped', 'limit']);
  assert.match(describeAiTransition(last), /toujours atteinte/);
});

test('aiControl.onChange : une erreur de l\'écouteur ne bloque pas la modification', () => {
  const ctl = createAiControl({ file: null });
  ctl.onChange(() => { throw new Error('boom'); });
  ctl.setEnabled(false);
  assert.equal(ctl.blockReason(), 'stopped');
});

test('sendBitrixMessage : appel im.message.add avec DIALOG_ID et MESSAGE', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ result: 1 }) };
  };
  const ok = await sendBitrixMessage('Bonjour', { fetchImpl, env: { API_BITRIX: 'https://x.bitrix24.fr/rest/1/abc' } });
  assert.equal(ok, true);
  assert.equal(calls[0].url, 'https://x.bitrix24.fr/rest/1/abc/im.message.add');
  assert.deepEqual(calls[0].body, { DIALOG_ID: 'chat127512', MESSAGE: 'Bonjour' });
});

test('sendBitrixMessage : sans API_BITRIX ou en erreur, ne lève jamais', async () => {
  assert.equal(await sendBitrixMessage('x', { env: {}, fetchImpl: () => assert.fail('pas d\'appel') }), false);
  const failing = async () => { throw new Error('réseau'); };
  assert.equal(await sendBitrixMessage('x', { env: { API_BITRIX: 'https://x/' }, fetchImpl: failing }), false);
  const refused = async () => ({ ok: false, status: 401, json: async () => ({ error: 'INVALID_CREDENTIALS' }) });
  assert.equal(await sendBitrixMessage('x', { env: { API_BITRIX: 'https://x/' }, fetchImpl: refused }), false);
});

test('mistralMonitor : une alerte par incident, un message au rétablissement', () => {
  const sent = [];
  const monitor = createMistralMonitor(async (m) => { sent.push(m); return true; });
  monitor.reportSuccess();
  assert.equal(sent.length, 0);
  monitor.reportFailure(Object.assign(new Error('QUOTA_EXHAUSTED'), { isQuotaExhausted: true }));
  monitor.reportFailure(new Error('encore'));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ne parvient plus à joindre Mistral.*quota/);
  monitor.reportSuccess();
  monitor.reportSuccess();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Mistral répond de nouveau[\s\S]*2 question\(s\) en échec/);
});

test('describeStartup : état restauré au démarrage', () => {
  const ctl = createAiControl({ file: null });
  assert.match(describeStartup(ctl.getStatus()), /Chatbot démarré[\s\S]*normalement/);
  ctl.setEnabled(false);
  assert.match(describeStartup(ctl.getStatus()), /toujours \[b\]arrêtée manuellement/);
});
