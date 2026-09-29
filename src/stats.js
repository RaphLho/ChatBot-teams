import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.join(__dirname, '../data/global_stats.json');

// Compteurs de qualité de la recherche (RAG), par question. Champs optionnels : absents des
// fichiers de statistiques antérieurs, complétés au chargement.
function emptyRagCounters() {
    return {
        questions: 0,          // questions passées par la recherche (hors cache)
        chunksSent: 0,         // total des blocs envoyés au LLM
        extraitsTokens: 0,     // total des tokens d'extraits estimés
        confident: 0,          // questions dont le premier bloc passe le seuil de confiance
        fallbackNoLLM: 0,      // formules de repli servies sans appel LLM
        cacheHits: 0,          // réponses servies depuis le cache (0 token)
        invalidCitations: 0,   // noms de fichiers cités hors extraits (retirés de la réponse)
        suspectAnswers: 0,     // réponses sans citation valide et sans balise
        suspectFallbacks: 0,   // [SANS_REPONSE] du LLM alors que le premier bloc était très pertinent
    };
}

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
    embedRequests: 0,
    rag: emptyRagCounters()
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
        globalStats.rag = { ...emptyRagCounters(), ...(globalStats.rag || {}) };
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
        rag: emptyRagCounters(),
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
 * @param {boolean} isNoAnswer - Vrai si le bot a utilisé sa formule de repli « je ne sais pas »
 * @param {object|null} rag - Détails de la recherche pour cette question (cf. trackRag), optionnel
 */
function recordUsage(promptTokens, completionTokens, userId = 'unknown', question = '', answer = '', isNonCompliant = false, responseTimeMs = null, model = 'mistral-small-latest', displayName = '', isNoAnswer = false, rag = null) {
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
        isNoAnswer,
        responseTimeMs: hasTiming ? responseTimeMs : null,
        model
    };
    if (rag) {
        entry.rag = rag;
        trackRag(rag);
    }

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
 * Met à jour les compteurs RAG (session + global) à partir des détails d'une question.
 * @param {{chunks?: number, extraitsTokens?: number, confident?: boolean, llmSkipped?: boolean,
 *   cached?: boolean, invalidCitations?: number, suspect?: boolean, suspectFallback?: boolean}} rag
 */
function trackRag(rag) {
    for (const counters of [botStats.session.rag, globalStats.rag]) {
        if (rag.cached) { counters.cacheHits += 1; continue; }
        counters.questions += 1;
        counters.chunksSent += rag.chunks || 0;
        counters.extraitsTokens += rag.extraitsTokens || 0;
        if (rag.confident) counters.confident += 1;
        if (rag.llmSkipped) counters.fallbackNoLLM += 1;
        counters.invalidCitations += rag.invalidCitations || 0;
        if (rag.suspect) counters.suspectAnswers += 1;
        if (rag.suspectFallback) counters.suspectFallbacks += 1;
    }
}

/**
 * Enregistre une réponse produite SANS appel LLM (cache de réponses ou formule de repli quand
 * aucun extrait n'est assez pertinent). Elle apparaît dans l'historique avec 0 token, sans
 * compter comme une requête Mistral.
 * @param {{userId: string, question: string, answer: string, displayName?: string,
 *   isNoAnswer?: boolean, local: 'cache'|'fallback', rag?: object}} params
 */
function recordLocalAnswer({ userId, question, answer, displayName = '', isNoAnswer = false, local, rag = {} }) {
    const entry = {
        timestamp: Date.now(),
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        userId,
        displayName,
        question,
        answer,
        isNonCompliant: false,
        isNoAnswer,
        responseTimeMs: null,
        model: 'mistral-small-latest',
        local,
        rag,
    };
    botStats.history.push(entry);
    if (botStats.history.length > MAX_HISTORY) botStats.history.shift();
    if (isRealUser(userId)) {
        sessionUniqueUserSet.add(userId);
        if (!globalUniqueUserSet.has(userId)) {
            globalUniqueUserSet.add(userId);
            globalStats.uniqueUserIds.push(userId);
        }
    }
    trackRag(rag);
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
export { recordUsage, recordLocalAnswer, aggregateHistory, aggregateByHourOfDay, aggregateByWeekday, getTopUsers, getSessionUniqueUsersCount };
