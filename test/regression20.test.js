// Régression du découpage et de la recherche : pour 20 questions réelles (mode Collaborateur),
// les blocs sélectionnés doivent contenir tous les faits attendus. Recherche lexicale seule (sans
// LLM ni embeddings), avec les paramètres de production (variables RAG_*).
//
// Documents : dossier Collaborateur (hors dépôt, confidentiel). Chemin dans RAG_TEST_DOCS ;
// sans lui, le test est ignoré.
//   RAG_TEST_DOCS="C:/…/Collaborateur" npm test
// Cas connu (n° 20) : « 72H » appartient à la colonne suivante (« mail lu ») ; la question est
// ambiguë, on vérifie seulement que la recherche ramène aussi ce bloc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileToChunks } from '../src/ingestion.js';
import { BM25Index, retrieve, ragOptionsFromEnv, normalize } from '../src/ragBoost.js';

const CASES = [
  ['Un prospect arrive dans « Nouvelle demande » sans formation renseignée. Que se passe-t-il, après combien de temps, et pour quelles sources cette règle ne s\'applique-t-elle pas ?', ['30 minutes', 'JobBoard', 'Site ESPL']],
  ['Quelles automatisations se déclenchent à l\'arrivée d\'une fiche dans « Nouvelle demande » ?', ['observateur', 'calendly']],
  ['Quel est le contenu du mail automatique envoyé en « Doc. générale envoyée », et quelle activité est créée pour le CDR et quand ?', ['vidéo de présentation', '24h']],
  ['Que se passe-t-il si le prospect n\'ouvre pas le mail envoyé en « Doc. qualifiée envoyée » ?', ['7 jours', '1ère relance']],
  ['Donne les délais de déclenchement des activités de relance dans les colonnes « Mail Lu / 1ère relance », « 2ème relance », « 3ème relance » et « Relance J+30 ».', ['48h', '5 jours', '15 jours', '30 jours']],
  ['À quelles heures est-il recommandé de relancer téléphoniquement un prospect, et que faire après la 4ème activité de relance si aucun RDV n\'est fixé ?', ['entre 12h et 14h', 'Injoignable']],
  ['Un prospect est en « Intéressé » avec un scoring de 3. Dans quel délai le RDV doit-il être pris, et que se passe-t-il ensuite dans le process ?', ['1 semaine', 'RDV Positionné', '2 mois']],
  ['Quel email automatique part en « Relance J+30 » et en « Procédure Hors UE » ?', ['template J+30', 'MyFrench DEGREE']],
  ['Qui déplace les fiches vers « Candidat non présenté » et « RDV réalisé », et quelle activité est déclenchée sur « Candidat non présenté » ?', ['CDF', 'motif de l\'absence']],
  ['Dans le kanban d\'admission, que se passe-t-il quand une fiche arrive dans « Admis » selon le champ « Type de formation » ?', ['kanban INI', 'kanban ALT', 'Doublon']],
  ['Quelles sont les automatisations et activités de la colonne « RDV réalisé » du kanban d\'admission ?', ['flyer parrainage', '7 jours', 'observateur']],
  ['Délais des activités des colonnes « En liste d\'attente » et « Commission » du kanban d\'admission ?', ['1 mois', '7 jours']],
  ['Dans le kanban Initial, que fait l\'automatisation de la colonne « Informations financement complémentaires » et quelle condition peut la bloquer ?', ['Génération du compte', 'Inscrit Parcoursup']],
  ['Comment fonctionne l\'approbation du contrat d\'études selon le campus ?', ['Angers', 'Nantes', 'approbation']],
  ['Quel est l\'ensemble des automatisations de la colonne « Facturation » du kanban Initial ?', ['SFPC', 'attestation d\'inscription', '2 répondants financiers']],
  ['Quand une fiche arrive-t-elle dans « Erreur lors de la mise en facturation » ?', ['informations sont manquantes', 'Bo-MyCampus']],
  ['Quel est le délai de réservation de place annoncé dans l\'email classique de confirmation de double inscription ?', ['15 jours']],
  ['Quelles tâches sont créées quand une fiche Initial passe en « Rupture », pour qui, avec quelle deadline ?', ['Rupture {{Dénomination}}', '5 jours', 'Valider montant du remboursement']],
  ['Dans le kanban Alternant, comment fonctionne le scoring de la colonne « Accompagnement » ?', ['95%', '20%']],
  ['Qu\'est-ce qui fait arriver une fiche dans la colonne « Envoi Formulaire Apprenti » du kanban Alternant, et que se passe-t-il 48h puis 72h après ?', ['Envoi fiche mémo', '48h', '72H']],
];

const DOCS = process.env.RAG_TEST_DOCS;
// Comparaison sans accents, sans casse, espaces et apostrophes unifiés
const flat = (s) => normalize(s).replace(/\s+/g, ' ');

test('régression : faits attendus dans les blocs sélectionnés (20 questions)', async (t) => {
  if (!DOCS || !fs.existsSync(DOCS)) return t.skip('RAG_TEST_DOCS non défini (dossier Collaborateur)');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const chunks = [];
  for (const f of walk(DOCS)) {
    try {
      chunks.push(...(await fileToChunks(fs.readFileSync(f), path.extname(f).toLowerCase(), f.split(path.sep).join('/'))));
    } catch { /* format non pris en charge */ }
  }
  const bm25 = new BM25Index(chunks);
  const chunksById = new Map(chunks.map((c) => [c.id, c]));
  const missing = [];
  for (const [i, [question, facts]] of CASES.entries()) {
    const sel = await retrieve({ question, bm25, chunksById, options: ragOptionsFromEnv() });
    const ctx = flat(sel.chunks.map((c) => c.embedText).join('\n'));
    const absent = facts.filter((f) => !ctx.includes(flat(f)));
    if (absent.length) missing.push(`#${i + 1} : ${absent.join(' ; ')}  (→ ${sel.chunks.map((c) => c.source).join(' | ')})`);
  }
  assert.deepEqual(missing, [], `faits absents des blocs :\n${missing.join('\n')}`);
});
