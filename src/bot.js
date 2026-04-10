import botbuilder from 'botbuilder';
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
                // 1. Vérification dans le cache RAM
                const cacheKey = userQuestion.toLowerCase().replace(/\s+/g, '_');
                if (responseCache.has(cacheKey)) {
                    const cached = responseCache.get(cacheKey);
                    await context.sendActivity(cached);
                    this._updateHistory(userId, userQuestion, cached);
                    return await next();
                }

                // 2. Recherche des extraits de cours les plus proches (vectorielle)
                let contextDocs = "Aucun cours indexé.";
                if (this.vectorStore) {
                    try {
                        const results = await this.vectorStore.similaritySearch(userQuestion, 3);
                        if (results.length > 0) {
                            contextDocs = results
                                .map((r, i) => `[Extrait ${i + 1} - Source: ${r.source}]\n${r.text}`)
                                .join("\n\n---\n\n");
                        }
                    } catch (e) {
                        console.error("Erreur de recherche vectorielle:", e.message);
                    }
                }

                // 3. Construction du prompt avec historique et contexte
                const historyStr = this._getHistory(userId);
                const systemPrompt = `Tu es un assistant pédagogique pour des étudiants en formation. 
Réponds UNIQUEMENT en te basant sur les extraits de cours fournis.
Si la réponse n'est pas dans les extraits, dis poliment que tu ne sais pas.
Sois clair, pédagogique et concis.`;

                const userPrompt = `Extraits de cours pertinents :
${contextDocs}

Historique récent :
${historyStr}

Question de l'étudiant : ${userQuestion}`;

                // 4. Appel à Mistral Small 3.1
                const chatResponse = await this.mistralClient.chat.complete({
                    model: 'mistral-small-latest',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                });

                const finalAnswer = chatResponse.choices[0].message.content;

                // 5. Mise en cache et historique
                responseCache.set(cacheKey, finalAnswer);
                this._updateHistory(userId, userQuestion, finalAnswer);

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

    _getHistory(userId) {
        if (!userHistory.has(userId)) return "Aucun historique.";
        return userHistory.get(userId).join("\n\n");
    }

    _updateHistory(userId, question, answer) {
        if (!userHistory.has(userId)) userHistory.set(userId, []);
        const history = userHistory.get(userId);
        history.push(`Étudiant: ${question}\nAssistant: ${answer}`);
        if (history.length > 5) history.shift(); // Garder les 5 derniers tours
    }
}

export default RAGBot;
