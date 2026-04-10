import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { chromaClient } from './database.js';
import { MistralAIEmbeddings } from '@langchain/mistralai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsPath = path.join(__dirname, '../docs');
const COLLECTION_NAME = 'cours_etudiants';

async function ingestDocuments() {
    try {
        console.log('Démarrage de l\'ingestion des documents...');
        
        // 1. Lire les fichiers du répertoire /docs
        if (!fs.existsSync(docsPath)) {
            console.error(`Le dossier ${docsPath} n'existe pas. Création du dossier...`);
            fs.mkdirSync(docsPath, { recursive: true });
            console.log('Veuillez ajouter des fichiers PDF dans le dossier /docs et relancer.');
            process.exit(0);
        }

        const files = fs.readdirSync(docsPath).filter(f => f.endsWith('.pdf'));
        if (files.length === 0) {
            console.log('Aucun fichier PDF trouvé dans /docs.');
            return;
        }

        let allText = [];
        
        // 2. Extraire le texte de chaque PDF (LangChain / pdf-parse)
        for (const file of files) {
            console.log(`Traitement du fichier: ${file}`);
            const filePath = path.join(docsPath, file);
            const dataBuffer = fs.readFileSync(filePath);
            
            try {
                const data = await pdfParse(dataBuffer);
                allText.push({
                    text: data.text,
                    metadata: { source: file }
                });
            } catch (err) {
                console.error(`Erreur lors de la lecture du fichier ${file}:`, err);
            }
        }

        // 3. Découpage du texte avec un chevauchement pour garder le contexte
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        let splitDocs = [];
        for (const doc of allText) {
            const chunks = await splitter.createDocuments([doc.text], [doc.metadata]);
            splitDocs.push(...chunks);
        }
        
        console.log(`Génération de ${splitDocs.length} segments (chunks).`);

        // 4. Stockage des embeddings avec ChromaDB et le modèle Mistral
        const embeddings = new MistralAIEmbeddings({
            apiKey: process.env.MISTRAL_API_KEY
        });

        // Suppression de l'ancienne collection si elle existe, puis création
        try {
            await chromaClient.deleteCollection({ name: COLLECTION_NAME });
        } catch(e) {
            // Ignorer l'erreur si la collection n'existait pas encore
        }

        const collection = await chromaClient.getOrCreateCollection({ 
            name: COLLECTION_NAME
        });

        // Insertion par lot pour limiter la taille des requêtes HTTP
        const maxBatchSize = 100;
        for (let i = 0; i < splitDocs.length; i += maxBatchSize) {
            const batch = splitDocs.slice(i, i + maxBatchSize);
            const texts = batch.map(d => d.pageContent);
            const metadatas = batch.map(d => d.metadata);
            const ids = batch.map((_, idx) => `id_${i + idx}`);
            
            console.log(`Calcul des embeddings pour le lot ${i / maxBatchSize + 1} / ${Math.ceil(splitDocs.length / maxBatchSize)}...`);
            const embedded_texts = await embeddings.embedDocuments(texts);
            
            await collection.add({
                ids: ids,
                embeddings: embedded_texts,
                metadatas: metadatas,
                documents: texts
            });
        }

        console.log('Ingestion terminée avec succès ! Les embeddings sont stockés dans ChromaDB.');

    } catch (error) {
        console.error('Erreur critique lors de l\'ingestion:', error);
    }
}

ingestDocuments();
