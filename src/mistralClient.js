import { Mistral } from '@mistralai/mistralai';

// Initialisation du client Mistral
const apiKey = process.env.MISTRAL_API_KEY;

if (!apiKey) {
    console.warn("Attention: MISTRAL_API_KEY n'est pas définie dans les variables d'environnement.");
}

const mistralClient = new Mistral({ apiKey: apiKey });

export default mistralClient;
