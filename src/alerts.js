// --- Alertes Bitrix24 ---
// Un message est posté dans le chat Bitrix de l'équipe (méthode im.message.add du webhook
// API_BITRIX) à chaque fois que le chatbot ne peut plus envoyer de question à Mistral, et quand
// il le peut de nouveau :
// - arrêt / réactivation manuels depuis la page de statistiques ;
// - limite d'utilisation atteinte / levée (cf. aiControl.js) ;
// - appels à Mistral en échec (quota, clé invalide, surcharge, panne) / rétablis ;
// - crash du serveur, et (re)démarrage.
// Un échec d'envoi est journalisé mais n'interrompt jamais le chatbot.

const DEFAULT_DIALOG_ID = 'chat127512';
const SEND_TIMEOUT_MS = 10000;
const TITLE = '[b]🤖 Chatbot Campus[/b]';

const LIMIT_TYPE_LABELS = { tokens: 'tokens', messages: 'messages' };
const PERIOD_LABELS = { day: "aujourd'hui", month: 'ce mois-ci', total: 'depuis la dernière remise à zéro' };

function formatDate(date = new Date()) {
    return date.toLocaleString('fr-FR', {
        timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

const fmt = (n) => Number(n || 0).toLocaleString('fr-FR');

function usageLine(status) {
    const { type, max, period } = status.limit;
    return `${fmt(status.usage[type])} / ${fmt(max)} ${LIMIT_TYPE_LABELS[type]} ${PERIOD_LABELS[period]}`;
}

/**
 * Poste un message dans le chat Bitrix. Ne lève jamais d'exception : retourne true si Bitrix a
 * accepté le message.
 * @param {string} message
 * @param {{fetchImpl?: typeof fetch, env?: object}} options
 */
export async function sendBitrixMessage(message, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
    const base = (env.API_BITRIX || '').trim();
    if (!base) {
        console.warn('⚠️ API_BITRIX absente du .env : alerte Bitrix non envoyée.');
        return false;
    }
    const url = `${base.replace(/\/?$/, '/')}im.message.add`;
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ DIALOG_ID: env.BITRIX_DIALOG_ID || DEFAULT_DIALOG_ID, MESSAGE: message }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            console.error(`❌ Alerte Bitrix refusée (${res.status}) : ${data.error_description || data.error || ''}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error("❌ Impossible d'envoyer l'alerte Bitrix :", e.message);
        return false;
    }
}

/**
 * Message d'alerte pour un changement d'état du contrôle de l'IA (cf. aiControl.onChange).
 * @param {{from: null|'stopped'|'limit', to: null|'stopped'|'limit', cause: string, before: object, after: object}} event
 */
export function describeAiTransition({ from, to, cause, before, after }, date = new Date()) {
    const when = formatDate(date);
    const refused = before.blockedQuestions
        ? `\n${fmt(before.blockedQuestions)} question(s) refusée(s) pendant la coupure.`
        : '';

    if (to === 'stopped') {
        return `${TITLE}\n⏸️ [b]IA arrêtée manuellement[/b] depuis la page de statistiques le ${when}.\n`
            + "Plus aucune question n'est envoyée à Mistral : les utilisateurs reçoivent un message d'indisponibilité jusqu'à la réactivation.";
    }
    if (to === 'limit') {
        const intro = from === 'stopped'
            ? `▶️ IA réactivée manuellement le ${when}, [b]mais la limite d'utilisation est toujours atteinte[/b] : elle reste coupée.`
            : `⛔ [b]Limite d'utilisation atteinte[/b] le ${when} : l'IA est coupée automatiquement.`;
        const resume = after.limit.period === 'total'
            ? 'Pour la relancer : augmentez la limite, remettez le compteur à zéro ou désactivez la limite.'
            : 'Reprise automatique à la prochaine période, ou augmentez / désactivez la limite.';
        return `${TITLE}\n${intro}\nConsommation : ${usageLine(after)}.\n${resume}`;
    }
    // to === null : l'IA répond de nouveau.
    const reasons = {
        manual: 'réactivation manuelle depuis la page de statistiques',
        period: 'nouvelle période, compteur remis à zéro automatiquement',
        reset: 'compteur remis à zéro depuis la page de statistiques',
        limit: after.limit.enabled ? 'limite modifiée depuis la page de statistiques' : 'limite désactivée depuis la page de statistiques',
    };
    const detail = after.limit.enabled ? `\nConsommation : ${usageLine(after)}.` : '';
    return `${TITLE}\n▶️ [b]IA relancée[/b] le ${when} (${reasons[cause] || cause}).\n`
        + `Les questions sont de nouveau envoyées à Mistral.${detail}${refused}`;
}

function describeMistralError(error) {
    if (error?.isQuotaExhausted) return "quota de l'API Mistral épuisé";
    const status = error?.statusCode || error?.status;
    const text = error?.message || String(error);
    if (status === 429 || /429|rate limit/i.test(text)) return 'API Mistral surchargée (rate limit), même après les nouvelles tentatives';
    if (status === 401 || /401|api key/i.test(text)) return 'clé API Mistral invalide';
    return `erreur de l'API Mistral : ${text.slice(0, 300)}`;
}

/**
 * Suivi de la disponibilité de Mistral : une alerte au premier échec d'une série, un message
 * au premier succès qui suit (pas une alerte par question en échec).
 * @param {(message: string) => Promise<boolean>} send
 */
export function createMistralMonitor(send = sendBitrixMessage) {
    let failingSince = null;
    let failures = 0;
    return {
        reportFailure(error) {
            failures += 1;
            if (failingSince) return;
            failingSince = new Date();
            send(`${TITLE}\n🔥 [b]Le chatbot ne parvient plus à joindre Mistral[/b] (${formatDate(failingSince)}) : ${describeMistralError(error)}.\n`
                + "Les utilisateurs reçoivent un message d'erreur. Un message sera envoyé dès le retour à la normale.");
        },
        reportSuccess() {
            if (!failingSince) return;
            const count = failures;
            failingSince = null;
            failures = 0;
            send(`${TITLE}\n✅ [b]Mistral répond de nouveau[/b] (${formatDate()}) : le chatbot fonctionne normalement.\n`
                + `${fmt(count)} question(s) en échec pendant l'incident.`);
        },
        isFailing: () => !!failingSince,
    };
}

export const mistralMonitor = createMistralMonitor();

/**
 * Crash du serveur (exception non interceptée) : alerte Bitrix puis arrêt du processus, comme
 * le comportement par défaut de Node. Le message « Chatbot démarré » signale la relance.
 */
export function installCrashAlerts() {
    let crashing = false;
    const onCrash = async (kind, error) => {
        console.error(`💥 ${kind} :`, error);
        if (crashing) return;
        crashing = true;
        const text = (error?.stack || error?.message || String(error)).slice(0, 800);
        await sendBitrixMessage(`${TITLE}\n💥 [b]Le chatbot a planté[/b] (${formatDate()}) : ${kind}.\n`
            + `Plus aucune question n'est traitée jusqu'au redémarrage.\n[code]${text}[/code]`);
        process.exit(1);
    };
    process.on('uncaughtException', (error) => onCrash('exception non interceptée', error));
    process.on('unhandledRejection', (reason) => onCrash('promesse rejetée non interceptée', reason));
}

/**
 * Message de (re)démarrage du serveur, avec l'état du contrôle de l'IA restauré depuis le disque.
 * @param {object} status - aiControl.getStatus()
 */
export function describeStartup(status, date = new Date()) {
    const state = status.reason === 'stopped'
        ? "⚠️ L'IA est toujours [b]arrêtée manuellement[/b] : réactivez-la depuis la page de statistiques."
        : status.reason === 'limit'
            ? `⚠️ La [b]limite d'utilisation est atteinte[/b] (${usageLine(status)}) : l'IA reste coupée.`
            : 'Les questions sont envoyées à Mistral normalement.';
    return `${TITLE}\n🚀 [b]Chatbot démarré[/b] le ${formatDate(date)}.\n${state}`;
}
