import 'dotenv/config';
import express from 'express';
import { BotFrameworkAdapter } from 'botbuilder';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
import { Mistral } from '@mistralai/mistralai';
import RAGBot from './bot.js';
import botStats, { recordUsage, aggregateHistory } from './stats.js';
import { listOneDriveFiles, downloadFilesBuffers } from './onedriveClient.js';
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
app.use(express.json());

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

    async addDocuments(chunks) {
        console.log(`   ↳ Envoi de ${chunks.length} blocs à Mistral pour embedding...`);
        const batchSize = 32;
        const delayBetweenBatches = 500; // ms entre chaque batch
        const maxRetries = 3;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            let retries = 0;
            let success = false;

            while (!success && retries <= maxRetries) {
                try {
                    if (retries > 0) {
                        const backoff = Math.pow(2, retries) * 1000; // 2s, 4s, 8s
                        console.log(`   ⏳ Retry ${retries}/${maxRetries} dans ${backoff / 1000}s (rate limit)...`);
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
                        recordUsage(embTk, 0, 'embedding_indexation');
                    }
                    success = true;
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

    async similaritySearch(query, k = 3) {
        if (this.documents.length === 0) return [];

        const response = await this.mistralClient.embeddings.create({
            model: 'mistral-embed',
            inputs: [query],
        });
        // Tracker les tokens d'embedding de recherche
        if (response.usage) {
            const embTk = response.usage.promptTokens || response.usage.prompt_tokens || response.usage.totalTokens || response.usage.total_tokens || 0;
            recordUsage(embTk, 0, 'embedding_search');
        }
        const queryVector = response.data[0].embedding;

        const scores = this.documents.map(doc => {
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

// --- EXTRACTION DE TEXTE DEPUIS UN BUFFER ---
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
        case '.csv':
            return buffer.toString('utf8');
        case '.docx':
            const docxData = await mammoth.extractRawText({ buffer });
            return docxData.value;
        case '.xlsx':
        case '.xls':
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            let text = "";
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                text += `\n--- Feuille: ${sheetName} ---\n`;
                text += xlsx.utils.sheet_to_csv(sheet);
            }
            return text;
        default:
            throw new Error(`Format non pris en charge : ${ext}`);
    }
}

// --- INDEXATION DES DOCUMENTS ---
let vectorStore = null;
let bot_instance = null;

async function initKnowledgeBase(mistralClient) {
    console.log("------------------------------------------");
    console.log("🔄 Indexation des documents en cours...");

    const cache = loadCache();
    let remoteFiles;
    try {
        remoteFiles = await listOneDriveFiles();
    } catch (err) {
        console.error("❌ Erreur de connexion OneDrive:", err.message);
        if (cache.documents.length > 0) {
            console.log("⚠️  Utilisation du cache local de la base de connaissance.");
            const store = new LocalRamVectorStore(mistralClient);
            store.documents = cache.documents;
            botStats.totalChunksIndexed = cache.documents.length;
            botStats.totalFilesParsed = Object.keys(cache.files).length;
            return store;
        }
        console.log("⚠️  Le bot démarrera sans base de connaissance.");
        return null;
    }

    if (!remoteFiles || remoteFiles.length === 0) {
        console.log("⚠️  Aucun document trouvé. Le bot fonctionnera sans base de cours.");
        return null;
    }

    const filesToDownload = [];
    const currentRemotePaths = new Set();

    for (const file of remoteFiles) {
        currentRemotePaths.add(file.fullPath);
        const cachedDate = cache.files[file.fullPath];
        if (!cachedDate || cachedDate !== file.lastModified) {
            filesToDownload.push(file);
        }
    }

    const pathsToRemove = Object.keys(cache.files).filter(p => !currentRemotePaths.has(p));
    
    let newChunks = [];
    if (filesToDownload.length > 0) {
        console.log(`🔄 ${filesToDownload.length} fichier(s) à télécharger/mettre à jour.`);
        const downloadedDocs = await downloadFilesBuffers(filesToDownload);
        for (const doc of downloadedDocs) {
            console.log(`📄 Traitement : ${doc.name}`);
            try {
                const text = await extractTextFromBuffer(doc.buffer, doc.ext);
                if (text && text.trim().length > 0) {
                    const chunks = splitText(text, 600, 100);
                    chunks.forEach(c => newChunks.push({ text: c, source: doc.fullPath }));
                } else {
                    console.log(`   ⚠️ Document vide ou illisible : ${doc.name}`);
                }
                const remoteFile = filesToDownload.find(f => f.fullPath === doc.fullPath);
                if (remoteFile) cache.files[doc.fullPath] = remoteFile.lastModified;
            } catch (e) {
                console.error(`   ❌ Impossible de lire ${doc.name}:`, e.message);
            }
        }
    } else {
        console.log(`✅ Tous les fichiers sont à jour. Aucun téléchargement nécessaire.`);
    }

    const store = new LocalRamVectorStore(mistralClient);
    
    let updatedDocuments = cache.documents.filter(doc => 
        !pathsToRemove.includes(doc.source) && 
        !filesToDownload.some(f => f.fullPath === doc.source)
    );

    if (newChunks.length > 0) {
        await store.addDocuments(newChunks);
        console.log(`✅ ${newChunks.length} blocs indexés !`);
        updatedDocuments = updatedDocuments.concat(store.documents);
    }

    for (const p of pathsToRemove) {
        delete cache.files[p];
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

app.use(express.static(path.join(__dirname, '../public')));

// --- MIDDLEWARE AUTH STATS ---
function basicAuthStats(req, res, next) {
    const authheader = req.headers.authorization;
    if (!authheader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Statistiques"');
        return res.status(401).send('Authentification requise');
    }
    const auth = Buffer.from(authheader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    if (user === process.env.ID_STATS && pass === process.env.MDP_STATS) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Statistiques"');
        return res.status(401).send('Identifiants incorrects');
    }
}

// Route HTML pour les stats
app.get('/stats', basicAuthStats, (req, res) => {
    res.sendFile(path.join(__dirname, '../protected/stats.html'));
});


// Point d'entrée pour Microsoft Teams / Bot Framework
app.post('/api/messages', async (req, res) => {
    if (!bot_instance) return res.status(503).send("Bot en cours d'initialisation...");
    await adapter.processActivity(req, res, (context) => bot_instance.run(context));
});

// Point d'entrée pour l'Interface Web
app.post('/api/chat', async (req, res) => {
    if (!bot_instance) return res.status(503).json({ error: "Bot en cours d'initialisation..." });
    try {
        const { question, userId = "web_user" } = req.body;
        if (!question) return res.status(400).json({ error: "Question manquante" });
        const answer = await bot_instance.askQuestion(question, userId);
        res.json({ answer });
    } catch (error) {
        console.error("Erreur Web API:", error);
        res.status(500).json({ error: "Une erreur est survenue lors de la génération de la réponse." });
    }
});

app.get('/api/stats', basicAuthStats, (req, res) => {
    const uptimeMs = Date.now() - botStats.startTime;
    
    const avgTokensSession = botStats.session.totalConversations > 0
        ? Math.round((botStats.session.totalPromptTokens + botStats.session.totalCompletionTokens) / botStats.session.totalConversations)
        : 0;
        
    const avgTokensGlobal = botStats.global.totalConversations > 0
        ? Math.round((botStats.global.totalPromptTokens + botStats.global.totalCompletionTokens) / botStats.global.totalConversations)
        : 0;
        
    res.json({ 
        uptime: uptimeMs, 
        totalFilesParsed: botStats.totalFilesParsed,
        totalChunksIndexed: botStats.totalChunksIndexed,
        session: { ...botStats.session, avgTokensPerRequest: avgTokensSession },
        global: { ...botStats.global, avgTokensPerRequest: avgTokensGlobal }
    });
});

// Route Historique détaillé
app.get('/api/stats/history', basicAuthStats, (req, res) => {
    const hourly = aggregateHistory('hour');
    const daily = aggregateHistory('day');
    res.json({
        entries: botStats.history,
        hourly,
        daily
    });
});

// --- ACTUALISATION AUTOMATIQUE ---
let isRefreshing = false;
let mistralGlobal = null;

async function refreshKnowledgeBase() {
    if (isRefreshing || !mistralGlobal) return;
    isRefreshing = true;
    try {
        console.log("\n⏱️ Actualisation automatique de la base de connaissance OneDrive...");
        const newStore = await initKnowledgeBase(mistralGlobal);
        if (newStore && bot_instance) {
            bot_instance.vectorStore = newStore;
            console.log("🔄 Base de connaissance mise à jour avec succès en mémoire (sans redémarrer le bot) !");
        }
    } catch (e) {
         console.error("❌ Erreur lors de l'actualisation automatique:", e);
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

    // Route permettant d'actualiser manuellement (ex: via un bouton ou Postman)
    app.post('/api/refresh', async (req, res) => {
        if (isRefreshing) return res.status(429).json({ status: "Déjà en cours d'actualisation" });
        await refreshKnowledgeBase();
        res.json({ status: "Base de connaissances mise à jour avec succès !" });
    });

    console.log("------------------------------------------");
    console.log(`🚀 BOT PRÊT ! Connectez Bot Framework Emulator sur : http://localhost:${PORT}/api/messages`);
    console.log("------------------------------------------\n");
});
