// --- JOURNAL DE DÉBOGAGE DES EXTRAITS ENVOYÉS ---
// Désactivé par défaut ; RAG_DEBUG_LOG=1 pour l'activer. Une ligne JSON par question dans
// data/rag-debug.jsonl : quels blocs ont été envoyés (avec leurs scores), et ce qu'est devenue
// la réponse. Pour chaque réponse ratée, on sait ainsi si le bon extrait était envoyé (défaut du
// modèle) ou non (défaut de recherche). Ni texte des extraits, ni identité de l'utilisateur.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { estimateTokens } from './ragBoost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, '../data/rag-debug.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;   // rotation simple : au-delà, renommé en .1

/**
 * Blocs envoyés, avec les scores de la recherche hybride (cf. hybridRank dans ragBoost.js).
 * @param {{chunks: object[], fused: object[]}|null} retrieval
 */
export function describeChunks(retrieval) {
    if (!retrieval) return [];
    const scores = new Map(retrieval.fused.map(f => [f.id, f]));
    return retrieval.chunks.map(c => {
        const f = scores.get(c.id) || {};
        return {
            source: c.source,
            phrase: f.phrase ?? 0,
            bm25: f.bm25 ?? null,
            vector: f.vector ?? null,
            tokens: estimateTokens(c.source + c.body) + 6,
        };
    });
}

/**
 * @param {{mode: string|null, question: string, chunks?: object[], confident?: boolean|null,
 *   fromCache?: boolean, status: 'answered'|'sans_reponse'|'non_conforme'|'repli_code',
 *   files?: string[], invalid?: string[]}} entry
 */
export function logRagDebug(entry, env = process.env) {
    if (env.RAG_DEBUG_LOG !== '1') return;
    try {
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
            fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
        }
        const line = {
            ts: new Date().toISOString(),
            mode: entry.mode || 'default',
            question: entry.question,
            chunks: entry.chunks || [],
            confident: entry.confident ?? null,
            fromCache: !!entry.fromCache,
            status: entry.status,
            files: entry.files || [],
            invalid: entry.invalid || [],
        };
        fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n');
    } catch (e) {
        console.error('Erreur journal RAG_DEBUG_LOG :', e.message);
    }
}
