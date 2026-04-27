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

function createMessageElement(text, isUser = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isUser ? 'user' : 'bot'}`;
    
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'avatar';
    avatarDiv.textContent = isUser ? '👤' : '🤖';
    
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
    avatarDiv.textContent = '🤖';
    
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
            body: JSON.stringify({ question, userId: currentUserId })
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

// New Chat Button
newChatBtn.addEventListener('click', () => {
    // Generate new ID to get fresh conversation context without memory from previous one
    currentUserId = 'web_user_' + Math.random().toString(36).substr(2, 9);
    
    // Clear container except the welcome message
    chatContainer.innerHTML = '';
    
    const welcomeMsg = createMessageElement("Bonjour ! Je suis votre assistant pédagogique IA.\n\nPosez-moi vos questions sur les cours et je ferai de mon mieux pour vous aider !");
    chatContainer.appendChild(welcomeMsg);
});
