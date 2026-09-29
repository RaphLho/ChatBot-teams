// --- MOTEUR VECTORIEL 100% RAM + INDEX LEXICAUX ---
// Module séparé d'index.js (qui démarre le serveur à l'import) pour être réutilisable hors
// serveur : tests et vérifications hors ligne.
import { recordUsage } from './stats.js';
import { BM25Index } from './ragBoost.js';

// --- CATEGORISATION DES DOCUMENTS (Étudiant / Collaborateur) ---
// Déduite du chemin OneDrive du document (dossier "Etudiant" ou "Collaborateur" à la racine
// du dossier indexé). Calculée à la volée à partir de "path" plutôt que persistée, pour
// rester valable même sur un cache constitué avant l'ajout de cette fonctionnalité.
export function getCategoryFromPath(fullPath) {
    const segments = (fullPath || '').split('/');
    if (segments.includes('Etudiant')) return 'etudiant';
    if (segments.includes('Collaborateur')) return 'collaborateur';
    return 'autre';
}

// --- MOTEUR VECTORIEL 100% RAM ---
export class LocalRamVectorStore {
    constructor(mistralClient) {
        this.mistralClient = mistralClient;
        this.documents = [];
        this.indexes = new Map();
        this.indexVersion = null;
    }

    /**
     * Remplace les blocs de la base et reconstruit les index lexicaux (BM25), un par mode, avec
     * le même filtrage que la recherche vectorielle. Appelé après chaque synchronisation et après
     * chargement du cache disque. indexVersion change à chaque appel : il invalide le cache de
     * réponses du bot (une réponse n'est réutilisée que sur la base qui l'a produite).
     */
    setDocuments(documents) {
        this.documents = documents;
        const byCategory = { etudiant: [], collaborateur: [] };
        for (const doc of documents) byCategory[getCategoryFromPath(doc.path)]?.push(doc);
        const build = (docs) => ({ bm25: new BM25Index(docs), chunksById: new Map(docs.map(d => [d.id, d])) });
        this.indexes = new Map([
            ['etudiant', build(byCategory.etudiant)],
            ['collaborateur', build(byCategory.collaborateur)],
            [null, build(documents)],
        ]);
        this.indexVersion = `${Date.now().toString(36)}-${documents.length}`;
    }

    /** @param {'etudiant'|'collaborateur'|null} category */
    getIndex(category = null) {
        return this.indexes.get(category || null) || this.indexes.get(null);
    }

    async addDocuments(chunks, onProgress = () => { }) {
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
                        inputs: batch.map(c => c.embedText),
                    });
                    batch.forEach((chunk, j) => {
                        this.documents.push({ ...chunk, embedding: response.data[j].embedding });
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
     * Recherche vectorielle à partir d'un vecteur déjà calculé : le bot calcule tous ses
     * embeddings d'une question en un seul appel mistral-embed (cf. askQuestion dans bot.js).
     * @param {number[]} queryVector
     * @param {number} k
     * @param {'etudiant'|'collaborateur'|null} category - Si fourni, ne recherche que parmi les
     *   documents dont le chemin OneDrive appartient au dossier "Etudiant" ou "Collaborateur" correspondant.
     * @returns {{id: string, score: number}[]}
     */
    vectorSearch(queryVector, k = 30, category = null) {
        const pool = category
            ? this.documents.filter(doc => getCategoryFromPath(doc.path) === category)
            : this.documents;

        const scores = pool.map(doc => {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < queryVector.length; i++) {
                dot += queryVector[i] * doc.embedding[i];
                normA += queryVector[i] ** 2;
                normB += doc.embedding[i] ** 2;
            }
            return { id: doc.id, score: dot / (Math.sqrt(normA) * Math.sqrt(normB)) };
        });

        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, k);
    }
}
