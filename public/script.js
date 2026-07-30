const form = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const chatContainer = document.getElementById('chat-container');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');

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

// Generate an anonymous unique user ID for the session
let currentUserId = 'web_user_' + Math.random().toString(36).substr(2, 9);

// ============================================
// Mode Selector (Tester en tant qu'étudiant / Collaborateur)
// ============================================
let currentMode = 'collaborateur'; // mode par défaut ; null = mode normal (aucune restriction), 'etudiant', ou 'collaborateur'

const modeSelector = document.getElementById('mode-selector');
const modeSelectorBtn = document.getElementById('mode-selector-btn');
const modeSelectorLabel = document.getElementById('mode-selector-label');

const MODE_INFO = {
    etudiant: { label: 'Mode : Étudiant' },
    collaborateur: { label: 'Mode : Collaborateur' }
};

function resetConversationUI() {
    currentUserId = 'web_user_' + Math.random().toString(36).substr(2, 9);
    chatContainer.innerHTML = '';
    const welcomeMsg = createMessageElement("Bonjour ! Je suis votre assistant pédagogique IA.\n\nPosez-moi vos questions sur les cours et je ferai de mon mieux pour vous aider !");
    chatContainer.appendChild(welcomeMsg);
}

function applyMode(mode, { reset = true } = {}) {
    currentMode = mode;

    modeSelectorLabel.textContent = (mode && MODE_INFO[mode]) ? MODE_INFO[mode].label : 'Mode normal';

    // Coche sur l'option active dans le menu
    document.querySelectorAll('.mode-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.mode === mode);
    });

    if (reset) resetConversationUI();
}

if (modeSelector && modeSelectorBtn) {
    modeSelectorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modeSelector.classList.toggle('open');
    });

    document.querySelectorAll('.mode-option').forEach(option => {
        option.addEventListener('click', () => {
            const mode = option.dataset.mode;
            // Cliquer sur le mode déjà actif désactive le mode de test (retour au mode normal)
            applyMode(currentMode === mode ? null : mode);
            modeSelector.classList.remove('open');
        });
    });

    document.addEventListener('click', (e) => {
        if (!modeSelector.contains(e.target)) {
            modeSelector.classList.remove('open');
        }
    });

    // Applique l'état visuel du mode par défaut sans réinitialiser la conversation au chargement
    applyMode(currentMode, { reset: false });
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
    }
    
    msgDiv.appendChild(avatarDiv);
    msgDiv.appendChild(bubbleDiv);
    
    return msgDiv;
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

// Handle form submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const question = messageInput.value.trim();
    if (!question) return;

    // 1. Add user message to UI
    const userMsg = createMessageElement(question, true);
    chatContainer.appendChild(userMsg);
    
    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    scrollToBottom();

    // 2. Show indicator
    showTypingIndicator();

    try {
        // 3. Make API request
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, userId: currentUserId, mode: currentMode })
        });
        
        const data = await response.json();
        removeTypingIndicator();

        if (!response.ok) {
            throw new Error(data.error || "Erreur de connexion serveur");
        }

        // 4. Add bot message to UI
        const botMsg = createMessageElement(data.answer);
        chatContainer.appendChild(botMsg);
        
    } catch (error) {
        removeTypingIndicator();
        console.error("Error:", error);
        const errorMsg = createMessageElement("⚠️ Une erreur est survenue lors de la communication avec le serveur : " + error.message);
        chatContainer.appendChild(errorMsg);
    } finally {
        sendBtn.disabled = false;
        scrollToBottom();
        messageInput.focus();
    }
});

// Submit on Enter (Shift+Enter for newline)
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit'));
    }
});

// Affiche l'onglet Statistiques si une session admin est active, sinon un bouton Connexion
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
        slot.innerHTML = `
            <a href="/login" class="nav-tab" id="nav-login" style="text-decoration: none; color: inherit;">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                    <polyline points="10 17 15 12 10 7"/>
                    <line x1="15" y1="12" x2="3" y2="12"/>
                </svg>
                Connexion
            </a>`;
    }
}

renderStatsNavSlot();

// New Chat Button (conserve le mode de test actif, réinitialise juste la conversation)
newChatBtn.addEventListener('click', () => {
    resetConversationUI();
});
