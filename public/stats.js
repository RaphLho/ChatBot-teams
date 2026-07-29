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
    const labels = data.map(u => truncateUserId(u.userId));

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
                        title: (items) => data[items[0].dataIndex] ? data[items[0].dataIndex].userId : '',
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
// Number Formatting
// ============================================
function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString('fr-FR');
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
// Load Stats & History
// ============================================
let currentRange = 'hourly';

async function loadStats() {
    try {
        const [statsRes, historyRes] = await Promise.all([
            fetch('/api/stats'),
            fetch('/api/stats/history')
        ]);

        const stats = await statsRes.json();
        const history = await historyRes.json();

        // Nouveaux calculs
        const date = new Date();
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const currentMonthTokens = (stats.global.monthlyUsage && stats.global.monthlyUsage[monthKey]) ? stats.global.monthlyUsage[monthKey] : 0;
        const globalTotal = stats.global.totalPromptTokens + stats.global.totalCompletionTokens;
        const sessionTotal = stats.session.totalPromptTokens + stats.session.totalCompletionTokens;

        // Update KPIs
        animateValue(document.getElementById('kpi-total-global'), globalTotal);
        animateValue(document.getElementById('kpi-total-month'), currentMonthTokens);
        animateValue(document.getElementById('kpi-total-session'), sessionTotal);
        animateValue(document.getElementById('kpi-requests'), stats.global.totalConversations);

        // Calcul du coût total estimé (au lieu d'annuel qui fausse avec l'indexation massive du jour 1)
        // Prix Mistral: ~0.10€/1M pour Embeddings, ~0.20€/1M pour Prompts (moyenne 0.15€)
        // Prix Completion: ~0.60€/1M
        const promptCost = stats.global.totalPromptTokens * (0.15 / 1000000);
        const completionCost = stats.global.totalCompletionTokens * (0.6 / 1000000);
        const totalCost = promptCost + completionCost;

        document.getElementById('kpi-total-cost').textContent = `~${Math.max(0.01, totalCost).toFixed(2)} €`;

        // KPIs qualité & utilisation
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

        // Charts
        const chartData = currentRange === 'hourly' ? history.hourly : history.daily;

        if (chartData && chartData.length > 0) {
            initTimelineChart(chartData);
            initBarChart(chartData);
        } else {
            // Show empty charts with placeholder data
            initTimelineChart([{ label: 'Pas de données', promptTokens: 0, completionTokens: 0, totalTokens: 0 }]);
            initBarChart([{ label: 'Pas de données', promptTokens: 0, completionTokens: 0 }]);
        }

        initDoughnutChart(stats.global.totalPromptTokens || 0, stats.global.totalCompletionTokens || 0);

        // Nouveaux graphiques : utilisation & qualité
        initTopUsersChart(history.topUsers || []);

        const compliantCount = Math.max(0, (stats.session.totalConversations || 0) - (stats.session.totalNonCompliant || 0));
        initComplianceChart(compliantCount, stats.session.totalNonCompliant || 0);

        initHourOfDayChart(history.hourOfDay || []);
        initWeekdayChart(history.weekday || []);

        // History table
        updateHistoryTable(history.entries || []);

    } catch (error) {
        console.error('Erreur lors du chargement des statistiques:', error);
    }
}

// ============================================
// History Table
// ============================================
function updateHistoryTable(entries) {
    const tbody = document.getElementById('history-tbody');
    const countEl = document.getElementById('history-count');

    countEl.textContent = `${entries.length} entrée${entries.length > 1 ? 's' : ''}`;

    if (entries.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucune donnée disponible</td></tr>';
        return;
    }

    // Show latest first, limit to 50
    const recent = [...entries].reverse().slice(0, 50);

    tbody.innerHTML = recent.map(entry => `
        <tr class="history-row ${entry.isNonCompliant ? 'row-error' : ''}"
            data-question="${encodeURIComponent(entry.question || 'Pas de question (Indexation ou erreur)')}"
            data-answer="${encodeURIComponent(entry.answer || 'Pas de réponse')}">
            <td>${formatTimestamp(entry.timestamp)}</td>
            <td><span class="user-badge">${entry.userId || 'inconnu'}</span></td>
            <td><span class="token-badge prompt">${formatNumber(entry.promptTokens)}</span></td>
            <td><span class="token-badge completion">${formatNumber(entry.completionTokens)}</span></td>
            <td><span class="token-badge total">${formatNumber(entry.totalTokens)}</span></td>
            <td>${entry.responseTimeMs ? `<span class="speed-badge">${formatResponseTime(entry.responseTimeMs)}</span>` : '—'}</td>
            <td>${entry.isNonCompliant
                ? '<span class="status-badge warn">⚠ Hors-sujet</span>'
                : '<span class="status-badge ok">✓ Conforme</span>'}</td>
        </tr>
    `).join('');

    // Ajout des events de clic sur chaque ligne
    document.querySelectorAll('.history-row').forEach(row => {
        row.addEventListener('click', () => {
            const question = decodeURIComponent(row.getAttribute('data-question'));
            const answer = decodeURIComponent(row.getAttribute('data-answer'));
            
            document.getElementById('modal-question').textContent = question;
            
            // On utilise marked.js s'il est dispo pour la réponse Markdown
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

// Logique de fermeture de la modale
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('history-modal');
    const closeBtn = document.querySelector('.close-modal');

    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        // Fermer au clic en dehors de la modale
        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
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
