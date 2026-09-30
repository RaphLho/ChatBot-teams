import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import { BotFrameworkAdapter } from 'botbuilder';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAuthCodeUrl, acquireTokenByCode, getLogoutUrl } from './msalClient.js';
import { Mistral } from '@mistralai/mistralai';
import RAGBot from './bot.js';
import botStats, { recordUsage, aggregateHistory, aggregateByHourOfDay, aggregateByWeekday, getTopUsers, getSessionUniqueUsersCount } from './stats.js';
import { listOneDriveFiles, downloadFilesBuffers, getOneDriveFolderUrl } from './onedriveClient.js';
import { loadCache, saveCache } from './cacheManager.js';
import { fileToChunks } from './ingestion.js';
import { LocalRamVectorStore } from './vectorStore.js';
import aiControl from './aiControl.js';

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
// (https://chatbotcampus-pays-de-la-loire.fr). Sans ceci, req.protocol renvoie "http"
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

// --- INDEXATION DES DOCUMENTS ---
let vectorStore = null;
let bot_instance = null;

async function initKnowledgeBase(mistralClient, onProgress = () => { }) {
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
            // Repli volontaire : sans cette conservation, une simple coupure réseau viderait la
            // base de connaissance. Le cache ne contient que des documents issus du OneDrive, mais
            // il peut être en retard sur une suppression récente : relancer l'actualisation.
            log("⚠️  OneDrive injoignable : conservation temporaire du cache local (aucune purge possible).");
            const store = new LocalRamVectorStore(mistralClient);
            store.setDocuments(cache.documents);
            botStats.totalChunksIndexed = cache.documents.length;
            botStats.totalFilesParsed = Object.keys(cache.files).length;
            return store;
        }
        log("⚠️  Le bot démarrera sans base de connaissance.");
        return null;
    }

    // Un OneDrive vide n'est pas une erreur : on poursuit pour purger la base RAG de tous les
    // documents devenus obsolètes (sans ce passage, le bot continuerait de répondre à partir de
    // fichiers qui n'existent plus et la page de statistiques continuerait de les lister).
    if (!remoteFiles) remoteFiles = [];
    if (remoteFiles.length === 0) {
        log("⚠️  Aucun document trouvé dans le OneDrive : la base de connaissance va être vidée.");
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

    // Tout ce qui est connu localement (fichiers indexés, métadonnées, sources des blocs déjà
    // vectorisés) et qui n'est plus présent dans le OneDrive doit disparaître. On balaye les trois
    // origines : un bloc peut avoir une source absente de cache.files (indexation interrompue,
    // cache issu d'une version antérieure), et resterait alors indéfiniment dans la base.
    const pathsToRemove = [...new Set([
        ...Object.keys(cache.files),
        ...Object.keys(cache.fileMeta),
        ...cache.documents.map(d => d.path),
    ])].filter(p => p && !currentRemotePaths.has(p));

    if (pathsToRemove.length > 0) {
        log(`🗑️  ${pathsToRemove.length} fichier(s) absent(s) du OneDrive → retiré(s) de la base RAG.`);
        pathsToRemove.forEach(p => log(`   − ${p.split('/').pop()}`));
    }

    onProgress({ type: 'files', files: filesToDownload.map(f => f.name) });
    onProgress({ type: 'removed', files: pathsToRemove.map(p => p.split('/').pop()) });

    let newChunks = [];
    if (filesToDownload.length > 0) {
        log(`🔄 ${filesToDownload.length} fichier(s) à télécharger/mettre à jour.`);
        const downloadedDocs = await downloadFilesBuffers(filesToDownload);
        for (const doc of downloadedDocs) {
            log(`📄 Traitement : ${doc.name}`);
            try {
                // Excel : une fiche par colonne d'étape ; Word : blocs par titres ; autres formats :
                // découpage texte. Tous les blocs portent leur fil d'Ariane (cf. src/ingestion.js).
                const chunks = await fileToChunks(doc.buffer, doc.ext, doc.fullPath);

                if (chunks.length > 0) {
                    newChunks.push(...chunks);
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

    // Filtrage POSITIF sur les chemins réellement présents dans le OneDrive : un bloc n'est
    // conservé que si son fichier source existe encore en ligne et n'a pas changé (les fichiers
    // modifiés viennent d'être re-vectorisés dans newChunks).
    let updatedDocuments = cache.documents.filter(doc =>
        currentRemotePaths.has(doc.path) &&
        !filesToDownload.some(f => f.fullPath === doc.path)
    );

    if (newChunks.length > 0) {
        await store.addDocuments(newChunks, onProgress);
        log(`✅ ${newChunks.length} blocs indexés !`);
        updatedDocuments = updatedDocuments.concat(store.documents);
    }

    for (const p of pathsToRemove) {
        delete cache.files[p];
        delete cache.fileMeta[p];
    }

    store.setDocuments(updatedDocuments);
    cache.documents = updatedDocuments;
    saveCache(cache);

    botStats.totalChunksIndexed = updatedDocuments.length;
    botStats.totalFilesParsed = Object.keys(cache.files).length;

    log(`📚 Base RAG à jour : ${botStats.totalFilesParsed} fichier(s), ${updatedDocuments.length} bloc(s).`);

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

// Extrait un profil déclaré (nom/prénom + formation ou rôle) depuis le corps de la requête,
// en ne conservant que les champs attendus, sous forme de chaîne courte : le contenu n'est
// jamais utilisé comme instruction (cf. bot.js), mais on évite tout objet/valeur inattendue.
function sanitizeIncomingProfile(rawProfile) {
    if (!rawProfile || typeof rawProfile !== 'object') return null;
    const toShortString = (v) => (typeof v === 'string' ? v.slice(0, 150) : '');
    const profile = {
        firstName: toShortString(rawProfile.firstName),
        lastName: toShortString(rawProfile.lastName),
        role: toShortString(rawProfile.role),
        formation: toShortString(rawProfile.formation),
    };
    return (profile.firstName || profile.lastName) ? profile : null;
}

// Point d'entrée pour l'Interface Web
app.post('/api/chat', requireChatAuthApi, async (req, res) => {
    if (!bot_instance) return res.status(503).json({ error: "Bot en cours d'initialisation..." });
    try {
        const { question, userId = "web_user" } = req.body;
        if (!question) return res.status(400).json({ error: "Question manquante" });
        const safeUserId = typeof userId === 'string' ? userId.slice(0, 100) : 'web_user';
        const profile = sanitizeIncomingProfile(req.body.profile);
        // Le mode est déterminé par le rôle déduit du domaine Microsoft de l'utilisateur connecté,
        // jamais par une valeur envoyée par le client.
        const validMode = req.session.chatUser.role;
        const answer = await bot_instance.askQuestion(question, safeUserId, validMode, profile);
        res.json({ answer });
    } catch (error) {
        console.error("Erreur Web API:", error);
        // Même classification que le bot Teams (cf. onMessage dans bot.js) : sans ça, l'utilisateur
        // web recevait un message générique même quand la cause est un quota Mistral épuisé, un
        // rate limit temporaire ou une clé API invalide — trois cas très différents à diagnostiquer.
        let message = "⚠️ Service temporairement indisponible. Réessayez dans quelques instants.";
        if (error.isQuotaExhausted) {
            message = "⛔ Le quota de l'API Mistral est épuisé (0 requête/minute autorisée). Contactez l'administrateur du bot.";
        } else if (error.statusCode === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
            message = "⏳ L'API Mistral est temporairement surchargée (rate limit). Réessayez dans quelques instants.";
        } else if (error.message?.includes('401') || error.message?.includes('API key')) {
            message = "❌ Clé API Mistral invalide côté serveur. Contactez l'administrateur du bot.";
        }
        res.status(503).json({ error: message });
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

// Racine du dossier indexé (ex: "Document IA Teams"), retirée de l'affichage : elle est
// identique pour tous les documents et n'apporte aucune information de localisation.
const ONEDRIVE_ROOT_PREFIX = `${process.env.ONEDRIVE_FOLDER_PATH || ''}/`;

// Route liste des fichiers indexés
app.get('/api/stats/files', requireStatsAuthApi, (req, res) => {
    const cache = loadCache();
    const documents = cache.documents || [];
    const fileEntries = Object.entries(cache.files || {}).map(([filePath, lastModified]) => {
        const parts = filePath.split('/');
        const fileName = parts.pop();
        const folder = parts.pop() || '';

        // Chemin des sous-dossiers menant au fichier, sans la racine OneDrive (constante) ni le
        // nom du fichier : ex. "Etudiant/01_Etudiant/B3CN" pour un PDF profondément imbriqué.
        // Sert à afficher où se trouve réellement chaque document (cf. confusion possible entre
        // le dossier "Collaborateur", qui ne contient aucun PDF, et "Etudiant", qui en contient).
        const relativeDir = filePath.startsWith(ONEDRIVE_ROOT_PREFIX)
            ? filePath.slice(ONEDRIVE_ROOT_PREFIX.length, filePath.length - fileName.length - 1)
            : parts.join('/');

        const meta = (cache.fileMeta && cache.fileMeta[filePath]) || {};
        const chunks = documents.filter(d => d.path === filePath);
        const textLength = chunks.reduce((acc, c) => acc + (c.body ? c.body.length : 0), 0);
        const size = (typeof meta.size === 'number' && meta.size > 0) ? meta.size : (textLength > 0 ? textLength : 1024);
        return {
            fileName,
            folder,
            relativeDir,
            fullPath: filePath,
            lastModified: typeof lastModified === 'string' ? lastModified : (meta.lastModified || new Date().toISOString()),
            size,
            chunksCount: chunks.length
        };
    });
    // Tri par emplacement (chemin complet) plutôt que par seul nom de fichier, pour regrouper
    // visuellement les documents d'un même sous-dossier les uns à la suite des autres.
    fileEntries.sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'fr'));
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
    const chunks = documents.filter(d => d.path === filePath);
    const meta = (cache.fileMeta && cache.fileMeta[filePath]) || {};
    const parts = filePath.split('/');
    const fileName = parts.pop();
    const folder = parts.pop() || '';
    const lastModified = cache.files?.[filePath] || meta.lastModified;

    const textLength = chunks.reduce((acc, c) => acc + (c.body ? c.body.length : 0), 0);
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
            text: c.source !== c.file ? `${c.source}\n${c.body}` : c.body,
            length: c.body ? c.body.length : 0
        })),
        fullText: chunks.map(c => c.body).join('\n\n')
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

// --- CONTRÔLE DE L'IA (arrêt manuel et limite d'utilisation, cf. aiControl.js) ---
app.get('/api/ai-control', requireStatsAuthApi, (req, res) => {
    res.json(aiControl.getStatus());
});

app.post('/api/ai-control/toggle', requireStatsAuthApi, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Paramètre enabled manquant.' });
    aiControl.setEnabled(enabled);
    console.log(enabled ? "▶️  IA réactivée depuis la page de statistiques." : "⏸️  IA arrêtée depuis la page de statistiques.");
    res.json(aiControl.getStatus());
});

app.post('/api/ai-control/limit', requireStatsAuthApi, (req, res) => {
    const { enabled, type, max, period } = req.body || {};
    try {
        aiControl.setLimit({ enabled, type, max, period });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    res.json(aiControl.getStatus());
});

app.post('/api/ai-control/reset', requireStatsAuthApi, (req, res) => {
    aiControl.resetCounter();
    res.json(aiControl.getStatus());
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

async function refreshKnowledgeBase(onProgress = () => { }) {
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
