import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONTROL_FILE = path.join(__dirname, '../data/ai_control.json');

// --- Contrôle de l'IA (page de statistiques) ---
// Deux coupures indépendantes, persistées sur disque pour survivre à un redémarrage :
// - l'arrêt manuel (bouton Stop), levé uniquement par le bouton Réactiver ;
// - la limite d'utilisation (tokens ou messages, par jour, par mois ou jusqu'à remise à zéro),
//   levée quand la période change, quand le compteur est remis à zéro, quand la limite est
//   augmentée ou désactivée.
// Tant que l'une des deux est active, askQuestion répond par un message fixe sans aucun appel
// Mistral (ni chat, ni embedding).

export const LIMIT_TYPES = ['tokens', 'messages'];
export const LIMIT_PERIODS = ['day', 'month', 'total'];
const MAX_LIMIT_VALUE = 1e12;

export const BLOCKED_MESSAGE_STOPPED = "⏸️ L'assistant est momentanément désactivé par l'administrateur. Réessayez plus tard.";
export const BLOCKED_MESSAGE_LIMIT = "⛔ L'assistant a atteint sa limite d'utilisation et est momentanément indisponible. Réessayez plus tard.";

function periodKey(period, date) {
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (period === 'day') return `${month}-${String(date.getDate()).padStart(2, '0')}`;
    if (period === 'month') return month;
    return 'total';
}

function defaultState(now) {
    return {
        enabled: true,
        stoppedAt: null,
        limit: { enabled: false, type: 'tokens', max: 100000, period: 'month' },
        usage: { periodKey: periodKey('month', now), since: now.getTime(), tokens: 0, messages: 0 },
        blockedQuestions: 0,
    };
}

/**
 * @param {{file?: string|null, now?: () => Date}} options
 *   file : fichier de persistance (null = en mémoire uniquement, pour les tests).
 */
export function createAiControl({ file = CONTROL_FILE, now = () => new Date() } = {}) {
    let state = defaultState(now());

    if (file && fs.existsSync(file)) {
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            const base = defaultState(now());
            state = {
                ...base,
                ...saved,
                limit: { ...base.limit, ...(saved.limit || {}) },
                usage: { ...base.usage, ...(saved.usage || {}) },
            };
        } catch (e) {
            console.error("Erreur lors de la lecture du contrôle de l'IA :", e);
        }
    }

    function save() {
        if (!file) return;
        try {
            const dir = path.dirname(file);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(state, null, 2));
        } catch (e) {
            if (e.code !== 'EBUSY') console.error("Erreur lors de la sauvegarde du contrôle de l'IA :", e);
        }
    }

    function resetUsage() {
        const date = now();
        state.usage = { periodKey: periodKey(state.limit.period, date), since: date.getTime(), tokens: 0, messages: 0 };
    }

    // Nouveau jour / nouveau mois : le compteur repart de zéro (et une coupure due à la limite
    // se lève d'elle-même).
    function rollPeriod() {
        if (state.usage.periodKey !== periodKey(state.limit.period, now())) {
            resetUsage();
            save();
        }
    }

    function isLimitReached() {
        rollPeriod();
        const { enabled, type, max } = state.limit;
        return enabled && max > 0 && state.usage[type] >= max;
    }

    /** Raison de la coupure en cours : 'stopped', 'limit', ou null si l'IA peut répondre. */
    function blockReason() {
        if (!state.enabled) return 'stopped';
        if (isLimitReached()) return 'limit';
        return null;
    }

    return {
        blockReason,

        /** Message servi à la place d'une réponse quand l'IA est coupée (null si elle est active). */
        blockedMessage() {
            const reason = blockReason();
            if (!reason) return null;
            state.blockedQuestions += 1;
            save();
            return reason === 'stopped' ? BLOCKED_MESSAGE_STOPPED : BLOCKED_MESSAGE_LIMIT;
        },

        /** Consommation à décompter de la limite (appelé par stats.js). */
        record({ tokens = 0, messages = 0 }) {
            if (!tokens && !messages) return;
            rollPeriod();
            state.usage.tokens += tokens;
            state.usage.messages += messages;
            save();
        },

        setEnabled(enabled) {
            state.enabled = !!enabled;
            state.stoppedAt = state.enabled ? null : now().getTime();
            // Le compteur de questions refusées porte sur la coupure en cours.
            state.blockedQuestions = 0;
            save();
        },

        /**
         * Met à jour la limite. Valeurs invalides → Error (message affichable).
         * Un changement de période remet le compteur à zéro (il ne mesurerait plus la même chose).
         */
        setLimit({ enabled, type, max, period }) {
            const next = { ...state.limit };
            if (enabled !== undefined) next.enabled = !!enabled;
            if (type !== undefined) {
                if (!LIMIT_TYPES.includes(type)) throw new Error('Type de limite invalide.');
                next.type = type;
            }
            if (period !== undefined) {
                if (!LIMIT_PERIODS.includes(period)) throw new Error('Période de limite invalide.');
                next.period = period;
            }
            if (max !== undefined) {
                const n = Number(max);
                if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT_VALUE) {
                    throw new Error('La limite doit être un nombre entier supérieur ou égal à 1.');
                }
                next.max = n;
            }
            const periodChanged = next.period !== state.limit.period;
            const wasBlockedByLimit = isLimitReached();
            state.limit = next;
            if (periodChanged) resetUsage();
            if (wasBlockedByLimit && !isLimitReached()) state.blockedQuestions = 0;
            save();
        },

        resetCounter() {
            resetUsage();
            state.blockedQuestions = 0;
            save();
        },

        getStatus() {
            const reason = blockReason();
            return {
                active: reason === null,
                reason,
                enabled: state.enabled,
                stoppedAt: state.stoppedAt,
                limit: { ...state.limit },
                usage: { ...state.usage },
                limitReached: isLimitReached(),
                blockedQuestions: state.blockedQuestions,
            };
        },
    };
}

const aiControl = createAiControl();
export default aiControl;
