import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import { BotFrameworkAdapter } from 'botbuilder';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getAuthCodeUrl, acquireTokenByCode, getLogoutUrl } from './msalClient.js';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
import { Mistral } from '@mistralai/mistralai';
import RAGBot from './bot.js';
import botStats, { recordUsage, aggregateHistory, aggregateByHourOfDay, aggregateByWeekday, getTopUsers, getSessionUniqueUsersCount } from './stats.js';
import { listOneDriveFiles, downloadFilesBuffers, getOneDriveFolderUrl } from './onedriveClient.js';
import { loadCache, saveCache } from './cacheManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- BOT FRAMEWORK ADAPTER ---
const adapter = new BotFrameworkAdapter({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD,
});

adapter.onTurnError = async (context, error) => {
    console.error(`\n [onTurnError]: ${error}`);
    await context.sendActivity("Le bot a subi une erreur interne.");
};

const app = express();
// L'application tourne derrière un reverse proxy HTTPS en production
// (https://bot-teams.campus-pays-de-la-loire.fr). Sans ceci, req.protocol renvoie "http"
// et les URL de redirection SSO générées seraient invalides.
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 4 * 60 * 60 * 1000, // 4 heures
        httpOnly: true,
        sameSite: 'lax',
    },
}));

// --- CATEGORISATION DES DOCUMENTS (Étudiant / Collaborateur) ---
// Déduite du chemin OneDrive du document (dossier "Etudiant" ou "Collaborateur" à la racine
// du dossier indexé). Calculée à la volée à partir de "source" plutôt que persistée, pour
// rester valable même sur un cache constitué avant l'ajout de cette fonctionnalité.
function getCategoryFromPath(fullPath) {
    const segments = (fullPath || '').split('/');
    if (segments.includes('Etudiant')) return 'etudiant';
    if (segments.includes('Collaborateur')) return 'collaborateur';
    return 'autre';
}

// --- DECOUPAGE DU TEXTE ---
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

// --- MOTEUR VECTORIEL 100% RAM ---
class LocalRamVectorStore {
    constructor(mistralClient) {
        this.mistralClient = mistralClient;
        this.documents = [];
    }

    async addDocuments(chunks, onProgress = () => {}) {
        const log = (msg) => { console.log(msg); onProgress({ type: 'log', message: msg }); };
        log(`   ↳ Envoi de ${chunks.length} blocs à Mistral pour embedding...`);
        const batchSize = 32;
        const delayBetweenBatches = 500; // ms entre chaque batch
        const maxRetries = 3;
        const totalBatches = Math.ceil(chunks.length / batchSize);

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            let retries = 0;
            let success = false;

            while (!success && retries <= maxRetries) {
                try {
                    if (retries > 0) {
                        const backoff = Math.pow(2, retries) * 1000; // 2s, 4s, 8s
                        log(`   ⏳ Retry ${retries}/${maxRetries} dans ${backoff / 1000}s (rate limit)...`);
                        await new Promise(r => setTimeout(r, backoff));
                    }

                    const response = await this.mistralClient.embeddings.create({
                        model: 'mistral-embed',
                        inputs: batch.map(c => c.text),
                    });
                    batch.forEach((chunk, j) => {
                        this.documents.push({
                            text: chunk.text,
                            source: chunk.source,
                            embedding: response.data[j].embedding
                        });
                    });
                    // Tracker les tokens d'embedding
                    if (response.usage) {
                        const embTk = response.usage.promptTokens || response.usage.prompt_tokens || response.usage.totalTokens || response.usage.total_tokens || 0;
                        recordUsage(embTk, 0, 'embedding_indexation', '', '', false, null, 'mistral-embed');
                    }
                    success = true;
                    log(`   ✓ Bloc ${batchNum}/${totalBatches} vectorisé (${batch.length} chunks)`);
                } catch (err) {
                    if (err.statusCode === 429 && retries < maxRetries) {
                        retries++;
                    } else {
                        throw err;
                    }
                }
            }

            // Délai entre les batches pour éviter le rate limit
            if (i + batchSize < chunks.length) {
                await new Promise(r => setTimeout(r, delayBetweenBatches));
            }
        }
    }

    /**
     * @param {string} query
     * @param {number} k
     * @param {'etudiant'|'collaborateur'|null} category - Si fourni, ne recherche que parmi les
     *   documents dont le chemin OneDrive appartient au dossier "Etudiant" ou "Collaborateur" correspondant.
     */
    async similaritySearch(query, k = 3, category = null) {
        const pool = category
            ? this.documents.filter(doc => getCategoryFromPath(doc.source) === category)
            : this.documents;

        if (pool.length === 0) return [];

        const response = await this.mistralClient.embeddings.create({
            model: 'mistral-embed',
            inputs: [query],
        });
        // Tracker les tokens d'embedding de recherche
        if (response.usage) {
            const embTk = response.usage.promptTokens || response.usage.prompt_tokens || response.usage.totalTokens || response.usage.total_tokens || 0;
            recordUsage(embTk, 0, 'embedding_search', '', '', false, null, 'mistral-embed');
        }
        const queryVector = response.data[0].embedding;

        const scores = pool.map(doc => {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < queryVector.length; i++) {
                dot += queryVector[i] * doc.embedding[i];
                normA += queryVector[i] ** 2;
                normB += doc.embedding[i] ** 2;
            }
            return { doc, score: dot / (Math.sqrt(normA) * Math.sqrt(normB)) };
        });

        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, k).map(r => r.doc);
    }
}

// --- DECOUPAGE D'UN TABLEAU (CSV) EN BLOCS AVEC EN-TETE REPETE ---
// Un découpage brut par caractères (splitText) coupe les lignes n'importe où et ne conserve
// l'en-tête (noms de colonnes) que dans le premier bloc : tous les blocs suivants deviennent
// illisibles hors contexte. Ici, on découpe ligne par ligne et on répète l'en-tête + le préfixe
// (nom de feuille) dans CHAQUE bloc, pour que la recherche vectorielle puisse renvoyer n'importe
// quel bloc de manière autonome, sans perdre le sens des colonnes.
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

// --- EXTRACTION DE TEXTE DEPUIS UN BUFFER ---
// Retourne soit une chaîne de texte brut (documents non tabulaires, découpés ensuite par
// splitText), soit un tableau de blocs déjà découpés avec en-tête répétée (CSV/Excel), pour
// éviter la perte de colonnes décrite dans chunkCsvWithHeader ci-dessus.
async function extractTextFromBuffer(buffer, ext) {
    switch (ext) {
        case '.pdf':
            const pdfData = await pdfParse(buffer);
            return pdfData.text;
        case '.md':
        case '.txt':
        case '.texte':
        case '.json':
        case '.xml':
            return buffer.toString('utf8');
        case '.csv':
            return chunkCsvWithHeader(buffer.toString('utf8'));
        case '.docx':
            const docxData = await mammoth.extractRawText({ buffer });
            return docxData.value;
        case '.xlsx':
        case '.xls':
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            let tableChunks = [];
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const csv = xlsx.utils.sheet_to_csv(sheet);
                tableChunks = tableChunks.concat(chunkCsvWithHeader(csv, `--- Feuille: ${sheetName} ---\n`));
            }
            return tableChunks;
        default:
            throw new Error(`Format non pris en charge : ${ext}`);
    }
}

// --- INDEXATION DES DOCUMENTS ---
let vectorStore = null;
let bot_instance = null;

async function initKnowledgeBase(mistralClient, onProgress = () => {}) {
    const log = (msg) => { console.log(msg); onProgress({ type: 'log', message: msg }); };
    log("------------------------------------------");
    log("🔄 Indexation des documents en cours...");

    const cache = loadCache();
    let remoteFiles;
    try {
        remoteFiles = await listOneDriveFiles();
    } catch (err) {
        console.error("❌ Erreur de connexion OneDrive:", err.message);
        onProgress({ type: 'log', message: `❌ Erreur de connexion OneDrive: ${err.message}` });
        if (cache.documents.length > 0) {
            log("⚠️  Utilisation du cache local de la base de connaissance.");
            const store = new LocalRamVectorStore(mistralClient);
            store.documents = cache.documents;
            botStats.totalChunksIndexed = cache.documents.length;
            botStats.totalFilesParsed = Object.keys(cache.files).length;
            return store;
        }
        log("⚠️  Le bot démarrera sans base de connaissance.");
        return null;
    }

    if (!remoteFiles || remoteFiles.length === 0) {
        log("⚠️  Aucun document trouvé. Le bot fonctionnera sans base de cours.");
        onProgress({ type: 'files', files: [] });
        return null;
    }

    const filesToDownload = [];
    const currentRemotePaths = new Set();
    if (!cache.fileMeta) cache.fileMeta = {};

    for (const file of remoteFiles) {
        currentRemotePaths.add(file.fullPath);
        cache.fileMeta[file.fullPath] = {
            name: file.name,
            size: file.size || 0,
            lastModified: file.lastModified,
            ext: file.ext
        };
        const cachedDate = cache.files[file.fullPath];
        if (!cachedDate || cachedDate !== file.lastModified) {
            filesToDownload.push(file);
        }
    }

    const pathsToRemove = Object.keys(cache.files).filter(p => !currentRemotePaths.has(p));

    onProgress({ type: 'files', files: filesToDownload.map(f => f.name) });

    let newChunks = [];
    if (filesToDownload.length > 0) {
        log(`🔄 ${filesToDownload.length} fichier(s) à télécharger/mettre à jour.`);
        const downloadedDocs = await downloadFilesBuffers(filesToDownload);
        for (const doc of downloadedDocs) {
            log(`📄 Traitement : ${doc.name}`);
            try {
                const extracted = await extractTextFromBuffer(doc.buffer, doc.ext);
                // CSV/Excel arrivent déjà découpés (en-tête répétée dans chaque bloc, voir
                // chunkCsvWithHeader) ; les autres formats sont une chaîne à découper ici.
                const chunks = Array.isArray(extracted)
                    ? extracted
                    : (extracted && extracted.trim().length > 0 ? splitText(extracted, 600, 100) : []);

                if (chunks.length > 0) {
                    chunks.forEach(c => newChunks.push({ text: c, source: doc.fullPath }));
                } else {
                    log(`   ⚠️ Document vide ou illisible : ${doc.name}`);
                }
                const remoteFile = filesToDownload.find(f => f.fullPath === doc.fullPath);
                if (remoteFile) cache.files[doc.fullPath] = remoteFile.lastModified;
            } catch (e) {
                console.error(`   ❌ Impossible de lire ${doc.name}:`, e.message);
                onProgress({ type: 'log', message: `   ❌ Impossible de lire ${doc.name}: ${e.message}` });
            }
        }
    } else {
        log(`✅ Tous les fichiers sont à jour. Aucun téléchargement nécessaire.`);
    }

    const store = new LocalRamVectorStore(mistralClient);

    let updatedDocuments = cache.documents.filter(doc =>
        !pathsToRemove.includes(doc.source) &&
        !filesToDownload.some(f => f.fullPath === doc.source)
    );

    if (newChunks.length > 0) {
        await store.addDocuments(newChunks, onProgress);
        log(`✅ ${newChunks.length} blocs indexés !`);
        updatedDocuments = updatedDocuments.concat(store.documents);
    }

    for (const p of pathsToRemove) {
        delete cache.files[p];
        if (cache.fileMeta) delete cache.fileMeta[p];
    }

    store.documents = updatedDocuments;
    cache.documents = updatedDocuments;
    saveCache(cache);

    botStats.totalChunksIndexed = updatedDocuments.length;
    botStats.totalFilesParsed = Object.keys(cache.files).length;

    return store;
}

// --- DEMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 3978;

// index:false : la page d'accueil (index.html) est servie explicitement via la route
// GET '/' ci-dessous, protégée par le SSO. Les autres fichiers statiques (css/js) restent
// accessibles pour ne pas casser l'affichage de la page de connexion / redirection.
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// --- MIDDLEWARE AUTH STATS (session) ---
function requireStatsAuthPage(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    return res.redirect('/login');
}

function requireStatsAuthApi(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    return res.status(401).json({ error: 'Authentification requise' });
}

// --- MIDDLEWARE SSO MICROSOFT (accès à la page chatbot) ---
// Liste par défaut des domaines pour chaque rôle (enrichie avec les variables .env)
const DEFAULT_STUDENT_DOMAINS = [
    'my-digital-school.org',
    'mydigitalschool.com',
    'etudiant.espl.fr',
    'etudiant-espl.fr',
    'etudiant.eduservices.fr',
    'apprenant.espl.fr'
];

const DEFAULT_COLLABORATOR_DOMAINS = [
    'groupe-eduservices.fr',
    'campus-espl.fr',
    'espl.fr',
    'eduservices.org',
    'eduservices.fr',
    'my-digital-school.com'
];

function parseDomainList(value) {
    return (value || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

function resolveRoleFromEmail(email) {
    if (!email) return 'etudiant';
    const cleanEmail = email.trim().toLowerCase();

    const envStudentDomains = parseDomainList(process.env.STUDENT_EMAIL_DOMAINS);
    const envCollabDomains = parseDomainList(process.env.COLLABORATOR_EMAIL_DOMAINS);

    const allCollabDomains = [...new Set([...envCollabDomains, ...DEFAULT_COLLABORATOR_DOMAINS])];
    const allStudentDomains = [...new Set([...envStudentDomains, ...DEFAULT_STUDENT_DOMAINS])];

    // 1. Vérification stricte des domaines collaborateurs
    if (allCollabDomains.some(domain => cleanEmail.endsWith(`@${domain}`) || cleanEmail.includes(`@${domain}`))) {
        return 'collaborateur';
    }

    // 2. Vérification stricte des domaines étudiants
    if (allStudentDomains.some(domain => cleanEmail.endsWith(`@${domain}`) || cleanEmail.includes(`@${domain}`))) {
        return 'etudiant';
    }

    // 3. Mots-clés dans le nom ou domaine
    if (cleanEmail.includes('eduservices') || cleanEmail.includes('campus') || cleanEmail.includes('formateur') || cleanEmail.includes('prof') || cleanEmail.includes('admin') || cleanEmail.includes('staff')) {
        return 'collaborateur';
    }

    // 4. Par défaut : rôle étudiant pour tout autre compte Microsoft
    return 'etudiant';
}

function requireChatAuthPage(req, res, next) {
    if (req.session && req.session.chatUser) {
        return next();
    }
    return res.redirect('/connexion');
}

function requireChatAuthApi(req, res, next) {
    if (req.session && req.session.chatUser) {
        return next();
    }
    return res.status(401).json({ error: 'Connexion Microsoft requise' });
}

// URL de retour envoyée à Microsoft. Déduite du domaine réellement utilisé pour la requête,
// pour rester valide en local (localhost:3978) comme en production. SSO_REDIRECT_URI permet
// de forcer une valeur si nécessaire. L'URI doit être déclarée à l'identique dans
// Azure Portal > App Registration > Authentification > URI de redirection (type Web).
function getSsoRedirectUri(req) {
    return process.env.SSO_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/callback`;
}

app.get('/auth/login', async (req, res) => {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        req.session.authState = state;
        const authUrl = await getAuthCodeUrl(state, getSsoRedirectUri(req));
        res.redirect(authUrl);
    } catch (err) {
        console.error('Erreur lors de la génération de l\'URL de connexion Microsoft:', err);
        res.status(500).send("Impossible de contacter Microsoft pour la connexion.");
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
        console.error('Erreur retournée par Microsoft:', error, error_description);
        return res.redirect('/connexion?ssoError=denied');
    }

    if (!state || state !== req.session.authState) {
        return res.status(400).send('Requête de connexion invalide (state incorrect).');
    }
    delete req.session.authState;

    try {
        const tokenResponse = await acquireTokenByCode(code, getSsoRedirectUri(req));

        // Extraction complète de l'email depuis tous les champs possibles renvoyés par Microsoft
        const rawEmail = tokenResponse.account?.username ||
                         tokenResponse.idTokenClaims?.preferred_username ||
                         tokenResponse.idTokenClaims?.email ||
                         tokenResponse.idTokenClaims?.upn ||
                         tokenResponse.account?.name ||
                         '';

        const email = rawEmail.trim().toLowerCase();
        const name = tokenResponse.account?.name ||
                     tokenResponse.idTokenClaims?.name ||
                     (email ? email.split('@')[0] : 'Utilisateur');

        // Attribution du rôle selon le domaine ou par défaut
        const role = resolveRoleFromEmail(email);

        console.log(`🔑 Connexion SSO Microsoft réussie : ${email} (${name}) → Rôle : ${role}`);

        req.session.chatUser = { email: email || 'utilisateur@microsoft.com', name, role };
        res.redirect('/');
    } catch (err) {
        console.error('Erreur lors de l\'échange du code SSO:', err);
        res.redirect('/connexion?ssoError=failed');
    }
});

app.get('/auth/logout', (req, res) => {
    const postLogoutRedirectUri = `${req.protocol}://${req.get('host')}/`;
    req.session.destroy(() => {
        res.redirect(getLogoutUrl(postLogoutRedirectUri));
    });
});

// Informations sur l'utilisateur Microsoft connecté (affichage côté page chatbot)
app.get('/api/auth/me', requireChatAuthApi, (req, res) => {
    const { email, name, role } = req.session.chatUser;
    res.json({ email, name, role });
});

// Statut d'authentification (utilisé par la page d'accueil pour afficher l'onglet Stats ou le bouton Connexion)
app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Page de connexion Microsoft (bouton "Se connecter avec Microsoft")
app.get('/connexion', (req, res) => {
    if (req.session && req.session.chatUser) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, '../protected/sso-login.html'));
});

// Page d'accueil du chatbot, protégée par le SSO Microsoft
app.get('/', requireChatAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Route de connexion
app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/stats');
    }
    res.sendFile(path.join(__dirname, '../protected/login.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === process.env.ID_STATS && password === process.env.MDP_STATS) {
        req.session.authenticated = true;
        return res.json({ status: 'ok' });
    }
    return res.status(401).json({ error: 'Identifiants incorrects' });
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ status: 'ok' });
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Route HTML pour les stats
app.get('/stats', requireStatsAuthPage, (req, res) => {
    res.sendFile(path.join(__dirname, '../protected/stats.html'));
});


// Point d'entrée pour Microsoft Teams / Bot Framework
app.post('/api/messages', async (req, res) => {
    if (!bot_instance) return res.status(503).send("Bot en cours d'initialisation...");
    await adapter.processActivity(req, res, (context) => bot_instance.run(context));
});

// Point d'entrée pour l'Interface Web
app.post('/api/chat', requireChatAuthApi, async (req, res) => {
    if (!bot_instance) return res.status(503).json({ error: "Bot en cours d'initialisation..." });
    try {
        const { question, userId = "web_user" } = req.body;
        if (!question) return res.status(400).json({ error: "Question manquante" });
        // Le mode est déterminé par le rôle déduit du domaine Microsoft de l'utilisateur connecté,
        // jamais par une valeur envoyée par le client.
        const validMode = req.session.chatUser.role;
        const answer = await bot_instance.askQuestion(question, userId, validMode);
        res.json({ answer });
    } catch (error) {
        console.error("Erreur Web API:", error);
        res.status(500).json({ error: "Une erreur est survenue lors de la génération de la réponse." });
    }
});

app.get('/api/stats', requireStatsAuthApi, (req, res) => {
    const uptimeMs = Date.now() - botStats.startTime;

    const avgTokensSession = botStats.session.totalConversations > 0
        ? Math.round((botStats.session.totalPromptTokens + botStats.session.totalCompletionTokens) / botStats.session.totalConversations)
        : 0;

    const avgTokensGlobal = botStats.global.totalConversations > 0
        ? Math.round((botStats.global.totalPromptTokens + botStats.global.totalCompletionTokens) / botStats.global.totalConversations)
        : 0;

    const avgResponseTimeSession = botStats.session.totalTimedRequests > 0
        ? Math.round(botStats.session.totalResponseTimeMs / botStats.session.totalTimedRequests)
        : 0;

    const avgResponseTimeGlobal = botStats.global.totalTimedRequests > 0
        ? Math.round(botStats.global.totalResponseTimeMs / botStats.global.totalTimedRequests)
        : 0;

    const nonCompliantRateSession = botStats.session.totalConversations > 0
        ? botStats.session.totalNonCompliant / botStats.session.totalConversations
        : 0;

    const nonCompliantRateGlobal = botStats.global.totalConversations > 0
        ? botStats.global.totalNonCompliant / botStats.global.totalConversations
        : 0;

    // On ne renvoie pas la liste brute des identifiants (uniqueUserIds), seulement son décompte
    const { uniqueUserIds, ...globalWithoutUserIds } = botStats.global;

    res.json({
        uptime: uptimeMs,
        totalFilesParsed: botStats.totalFilesParsed,
        totalChunksIndexed: botStats.totalChunksIndexed,
        cacheHits: botStats.cacheHits || 0,
        session: {
            ...botStats.session,
            avgTokensPerRequest: avgTokensSession,
            avgResponseTimeMs: avgResponseTimeSession,
            nonCompliantRate: nonCompliantRateSession,
            uniqueUsers: getSessionUniqueUsersCount(),
        },
        global: {
            ...globalWithoutUserIds,
            avgTokensPerRequest: avgTokensGlobal,
            avgResponseTimeMs: avgResponseTimeGlobal,
            nonCompliantRate: nonCompliantRateGlobal,
            uniqueUsers: uniqueUserIds ? uniqueUserIds.length : 0,
        }
    });
});

// Route liste des fichiers indexés
app.get('/api/stats/files', requireStatsAuthApi, (req, res) => {
    const cache = loadCache();
    const documents = cache.documents || [];
    const fileEntries = Object.entries(cache.files || {}).map(([filePath, lastModified]) => {
        const parts = filePath.split('/');
        const fileName = parts.pop();
        const folder = parts.pop() || '';
        const meta = (cache.fileMeta && cache.fileMeta[filePath]) || {};
        const chunks = documents.filter(d => d.source === filePath);
        const textLength = chunks.reduce((acc, c) => acc + (c.text ? c.text.length : 0), 0);
        const size = (typeof meta.size === 'number' && meta.size > 0) ? meta.size : (textLength > 0 ? textLength : 1024);
        return {
            fileName,
            folder,
            fullPath: filePath,
            lastModified: typeof lastModified === 'string' ? lastModified : (meta.lastModified || new Date().toISOString()),
            size,
            chunksCount: chunks.length
        };
    });
    fileEntries.sort((a, b) => a.fileName.localeCompare(b.fileName, 'fr'));
    const totalSize = fileEntries.reduce((acc, f) => acc + (f.size || 0), 0);
    const totalChunks = fileEntries.reduce((acc, f) => acc + (f.chunksCount || 0), 0);
    res.json({ files: fileEntries, total: fileEntries.length, totalSize, totalChunks });
});

// Route contenu d'un fichier pour visualisation
app.get('/api/stats/file-content', requireStatsAuthApi, (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Paramètre path manquant' });

    const cache = loadCache();
    const documents = cache.documents || [];
    const chunks = documents.filter(d => d.source === filePath);
    const meta = (cache.fileMeta && cache.fileMeta[filePath]) || {};
    const parts = filePath.split('/');
    const fileName = parts.pop();
    const folder = parts.pop() || '';
    const lastModified = cache.files?.[filePath] || meta.lastModified;

    const textLength = chunks.reduce((acc, c) => acc + (c.text ? c.text.length : 0), 0);
    const size = (typeof meta.size === 'number' && meta.size > 0) ? meta.size : textLength;

    res.json({
        fileName,
        folder,
        fullPath: filePath,
        size,
        lastModified,
        chunksCount: chunks.length,
        chunks: chunks.map((c, idx) => ({
            index: idx + 1,
            text: c.text,
            length: c.text ? c.text.length : 0
        })),
        fullText: chunks.map(c => c.text).join('\n\n')
    });
});

// Route lien OneDrive du dossier de documents indexés (bouton "OneDrive" de la page stats)
app.get('/api/stats/onedrive-link', requireStatsAuthApi, async (req, res) => {
    try {
        const url = await getOneDriveFolderUrl();
        res.json({ url });
    } catch (err) {
        console.error('Erreur récupération lien OneDrive:', err.message);
        res.status(500).json({ error: "Impossible de récupérer le lien du dossier OneDrive." });
    }
});

// Route Historique détaillé
app.get('/api/stats/history', requireStatsAuthApi, (req, res) => {
    const hourly = aggregateHistory('hour');
    const daily = aggregateHistory('day');
    const hourOfDay = aggregateByHourOfDay();
    const weekday = aggregateByWeekday();
    const topUsers = getTopUsers(10);
    res.json({
        entries: botStats.history,
        hourly,
        daily,
        hourOfDay,
        weekday,
        topUsers
    });
});

// --- ACTUALISATION AUTOMATIQUE ---
let isRefreshing = false;
let mistralGlobal = null;

// --- DIFFUSION TEMPS REEL DE LA PROGRESSION (SSE) ---
// Utilisé par le bouton "Actualiser le RAG" de la page stats : la popup terminal ouvre une
// connexion Server-Sent Events pour recevoir en direct les lignes de log de l'indexation,
// pendant que la requête POST /api/refresh déclenche l'actualisation elle-même.
let sseClients = [];

function broadcastEvent(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    sseClients.forEach(res => {
        try { res.write(payload); } catch (e) { /* client déconnecté */ }
    });
}

app.get('/api/refresh/stream', requireStatsAuthApi, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connecté\n\n');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

async function refreshKnowledgeBase(onProgress = () => {}) {
    if (isRefreshing || !mistralGlobal) {
        onProgress({ type: 'error', message: "Une actualisation est déjà en cours ou le bot n'est pas encore initialisé." });
        return;
    }
    isRefreshing = true;
    try {
        onProgress({ type: 'log', message: "⏱️ Actualisation manuelle de la base de connaissance OneDrive..." });
        const newStore = await initKnowledgeBase(mistralGlobal, onProgress);
        if (newStore && bot_instance) {
            bot_instance.vectorStore = newStore;
            onProgress({ type: 'log', message: "🔄 Base de connaissance mise à jour avec succès en mémoire (sans redémarrer le bot) !" });
        }
        onProgress({ type: 'done', message: "Actualisation terminée." });
    } catch (e) {
        console.error("❌ Erreur lors de l'actualisation automatique:", e);
        onProgress({ type: 'error', message: `Erreur lors de l'actualisation : ${e.message}` });
    } finally {
        isRefreshing = false;
    }
}

app.listen(PORT, async () => {
    console.log(`\n🌐 Serveur démarré sur le port ${PORT}`);

    if (!process.env.MISTRAL_API_KEY) {
        console.error("❌ MISTRAL_API_KEY manquante dans le fichier .env !");
        process.exit(1);
    }

    mistralGlobal = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
    vectorStore = await initKnowledgeBase(mistralGlobal);
    bot_instance = new RAGBot(vectorStore, mistralGlobal);

    // Route permettant d'actualiser manuellement (ex: via le bouton de la page stats ou Postman)
    app.post('/api/refresh', requireStatsAuthApi, async (req, res) => {
        if (isRefreshing) return res.status(429).json({ status: "Déjà en cours d'actualisation" });
        await refreshKnowledgeBase(broadcastEvent);
        res.json({ status: "Base de connaissances mise à jour avec succès !" });
    });

    console.log("------------------------------------------");
    console.log(`🚀 BOT PRÊT ! Connectez Bot Framework Emulator sur : http://localhost:${PORT}/api/messages`);
    console.log("------------------------------------------\n");
});
