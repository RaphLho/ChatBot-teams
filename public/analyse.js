document.addEventListener('DOMContentLoaded', fetchStats);

document.getElementById('refresh-btn').addEventListener('click', () => {
    const btn = document.getElementById('refresh-btn');
    btn.innerHTML = '⏳ Chargement...';
    fetchStats().then(() => {
        btn.innerHTML = '🔄 Rafraîchir les données';
    });
});

function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    const startNum = parseInt(obj.innerText.replace(/,/g, '')) || 0;
    if (startNum === end) return;
    
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = Math.floor(progress * (end - startNum) + startNum);
        
        // Format with commas (e.g. 10,000)
        obj.innerHTML = current.toLocaleString('en-US');
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}

function formatUptime(ms) {
    let seconds = Math.floor(ms / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
    
    seconds = seconds % 60;
    minutes = minutes % 60;
    
    return `${hours}h ${minutes}m ${seconds}s`;
}

async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error("Erreur réseau");
        
        const data = await response.json();
        
        const total = data.totalPromptTokens + data.totalCompletionTokens;
        
        animateValue('stat-prompt', 0, data.totalPromptTokens, 1000);
        animateValue('stat-completion', 0, data.totalCompletionTokens, 1000);
        animateValue('stat-total', 0, total, 1000);
        animateValue('stat-conversations', 0, data.totalConversations, 800);
        animateValue('stat-files', 0, data.totalFilesParsed, 800);
        animateValue('stat-chunks', 0, data.totalChunksIndexed, 800);
        
        document.getElementById('uptime-text').innerHTML = `Le serveur (npm start) est en ligne depuis : <strong>${formatUptime(data.uptime)}</strong>`;
        
    } catch(err) {
        console.error(err);
        alert("Impossible de charger les statistiques.");
    }
}
