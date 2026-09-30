// --- Petits échanges traités sans appel LLM (0 token) ---
// 1. Salutations et remerciements seuls (« bonjour », « merci ! ») : réponse courtoise fixe. Sans
//    ce traitement, un « bonjour » partait dans la recherche documentaire et recevait la formule
//    de repli (« Je ne trouve pas cette information… »).
// 2. Questions de clarification : le modèle commence sa réponse par [CLARIFICATION] et propose
//    une liste numérotée terminée par « Autres (à préciser) ». Le message suivant (« 2 »,
//    « Formulaire de stage »…) est rattaché à la question d'origine par resolveClarification.

const normalize = (s) => (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const HELLO = '(?:bonjour|bonsoir|salut|hello|coucou|hey|bjr|slt|hi|re)';
const POLITE_TAIL = '(?: (?:a (?:toi|vous|tous|toutes)|tout le monde|l assistant|le bot|chatbot|madame|monsieur))?';
const HOW_ARE_YOU = '(?: (?:comment (?:ca va|allez vous|vas tu)|ca va|vous allez bien))?';
const GREETING_RE = new RegExp(`^${HELLO}${POLITE_TAIL}${HOW_ARE_YOU}$`);
const THANKS_RE = /^(?:(?:un )?grand )?(?:merci|thanks|thx)(?: (?:beaucoup|bien|infiniment|pour (?:tout|votre aide|ton aide|l info|la reponse|ces informations)))*$|^(?:super|parfait|top|genial|d accord|ok|okay)(?: merci(?: beaucoup)?)?$/;
const BYE_RE = /^(?:(?:merci )?(?:au revoir|bonne (?:journee|soiree)|a bientot|bye|a plus))(?: (?:et )?merci(?: beaucoup)?)?$/;

/**
 * Réponse courtoise à un message qui n'est qu'une salutation, un remerciement ou un au revoir ;
 * null pour toute autre question (y compris « Bonjour, quand sont les examens ? »).
 * @param {string} message
 * @param {string} firstName - prénom déclaré (profil), vide si inconnu
 * @param {Date} date
 */
export function smallTalkReply(message, firstName = '', date = new Date()) {
    const text = normalize(message);
    if (!text || text.length > 60) return null;
    const name = firstName ? ` ${firstName}` : '';

    if (GREETING_RE.test(text)) {
        // Heure de Paris (le serveur peut tourner en UTC, par exemple dans Docker)
        const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }).format(date));
        const evening = /^bonsoir/.test(text) || hour >= 18;
        const hello = evening ? 'Bonsoir' : 'Bonjour';
        return `${hello}${name} ! Comment allez-vous aujourd'hui ? Je suis à votre disposition : que puis-je faire pour vous aider ?`;
    }
    if (BYE_RE.test(text)) {
        return `Je vous en prie${name}, ce fut un plaisir de vous aider ! Je reste disponible si vous avez d'autres questions. Belle journée à vous !`;
    }
    if (THANKS_RE.test(text)) {
        return `Je vous en prie${name}, avec plaisir ! N'hésitez pas si vous avez une autre question, je reste à votre disposition.`;
    }
    return null;
}

export const CLARIFICATION_TAG = '[CLARIFICATION]';

// Réponse servie quand la personne choisit « Autres » : elle précise librement sa demande au
// message suivant, toujours rattaché à la question d'origine.
export const CLARIFICATION_OTHER_REPLY = "Bien sûr ! Précisez librement votre demande dans votre prochain message, je vous réponds dès que possible.";

const OTHER_RE = /^autres?\b/;

/**
 * Choix numérotés d'une question de clarification (« 1. Formulaire de rentrée »…).
 * @returns {{n: number, label: string, other: boolean}[]}
 */
export function parseClarificationOptions(answer) {
    const options = [];
    for (const line of (answer || '').split('\n')) {
        const m = line.match(/^\s*(?:[-*]\s*)?(\d{1,2})\s*[.)-]\s+(.+?)\s*$/);
        if (!m) continue;
        const label = m[2].replace(/\*\*/g, '').trim();
        options.push({ n: Number(m[1]), label, other: OTHER_RE.test(normalize(label)) });
    }
    return options;
}

/**
 * Interprète la réponse à une question de clarification.
 * @returns {{type: 'option', label: string} | {type: 'other'} | {type: 'free', text: string}}
 *   option : choix reconnu (numéro ou intitulé) ; other : « Autres » sans précision ;
 *   free : précision libre (réponse après « Autres », ou texte ne correspondant à aucun choix).
 */
export function resolveClarification(message, options) {
    const text = normalize(message);
    const num = text.match(/^(?:(?:le|la|choix|option|numero|n) )?(\d{1,2})(?: (.*))?$/);
    let chosen = null;
    if (num) chosen = options.find(o => o.n === Number(num[1])) || null;
    if (!chosen) chosen = options.find(o => normalize(o.label) === text) || null;

    if (chosen?.other || (!chosen && OTHER_RE.test(text))) {
        // « Autres » seul → inviter à préciser ; « 5. mon cas particulier » / « autre : … » → précision libre
        const precision = message
            .replace(/^\s*(?:(?:le|la|choix|option|num[ée]ro|n°?)\s*)?\d{1,2}\s*[.)-]?\s*/i, '')
            .replace(/^\s*autres?\b\s*(?:\(\s*[àa] pr[ée]ciser\s*\))?\s*[:,-]?\s*/i, '')
            .trim();
        return precision ? { type: 'free', text: precision } : { type: 'other' };
    }
    if (chosen) return { type: 'option', label: chosen.label };
    return { type: 'free', text: message.trim() };
}
