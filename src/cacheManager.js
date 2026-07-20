import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '../data/vector_cache.json');

export function loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
        try {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            console.error("Erreur lors de la lecture du cache :", e);
        }
    }
    return { files: {}, documents: [] };
}

export function saveCache(cache) {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error("Erreur lors de la sauvegarde du cache :", e);
    }
}
