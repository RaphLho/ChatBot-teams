import botbuilder from 'botbuilder';
import botStats, { recordUsage } from './stats.js';
const { ActivityHandler } = botbuilder;

// Mémoire courte : historique des conversations par utilisateur (en RAM)
const userHistory = new Map();
// Cache de réponses pour éviter de rappeler Mistral sur la même question
const responseCache = new Map();

class RAGBot extends ActivityHandler {
    constructor(vectorStore, mistralClient) {
        super();
        this.vectorStore = vectorStore;
        this.mistralClient = mistralClient;

        this.onMessage(async (context, next) => {
            const userQuestion = context.activity.text?.trim();
            if (!userQuestion) return await next();

            const userId = context.activity.from.id;

            try {
                const finalAnswer = await this.askQuestion(userQuestion, userId);
                await context.sendActivity(finalAnswer);
            } catch (error) {
                console.error("Erreur lors du traitement:", error.message);
                if (error.message?.includes('401') || error.message?.includes('API key')) {
                    await context.sendActivity("❌ Clé API Mistral invalide. Vérifiez le fichier .env");
                } else {
                    await context.sendActivity("⚠️ Service temporairement indisponible. Réessayez dans quelques instants.");
                }
            }

            await next();
        });


        this.onMembersAdded(async (context, next) => {
            for (const member of context.activity.membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(
                        "👋 Bonjour ! Je suis votre assistant pédagogique IA.\n\n" +
                        "Posez-moi vos questions sur les cours et je ferai de mon mieux pour vous aider !"
                    );
                }
            }
            await next();
        });
    }

    async askQuestion(userQuestion, userId) {
        // 1. Vérification dans le cache RAM
        const cacheKey = userQuestion.toLowerCase().replace(/\s+/g, '_');
        if (responseCache.has(cacheKey)) {
            const cached = responseCache.get(cacheKey);
            botStats.cacheHits += 1;
            this._updateHistory(userId, userQuestion, cached);
            return cached;
        }

        // 2. Recherche des extraits de cours (vectorielle)
        // On récupère le dernier message de l'historique pour l'incorporer dans la recherche vectorielle (pour donner un sens à "la suite")
        let searchContext = userQuestion;
        if (userHistory.has(userId)) {
            const history = userHistory.get(userId);
            if (history.length > 0) {
                searchContext = `${history[history.length - 1].question} ${userQuestion}`;
            }
        }

        let contextDocs = "";
        if (this.vectorStore) {
            try {
                const results = await this.vectorStore.similaritySearch(searchContext, 2);
                if (results.length > 0) {
                    contextDocs = results
                        .map((r, i) => `[Extrait ${i + 1} - Source: ${r.source}]\n${r.text}`)
                        .join("\n\n---\n\n");
                }
            } catch (e) {
                console.error("Erreur de recherche vectorielle:", e.message);
            }
        }

        // 3. Construction des messages avec l'historique NATIF
        const systemPrompt = `Tu es un assistant pédagogique pour des étudiants. 
Ta mission est d'aider les étudiants dans leurs cours.
Règles :
1. Si des extraits de cours pertinents te sont fournis, base tes explications dessus. Ne dis JAMAIS "D'après l'extrait fourni". Dis toujours "D'après le document [NOM_DU_FICHIER_SOURCE]".
2. Si l'étudiant donne une question de suivi ("et la suite ?", "plus de détails ?"), sers-toi de la conversation précédente pour comprendre de quoi il parle.
3. Si l'étudiant pose une question totalement hors contexte éducatif ou professionnel (ex: recette de cuisine, blague, cinéma, etc.), commence obligatoirement ta réponse par la balise exacte [NON-CONFORME] puis refuse poliment de répondre en précisant que ton but est purement éducatif.
4. Si la réponse te manque totalement et n'est ni dans l'historique, ni dans tes connaissances éducatives générales, avoue poliment que tu ne sais pas.
5. SOIS CONCIS. Tes réponses doivent être directes, claires et aller à l'essentiel. Ne génère pas de longs textes inutiles.`;

        let messages = [{ role: 'system', content: systemPrompt }];

        // Historique
        if (userHistory.has(userId)) {
            const history = userHistory.get(userId);
            for (const turn of history) {
                messages.push({ role: 'user', content: turn.question });
                messages.push({ role: 'assistant', content: turn.answer });
            }
        }

        // Message final
        const userPrompt = contextDocs
            ? `Voici des extraits extraits potentiellement utiles de notre base de cours :\n${contextDocs}\n\nQuestion de l'étudiant : ${userQuestion}`
            : userQuestion;

        messages.push({ role: 'user', content: userPrompt });

        // 4. Appel à Mistral
        const requestStartTime = Date.now();
        const chatResponse = await this.mistralClient.chat.complete({
            model: 'mistral-small-latest',
            messages: messages
        });
        const responseTimeMs = Date.now() - requestStartTime;

        let finalAnswer = chatResponse.choices[0].message.content;
        let isNonCompliant = false;

        // Détection de hors sujet
        if (finalAnswer.includes('[NON-CONFORME]')) {
            isNonCompliant = true;
            finalAnswer = finalAnswer.replace('[NON-CONFORME]', '').trim();
        }

        // 4.b Enregistrement des tokens
        const usage = chatResponse.usage;
        if (usage) {
            const promptTk = usage.promptTokens || usage.prompt_tokens || 0;
            const completionTk = usage.completionTokens || usage.completion_tokens || 0;
            console.log(`📊 Tokens utilisés — prompt: ${promptTk}, completion: ${completionTk}${isNonCompliant ? ' [HORS SUJET DÉTECTÉ]' : ''}`);
            recordUsage(promptTk, completionTk, userId, userQuestion, finalAnswer, isNonCompliant, responseTimeMs);
        } else {
            console.warn('⚠️ Pas de données usage dans la réponse Mistral');
            recordUsage(0, 0, userId, userQuestion, finalAnswer, isNonCompliant, responseTimeMs);
        }

        // 5. Mise en cache et historique
        responseCache.set(cacheKey, finalAnswer);
        this._updateHistory(userId, userQuestion, finalAnswer);

        return finalAnswer;
    }

    _updateHistory(userId, question, answer) {
        if (!userHistory.has(userId)) userHistory.set(userId, []);
        const history = userHistory.get(userId);
        
        // Troncature de la réponse pour économiser des tokens dans le futur
        const truncatedAnswer = answer.length > 300 ? answer.substring(0, 300) + "... [Texte tronqué]" : answer;
        
        history.push({ question, answer: truncatedAnswer });
        // Garder uniquement les 2 derniers tours de conversation
        if (history.length > 2) history.shift();
    }
}

export default RAGBot;
