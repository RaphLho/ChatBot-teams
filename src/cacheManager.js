import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '../data/vector_cache.json');

// Version du format des blocs stockés. À incrémenter à chaque changement de format : un cache
// d'une autre version est ignoré, ce qui force une ré-indexation complète (nouvelle passe
// d'embeddings sur tous les fichiers, comme une synchronisation normale).
//   1 (implicite) : { text, source, embedding }
//   2 : { id, path, file, section, source, body, embedText, embedding } (cf. src/ingestion.js)
//   3 : même format ; blocs Excel réordonnés (gabarits d'emails et textes de tâches en fin de bloc)
export const CACHE_VERSION = 3;

const emptyCache = () => ({ version: CACHE_VERSION, files: {}, documents: [], fileMeta: {} });

export function loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (data.version === CACHE_VERSION) return data;
            console.log(`♻️  Cache vectoriel au format ${data.version || 1} (attendu : ${CACHE_VERSION}) : ré-indexation complète.`);
        } catch (e) {
            console.error("Erreur lors de la lecture du cache :", e);
        }
    }
    return emptyCache();
}

export function saveCache(cache) {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...cache, version: CACHE_VERSION }, null, 2));
    } catch (e) {
        console.error("Erreur lors de la sauvegarde du cache :", e);
    }
}
