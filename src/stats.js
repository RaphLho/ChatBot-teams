import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.join(__dirname, '../data/global_stats.json');

// --- Statistiques Persistantes (Globales) ---
let globalStats = {
    totalConversations: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    monthlyUsage: {},
    firstLaunchDate: Date.now()
};

if (fs.existsSync(STATS_FILE)) {
    try {
        const data = fs.readFileSync(STATS_FILE, 'utf8');
        globalStats = JSON.parse(data);
        if (!globalStats.firstLaunchDate) {
            globalStats.firstLaunchDate = Date.now();
        }
    } catch (e) {
        console.error("Erreur lors de la lecture des statistiques globales :", e);
    }
}

function saveGlobalStats() {
    try {
        const dir = path.dirname(STATS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATS_FILE, JSON.stringify(globalStats, null, 2));
    } catch (e) {
        if (e.code !== 'EBUSY') {
            console.error("Erreur lors de la sauvegarde des statistiques globales :", e);
        }
    }
}

// --- Statistiques de Session (En Mémoire) ---
const botStats = {
    startTime: Date.now(),
    
    session: {
        totalConversations: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
    },
    
    global: globalStats,
    
    totalFilesParsed: 0,
    totalChunksIndexed: 0,
    
    history: []
};

const MAX_HISTORY = 1000;

/**
 * Enregistre une utilisation de tokens dans l'historique et met à jour les totaux (session + global).
 * @param {number} promptTokens - Nombre de tokens du prompt
 * @param {number} completionTokens - Nombre de tokens de complétion
 * @param {string} userId - Identifiant de l'utilisateur
 * @param {string} question - Question de l'utilisateur
 * @param {string} answer - Réponse du bot
 * @param {boolean} isNonCompliant - Vrai si la requête était hors sujet
 */
function recordUsage(promptTokens, completionTokens, userId = 'unknown', question = '', answer = '', isNonCompliant = false) {
    const pTokens = promptTokens || 0;
    const cTokens = completionTokens || 0;
    const totalTk = pTokens + cTokens;

    // 1. Mise à jour de l'historique de session
    const entry = {
        timestamp: Date.now(),
        promptTokens: pTokens,
        completionTokens: cTokens,
        totalTokens: totalTk,
        userId,
        question,
        answer,
        isNonCompliant
    };

    botStats.history.push(entry);
    if (botStats.history.length > MAX_HISTORY) {
        botStats.history.shift();
    }

    // 2. Mise à jour des statistiques de session
    botStats.session.totalPromptTokens += pTokens;
    botStats.session.totalCompletionTokens += cTokens;
    botStats.session.totalConversations += 1;

    // 3. Mise à jour des statistiques globales
    globalStats.totalPromptTokens += pTokens;
    globalStats.totalCompletionTokens += cTokens;
    globalStats.totalConversations += 1;

    // 4. Statistiques mensuelles
    const date = new Date();
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!globalStats.monthlyUsage) globalStats.monthlyUsage = {};
    if (!globalStats.monthlyUsage[monthKey]) globalStats.monthlyUsage[monthKey] = 0;
    
    globalStats.monthlyUsage[monthKey] += totalTk;

    // Sauvegarde sur disque
    saveGlobalStats();
}

/**
 * Agrège l'historique de session par intervalle de temps (heure ou jour).
 * @param {'hour'|'day'} interval
 * @returns {Array} Données agrégées
 */
function aggregateHistory(interval = 'hour') {
    const buckets = new Map();

    for (const entry of botStats.history) {
        const date = new Date(entry.timestamp);
        let key;

        if (interval === 'hour') {
            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
        } else {
            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        }

        if (!buckets.has(key)) {
            buckets.set(key, { label: key, promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 });
        }
        const bucket = buckets.get(key);
        bucket.promptTokens += entry.promptTokens;
        bucket.completionTokens += entry.completionTokens;
        bucket.totalTokens += entry.totalTokens;
        bucket.requests += 1;
    }

    return Array.from(buckets.values());
}

export default botStats;
export { recordUsage, aggregateHistory };
