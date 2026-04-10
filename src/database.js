import { createClient } from 'redis';
import { ChromaClient } from 'chromadb';

// Initialisation du client Redis
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Erreur Redis Client:', err));

async function connectRedis() {
    if (!redisClient.isOpen) {
        await redisClient.connect();
        console.log('Connecté à Redis');
    }
}

// Initialisation du client ChromaDB
const chromaClient = new ChromaClient({
    path: process.env.CHROMA_URL || 'http://localhost:8000'
});

export {
    redisClient,
    connectRedis,
    chromaClient
};
