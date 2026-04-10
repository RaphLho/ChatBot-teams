import 'dotenv/config';
import express from 'express';
import botbuilder from 'botbuilder';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { Mistral } from '@mistralai/mistralai';
import RAGBot from './bot.js';

const { CloudAdapter, ConfigurationServiceClientCredentialFactory, ConfigurationBotFrameworkAuthentication } = botbuilder;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docsPath = path.join(__dirname, '../docs');

const app = express();
app.use(express.json());

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: process.env.MICROSOFT_APP_ID,
    MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD,
    MicrosoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context, error) => {
    console.error(`\n [onTurnError]: ${error}`);
    await context.sendActivity("Le bot a subi une erreur interne.");
};

// --- DECOUPAGE DU TEXTE (sans LangChain) ---
function splitText(text, chunkSize = 1000, overlap = 200) {
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
        // Traitement par lots de 32 pour ne pas dépasser les limites de l'API
        const batchSize = 32;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
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
        }
    }

    async similaritySearch(query, k = 3) {
        if (this.documents.length === 0) return [];

        // Calcul de l'embedding pour la question
        const response = await this.mistralClient.embeddings.create({
            model: 'mistral-embed',
            inputs: [query],
        });
        const queryVector = response.data[0].embedding;

        // Calcul de la similarité cosinus
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

// --- INGESTION DES PDF ---
let vectorStore = null;
let bot_instance = null;

async function initKnowledgeBase(mistralClient) {
    console.log("------------------------------------------");
    console.log("🔄 Indexation des documents PDF en cours...");

    if (!fs.existsSync(docsPath)) {
        fs.mkdirSync(docsPath, { recursive: true });
        console.log("⚠️  Dossier /docs créé. Ajoutez des PDF dedans et relancez.");
        return null;
    }

    const files = fs.readdirSync(docsPath).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
        console.log("⚠️  Aucun PDF dans /docs. Le bot fonctionnera sans base de cours.");
        return null;
    }

    const store = new LocalRamVectorStore(mistralClient);
    let allChunks = [];

    for (const file of files) {
        console.log(`📄 Lecture : ${file}`);
        const filePath = path.join(docsPath, file);
        const dataBuffer = fs.readFileSync(filePath);
        try {
            const data = await pdfParse(dataBuffer);
            const chunks = splitText(data.text, 1000, 200);
            chunks.forEach(c => allChunks.push({ text: c, source: file }));
        } catch (e) {
            console.error(`   ❌ Impossible de lire ${file}:`, e.message);
        }
    }

    if (allChunks.length > 0) {
        await store.addDocuments(allChunks);
        console.log(`✅ ${allChunks.length} blocs indexés en mémoire RAM !`);
    }

    return store;
}

// --- DEMARRAGE DU SERVEUR ---
const PORT = process.env.PORT || 3978;
app.post('/api/messages', async (req, res) => {
    if (!bot_instance) return res.status(503).send("Bot en cours d'initialisation...");
    await adapter.process(req, res, (context) => bot_instance.run(context));
});

app.listen(PORT, async () => {
    console.log(`\n🌐 Serveur démarré sur le port ${PORT}`);

    if (!process.env.MISTRAL_API_KEY) {
        console.error("❌ MISTRAL_API_KEY manquante dans le fichier .env !");
        process.exit(1);
    }

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
    vectorStore = await initKnowledgeBase(mistral);
    bot_instance = new RAGBot(vectorStore, mistral);

    console.log("------------------------------------------");
    console.log(`🚀 BOT PRÊT ! Connectez Bot Framework Emulator sur : http://localhost:${PORT}/api/messages`);
    console.log("------------------------------------------\n");
});
