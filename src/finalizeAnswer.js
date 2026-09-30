import { tokenize } from './ragBoost.js';

// Réponses qui ne s'appuient sur aucun extrait et ne doivent donc recevoir aucune source :
// demande de formation (PÉRIMÈTRE DE FORMATION) et refus de sécurité (SÉCURITÉ). Les réponses
// balisées (repli, hors périmètre, question de clarification) n'en reçoivent pas non plus.
const NO_SOURCE = /pouvez-vous m['’]indiquer votre formation et votre ann[ée]e|Je ne peux pas d[ée]tailler mon fonctionnement interne/i;

// Remplace checkCitations : la source n'est plus écrite par le modèle mais ajoutée par le code
// à partir des blocs réellement envoyés (0 token). Nom de fichier inventé => impossible.
export function finalizeAnswer(raw, chunks, { minShare = 0.12, relShare = 0.4, noSource = NO_SOURCE } = {}) {
  const tagged = /\[(SANS_REPONSE|NON-CONFORME|CLARIFICATION)\]/.test(raw);
  if (tagged || !chunks.length) return { text: raw.trim(), files: [], invalid: [], suspect: false };

  // 1. Retire les citations écrites par le modèle (lignes de citation, « D'après l'extrait [1] du fichier X : »)
  const FILE = /\.(?:docx?|xlsx?|pdf|csv|txt|pptx?)\b/i;
  const invalid = [];
  const allowed = new Set(chunks.map((c) => c.file.trim()));
  let text = raw
    .split('\n')
    .filter((line) => {
      const l = line.trim();
      // Ligne « Source : fichier › section » (ou « [1] Source : … ») recopiée depuis les extraits
      const sourceLine = /^[*_>•\-\s]*(?:\[\d+\]\s*)?sources?\s*:/i.test(l);
      if (!sourceLine && !/^d['’]apr[eè]s\b/i.test(l)) return true;
      if (l.length > 220 || (!sourceLine && !FILE.test(l) && !/\[\d+\]/.test(l))) return true;     // vraie phrase de contenu
      (l.match(/[^\s,;:«»"]+(?: [^\s,;:«»"]+)*?\.(?:docx?|xlsx?|pdf|csv|txt|pptx?)/gi) || [])
        // Préfixe « D'après … le fichier / les documents » retiré seulement en tête de citation :
        // un nom de fichier qui commence lui-même par « Document » reste entier.
        .map((f) => f.replace(/^d['’]apr[eè]s\b.*?\b(?:fichiers?|documents?)\s+/i, '').replace(/^(et|,)\s*/i, '').trim())
        .forEach((f) => { if (!allowed.has(f)) invalid.push(f); });
      return false;
    })
    .join('\n')
    .replace(/\s*\((?:extraits?|sources?)\s*\[[^\]]*\](?:[^)]*)\)/gi, '')
    .replace(/\s*\(sources?\s*:[^)]*\)/gi, '')                          // « (Source : X.docx) » en fin de phrase
    .replace(/\bextraits?\s*\[\d+\](?:\s*(?:et|,)\s*\[\d+\])*/gi, 'les documents')
    .trim();

  if (noSource && noSource.test(text)) return { text, files: [], invalid, suspect: invalid.length > 0 };

  // 2. Sources = fichiers des blocs dont le contenu se retrouve dans la réponse
  const ans = new Set(tokenize(text));
  const scored = chunks.map((c) => {
    const ct = new Set(tokenize(c.body));
    let hit = 0; ans.forEach((t) => { if (ct.has(t)) hit++; });
    return { file: c.file, share: hit / Math.max(1, ans.size) };
  }).sort((a, b) => b.share - a.share);
  const best = scored[0].share;
  const files = [...new Set(scored.filter((s, i) => i === 0 || (s.share >= minShare && s.share >= best * relShare)).map((s) => s.file))];

  text += `\n\nD'après ${files.length > 1 ? 'les documents' : 'le document'} ${files.join(', ')}`;
  return { text, files, invalid, suspect: invalid.length > 0 };
}
