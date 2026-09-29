// --- DÉCOUPAGE DES DOCUMENTS EN BLOCS ---
// Partagé par l'indexation (index.js) et l'évaluation hors ligne (scripts/evalRetrieval.js),
// pour que l'évaluation mesure exactement les blocs que voit le bot.
//
// Chaque bloc a la forme { id, path, file, section, source, body, embedText } :
//   - path : chemin OneDrive complet (sert au filtrage Étudiant/Collaborateur et à la purge) ;
//   - source : fil d'Ariane « fichier › section » envoyé au LLM avec body (formatExtraits) ;
//   - embedText : fil d'Ariane + texte, c'est lui qui est vectorisé et indexé en BM25.
import { createRequire } from 'module';
import { excelToChunks, docxToChunks, makeChunk } from './ragBoost.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// --- DECOUPAGE DU TEXTE (PDF, TXT...) ---
function splitText(text, chunkSize = 600, overlap = 100) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push(text.slice(start, end));
        start += chunkSize - overlap;
    }
    return chunks;
}

// --- DECOUPAGE D'UN TABLEAU (CSV) EN BLOCS AVEC EN-TETE REPETE ---
// Un découpage brut par caractères (splitText) coupe les lignes n'importe où et ne conserve
// l'en-tête (noms de colonnes) que dans le premier bloc : tous les blocs suivants deviennent
// illisibles hors contexte. Ici, on découpe ligne par ligne et on répète l'en-tête + le préfixe
// dans CHAQUE bloc, pour que la recherche puisse renvoyer n'importe quel bloc de manière
// autonome, sans perdre le sens des colonnes.
function chunkCsvWithHeader(csvText, prefix = "", chunkSize = 1200, overlapRows = 2) {
    const lines = csvText.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return [];

    const headerLine = lines[0];
    const dataLines = lines.slice(1);
    if (dataLines.length === 0) return [`${prefix}${headerLine}`];

    const header = `${prefix}${headerLine}`;
    const chunks = [];
    let current = [];
    let currentLen = header.length;

    for (const line of dataLines) {
        if (current.length > 0 && currentLen + line.length + 1 > chunkSize) {
            chunks.push([header, ...current].join('\n'));
            current = current.slice(-overlapRows);
            currentLen = header.length + current.reduce((sum, l) => sum + l.length + 1, 0);
        }
        current.push(line);
        currentLen += line.length + 1;
    }
    if (current.length > 0) chunks.push([header, ...current].join('\n'));

    return chunks;
}

// Blocs « sans structure » (PDF, texte, CSV) : même format d'objet que les blocs Excel/Word,
// avec le nom de fichier comme fil d'Ariane (pas de section disponible).
function plainChunks(texts, file) {
    return texts
        .map(t => t.trim())
        .filter(Boolean)
        .map((t, i) => makeChunk(file, '', t, i));
}

/**
 * Découpe un fichier en blocs prêts à vectoriser.
 * @param {Buffer} buffer
 * @param {string} ext - extension en minuscules, avec le point (".pdf")
 * @param {string} fullPath - chemin OneDrive complet (ou chemin local pour l'évaluation)
 */
export async function fileToChunks(buffer, ext, fullPath) {
    const file = fullPath.split('/').pop();
    let chunks;
    switch (ext) {
        case '.xlsx':
        case '.xls':
            chunks = excelToChunks(buffer, file);
            break;
        case '.docx':
            chunks = await docxToChunks(buffer, file);
            break;
        case '.csv':
            chunks = plainChunks(chunkCsvWithHeader(buffer.toString('utf8')), file);
            break;
        case '.pdf': {
            const pdfData = await pdfParse(buffer);
            chunks = plainChunks(splitText(pdfData.text || '', 600, 100), file);
            break;
        }
        case '.md':
        case '.txt':
        case '.texte':
        case '.json':
        case '.xml':
            chunks = plainChunks(splitText(buffer.toString('utf8'), 600, 100), file);
            break;
        default:
            throw new Error(`Format non pris en charge : ${ext}`);
    }
    // Identifiant unique sur toute la base : deux fichiers de même nom peuvent exister dans des
    // dossiers différents, et deux colonnes d'un même onglet peuvent porter le même libellé.
    return chunks.map((c, i) => ({ ...c, id: `${fullPath}#${i}`, path: fullPath }));
}
