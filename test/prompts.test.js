// Garde-fous sur les prompts système : règles anti-refus du mode Collaborateur et taille maximale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPTS } from '../src/bot.js';

// Longueur (caractères) des prompts d'origine, avant le chantier RAG : les prompts actuels
// doivent rester plus courts (contrainte : pas plus de tokens par question qu'à l'origine).
const ORIGINAL_CHARS = { etudiant: 7964, collaborateur: 7037, defaut: 7577 };

test('prompts : plus courts que les prompts d\'origine', () => {
  for (const [mode, max] of Object.entries(ORIGINAL_CHARS)) {
    assert.ok(SYSTEM_PROMPTS[mode].length < max, `${mode} : ${SYSTEM_PROMPTS[mode].length} ≥ ${max}`);
  }
});

test('prompt Collaborateur : v3 actif, aucun renvoi abusif', () => {
  const p = SYSTEM_PROMPTS.collaborateur;
  assert.match(p, /\(mode Collaborateur\)/);
  assert.match(p, /Si un extrait retenu traite l'objet demandé/);
  assert.match(p, /Complétude :/);
  assert.match(p, /ne renvoie jamais vers le mode « Étudiant », un référent, un service ou le support/);
  for (const outil of ['Teams', 'WhatCRM', 'SMS', 'Brevo', 'fusion de fiches', 'signatures e-mail', 'rentrée']) {
    assert.ok(p.includes(outil), `périmètre : ${outil}`);
  }
  assert.doesNotMatch(p, /référent RH|service scolarité/);
  assert.match(p, /\[SANS_REPONSE\] Je ne sais pas répondre .* https:\/\/form\.jotform\.com\/243012118488049 »/);
  assert.doesNotMatch(p, /En cas de doute entre répondre et ne pas répondre/);
});

test('prompt Étudiant : aucun lien vers le formulaire support', () => {
  assert.doesNotMatch(SYSTEM_PROMPTS.etudiant, /jotform/);
  assert.doesNotMatch(SYSTEM_PROMPTS.defaut, /jotform|mode « Collaborateur »/);
});
