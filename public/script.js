const form = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const chatContainer = document.getElementById('chat-container');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const exportChatBtn = document.getElementById('export-chat-btn');

// Auto-resize textarea
messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if(this.value.trim() === '') {
        this.style.height = 'auto';
    }
});

// Configure Marked.js options safely
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,
        gfm: true
    });
}

// ============================================
// Rôle (Étudiant / Collaborateur), déduit du domaine du compte Microsoft connecté
// ============================================
let currentMode = null; // renseigné par renderChatUserInfo() une fois le rôle connu

const modeSelectorLabel = document.getElementById('mode-selector-label');

const MODE_INFO = {
    etudiant: { label: 'Mode : Étudiant' },
    collaborateur: { label: 'Mode : Collaborateur' }
};

function applyMode(mode) {
    currentMode = mode;
    if (modeSelectorLabel) {
        modeSelectorLabel.textContent = (mode && MODE_INFO[mode]) ? MODE_INFO[mode].label : 'Mode normal';
    }
}

function escapeHtml(str) {
    return (str || '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function createMessageElement(text, isUser = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isUser ? 'user' : 'bot'}`;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'avatar';

    if (isUser) {
        avatarDiv.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    } else {
        avatarDiv.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
    }

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'bubble';

    if (isUser) {
        bubbleDiv.textContent = text; // Plain text for user (security)
    } else {
        // Parse markdown if possible, otherwise innerHTML (already formatted by server or plain text)
        bubbleDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(text) : text;
        renderClarificationChoices(bubbleDiv, text);
    }

    msgDiv.appendChild(avatarDiv);
    msgDiv.appendChild(bubbleDiv);

    return msgDiv;
}

// --- Question de clarification : choix cliquables ---
// Une réponse du bot dont la liste numérotée se termine par « Autres (à préciser) » est une
// question de clarification (cf. src/conversation.js) : la liste est remplacée par des boutons.
// Un choix envoie « 2. Intitulé » ; « Autres » laisse la personne écrire librement sa précision.
const CLARIFICATION_DEFAULT_PLACEHOLDER = messageInput.placeholder;

function parseClarificationChoices(text) {
    const choices = [];
    for (const line of (text || '').split('\n')) {
        const m = line.match(/^\s*(\d{1,2})\s*[.)]\s+(.+?)\s*$/);
        if (m) choices.push({ n: m[1], label: m[2].replace(/\*\*/g, '') });
    }
    const last = choices[choices.length - 1];
    return choices.length >= 2 && /^autres?\b/i.test(last.label) ? choices : null;
}

function renderClarificationChoices(bubbleDiv, text) {
    const choices = parseClarificationChoices(text);
    if (!choices) return;
    const lists = bubbleDiv.querySelectorAll('ol');
    const list = lists[lists.length - 1];
    if (list && list.children.length === choices.length) list.remove();

    const wrap = document.createElement('div');
    wrap.className = 'clarify-choices';
    choices.forEach(choice => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'clarify-choice';
        btn.disabled = true; // activé seulement sur le dernier message (cf. refreshClarificationChoices)
        const num = document.createElement('span');
        num.className = 'clarify-choice-num';
        num.textContent = choice.n;
        btn.append(num, document.createTextNode(choice.label));
        btn.addEventListener('click', () => {
            if (/^autres?\b/i.test(choice.label)) {
                messageInput.placeholder = 'Précisez votre demande…';
                messageInput.focus();
                return;
            }
            messageInput.value = `${choice.n}. ${choice.label}`;
            form.requestSubmit();
        });
        wrap.appendChild(btn);
    });
    bubbleDiv.appendChild(wrap);
}

// Seuls les choix du dernier message du bot restent cliquables.
function refreshClarificationChoices() {
    chatContainer.querySelectorAll('.clarify-choice').forEach(b => { b.disabled = true; });
    const last = chatContainer.lastElementChild;
    if (last && last.classList.contains('bot')) {
        last.querySelectorAll('.clarify-choice').forEach(b => { b.disabled = false; });
    }
}

function showTypingIndicator() {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message bot';
    msgDiv.id = 'typing-indicator';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'avatar';
    avatarDiv.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';

    const indicatorDiv = document.createElement('div');
    indicatorDiv.className = 'typing-indicator';
    indicatorDiv.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';

    msgDiv.appendChild(avatarDiv);
    msgDiv.appendChild(indicatorDiv);

    chatContainer.appendChild(msgDiv);
    scrollToBottom();
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// ============================================
// Stockage local : profils et historique des conversations
// ============================================
// Tout est conservé dans le navigateur (localStorage) : aucune donnée de conversation n'est
// envoyée à un serveur autre que la question posée à /api/chat. Aucun coût ni appel IA
// supplémentaire n'est engendré par la gestion de cet historique.
const LS_PROFILES_KEY = 'ragbot_profiles';
const LS_CONVERSATIONS_KEY = 'ragbot_conversations';
const LS_ACTIVE_CONV_KEY = 'ragbot_active_conversation_id';
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 400;

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try {
        const value = JSON.parse(str);
        return value == null ? fallback : value;
    } catch (e) {
        return fallback;
    }
}

// localStorage peut lever (navigation privée stricte, stockage désactivé...) : chaque accès est
// protégé pour que l'application reste utilisable (sans historique persistant) plutôt que de casser.
function loadProfiles() {
    try { return safeParseJSON(localStorage.getItem(LS_PROFILES_KEY), []); } catch (e) { return []; }
}
function saveProfiles(profiles) {
    try { localStorage.setItem(LS_PROFILES_KEY, JSON.stringify(profiles)); } catch (e) { console.error('Stockage local indisponible :', e); }
}
function loadConversations() {
    try { return safeParseJSON(localStorage.getItem(LS_CONVERSATIONS_KEY), []); } catch (e) { return []; }
}
function saveConversations(conversations) {
    try { localStorage.setItem(LS_CONVERSATIONS_KEY, JSON.stringify(conversations)); } catch (e) { console.error('Stockage local indisponible :', e); }
}
function getActiveConversationId() {
    try { return localStorage.getItem(LS_ACTIVE_CONV_KEY); } catch (e) { return null; }
}
function setActiveConversationId(id) {
    try { localStorage.setItem(LS_ACTIVE_CONV_KEY, id); } catch (e) { /* ignoré */ }
}
function clearActiveConversationId() {
    try { localStorage.removeItem(LS_ACTIVE_CONV_KEY); } catch (e) { /* ignoré */ }
}

let currentConversation = null;
let currentUserId = null;

function formatConversationDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function createConversation(profile) {
    const conversations = loadConversations();
    const conv = {
        id: 'conv_' + uid(),
        // Copie figée du profil au moment de la création : si le profil est modifié ou supprimé
        // plus tard, cette conversation garde son identité d'origine intacte.
        profileSnapshot: profile ? {
            firstName: profile.firstName,
            lastName: profile.lastName,
            role: profile.role || '',
            formation: profile.formation || '',
        } : null,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    conversations.unshift(conv);
    if (conversations.length > MAX_CONVERSATIONS) conversations.length = MAX_CONVERSATIONS;
    saveConversations(conversations);
    setActiveConversationId(conv.id);
    renderChatHistorySidebar();
    return conv;
}

function appendMessageToConversation(role, text) {
    if (!currentConversation) return;
    const conversations = loadConversations();
    const idx = conversations.findIndex(c => c.id === currentConversation.id);
    if (idx === -1) return; // conversation supprimée entre-temps (autre onglet)

    const conv = conversations[idx];
    conv.messages.push({ role, text, ts: Date.now() });
    if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
        conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    conv.updatedAt = Date.now();

    // Fait remonter la conversation active en tête de liste (plus récent en premier)
    conversations.splice(idx, 1);
    conversations.unshift(conv);
    saveConversations(conversations);
    currentConversation = conv;
    renderChatHistorySidebar();
}

function loadConversationIntoUI(conv) {
    currentConversation = conv;
    currentUserId = conv.id;
    chatContainer.innerHTML = '';

    if (conv.messages.length === 0) {
        const firstName = conv.profileSnapshot && conv.profileSnapshot.firstName ? `, ${conv.profileSnapshot.firstName}` : '';
        const welcome = createMessageElement(
            `Bonjour${firstName} ! Je suis votre assistant pédagogique IA.\n\nPosez-moi vos questions sur les cours et je ferai de mon mieux pour vous aider !`
        );
        chatContainer.appendChild(welcome);
    } else {
        conv.messages.forEach(m => {
            chatContainer.appendChild(createMessageElement(m.text, m.role === 'user'));
        });
        refreshClarificationChoices();
    }

    scrollToBottom();
    renderChatHistorySidebar();
}

function deleteConversationById(id) {
    let conversations = loadConversations();
    conversations = conversations.filter(c => c.id !== id);
    saveConversations(conversations);

    if (getActiveConversationId() === id) {
        clearActiveConversationId();
        if (conversations.length > 0) {
            setActiveConversationId(conversations[0].id);
            loadConversationIntoUI(conversations[0]);
            return;
        }
        currentConversation = null;
        chatContainer.innerHTML = '';
        openProfileModal({ isInitial: true });
        return;
    }
    renderChatHistorySidebar();
}

function renderChatHistorySidebar() {
    const list = document.getElementById('chat-history-list');
    if (!list) return;

    const conversations = loadConversations();
    if (conversations.length === 0) {
        list.innerHTML = '<p class="chat-history-empty">Aucune conversation pour l\'instant.</p>';
        return;
    }

    list.innerHTML = conversations.map(c => {
        const profile = c.profileSnapshot;
        const name = profile ? `${profile.firstName} ${profile.lastName}`.trim() : 'Invité';
        const detail = profile ? (profile.formation || profile.role || '') : '';
        const lastMsg = c.messages.length > 0 ? c.messages[c.messages.length - 1].text : 'Nouvelle conversation';
        const preview = lastMsg.length > 42 ? lastMsg.slice(0, 42) + '…' : lastMsg;
        const isActive = currentConversation && c.id === currentConversation.id;

        return `
            <div class="chat-history-item ${isActive ? 'active' : ''}" data-id="${c.id}">
                <div class="chat-history-item-row">
                    <span class="chat-history-item-name">${escapeHtml(name)}</span>
                    <span class="chat-history-item-date">${formatConversationDate(c.updatedAt)}</span>
                </div>
                <div class="chat-history-item-preview">${escapeHtml(preview)}</div>
                ${detail ? `<div class="chat-history-item-detail">${escapeHtml(detail)}</div>` : ''}
                <button type="button" class="chat-history-delete-btn" data-id="${c.id}" title="Supprimer cette conversation">
                    <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.chat-history-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.chat-history-delete-btn')) return;
            const id = item.getAttribute('data-id');
            const conv = loadConversations().find(c => c.id === id);
            if (conv) {
                setActiveConversationId(conv.id);
                loadConversationIntoUI(conv);
            }
        });
    });

    list.querySelectorAll('.chat-history-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteConversationById(btn.getAttribute('data-id'));
        });
    });
}

// ============================================
// Popup de profil (nom, prénom, formation/rôle)
// ============================================
const profileModal = document.getElementById('profile-modal');
const profileModalCloseBtn = document.getElementById('profile-modal-close');
const profileListEl = document.getElementById('profile-list');
const profileSelectView = document.getElementById('profile-select-view');
const profileFormView = document.getElementById('profile-form');
const profileShowFormBtn = document.getElementById('profile-show-form-btn');
const profileFormBackBtn = document.getElementById('profile-form-back-btn');
const profileFirstNameInput = document.getElementById('profile-firstname');
const profileLastNameInput = document.getElementById('profile-lastname');
const profileExtraFieldLabel = document.getElementById('profile-extra-field-label');
const profileExtraFieldText = document.getElementById('profile-extra-field-text');
const profileExtraFieldInput = document.getElementById('profile-extra-field');

// true lorsque la popup a été ouverte automatiquement au chargement (aucune conversation active) :
// si elle est fermée sans choix dans ce cas précis, une conversation "Invité" est créée pour ne
// pas bloquer l'accès au chat. Fermer la popup ouverte via "Nouvelle conversation" n'a, lui, aucun
// effet (on reste simplement sur la conversation courante).
let profileModalIsInitial = false;

function openProfileModal({ isInitial = false } = {}) {
    profileModalIsInitial = isInitial;
    renderProfileList();
    const profiles = loadProfiles();
    if (profiles.length === 0) {
        showProfileFormView();
    } else {
        showProfileSelectView();
    }
    profileModal.style.display = 'flex';
}

function closeProfileModal() {
    profileModal.style.display = 'none';
    if (profileModalIsInitial && !getActiveConversationId()) {
        const conv = createConversation(null);
        loadConversationIntoUI(conv);
    }
}

function showProfileSelectView() {
    profileSelectView.style.display = 'block';
    profileFormView.style.display = 'none';
}

function showProfileFormView() {
    profileFirstNameInput.value = '';
    profileLastNameInput.value = '';
    profileExtraFieldInput.value = '';

    if (currentMode === 'collaborateur') {
        profileExtraFieldLabel.style.display = 'block';
        profileExtraFieldText.textContent = 'Rôle';
        profileExtraFieldInput.placeholder = 'ex : Commercial, RH, Formateur...';
    } else if (currentMode === 'etudiant') {
        profileExtraFieldLabel.style.display = 'block';
        profileExtraFieldText.textContent = 'Formation';
        profileExtraFieldInput.placeholder = 'ex : Bachelor 3 Marketing Digital';
    } else {
        profileExtraFieldLabel.style.display = 'none';
    }

    profileSelectView.style.display = 'none';
    profileFormView.style.display = 'block';
    profileFirstNameInput.focus();
}

function renderProfileList() {
    const profiles = loadProfiles();
    if (profiles.length === 0) {
        profileListEl.innerHTML = '<p class="profile-list-empty">Aucun profil enregistré pour l\'instant.</p>';
        return;
    }

    profileListEl.innerHTML = profiles.map(p => {
        const detail = p.formation || p.role || '';
        return `
            <div class="profile-row" data-id="${p.id}">
                <div class="profile-row-info">
                    <span class="profile-row-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
                    ${detail ? `<span class="profile-row-detail">${escapeHtml(detail)}</span>` : ''}
                </div>
                <button type="button" class="profile-delete-btn" data-id="${p.id}" title="Supprimer ce profil">
                    <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        `;
    }).join('');

    profileListEl.querySelectorAll('.profile-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.profile-delete-btn')) return;
            const profile = loadProfiles().find(p => p.id === row.getAttribute('data-id'));
            if (!profile) return;
            const conv = createConversation(profile);
            profileModal.style.display = 'none';
            loadConversationIntoUI(conv);
        });
    });

    profileListEl.querySelectorAll('.profile-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const profiles = loadProfiles().filter(p => p.id !== btn.getAttribute('data-id'));
            saveProfiles(profiles);
            renderProfileList();
            if (profiles.length === 0) showProfileFormView();
        });
    });
}

if (profileShowFormBtn) profileShowFormBtn.addEventListener('click', showProfileFormView);

if (profileFormBackBtn) {
    profileFormBackBtn.addEventListener('click', () => {
        if (loadProfiles().length > 0) {
            showProfileSelectView();
        } else {
            closeProfileModal();
        }
    });
}

if (profileFormView) {
    profileFormView.addEventListener('submit', (e) => {
        e.preventDefault();
        const firstName = profileFirstNameInput.value.trim();
        const lastName = profileLastNameInput.value.trim();
        if (!firstName || !lastName) return;

        const extraVal = profileExtraFieldInput.value.trim();
        const profile = {
            id: 'profile_' + uid(),
            firstName,
            lastName,
            role: currentMode === 'collaborateur' ? extraVal : '',
            formation: currentMode === 'etudiant' ? extraVal : '',
            mode: currentMode,
            createdAt: Date.now(),
        };

        const profiles = loadProfiles();
        profiles.push(profile);
        saveProfiles(profiles);

        const conv = createConversation(profile);
        profileModal.style.display = 'none';
        loadConversationIntoUI(conv);
    });
}

if (profileModalCloseBtn) profileModalCloseBtn.addEventListener('click', closeProfileModal);
if (profileModal) {
    profileModal.addEventListener('click', (e) => {
        if (e.target === profileModal) closeProfileModal();
    });
}
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && profileModal && profileModal.style.display !== 'none') {
        closeProfileModal();
    }
});

// "Nouvelle conversation" : ouvre toujours la popup de profil (sélection ou création). L'ancienne
// discussion n'est jamais supprimée, elle reste consultable dans l'historique de la barre latérale.
newChatBtn.addEventListener('click', () => {
    openProfileModal({ isInitial: false });
});

// Handle form submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const question = messageInput.value.trim();
    if (!question || !currentConversation) return;
    messageInput.placeholder = CLARIFICATION_DEFAULT_PLACEHOLDER;

    // 1. Add user message to UI + historique local
    const userMsg = createMessageElement(question, true);
    chatContainer.appendChild(userMsg);
    appendMessageToConversation('user', question);

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    scrollToBottom();

    // 2. Show indicator
    showTypingIndicator();

    try {
        // 3. Make API request (profil transmis pour que le bot sache à qui il s'adresse, et pour
        // affichage du nom dans les statistiques)
        const profile = currentConversation.profileSnapshot;
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                userId: currentUserId,
                profile: profile ? {
                    firstName: profile.firstName,
                    lastName: profile.lastName,
                    role: profile.role,
                    formation: profile.formation,
                } : null,
            })
        });

        const data = await response.json();
        removeTypingIndicator();

        if (!response.ok) {
            // Le serveur renvoie déjà un message explicite et déjà formaté pour l'utilisateur
            // (quota Mistral épuisé, rate limit, clé API invalide...) : on l'affiche tel quel,
            // sans préfixe générique redondant.
            const serverError = new Error(data.error || "Erreur de connexion serveur");
            serverError.isServerMessage = !!data.error;
            throw serverError;
        }

        // 4. Add bot message to UI + historique local
        const botMsg = createMessageElement(data.answer);
        chatContainer.appendChild(botMsg);
        appendMessageToConversation('bot', data.answer);

    } catch (error) {
        removeTypingIndicator();
        console.error("Error:", error);
        const text = error.isServerMessage
            ? error.message
            : "⚠️ Une erreur est survenue lors de la communication avec le serveur : " + error.message;
        const errorMsg = createMessageElement(text);
        chatContainer.appendChild(errorMsg);
    } finally {
        sendBtn.disabled = false;
        refreshClarificationChoices();
        scrollToBottom();
        messageInput.focus();
    }
});

// Submit on Enter (Shift+Enter for newline)
// Note : on utilise form.requestSubmit() plutôt que form.dispatchEvent(new Event('submit')).
// Un Event('submit') créé manuellement n'est pas "cancelable" par défaut : sur Firefox,
// preventDefault() n'a alors aucun effet et le navigateur effectue une vraie soumission
// native du formulaire (rechargement de page, message jamais envoyé à /api/chat).
// requestSubmit() déclenche un événement 'submit' natif et correctement annulable.
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
    }
});

// Affiche l'onglet Statistiques si une session admin est active, sinon rien
async function renderStatsNavSlot() {
    const slot = document.getElementById('nav-stats-slot');
    if (!slot) return;

    let authenticated = false;
    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        authenticated = !!data.authenticated;
    } catch (err) {
        authenticated = false;
    }

    if (authenticated) {
        slot.innerHTML = `
            <a href="/stats" target="_blank" class="nav-tab" id="nav-stats" style="text-decoration: none; color: inherit;">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 20V10"/>
                    <path d="M12 20V4"/>
                    <path d="M6 20v-6"/>
                </svg>
                Statistiques
            </a>`;
    } else {
        slot.innerHTML = '';
    }
}

// Affiche l'utilisateur Microsoft connecté (SSO) et le lien de déconnexion. Renseigne également
// currentMode (rôle étudiant/collaborateur), nécessaire avant l'ouverture de la popup de profil.
async function renderChatUserInfo() {
    const slot = document.getElementById('chat-user-info');
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = await res.json();

        applyMode(data.role);

        if (slot) {
            slot.innerHTML = `
                <span title="${data.email}" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${data.name}</span>
                <a href="/auth/logout" style="text-decoration:none; color:inherit; opacity:0.8; white-space:nowrap;">Déconnexion</a>`;
        }
    } catch (err) {
        // silencieux : l'utilisateur reste affiché sans info si l'appel échoue
    }
}

// ============================================
// Initialisation : restaure la dernière conversation active, ou propose d'en démarrer une
// ============================================
(async function init() {
    renderStatsNavSlot();
    await renderChatUserInfo(); // currentMode doit être connu avant l'ouverture éventuelle de la popup

    const conversations = loadConversations();
    const activeId = getActiveConversationId();
    const activeConv = conversations.find(c => c.id === activeId);

    if (activeConv) {
        loadConversationIntoUI(activeConv);
    } else {
        renderChatHistorySidebar();
        openProfileModal({ isInitial: true });
    }
})();

// ============================================
// Export de la conversation (fichier texte téléchargeable)
// ============================================
function exportConversation() {
    const messages = Array.from(chatContainer.querySelectorAll('.message')).filter(
        el => el.id !== 'typing-indicator'
    );

    const now = new Date();
    const dateLabel = now.toLocaleString('fr-FR');
    const modeLabel = (currentMode && MODE_INFO[currentMode]) ? MODE_INFO[currentMode].label : 'Mode normal';

    let lines = [
        'Conversation exportée le ' + dateLabel,
        modeLabel,
        ''
    ];

    messages.forEach(el => {
        const isUser = el.classList.contains('user');
        const bubble = el.querySelector('.bubble');
        const text = (bubble.innerText || bubble.textContent || '').trim();
        lines.push(isUser ? 'Vous :' : 'Assistant :');
        lines.push(text);
        lines.push('');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    a.href = url;
    a.download = `conversation-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

if (exportChatBtn) {
    exportChatBtn.addEventListener('click', exportConversation);
}
