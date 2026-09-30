// Tests : arrêt manuel de l'IA et limite d'utilisation (tokens / messages, par période).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAiControl, BLOCKED_MESSAGE_STOPPED, BLOCKED_MESSAGE_LIMIT } from '../src/aiControl.js';

function clock(iso) {
  let date = new Date(iso);
  return { now: () => date, set: (next) => { date = new Date(next); } };
}

test('aiControl : active par défaut, limite désactivée', () => {
  const ctl = createAiControl({ file: null });
  assert.equal(ctl.blockReason(), null);
  assert.equal(ctl.blockedMessage(), null);
  ctl.record({ tokens: 1e9, messages: 1e6 });
  assert.equal(ctl.blockReason(), null, 'sans limite activée, la consommation ne coupe jamais');
});

test('aiControl : arrêt manuel puis réactivation', () => {
  const ctl = createAiControl({ file: null });
  ctl.setEnabled(false);
  assert.equal(ctl.blockReason(), 'stopped');
  assert.equal(ctl.blockedMessage(), BLOCKED_MESSAGE_STOPPED);
  assert.equal(ctl.getStatus().blockedQuestions, 1);
  ctl.setEnabled(true);
  assert.equal(ctl.blockReason(), null);
  assert.equal(ctl.getStatus().stoppedAt, null);
});

test('aiControl : limite de tokens atteinte, levée par remise à zéro', () => {
  const ctl = createAiControl({ file: null });
  ctl.setLimit({ enabled: true, type: 'tokens', max: 1000, period: 'total' });
  ctl.record({ tokens: 999 });
  assert.equal(ctl.blockReason(), null);
  ctl.record({ tokens: 1 });
  assert.equal(ctl.blockReason(), 'limit');
  assert.equal(ctl.blockedMessage(), BLOCKED_MESSAGE_LIMIT);
  ctl.resetCounter();
  assert.equal(ctl.blockReason(), null);
  assert.equal(ctl.getStatus().blockedQuestions, 0);
});

test('aiControl : limite de messages, levée en augmentant ou désactivant la limite', () => {
  const ctl = createAiControl({ file: null });
  ctl.setLimit({ enabled: true, type: 'messages', max: 2, period: 'total' });
  ctl.record({ tokens: 500, messages: 1 });
  ctl.record({ messages: 1 });
  assert.equal(ctl.blockReason(), 'limit');
  ctl.setLimit({ max: 3 });
  assert.equal(ctl.blockReason(), null);
  ctl.record({ messages: 1 });
  assert.equal(ctl.blockReason(), 'limit');
  ctl.setLimit({ enabled: false });
  assert.equal(ctl.blockReason(), null);
});

test('aiControl : l\'arrêt manuel prime sur la limite', () => {
  const ctl = createAiControl({ file: null });
  ctl.setLimit({ enabled: true, type: 'messages', max: 1, period: 'total' });
  ctl.record({ messages: 1 });
  ctl.setEnabled(false);
  assert.equal(ctl.blockReason(), 'stopped');
});

test('aiControl : limite par jour, reprise automatique le lendemain', () => {
  const c = clock('2026-09-30T10:00:00');
  const ctl = createAiControl({ file: null, now: c.now });
  ctl.setLimit({ enabled: true, type: 'messages', max: 1, period: 'day' });
  ctl.record({ messages: 1 });
  assert.equal(ctl.blockReason(), 'limit');
  c.set('2026-09-30T23:59:00');
  assert.equal(ctl.blockReason(), 'limit');
  c.set('2026-10-01T00:01:00');
  assert.equal(ctl.blockReason(), null);
  assert.equal(ctl.getStatus().usage.messages, 0);
});

test('aiControl : limite par mois, changement de période remet le compteur à zéro', () => {
  const c = clock('2026-09-30T10:00:00');
  const ctl = createAiControl({ file: null, now: c.now });
  ctl.setLimit({ enabled: true, type: 'tokens', max: 100, period: 'month' });
  ctl.record({ tokens: 150 });
  assert.equal(ctl.blockReason(), 'limit');
  c.set('2026-10-01T08:00:00');
  assert.equal(ctl.blockReason(), null);
  ctl.record({ tokens: 80 });
  ctl.setLimit({ period: 'day' });
  assert.equal(ctl.getStatus().usage.tokens, 0);
});

test('aiControl : valeurs invalides refusées sans modifier la limite', () => {
  const ctl = createAiControl({ file: null });
  const before = ctl.getStatus().limit;
  assert.throws(() => ctl.setLimit({ max: 0 }));
  assert.throws(() => ctl.setLimit({ max: 12.5 }));
  assert.throws(() => ctl.setLimit({ max: 'abc' }));
  assert.throws(() => ctl.setLimit({ type: 'euros' }));
  assert.throws(() => ctl.setLimit({ period: 'week' }));
  assert.deepEqual(ctl.getStatus().limit, before);
});

test('aiControl : état persisté et relu au redémarrage', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-control-')), 'ai_control.json');
  const first = createAiControl({ file });
  first.setEnabled(false);
  first.setLimit({ enabled: true, type: 'messages', max: 5, period: 'total' });
  first.record({ messages: 2 });

  const second = createAiControl({ file });
  const status = second.getStatus();
  assert.equal(status.reason, 'stopped');
  assert.deepEqual(status.limit, { enabled: true, type: 'messages', max: 5, period: 'total' });
  assert.equal(status.usage.messages, 2);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
