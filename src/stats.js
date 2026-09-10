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
    totalNonCompliant: 0,
    totalResponseTimeMs: 0,
    totalTimedRequests: 0,
    uniqueUserIds: [],
    monthlyUsage: {},
    firstLaunchDate: Date.now(),
    // Per-model tracking
    chatPromptTokens: 0,
    chatCompletionTokens: 0,
    embedTokens: 0,
    chatRequests: 0,
    embedRequests: 0
};

if (fs.existsSync(STATS_FILE)) {
    try {
        const data = fs.readFileSync(STATS_FILE, 'utf8');
        globalStats = JSON.parse(data);
        if (!globalStats.firstLaunchDate) {
            globalStats.firstLaunchDate = Date.now();
        }
        if (!Array.isArray(globalStats.uniqueUserIds)) globalStats.uniqueUserIds = [];
        if (!globalStats.totalNonCompliant) globalStats.totalNonCompliant = 0;
        if (!globalStats.totalResponseTimeMs) globalStats.totalResponseTimeMs = 0;
        if (!globalStats.totalTimedRequests) globalStats.totalTimedRequests = 0;
        // Ensure per-model fields exist (backward compat with old data files)
        if (!globalStats.chatPromptTokens) globalStats.chatPromptTokens = 0;
        if (!globalStats.chatCompletionTokens) globalStats.chatCompletionTokens = 0;
        if (!globalStats.embedTokens) globalStats.embedTokens = 0;
        if (!globalStats.chatRequests) globalStats.chatRequests = 0;
        if (!globalStats.embedRequests) globalStats.embedRequests = 0;
    } catch (e) {
        console.error("Erreur lors de la lecture des statistiques globales :", e);
    }
}

// Ensemble en mémoire pour un lookup O(1) des utilisateurs déjà vus (persisté via globalStats.uniqueUserIds)
const globalUniqueUserSet = new Set(globalStats.uniqueUserIds);
// Ensemble propre à la session en cours (remis à zéro à chaque redémarrage du serveur)
const sessionUniqueUserSet = new Set();

function isRealUser(userId) {
    return !!userId && !userId.startsWith('embedding_');
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
        totalNonCompliant: 0,
        totalResponseTimeMs: 0,
        totalTimedRequests: 0,
        // Per-model tracking (session)
        chatPromptTokens: 0,
        chatCompletionTokens: 0,
        embedTokens: 0,
        chatRequests: 0,
        embedRequests: 0,
    },

    global: globalStats,

    totalFilesParsed: 0,
    totalChunksIndexed: 0,

    // Nombre de réponses servies depuis le cache RAM (aucun appel API Mistral effectué)
    cacheHits: 0,

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
 * @param {number|null} responseTimeMs - Temps de génération de la réponse par Mistral (ms), null si non mesuré
 * @param {string} model - Modèle utilisé ('mistral-small-latest' ou 'mistral-embed')
 * @param {string} displayName - Nom déclaré par la personne (popup de profil côté web), vide si inconnu
 */
function recordUsage(promptTokens, completionTokens, userId = 'unknown', question = '', answer = '', isNonCompliant = false, responseTimeMs = null, model = 'mistral-small-latest', displayName = '') {
    const pTokens = promptTokens || 0;
    const cTokens = completionTokens || 0;
    const totalTk = pTokens + cTokens;
    const hasTiming = typeof responseTimeMs === 'number' && responseTimeMs >= 0;
    const isChat = model === 'mistral-small-latest';

    // 1. Mise à jour de l'historique de session
    const entry = {
        timestamp: Date.now(),
        promptTokens: pTokens,
        completionTokens: cTokens,
        totalTokens: totalTk,
        userId,
        displayName: displayName || '',
        question,
        answer,
        isNonCompliant,
        responseTimeMs: hasTiming ? responseTimeMs : null,
        model
    };

    botStats.history.push(entry);
    if (botStats.history.length > MAX_HISTORY) {
        botStats.history.shift();
    }

    // 2. Mise à jour des statistiques de session
    botStats.session.totalPromptTokens += pTokens;
    botStats.session.totalCompletionTokens += cTokens;
    botStats.session.totalConversations += 1;
    if (isNonCompliant) botStats.session.totalNonCompliant += 1;
    if (hasTiming) {
        botStats.session.totalResponseTimeMs += responseTimeMs;
        botStats.session.totalTimedRequests += 1;
    }
    if (isRealUser(userId)) sessionUniqueUserSet.add(userId);

    // Per-model session stats
    if (isChat) {
        botStats.session.chatPromptTokens += pTokens;
        botStats.session.chatCompletionTokens += cTokens;
        botStats.session.chatRequests += 1;
    } else {
        botStats.session.embedTokens += pTokens;
        botStats.session.embedRequests += 1;
    }

    // 3. Mise à jour des statistiques globales
    globalStats.totalPromptTokens += pTokens;
    globalStats.totalCompletionTokens += cTokens;
    globalStats.totalConversations += 1;
    if (isNonCompliant) globalStats.totalNonCompliant += 1;
    if (hasTiming) {
        globalStats.totalResponseTimeMs += responseTimeMs;
        globalStats.totalTimedRequests += 1;
    }
    if (isRealUser(userId) && !globalUniqueUserSet.has(userId)) {
        globalUniqueUserSet.add(userId);
        globalStats.uniqueUserIds.push(userId);
    }

    // Per-model global stats
    if (isChat) {
        globalStats.chatPromptTokens += pTokens;
        globalStats.chatCompletionTokens += cTokens;
        globalStats.chatRequests += 1;
    } else {
        globalStats.embedTokens += pTokens;
        globalStats.embedRequests += 1;
    }

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
 * Nombre d'utilisateurs distincts ayant posé une question depuis le démarrage du serveur.
 */
function getSessionUniqueUsersCount() {
    return sessionUniqueUserSet.size;
}

/**
 * Agrège l'historique de session par heure de la journée (0-23), toutes dates confondues.
 * Permet de visualiser les créneaux horaires les plus actifs.
 */
function aggregateByHourOfDay() {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}h`, totalTokens: 0, requests: 0 }));
    for (const entry of botStats.history) {
        const h = new Date(entry.timestamp).getHours();
        buckets[h].totalTokens += entry.totalTokens;
        buckets[h].requests += 1;
    }
    return buckets;
}

/**
 * Agrège l'historique de session par jour de la semaine (Lundi -> Dimanche).
 */
function aggregateByWeekday() {
    const labels = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const buckets = labels.map(label => ({ label, totalTokens: 0, requests: 0 }));
    for (const entry of botStats.history) {
        const jsDay = new Date(entry.timestamp).getDay(); // 0 = Dimanche ... 6 = Samedi
        const idx = jsDay === 0 ? 6 : jsDay - 1;
        buckets[idx].totalTokens += entry.totalTokens;
        buckets[idx].requests += 1;
    }
    return buckets;
}

/**
 * Classe les utilisateurs de la session par consommation de tokens décroissante.
 * Les appels d'indexation/embedding (userId préfixé "embedding_") sont exclus.
 * @param {number} limit
 */
function getTopUsers(limit = 10) {
    const map = new Map();
    for (const entry of botStats.history) {
        if (!isRealUser(entry.userId)) continue;
        if (!map.has(entry.userId)) {
            map.set(entry.userId, { userId: entry.userId, displayName: '', totalTokens: 0, requests: 0, nonCompliant: 0 });
        }
        const u = map.get(entry.userId);
        u.totalTokens += entry.totalTokens;
        u.requests += 1;
        if (entry.isNonCompliant) u.nonCompliant += 1;
        // Conserve le nom déclaré le plus récent pour cet identifiant (peut être vide sur les
        // toutes premières requêtes d'une conversation avant saisie du profil).
        if (entry.displayName) u.displayName = entry.displayName;
    }
    return Array.from(map.values())
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, limit);
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
export { recordUsage, aggregateHistory, aggregateByHourOfDay, aggregateByWeekday, getTopUsers, getSessionUniqueUsersCount };
