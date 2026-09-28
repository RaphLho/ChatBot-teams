// ============================================
// Auto Refresh
// ============================================
let statsRefreshInterval = null;

function startAutoRefresh() {
    if (statsRefreshInterval) return;
    statsRefreshInterval = setInterval(loadStats, 30000);
}

function stopAutoRefresh() {
    if (statsRefreshInterval) {
        clearInterval(statsRefreshInterval);
        statsRefreshInterval = null;
    }
}

// Load automatically on page load
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    startAutoRefresh();
});


// ============================================
// Chart.js Instances
// ============================================
let timelineChart = null;
let barChart = null;
let doughnutChart = null;
let topUsersChart = null;
let complianceChart = null;
let hourOfDayChart = null;
let weekdayChart = null;

const chartColors = {
    violet: 'rgba(139, 92, 246, 1)',
    violetBg: 'rgba(139, 92, 246, 0.15)',
    blue: 'rgba(59, 130, 246, 1)',
    blueBg: 'rgba(59, 130, 246, 0.15)',
    emerald: 'rgba(16, 185, 129, 1)',
    emeraldBg: 'rgba(16, 185, 129, 0.15)',
    amber: 'rgba(245, 158, 11, 1)',
    amberBg: 'rgba(245, 158, 11, 0.15)',
    rose: 'rgba(244, 63, 94, 1)',
    roseBg: 'rgba(244, 63, 94, 0.15)',
    cyan: 'rgba(6, 182, 212, 1)',
    cyanBg: 'rgba(6, 182, 212, 0.15)',
    indigo: 'rgba(99, 102, 241, 1)',
    indigoBg: 'rgba(99, 102, 241, 0.15)',
};

const commonChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            labels: {
                font: { family: "'Inter', sans-serif", size: 12, weight: 500 },
                padding: 16,
                usePointStyle: true,
                pointStyleWidth: 8,
            }
        },
        tooltip: {
            backgroundColor: '#18181b',
            titleFont: { family: "'Inter', sans-serif", size: 13, weight: 600 },
            bodyFont: { family: "'Inter', sans-serif", size: 12 },
            padding: 12,
            cornerRadius: 10,
            displayColors: true,
            boxPadding: 4,
        }
    }
};

// ============================================
// Timeline Chart (Line)
// ============================================
function initTimelineChart(data) {
    const ctx = document.getElementById('chart-timeline').getContext('2d');

    if (timelineChart) timelineChart.destroy();

    timelineChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.label),
            datasets: [
                {
                    label: 'Prompt tokens',
                    data: data.map(d => d.promptTokens),
                    borderColor: chartColors.emerald,
                    backgroundColor: chartColors.emeraldBg,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: chartColors.emerald,
                },
                {
                    label: 'Completion tokens',
                    data: data.map(d => d.completionTokens),
                    borderColor: chartColors.amber,
                    backgroundColor: chartColors.amberBg,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: chartColors.amber,
                },
                {
                    label: 'Total',
                    data: data.map(d => d.totalTokens),
                    borderColor: chartColors.violet,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [6, 4],
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: chartColors.violet,
                }
            ]
        },
        options: {
            ...commonChartOptions,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 11 },
                        color: '#71717a',
                        maxRotation: 45,
                        maxTicksLimit: 12,
                    },
                    border: { display: false }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 11 },
                        color: '#71717a',
                    },
                    border: { display: false },
                    beginAtZero: true,
                }
            },
            interaction: {
                mode: 'index',
                intersect: false,
            }
        }
    });
}

// ============================================
// Bar Chart (Prompt vs Completion)
// ============================================
function initBarChart(data) {
    const ctx = document.getElementById('chart-bar').getContext('2d');

    if (barChart) barChart.destroy();

    // Take last 10 entries max for readability
    const recentData = data.slice(-10);

    barChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: recentData.map(d => d.label),
            datasets: [
                {
                    label: 'Prompt',
                    data: recentData.map(d => d.promptTokens),
                    backgroundColor: chartColors.emerald,
                    borderRadius: 6,
                    borderSkipped: false,
                    barPercentage: 0.7,
                },
                {
                    label: 'Completion',
                    data: recentData.map(d => d.completionTokens),
                    backgroundColor: chartColors.amber,
                    borderRadius: 6,
                    borderSkipped: false,
                    barPercentage: 0.7,
                }
            ]
        },
        options: {
            ...commonChartOptions,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 10 },
                        color: '#71717a',
                        maxRotation: 45,
                    },
                    border: { display: false }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: {
                        font: { family: "'Inter', sans-serif", size: 11 },
                        color: '#71717a',
                    },
                    border: { display: false },
                    beginAtZero: true,
                }
            }
        }
    });
}

// ============================================
// Doughnut Chart (Global Split)
// ============================================
function initDoughnutChart(promptTotal, completionTotal) {
    const ctx = document.getElementById('chart-doughnut').getContext('2d');

    if (doughnutChart) doughnutChart.destroy();

    doughnutChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Prompt tokens', 'Completion tokens'],
            datasets: [{
                data: [promptTotal, completionTotal],
                backgroundColor: [chartColors.emerald, chartColors.amber],
                borderColor: ['white', 'white'],
                borderWidth: 3,
                hoverOffset: 8,
            }]
        },
        options: {
            ...commonChartOptions,
            cutout: '65%',
            plugins: {
                ...commonChartOptions.plugins,
                legend: {
                    ...commonChartOptions.plugins.legend,
                    position: 'bottom',
                }
            }
        }
    });
}

// ============================================
// Top Users Chart (Horizontal Bar)
// ============================================
function initTopUsersChart(topUsers) {
    const ctx = document.getElementById('chart-top-users').getContext('2d');

    if (topUsersChart) topUsersChart.destroy();

    const data = topUsers && topUsers.length > 0 ? topUsers : [];
    const labels = data.map(u => u.displayName || truncateUserId(u.userId));

    topUsersChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Tokens consommés',
                data: data.map(u => u.totalTokens),
                backgroundColor: chartColors.indigo,
                borderRadius: 6,
                borderSkipped: false,
                barPercentage: 0.7,
            }]
        },
        options: {
            ...commonChartOptions,
            indexAxis: 'y',
            plugins: {
                ...commonChartOptions.plugins,
                legend: { display: false },
                tooltip: {
                    ...commonChartOptions.plugins.tooltip,
                    callbacks: {
                        title: (items) => {
                            const u = data[items[0].dataIndex];
                            if (!u) return '';
                            return u.displayName ? `${u.displayName} (${truncateUserId(u.userId)})` : u.userId;
                        },
                        afterLabel: (item) => {
                            const u = data[item.dataIndex];
                            return u ? `${u.requests} requête(s) — ${u.nonCompliant} hors-sujet` : '';
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#71717a' },
                    border: { display: false },
                    beginAtZero: true,
                },
                y: {
                    grid: { display: false },
                    ticks: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#71717a' },
                    border: { display: false },
                }
            }
        }
    });
}

// ============================================
// Compliance Chart (Doughnut)
// ============================================
function initComplianceChart(compliant, nonCompliant) {
    const ctx = document.getElementById('chart-compliance').getContext('2d');

    if (complianceChart) complianceChart.destroy();

    complianceChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Conformes', 'Hors-sujet'],
            datasets: [{
                data: [compliant, nonCompliant],
                backgroundColor: [chartColors.emerald, chartColors.rose],
                borderColor: ['white', 'white'],
                borderWidth: 3,
                hoverOffset: 8,
            }]
        },
        options: {
            ...commonChartOptions,
            cutout: '65%',
            plugins: {
                ...commonChartOptions.plugins,
                legend: {
                    ...commonChartOptions.plugins.legend,
                    position: 'bottom',
                }
            }
        }
    });
}

// ============================================
// Hour of Day Chart (Bar)
// ============================================
function initHourOfDayChart(data) {
    const ctx = document.getElementById('chart-hour-of-day').getContext('2d');

    if (hourOfDayChart) hourOfDayChart.destroy();

    hourOfDayChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => d.label),
            datasets: [{
                label: 'Requêtes',
                data: data.map(d => d.requests),
                backgroundColor: chartColors.cyan,
                borderRadius: 6,
                borderSkipped: false,
                barPercentage: 0.75,
            }]
        },
        options: {
            ...commonChartOptions,
            plugins: { ...commonChartOptions.plugins, legend: { display: false } },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: "'Inter', sans-serif", size: 10 }, color: '#71717a', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
                    border: { display: false }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#71717a', precision: 0 },
                    border: { display: false },
                    beginAtZero: true,
                }
            }
        }
    });
}

// ============================================
// Weekday Chart (Bar)
// ============================================
function initWeekdayChart(data) {
    const ctx = document.getElementById('chart-weekday').getContext('2d');

    if (weekdayChart) weekdayChart.destroy();

    weekdayChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => d.label),
            datasets: [{
                label: 'Requêtes',
                data: data.map(d => d.requests),
                backgroundColor: chartColors.violet,
                borderRadius: 6,
                borderSkipped: false,
                barPercentage: 0.6,
            }]
        },
        options: {
            ...commonChartOptions,
            plugins: { ...commonChartOptions.plugins, legend: { display: false } },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#71717a' },
                    border: { display: false }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { family: "'Inter', sans-serif", size: 11 }, color: '#71717a', precision: 0 },
                    border: { display: false },
                    beginAtZero: true,
                }
            }
        }
    });
}

// ============================================
// Number & Bytes Formatting
// ============================================
function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return (n || 0).toLocaleString('fr-FR');
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 Ko';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' Mo';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' Ko';
    return bytes + ' o';
}

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}j ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatResponseTime(ms) {
    if (!ms || ms <= 0) return '0 s';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
}

function formatPercent(ratio) {
    return `${Math.round((ratio || 0) * 1000) / 10}%`;
}

function truncateUserId(userId) {
    if (!userId) return 'inconnu';
    return userId.length > 22 ? userId.slice(0, 22) + '…' : userId;
}

function formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric'
    }) + ' ' + d.toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function formatCost(amount) {
    return `~${Math.max(0.01, amount).toFixed(2)} €`;
}

// ============================================
// Animate Counter
// ============================================
function animateValue(element, target) {
    const current = parseInt(element.textContent.replace(/\s/g, '').replace(/[k,M]/g, '')) || 0;
    if (current === target) return;
    element.textContent = formatNumber(target);
    element.style.transform = 'scale(1.05)';
    setTimeout(() => { element.style.transform = 'scale(1)'; }, 200);
}

// ============================================
// Load Stats, History & Files
// ============================================
let currentRange = 'hourly';
let currentHistoryFilter = 'all';
let lastHistoryEntries = [];
let currentFileChunks = [];
let currentFileFullText = '';

async function loadStats() {
    try {
        const [statsRes, historyRes, filesRes] = await Promise.all([
            fetch('/api/stats'),
            fetch('/api/stats/history'),
            fetch('/api/stats/files')
        ]);

        const stats = await statsRes.json();
        const history = await historyRes.json();
        const filesData = await filesRes.json();

        // ---- Model Cards ----
        const gChatPrompt = stats.global.chatPromptTokens || 0;
        const gChatCompletion = stats.global.chatCompletionTokens || 0;
        const gEmbedTokens = stats.global.embedTokens || 0;

        document.getElementById('model-chat-prompt').textContent = formatNumber(gChatPrompt);
        document.getElementById('model-chat-completion').textContent = formatNumber(gChatCompletion);
        document.getElementById('model-chat-requests').textContent = formatNumber(stats.global.chatRequests || 0);

        const chatCost = gChatPrompt * (0.20 / 1000000) + gChatCompletion * (0.60 / 1000000);
        document.getElementById('model-chat-cost').textContent = formatCost(chatCost);

        document.getElementById('model-embed-tokens').textContent = formatNumber(gEmbedTokens);
        document.getElementById('model-embed-requests').textContent = formatNumber(stats.global.embedRequests || 0);
        document.getElementById('model-embed-chunks').textContent = formatNumber(stats.totalChunksIndexed || 0);

        const embedCost = gEmbedTokens * (0.10 / 1000000);
        document.getElementById('model-embed-cost').textContent = formatCost(embedCost);

        // ---- Files Section ----
        document.getElementById('files-total-count').textContent = filesData.total || 0;
        document.getElementById('files-chunks-count').textContent = formatNumber(stats.totalChunksIndexed || filesData.totalChunks || 0);
        document.getElementById('files-total-size').textContent = `${formatBytes(filesData.totalSize)} au total`;
        renderFileTree(filesData.files || []);

        // ---- KPIs ----
        const date = new Date();
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const currentMonthTokens = (stats.global.monthlyUsage && stats.global.monthlyUsage[monthKey]) ? stats.global.monthlyUsage[monthKey] : 0;
        const globalTotal = stats.global.totalPromptTokens + stats.global.totalCompletionTokens;
        const sessionTotal = stats.session.totalPromptTokens + stats.session.totalCompletionTokens;

        animateValue(document.getElementById('kpi-total-global'), globalTotal);
        animateValue(document.getElementById('kpi-total-month'), currentMonthTokens);
        animateValue(document.getElementById('kpi-total-session'), sessionTotal);
        animateValue(document.getElementById('kpi-requests'), stats.global.totalConversations);

        const totalCost = chatCost + embedCost;
        document.getElementById('kpi-total-cost').textContent = formatCost(totalCost);

        document.getElementById('kpi-unique-users').textContent = formatNumber(stats.global.uniqueUsers || 0);
        document.getElementById('kpi-unique-users-session').textContent = `${formatNumber(stats.session.uniqueUsers || 0)} sur cette session`;

        document.getElementById('kpi-noncompliant-rate').textContent = formatPercent(stats.global.nonCompliantRate);
        document.getElementById('kpi-noncompliant-count').textContent = `${formatNumber(stats.global.totalNonCompliant || 0)} requête(s)`;

        document.getElementById('kpi-response-time').textContent = formatResponseTime(stats.global.avgResponseTimeMs);

        document.getElementById('kpi-cache-hits').textContent = formatNumber(stats.cacheHits || 0);

        // Uptime bar
        document.getElementById('uptime-display').textContent = formatUptime(stats.uptime);
        document.getElementById('files-parsed').textContent = stats.totalFilesParsed;
        document.getElementById('chunks-indexed').textContent = formatNumber(stats.totalChunksIndexed);
        document.getElementById('avg-tokens').textContent = formatNumber(stats.global.avgTokensPerRequest || 0);

        // ---- Charts ----
        const chartData = currentRange === 'hourly' ? history.hourly : history.daily;

        if (chartData && chartData.length > 0) {
            initTimelineChart(chartData);
            initBarChart(chartData);
        } else {
            initTimelineChart([{ label: 'Pas de données', promptTokens: 0, completionTokens: 0, totalTokens: 0 }]);
            initBarChart([{ label: 'Pas de données', promptTokens: 0, completionTokens: 0 }]);
        }

        initDoughnutChart(stats.global.totalPromptTokens || 0, stats.global.totalCompletionTokens || 0);

        initTopUsersChart(history.topUsers || []);

        const compliantCount = Math.max(0, (stats.session.totalConversations || 0) - (stats.session.totalNonCompliant || 0));
        initComplianceChart(compliantCount, stats.session.totalNonCompliant || 0);

        initHourOfDayChart(history.hourOfDay || []);
        initWeekdayChart(history.weekday || []);

        // ---- History Entries ----
        lastHistoryEntries = history.entries || [];
        renderHistoryEntries(lastHistoryEntries, currentHistoryFilter);

    } catch (error) {
        console.error('Erreur lors du chargement des statistiques:', error);
    }
}

// ============================================
// Arborescence des fichiers (dossiers déroulants)
// ============================================
// Construit un arbre { name, type: 'folder'|'file', children: Map, fileCount } à partir de la
// liste plate renvoyée par /api/stats/files, en utilisant relativeDir (chemin des sous-dossiers
// sans la racine OneDrive, calculé côté serveur) pour retrouver la hiérarchie réelle.
function buildFileTree(files) {
    const root = { name: '', type: 'folder', children: new Map(), fileCount: 0 };

    files.forEach(file => {
        const segments = file.relativeDir ? file.relativeDir.split('/').filter(Boolean) : [];
        let node = root;
        node.fileCount += 1;
        segments.forEach(seg => {
            if (!node.children.has(seg)) {
                node.children.set(seg, { name: seg, type: 'folder', children: new Map(), fileCount: 0 });
            }
            node = node.children.get(seg);
            node.fileCount += 1;
        });
        node.children.set('file::' + file.fullPath, { name: file.fileName, type: 'file', file, fileCount: 1 });
    });

    return root;
}

function sortedTreeChildren(node) {
    return Array.from(node.children.values()).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, 'fr');
    });
}

function detectRootCategoryClass(folderName) {
    if (folderName === 'Etudiant') return 'cat-etudiant';
    if (folderName === 'Collaborateur') return 'cat-collaborateur';
    return '';
}

// Mémorise les dossiers ouverts (par chemin, ex. "Etudiant/01_Etudiant") d'un rendu à l'autre :
// sans ça, l'auto-refresh des stats (toutes les 30s) replierait tout à chaque fois. `null` tant
// qu'aucun rendu n'a eu lieu, pour ne définir l'état par défaut (racines ouvertes) qu'une fois.
let treeOpenPaths = null;

function renderTreeNode(node, depth, path) {
    if (node.type === 'file') {
        const file = node.file;
        const ext = file.fileName.split('.').pop().toLowerCase();
        const extClass = ['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md'].includes(ext) ? ext : '';
        const sizeFormatted = formatBytes(file.size);
        const modDate = file.lastModified ? new Date(file.lastModified).toLocaleDateString('fr-FR', {
            day: '2-digit', month: '2-digit', year: 'numeric'
        }) : '—';

        return `
            <div class="tree-file" style="--depth:${depth}" data-path="${encodeURIComponent(file.fullPath)}" title="${escapeHtml(file.fileName)}">
                <span class="file-ext-badge ${extClass}">${ext}</span>
                <span class="tree-file-name">${escapeHtml(file.fileName)}</span>
                <span class="tree-file-meta">${sizeFormatted} · ${file.chunksCount || 0} bloc(s) · ${modDate}</span>
                <button class="tree-file-preview-btn" type="button" data-path="${encodeURIComponent(file.fullPath)}" title="Aperçu du document">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            </div>
        `;
    }

    const children = sortedTreeChildren(node);
    const childrenHtml = children.map(c => renderTreeNode(c, depth + 1, `${path}/${c.name}`)).join('');
    const catClass = depth === 0 ? detectRootCategoryClass(node.name) : '';
    const isOpen = treeOpenPaths.has(path);

    return `
        <div class="tree-folder ${catClass} ${isOpen ? 'open' : ''}" data-tree-path="${escapeHtml(path)}">
            <div class="tree-folder-header" style="--depth:${depth}">
                <svg class="tree-chevron" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                <svg class="tree-folder-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span class="tree-folder-name">${escapeHtml(node.name)}</span>
                <span class="tree-folder-count">${node.fileCount} fichier${node.fileCount > 1 ? 's' : ''}</span>
            </div>
            <div class="tree-folder-children">
                ${childrenHtml}
            </div>
        </div>
    `;
}

function renderFileTree(files) {
    const container = document.getElementById('file-tree');
    if (!container) return;

    if (!files || files.length === 0) {
        container.innerHTML = '<p class="tree-loading" style="font-style: italic;">Aucun fichier indexé</p>';
        return;
    }

    const root = buildFileTree(files);
    const topNodes = sortedTreeChildren(root);

    // Premier rendu seulement : les dossiers racine (Étudiant/Collaborateur/Autre) sont ouverts
    // par défaut, tout le reste replié.
    if (treeOpenPaths === null) {
        treeOpenPaths = new Set(topNodes.map(n => n.name));
    }

    container.innerHTML = topNodes.map(node => renderTreeNode(node, 0, node.name)).join('');

    container.querySelectorAll('.tree-folder').forEach(folderEl => {
        const header = folderEl.querySelector('.tree-folder-header');
        const path = folderEl.getAttribute('data-tree-path');
        header.addEventListener('click', () => {
            const nowOpen = folderEl.classList.toggle('open');
            if (nowOpen) treeOpenPaths.add(path); else treeOpenPaths.delete(path);
        });
    });

    container.querySelectorAll('.tree-file').forEach(row => {
        row.addEventListener('click', () => {
            openFileModal(decodeURIComponent(row.getAttribute('data-path')));
        });
    });
}

// ============================================
// File Content Modal
// ============================================
async function openFileModal(filePath) {
    const modal = document.getElementById('file-modal');
    const nameEl = document.getElementById('file-modal-name');
    const extEl = document.getElementById('file-modal-ext');
    const metaEl = document.getElementById('file-modal-meta');
    const viewerEl = document.getElementById('file-content-viewer');
    const chunksCountEl = document.getElementById('file-modal-chunks-count');
    const searchInput = document.getElementById('file-search-input');

    if (!modal) return;

    // Reset search
    if (searchInput) searchInput.value = '';

    modal.style.display = 'flex';
    nameEl.textContent = filePath.split('/').pop();
    extEl.textContent = filePath.split('.').pop().toUpperCase();
    metaEl.innerHTML = '<span>Chargement des métadonnées...</span>';
    viewerEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-secondary);">Chargement du document et des blocs vectoriels...</div>';
    chunksCountEl.textContent = '...';

    try {
        const res = await fetch(`/api/stats/file-content?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        const data = await res.json();

        currentFileChunks = data.chunks || [];
        currentFileFullText = data.fullText || '';

        const ext = data.fileName.split('.').pop().toLowerCase();
        extEl.textContent = ext.toUpperCase();
        extEl.className = `file-modal-ext-badge ${['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md'].includes(ext) ? ext : ''}`;
        nameEl.textContent = data.fileName;

        let folderLabel = data.folder || 'Autre';
        let folderClass = 'autre';
        if (data.fullPath.includes('Etudiant')) { folderClass = 'etudiant'; folderLabel = 'Étudiant'; }
        else if (data.fullPath.includes('Collaborateur')) { folderClass = 'collaborateur'; folderLabel = 'Collaborateur'; }

        const modDate = data.lastModified ? new Date(data.lastModified).toLocaleDateString('fr-FR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '—';

        metaEl.innerHTML = `
            <span class="folder-badge ${folderClass}">${folderLabel}</span>
            <span>•</span>
            <span><strong>Taille :</strong> ${formatBytes(data.size)}</span>
            <span>•</span>
            <span><strong>Modifié le :</strong> ${modDate}</span>
            <span>•</span>
            <span title="${data.fullPath}" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><strong>Chemin :</strong> ${data.fullPath}</span>
        `;

        chunksCountEl.textContent = `${currentFileChunks.length} bloc(s) RAG`;

        renderFileChunks(currentFileChunks);

    } catch (err) {
        viewerEl.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--accent-rose);">❌ Impossible de charger le document : ${err.message}</div>`;
    }
}

function renderFileChunks(chunks, query = '') {
    const viewerEl = document.getElementById('file-content-viewer');
    if (!chunks || chunks.length === 0) {
        viewerEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-secondary); font-style: italic;">Aucun bloc vectoriel extrait pour ce document.</div>';
        return;
    }

    const q = query.trim().toLowerCase();
    const filtered = q ? chunks.filter(c => c.text && c.text.toLowerCase().includes(q)) : chunks;

    if (filtered.length === 0) {
        viewerEl.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-secondary); font-style: italic;">Aucun résultat pour la recherche "${escapeHtml(query)}"</div>`;
        return;
    }

    viewerEl.innerHTML = filtered.map(chunk => {
        let textContent = escapeHtml(chunk.text || '');
        if (q) {
            const regex = new RegExp(`(${escapeRegex(q)})`, 'gi');
            textContent = textContent.replace(regex, '<mark style="background: #fef08a; padding: 1px 3px; border-radius: 3px;">$1</mark>');
        }

        return `
            <div class="file-chunk-card">
                <div class="file-chunk-header">
                    <span class="file-chunk-num">Bloc #${chunk.index}</span>
                    <span class="file-chunk-len">${chunk.length} caractères</span>
                </div>
                <div class="file-chunk-text">${textContent}</div>
            </div>
        `;
    }).join('');
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// History Entries (Card style)
// ============================================
function renderHistoryEntries(entries, filter) {
    const container = document.getElementById('history-entries');
    const countEl = document.getElementById('history-count');

    // Apply filter
    let filtered = entries;
    if (filter === 'chat') {
        filtered = entries.filter(e => e.model === 'mistral-small-latest');
    } else if (filter === 'embed') {
        filtered = entries.filter(e => e.model === 'mistral-embed');
    }

    countEl.textContent = `${filtered.length} entrée${filtered.length > 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 32px; font-style: italic;">Aucune donnée disponible</div>';
        return;
    }

    // Show latest first, limit to 50
    const recent = [...filtered].reverse().slice(0, 50);

    container.innerHTML = recent.map(entry => {
        const isChat = entry.model === 'mistral-small-latest';
        const modelLabel = isChat ? 'mistral-small' : 'mistral-embed';
        const modelClass = isChat ? 'chat' : 'embed';

        const question = entry.question || (isChat ? 'Pas de question' : 'Indexation / Embedding');
        const truncatedQuestion = question.length > 100 ? question.substring(0, 100) + '…' : question;

        const statusHtml = entry.isNonCompliant
            ? '<span class="status-badge warn">🚫 Hors-sujet</span>'
            : entry.isNoAnswer
                ? '<span class="status-badge noanswer">❓ Sans réponse</span>'
                : '<span class="status-badge ok">✓ Conforme</span>';

        const timeHtml = entry.responseTimeMs
            ? `<span class="meta-item"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${formatResponseTime(entry.responseTimeMs)}</span>`
            : '';

        // Nom déclaré par la personne (popup de profil côté web) : affiché en priorité, avec
        // l'identifiant technique en infobulle pour la traçabilité. Repli sur l'identifiant seul
        // si aucun profil n'a été renseigné (Teams, ou conversation "Invité").
        const userLabel = entry.displayName
            ? `${escapeHtml(entry.displayName)} <span class="history-entry-user-id">(${escapeHtml(truncateUserId(entry.userId || ''))})</span>`
            : escapeHtml(entry.userId || 'inconnu');

        const cardClass = entry.isNonCompliant ? 'entry-noncompliant' : (entry.isNoAnswer ? 'entry-noanswer' : '');

        return `
            <div class="history-entry ${cardClass}"
                data-question="${encodeURIComponent(entry.question || 'Pas de question')}"
                data-answer="${encodeURIComponent(entry.answer || 'Pas de réponse')}">
                <div class="history-entry-header">
                    <span class="history-entry-time">
                        <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        ${formatTimestamp(entry.timestamp)}
                    </span>
                    <span class="history-entry-user" title="${escapeHtml(entry.userId || '')}">${userLabel}</span>
                </div>
                <div class="history-entry-question">${escapeHtml(truncatedQuestion)}</div>
                <div class="history-entry-meta">
                    <span class="model-badge ${modelClass}">${modelLabel}</span>
                    <span class="meta-separator"></span>
                    ${timeHtml}
                    ${timeHtml ? '<span class="meta-separator"></span>' : ''}
                    <div class="history-entry-tokens">
                        <span class="token-badge prompt">${formatNumber(entry.promptTokens)}</span>
                        <span class="token-badge completion">${formatNumber(entry.completionTokens)}</span>
                        <span class="token-badge total">${formatNumber(entry.totalTokens)}</span>
                    </div>
                    <span class="meta-separator"></span>
                    ${statusHtml}
                </div>
            </div>
        `;
    }).join('');

    // Click to open modal
    container.querySelectorAll('.history-entry').forEach(card => {
        card.addEventListener('click', () => {
            const question = decodeURIComponent(card.getAttribute('data-question'));
            const answer = decodeURIComponent(card.getAttribute('data-answer'));

            document.getElementById('modal-question').textContent = question;

            const answerEl = document.getElementById('modal-answer');
            if (typeof marked !== 'undefined') {
                answerEl.innerHTML = marked.parse(answer);
            } else {
                answerEl.textContent = answer;
            }

            document.getElementById('history-modal').style.display = 'flex';
        });
    });
}

// ============================================
// Modal close logic & events
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // History Modal
    const histModal = document.getElementById('history-modal');
    const histClose = histModal ? histModal.querySelector('.close-modal') : null;
    if (histClose && histModal) {
        histClose.addEventListener('click', () => { histModal.style.display = 'none'; });
    }

    // File Modal
    const fileModal = document.getElementById('file-modal');
    const fileClose = fileModal ? fileModal.querySelector('.close-file-modal') : null;
    if (fileClose && fileModal) {
        fileClose.addEventListener('click', () => { fileModal.style.display = 'none'; });
    }

    // Close on backdrop click
    window.addEventListener('click', (e) => {
        if (e.target === histModal) histModal.style.display = 'none';
        if (e.target === fileModal) fileModal.style.display = 'none';
    });

    // Close on Escape key
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (histModal) histModal.style.display = 'none';
            if (fileModal) fileModal.style.display = 'none';
        }
    });

    // Search in File content
    const searchInput = document.getElementById('file-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            renderFileChunks(currentFileChunks, e.target.value);
        });
    }

    // Copy File content
    const copyBtn = document.getElementById('file-copy-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            if (!currentFileFullText) return;
            try {
                await navigator.clipboard.writeText(currentFileFullText);
                const originalHtml = copyBtn.innerHTML;
                copyBtn.innerHTML = '✓ Copié !';
                setTimeout(() => { copyBtn.innerHTML = originalHtml; }, 2000);
            } catch (err) {
                console.error('Erreur copie presse-papier:', err);
            }
        });
    }
});

// ============================================
// Glossary Toggle
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const glossaryToggle = document.getElementById('glossary-toggle');
    const glossaryCard = document.getElementById('glossary-card');

    if (glossaryToggle && glossaryCard) {
        glossaryToggle.addEventListener('click', () => {
            const isOpen = glossaryCard.classList.toggle('open');
            glossaryToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    }
});

// ============================================
// Files Toggle
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const filesToggle = document.getElementById('files-toggle-btn');
    const filesCard = document.getElementById('files-card');

    if (filesToggle && filesCard) {
        filesToggle.addEventListener('click', () => {
            filesCard.classList.toggle('open');
        });
    }
});

// ============================================
// Arborescence des fichiers : tout déplier / tout replier
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const expandAllBtn = document.getElementById('tree-expand-all-btn');
    const collapseAllBtn = document.getElementById('tree-collapse-all-btn');
    const treeContainer = document.getElementById('file-tree');

    if (expandAllBtn && treeContainer) {
        expandAllBtn.addEventListener('click', () => {
            treeContainer.querySelectorAll('.tree-folder').forEach(folderEl => {
                folderEl.classList.add('open');
                if (treeOpenPaths) treeOpenPaths.add(folderEl.getAttribute('data-tree-path'));
            });
        });
    }

    if (collapseAllBtn && treeContainer) {
        collapseAllBtn.addEventListener('click', () => {
            treeContainer.querySelectorAll('.tree-folder').forEach(folderEl => {
                folderEl.classList.remove('open');
                if (treeOpenPaths) treeOpenPaths.delete(folderEl.getAttribute('data-tree-path'));
            });
        });
    }
});

// ============================================
// Refresh Button
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.classList.add('loading');

            await loadStats();

            setTimeout(() => {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('loading');
            }, 2000);
        });
    }
});

// ============================================
// OneDrive Link Button
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const onedriveBtn = document.getElementById('onedrive-open-btn');

    if (onedriveBtn) {
        onedriveBtn.addEventListener('click', async () => {
            onedriveBtn.disabled = true;
            try {
                const res = await fetch('/api/stats/onedrive-link');
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
                window.open(data.url, '_blank', 'noopener');
            } catch (err) {
                console.error('Erreur ouverture OneDrive:', err);
                alert("Impossible d'ouvrir le dossier OneDrive : " + err.message);
            } finally {
                onedriveBtn.disabled = false;
            }
        });
    }
});

// ============================================
// RAG Refresh Button — popup terminal + liste des nouveaux fichiers
// ============================================
// L'actualisation (téléchargement OneDrive + extraction + embeddings) peut prendre plusieurs
// dizaines de secondes. On ouvre une popup "terminal" qui affiche en direct la progression via
// Server-Sent Events (/api/refresh/stream), pendant que la requête POST /api/refresh déclenche
// réellement l'actualisation côté serveur.
document.addEventListener('DOMContentLoaded', () => {
    const ragBtn = document.getElementById('rag-refresh-btn');
    const ragModal = document.getElementById('rag-terminal-modal');
    const ragOutput = document.getElementById('rag-terminal-output');
    const ragFilesWrap = document.getElementById('rag-terminal-files');
    const ragFilesList = document.getElementById('rag-terminal-files-list');
    const ragRemovedWrap = document.getElementById('rag-terminal-removed');
    const ragRemovedList = document.getElementById('rag-terminal-removed-list');
    const ragStatusDot = document.getElementById('rag-terminal-status-dot');
    const ragHint = document.getElementById('rag-terminal-hint');
    const ragCloseBtn = document.getElementById('rag-terminal-close-btn');
    const ragCloseX = ragModal ? ragModal.querySelector('.close-rag-terminal-modal') : null;

    if (!ragBtn || !ragModal) return;

    let ragEventSource = null;

    function appendRagLine(message, cls = '') {
        const line = document.createElement('span');
        line.className = `rag-terminal-line ${cls}`.trim();
        line.textContent = message;
        ragOutput.appendChild(line);
        ragOutput.scrollTop = ragOutput.scrollHeight;
    }

    function setRagStatus(status) {
        ragStatusDot.classList.remove('status-done', 'status-error');
        if (status === 'done' || status === 'error') ragStatusDot.classList.add(`status-${status}`);
    }

    function stopRagRefresh() {
        ragBtn.disabled = false;
        ragBtn.classList.remove('loading');
    }

    function closeRagEventSource() {
        if (ragEventSource) {
            ragEventSource.close();
            ragEventSource = null;
        }
    }

    function closeRagModal() {
        ragModal.style.display = 'none';
        closeRagEventSource();
    }

    ragCloseBtn?.addEventListener('click', closeRagModal);
    ragCloseX?.addEventListener('click', closeRagModal);
    ragModal.addEventListener('click', (e) => {
        if (e.target === ragModal) closeRagModal();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && ragModal.style.display !== 'none') closeRagModal();
    });

    ragBtn.addEventListener('click', () => {
        ragOutput.innerHTML = '';
        ragFilesList.innerHTML = '';
        ragFilesWrap.hidden = true;
        ragRemovedList.innerHTML = '';
        ragRemovedWrap.hidden = true;
        setRagStatus('running');
        ragHint.textContent = 'Actualisation en cours...';
        ragModal.style.display = 'flex';

        ragBtn.disabled = true;
        ragBtn.classList.add('loading');

        closeRagEventSource();
        ragEventSource = new EventSource('/api/refresh/stream');

        ragEventSource.onmessage = (e) => {
            let data;
            try { data = JSON.parse(e.data); } catch (err) { return; }

            switch (data.type) {
                case 'log':
                    appendRagLine(data.message);
                    break;
                case 'files':
                    if (data.files && data.files.length > 0) {
                        ragFilesList.innerHTML = data.files.map(f => `<li>${escapeHtml(f)}</li>`).join('');
                        ragFilesWrap.hidden = false;
                    } else {
                        ragFilesWrap.hidden = true;
                    }
                    break;
                case 'removed':
                    if (data.files && data.files.length > 0) {
                        ragRemovedList.innerHTML = data.files.map(f => `<li>${escapeHtml(f)}</li>`).join('');
                        ragRemovedWrap.hidden = false;
                    } else {
                        ragRemovedWrap.hidden = true;
                    }
                    break;
                case 'done':
                    appendRagLine(data.message, 'line-system');
                    setRagStatus('done');
                    ragHint.textContent = 'Terminé.';
                    stopRagRefresh();
                    closeRagEventSource();
                    loadStats();
                    break;
                case 'error':
                    appendRagLine(`❌ ${data.message}`, 'line-error');
                    setRagStatus('error');
                    ragHint.textContent = "Erreur lors de l'actualisation.";
                    stopRagRefresh();
                    closeRagEventSource();
                    break;
            }
        };

        ragEventSource.onerror = () => {
            // Se déclenche aussi normalement quand closeRagEventSource() ferme la connexion
            // après un événement 'done'/'error' : le navigateur peut émettre un dernier 'error'.
            if (ragEventSource) {
                appendRagLine('⚠️ Connexion au flux de progression interrompue.', 'line-error');
            }
        };

        fetch('/api/refresh', { method: 'POST' })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    appendRagLine(`❌ ${data.status || data.error || 'Erreur inconnue'}`, 'line-error');
                    setRagStatus('error');
                    ragHint.textContent = "Erreur lors de l'actualisation.";
                    stopRagRefresh();
                    closeRagEventSource();
                }
            })
            .catch((err) => {
                appendRagLine(`❌ Erreur réseau : ${err.message}`, 'line-error');
                setRagStatus('error');
                ragHint.textContent = "Erreur lors de l'actualisation.";
                stopRagRefresh();
                closeRagEventSource();
            });
    });
});

// ============================================
// History Filter
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.history-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentHistoryFilter = btn.dataset.filter;
            renderHistoryEntries(lastHistoryEntries, currentHistoryFilter);
        });
    });
});

// ============================================
// Chart Toggle (Hourly / Daily)
// ============================================
document.querySelectorAll('.chart-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        loadStats();
    });
});
