// ragBoost.js — Améliorations RAG sans appel LLM supplémentaire
// ------------------------------------------------------------------
// Tout ce module tourne en local (CPU / RAM). Il ne fait AUCUN appel à
// mistral-small. Il réduit au contraire le nombre de tokens envoyés au LLM.
//
// Utilisation :
//   - ingestion (src/ingestion.js) : excelToChunks / docxToChunks → blocs
//     { id, file, section, source, body, embedText } ; on vectorise embedText.
//   - recherche (src/bot.js, scripts/evalRetrieval.js) : retrieve() enchaîne
//     expandQuery → recherche vectorielle → hybridRank → selectChunks.
//   - génération : formatExtraits, trimHistory, checkCitations, AnswerCache.
// ------------------------------------------------------------------

import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

// Estimation grossière (tokenizer Tekken ≈ 3,6 caractères/token en français)
export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

const clean = (v) =>
  v === null || v === undefined
    ? ''
    : String(v).replace(/ /g, ' ').replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();

export function makeChunk(file, section, body, i) {
  const source = section ? `${file} › ${section}` : file;
  return {
    id: `${file}#${section || ''}#${i}`,
    file,
    section,
    source,
    body,
    // Le fil d'Ariane est embarqué dans le texte vectorisé : la recherche
    // « sait » de quel kanban / de quelle colonne parle le bloc.
    embedText: `${source}\n${body}`,
  };
}

// Découpe un texte trop long en morceaux ≤ maxChars, sur les fins de ligne
// puis de phrase, sans jamais couper un mot.
export function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let cur = '';
  const units = text.split(/(?<=\n)|(?<=[.!?])\s+/);
  for (const u of units) {
    if ((cur + u).length > maxChars && cur) { parts.push(cur.trim()); cur = ''; }
    if (u.length > maxChars) {
      for (let i = 0; i < u.length; i += maxChars) parts.push(u.slice(i, i + maxChars).trim());
    } else cur += (cur && !cur.endsWith('\n') ? ' ' : '') + u;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ================================================================
// 1. EXCEL : une fiche par colonne (étape) au lieu d'une ligne large
// ================================================================
// Dans « CRM Kanban commercial.xlsx », les colonnes sont les étapes du
// kanban et les lignes des attributs (« Déplacé par : », « Activité : »…).
// Découper par ligne oblige le LLM à aligner la 9e cellule avec le 9e
// en-tête : c'est la source des réponses « décalées ». Ici chaque bloc
// contient UNE étape et tous ses attributs, déjà étiquetés.

function isAttributeSheet(rows) {
  const labels = rows.slice(1).map((r) => clean(r[0])).filter(Boolean);
  if (labels.length < 2) return false;
  const withColon = labels.filter((l) => /:\s*$/.test(l)).length;
  return withColon / labels.length >= 0.5;
}

function columnChunks(rows, file, sheet, maxChars) {
  // Une feuille peut contenir plusieurs tableaux empilés : un nouveau bloc
  // commence à chaque ligne qui répète le libellé de la 1re ligne.
  const headLabel = clean(rows[0][0]);
  const blocks = [];
  for (const r of rows) {
    if (clean(r[0]) === headLabel || !blocks.length) blocks.push([]);
    blocks[blocks.length - 1].push(r);
  }
  const out = [];
  blocks.forEach((block, bi) => {
    const header = block[0];
    const stages = [];
    for (let c = 1; c < header.length; c++) if (clean(header[c])) stages.push(c);
    stages.forEach((c, si) => {
      const stage = clean(header[c]);
      const lines = [];
      const prev = si > 0 ? clean(header[stages[si - 1]]) : null;
      const next = si < stages.length - 1 ? clean(header[stages[si + 1]]) : null;
      lines.push(`Position : étape ${si + 1}/${stages.length}` +
        (prev ? ` ; précédente « ${prev} »` : '') + (next ? ` ; suivante « ${next} »` : ''));
      for (const r of block.slice(1)) {
        const label = clean(r[0]).replace(/\s*:\s*$/, '');
        const val = clean(r[c]);
        if (label && val) lines.push(`${label} : ${val}`);   // cellules vides ignorées
      }
      if (lines.length <= 1) return;
      const section = `${sheet}${blocks.length > 1 ? ` (tableau ${bi + 1})` : ''} › Colonne « ${stage} »`;
      splitText(lines.join('\n'), maxChars).forEach((body, i) =>
        out.push(makeChunk(file, section, body, i)));
    });
  });
  return out;
}

function rowChunks(rows, file, sheet, maxChars) {
  // Tableau classique (1 ligne = 1 enregistrement) : chaque ligne devient
  // « En-tête : valeur ; En-tête : valeur », cellules vides supprimées.
  const header = rows[0].map(clean);
  const out = [];
  let buf = '';
  let n = 0;
  for (const r of rows.slice(1)) {
    const rec = header.map((h, i) => (clean(r[i]) ? `${h || `Col${i + 1}`} : ${clean(r[i])}` : ''))
      .filter(Boolean).join(' ; ');
    if (!rec) continue;
    if ((buf + rec).length > maxChars && buf) { out.push(makeChunk(file, sheet, buf.trim(), n++)); buf = ''; }
    for (const piece of splitText(rec, maxChars)) {
      if ((buf + piece).length > maxChars && buf) { out.push(makeChunk(file, sheet, buf.trim(), n++)); buf = ''; }
      buf += piece + '\n';
    }
  }
  if (buf.trim()) out.push(makeChunk(file, sheet, buf.trim(), n));
  return out;
}

export function excelToChunks(buffer, file, { maxChars = 1400, orientation = 'auto' } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = [];
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: null, blankrows: false });
    if (!rows.length) continue;
    const mode = orientation === 'auto' ? (isAttributeSheet(rows) ? 'columns' : 'rows') : orientation;
    out.push(...(mode === 'columns'
      ? columnChunks(rows, file, sheet, maxChars)
      : rowChunks(rows, file, sheet, maxChars)));
  }
  return out;
}

// ================================================================
// 2. WORD : blocs rattachés à leur chemin de titres (H1 › H2 › H3)
// ================================================================
const NOISE = /^(version texte intégrale|table des matières|sommaire)/i;

export async function docxToChunks(buffer, file, { maxChars = 1400, minChars = 700, mergeLevel = 1 } = {}) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const path = [];
  const out = [];
  let buf = '';
  let n = 0;
  let skipToc = false;
  const flush = () => {
    if (buf.trim()) splitText(buf.trim(), maxChars).forEach((b) =>
      out.push(makeChunk(file, path.filter(Boolean).join(' › '), b, n++)));
    buf = '';
  };
  const re = /<(h[1-6]|p|li|tr)[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const text = tag === 'tr'
      ? m[2].split(/<\/t[dh]>/).map(decode).filter(Boolean).join(' | ')
      : decode(m[2]);
    if (!text) continue;
    if (tag[0] === 'h') {
      const level = Number(tag[1]);
      // Petits sous-titres fusionnés dans le bloc courant tant qu'il reste court :
      // évite des blocs de 2 lignes qui séparent une règle de ses détails
      // (ex. « Code société », « Code marque », « Code cycle » du document Teams).
      if (level > mergeLevel && buf && buf.length < minChars && !skipToc && !NOISE.test(text)) {
        path.length = Math.min(path.length, level - 1);   // le bloc prend le titre parent
        buf += `— ${text} —\n`;
        continue;
      }
      flush();
      path.length = level - 1;
      path[level - 1] = text;
      skipToc = NOISE.test(text);            // on saute le contenu du sommaire
      continue;
    }
    if (skipToc || NOISE.test(text)) continue;
    if ((buf + text).length > maxChars) flush();
    buf += text + '\n';
  }
  flush();
  return out;
}

// ================================================================
// 3. RECHERCHE LEXICALE BM25 (en RAM, 0 token)
// ================================================================
// Les embeddings captent le sens mais ratent les libellés exacts
// (« Doc. qualifiée envoyée », « Relance J+30 », « CTRL AP »…). BM25 les
// retrouve à coup sûr. On fusionne les deux classements.

const STOP = new Set(('le la les de des du un une et ou en au aux a dans pour par sur avec est sont ' +
  'que qui quoi quel quelle quels quelles ce cette ces se sa son ses il elle on ne pas plus comment ' +
  'quand lors fait faire se passe il y dont etre avoir d l qu c s j n t m').split(' '));

export const normalize = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');

const stem = (t) => {
  if (t.length <= 4 || /\d/.test(t)) return t;
  for (const suf of ['ements', 'ement', 'ations', 'ation', 'ees', 'ee', 'es', 'e', 's', 'x']) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) return t.slice(0, -suf.length);
  }
  return t;
};

export const tokenize = (s) =>
  normalize(s).split(/[^a-z0-9+]+/).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);

export class BM25Index {
  constructor(chunks, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = chunks.map((c) => {
      const toks = tokenize(c.embedText);
      const tf = new Map();
      toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      const flat = (s) => normalize(s).replace(/[^a-z0-9+]+/g, ' ').trim();
      const title = (c.section || '').split(' › ').pop();
      return { id: c.id, len: toks.length, tf, normSection: flat(c.section || ''), normTitle: flat(title), normFlat: flat(c.embedText) };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
    this.df = new Map();
    this.docs.forEach((d) => d.tf.forEach((_, t) => this.df.set(t, (this.df.get(t) || 0) + 1)));
  }
  idf(t) {
    const N = this.docs.length, df = this.df.get(t) || 0;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }
  search(query, k = 30) {
    const qt = [...new Set(tokenize(query))];
    const res = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of qt) {
        const f = d.tf.get(t);
        if (!f) continue;
        s += this.idf(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / this.avgLen));
      }
      if (s > 0) res.push({ id: d.id, score: s });
    }
    return res.sort((a, b) => b.score - a.score).slice(0, k);
  }
  // Blocs contenant mot pour mot les expressions entre guillemets de la question.
  // Un bloc dont le TITRE (colonne, section) est l'expression pèse 3 fois plus
  // qu'un bloc qui la mentionne seulement dans son texte.
  phraseHits(query) {
    const phrases = [...String(query).matchAll(/[«“"]\s*([^»”"]{3,80}?)\s*[»”"]/g)]
      .map((m) => normalize(m[1]).replace(/[^a-z0-9+]+/g, ' ').trim()).filter(Boolean);
    if (!phrases.length) return [];
    return this.docs
      .map((d) => {
        let s = 0;
        for (const p of phrases) {
          if (d.normTitle === p || d.normTitle === `colonne ${p}`) s += 5;   // titre exact
          else if (` ${d.normSection} `.includes(` ${p} `)) s += 3;            // dans le titre
          else if (d.normFlat.includes(p)) s += 1;                            // dans le texte
        }
        return { id: d.id, score: s };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

// ================================================================
// 4. EXPANSION DES SIGLES (0 token LLM : dictionnaire local)
// ================================================================
export const GLOSSAIRE = {
  CDR: 'chargé de recrutement', CDF: 'conseiller de formation', AP: 'assistant pédagogique',
  RF: 'référent filière responsable filière', ADV: 'administration des ventes',
  ALT: 'alternant alternance', INI: 'initial formation initiale', FI: 'formation initiale',
  FA: 'formation alternance', DI: 'double inscription droit à l\'image', CL: 'candidat libre',
  CE: 'contrat d\'études', SFPC: 'stagiaire de la formation continue', RI: 'règlement intérieur',
  HP: 'Hyperplanning', OPCO: 'opérateur de compétences', CVEC: 'contribution vie étudiante',
  UAI: 'numéro UAI école', SPA: 'automatisation intelligente de processus', CTRL: 'contrôle',
  RQTH: 'travailleur handicapé', VAE: 'validation des acquis de l\'expérience',
};

// Sens inverse : mots courants → nom réel des onglets / kanbans dans les fichiers
export const ALIAS = {
  'kanban initial': 'INI', 'kanban alternant': 'ALT', 'kanban entreprise': 'Entreprise',
  'formation tuteur': 'tuteur', 'stagiaire de la formation continue': 'SFPC',
};

export function expandQuery(query, glossary = GLOSSAIRE, alias = ALIAS) {
  const add = [];
  for (const [sigle, long] of Object.entries(glossary)) {
    if (new RegExp(`\\b${sigle}\\b`).test(query)) add.push(long);
  }
  const nq = normalize(query);
  for (const [k, v] of Object.entries(alias)) if (nq.includes(normalize(k))) add.push(v);
  return add.length ? `${query} (${add.join(' ; ')})` : query;
}

// ================================================================
// 5. FUSION DES CLASSEMENTS (Reciprocal Rank Fusion)
// ================================================================
export function hybridRank({ query, vectorResults = [], bm25, k = 60,
  weights = { vector: 1, bm25: 1, phrase: 1.5 } }) {
  const lists = [
    ['vector', vectorResults],
    ['bm25', bm25 ? bm25.search(query, 30) : []],
    ['phrase', bm25 ? bm25.phraseHits(query) : []],
  ];
  const acc = new Map();
  for (const [name, list] of lists) {
    list.forEach((r, rank) => {
      const e = acc.get(r.id) || { id: r.id, score: 0, vector: null, bm25: null, phrase: 0 };
      // Guillemets : contribution proportionnelle au score (titre exact = 5,
      // titre partiel = 3, simple mention = 1) plutôt qu'au rang.
      e.score += name === 'phrase'
        ? weights.phrase * r.score / (k + 1) / 2
        : weights[name] / (k + rank + 1);
      e[name] = r.score;
      acc.set(r.id, e);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

// ================================================================
// 6. SÉLECTION SOUS BUDGET + SEUIL DE CONFIANCE
// ================================================================
// - N'envoie que ce qui tient dans le budget (moins de tokens qu'un top 5 fixe).
// - Coupe dès que la pertinence chute (inutile d'envoyer 5 blocs si 2 suffisent).
// - Si rien n'est assez pertinent : pas d'appel LLM, formule de repli directe.
//   minVector est à calibrer sur le jeu de test (voir scripts/evalRetrieval.js).
export function selectChunks(fused, chunksById, {
  maxChunks = 5, tokenBudget = 1400, relativeCut = 0.3, minVector = null,
} = {}) {
  const top = fused[0];
  const confident = !!top && (
    top.phrase > 0 ||
    (minVector === null ? true : (top.vector ?? 0) >= minVector) ||
    (top.bm25 !== null && top.vector !== null)          // les deux moteurs d'accord
  );
  const chunks = [];
  let used = 0;
  for (const f of fused) {
    if (chunks.length >= maxChunks) break;
    if (chunks.length && f.score < top.score * relativeCut) break;
    const c = chunksById.get(f.id);
    if (!c) continue;
    const t = estimateTokens(c.source + c.body) + 6;
    if (chunks.length && used + t > tokenBudget) continue;
    chunks.push(c); used += t;
  }
  return { confident, chunks, tokens: used };
}

export function formatExtraits(chunks) {
  return '<EXTRAITS>\n' +
    chunks.map((c, i) => `[${i + 1}] Source : ${c.source}\n${c.body}`).join('\n\n') +
    '\n</EXTRAITS>';
}

// ================================================================
// 6 bis. CHAÎNE DE RECHERCHE COMPLÈTE (partagée prod / évaluation)
// ================================================================
const envNumber = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

// Paramètres réglables par variables d'environnement (RAG_MIN_VECTOR vide = seuil désactivé).
// Budget par défaut 1 150 tokens (et non 1 400) : mesuré sur le jeu de 118 questions, c'est la
// valeur qui garde les extraits sous le volume de l'ancienne chaîne (top 5 fixe ≈ 1 040 tokens).
export function ragOptionsFromEnv(env = process.env) {
  return {
    tokenBudget: envNumber(env.RAG_TOKEN_BUDGET, 1150),
    maxChunks: envNumber(env.RAG_MAX_CHUNKS, 5),
    relativeCut: envNumber(env.RAG_RELATIVE_CUT, 0.3),
    minVector: envNumber(env.RAG_MIN_VECTOR, null),
  };
}

// question → expandQuery → recherche vectorielle (callback, top 30) → hybridRank → selectChunks.
// vectorSearch(expandedQuery) doit renvoyer [{ id, score }] déjà filtrés par mode ; il est
// optionnel (évaluation en recherche lexicale seule).
export async function retrieve({ question, bm25, chunksById, vectorSearch = null, options = {} }) {
  const query = expandQuery(question);
  const vectorResults = vectorSearch ? await vectorSearch(query) : [];
  const fused = hybridRank({ query, vectorResults, bm25 });
  const sel = selectChunks(fused, chunksById, options);
  return { query, fused, top: fused[0] || null, ...sel };
}

// ================================================================
// 7. HISTORIQUE ALLÉGÉ
// ================================================================
// Garde les 2 derniers échanges, retire les citations et tronque les
// réponses longues : le sujet reste reconstituable, pour beaucoup moins de tokens.
export function trimHistory(messages, { maxTurns = 2, maxAssistantChars = 350 } = {}) {
  const kept = messages.slice(-maxTurns * 2);
  return kept.map((m) => {
    if (m.role !== 'assistant') return m;
    let t = String(m.content).replace(/D['’]après (le|les) documents?[^\n]*/gi, '').trim();
    if (t.length > maxAssistantChars) t = t.slice(0, maxAssistantChars).replace(/\s+\S*$/, '') + '…';
    return { ...m, content: t };
  });
}

// ================================================================
// 8. CONTRÔLE DES CITATIONS (post-traitement, 0 token)
// ================================================================
// Supprime les noms de fichiers cités qui n'étaient pas dans les extraits
// envoyés, et signale les réponses « suspectes » pour le tableau /stats.
const FILE_RE = /[^\n,;«»"]+?\.(?:docx?|xlsx?|pdf|csv|txt|pptx?)/gi;

export function checkCitations(answer, chunks) {
  const allowed = [...new Set(chunks.map((c) => c.file.trim()))]
    .sort((a, b) => b.length - a.length);                 // noms les plus longs d'abord
  const cited = [];
  const invalid = [];
  const text = answer.replace(/D['’]après (?:le|les) documents? ([^\n]+)/gi, (line, names) => {
    // Les noms autorisés sont reconnus par inclusion : certains contiennent des virgules
    // (« Les dépendances - Contacts, Prospects, Transactions, etc.docx ») que FILE_RE couperait.
    let rest = names;
    const ok = [];
    for (const f of allowed) {
      if (rest.includes(f)) { ok.push(f); rest = rest.split(f).join(' '); }
    }
    const bad = (rest.match(FILE_RE) || []).map((f) => f.replace(/^\s*(et|,)\s*/i, '').trim()).filter(Boolean);
    cited.push(...ok);
    invalid.push(...bad);
    if (!ok.length) return '';
    return ok.length === 1 ? `D'après le document ${ok[0]}` : `D'après les documents ${ok.join(', ')}`;
  }).trim();
  const tagged = /\[(SANS_REPONSE|NON-CONFORME)\]/.test(answer);
  return { text, cited, invalid, suspect: invalid.length > 0 || (!cited.length && !tagged) };
}

// ================================================================
// 9. CACHE DE RÉPONSES (0 token pour les questions déjà posées)
// ================================================================
export class AnswerCache {
  constructor({ ttlMs = 7 * 24 * 3600e3, max = 2000 } = {}) { this.ttl = ttlMs; this.max = max; this.m = new Map(); }
  key({ mode, formation = '', question, indexVersion }) {
    return [mode, normalize(formation), tokenize(question).sort().join(' '), indexVersion].join('|');
  }
  get(k) { const e = this.m.get(k); if (!e || Date.now() - e.t > this.ttl) return null; return e.v; }
  set(k, v) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, t: Date.now() });
  }
}
// Ne mettre en cache que les questions sans historique (pas les questions de suivi),
// et changer indexVersion à chaque synchronisation OneDrive.
