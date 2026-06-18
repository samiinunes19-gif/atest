/**
 * ============================================================
 * ADMIN.JS – Lógica do Painel Administrativo
 * SSE, Gráficos (Chart.js), Tabela, Filtros, Export CSV
 * ============================================================
 */

'use strict';

// ── Credenciais (Basic Auth via navegador) ──────────────────
// O navegador armazena as credenciais após o primeiro desafio HTTP Basic Auth.
// Mas para SSE e API, precisamos enviá-las manualmente com fetch/EventSource.

// Recupera credenciais salvas no sessionStorage (definidas no primeiro login)
let adminPass = sessionStorage.getItem('adminPass') || '';

if (!adminPass) {
  adminPass = prompt('🔒 Senha do painel admin:') || '';
  sessionStorage.setItem('adminPass', adminPass);
}

const AUTH_HEADER = 'Basic ' + btoa('admin:' + adminPass);

// ── Estado Global ───────────────────────────────────────────
const state = {
  logs:        [],      // todos os logs recebidos
  filtered:    [],      // logs após filtro
  currentPage: 1,
  pageSize:    50,
  sortKey:     'timestamp',
  sortDir:     'desc',  // 'asc' | 'desc'
  search:      '',
  filterResult:'',
};

// ── Referências DOM ─────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  statusDot:     $('status-dot'),
  statusText:    $('status-text'),
  headerTime:    $('header-time'),
  statTotal:     $('stat-total'),
  statAuth:      $('stat-authorized'),
  statBlocked:   $('stat-blocked'),
  statRate:      $('stat-rate'),
  logTbody:      $('log-tbody'),
  tableCount:    $('table-count'),
  pagination:    $('pagination'),
  searchInput:   $('search-input'),
  filterResult:  $('filter-result'),
  btnClearFilter:$('btn-clear-filter'),
  btnExport:     $('btn-export'),
  toastContainer:$('toast-container'),
  legendReasons: $('legend-reasons'),
};

// ── Relógio ─────────────────────────────────────────────────
function tickClock() {
  DOM.headerTime.textContent = new Date().toLocaleTimeString('pt-BR');
}
tickClock();
setInterval(tickClock, 1000);

// ── Toast ────────────────────────────────────────────────────
/**
 * Exibe uma notificação toast temporária
 * @param {string} msg - Mensagem
 * @param {'info'|'success'|'error'} type - Tipo
 * @param {number} duration - Duração em ms
 */
function showToast(msg, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Gráficos ─────────────────────────────────────────────────

// Cores harmonizadas
const COLORS = {
  success:  'rgba(34, 211, 165, 0.9)',
  successFill: 'rgba(34, 211, 165, 0.15)',
  danger:   'rgba(244, 63, 94, 0.9)',
  dangerFill: 'rgba(244, 63, 94, 0.15)',
  primary:  'rgba(99, 102, 241, 0.9)',
  primaryFill: 'rgba(99, 102, 241, 0.15)',
  info:     'rgba(56, 189, 248, 0.9)',
  warning:  'rgba(251, 146, 60, 0.9)',
  purple:   'rgba(168, 85, 247, 0.9)',
  pink:     'rgba(236, 72, 153, 0.9)',
};

const REASON_COLORS = {
  ip_bloqueado:        COLORS.danger,
  user_agent_restrito: COLORS.warning,
  sem_cookie:          COLORS.primary,
  pais_nao_permitido:  COLORS.purple,
  url_autorizacao:     COLORS.success,
  cookie_concedido:    COLORS.info,
};

const chartDefaults = {
  font: { family: "'Inter', sans-serif", size: 12 },
  color: 'rgba(148,163,184,0.8)',
};
Chart.defaults.font.family = chartDefaults.font.family;
Chart.defaults.font.size   = chartDefaults.font.size;
Chart.defaults.color       = chartDefaults.color;

// ─── Gráfico de Barras: Acessos por hora ──────────────────
let chartHours;
function initHoursChart() {
  const ctx = document.getElementById('chart-hours').getContext('2d');
  chartHours = new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   [],
      datasets: [
        {
          label: 'Autorizados',
          data: [],
          backgroundColor: COLORS.successFill,
          borderColor:     COLORS.success,
          borderWidth: 1.5,
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Bloqueados',
          data: [],
          backgroundColor: COLORS.dangerFill,
          borderColor:     COLORS.danger,
          borderWidth: 1.5,
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,18,32,0.95)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor:  '#94a3b8',
          padding: 10,
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { maxRotation: 0 },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

// ─── Gráfico de Pizza: Motivos de bloqueio ────────────────
let chartReasons;
function initReasonsChart() {
  const ctx = document.getElementById('chart-reasons').getContext('2d');
  chartReasons = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0, hoverOffset: 8 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,18,32,0.95)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor:  '#94a3b8',
          padding: 10,
        },
      },
    },
  });
}

// ─── Gráfico de Linha: Atividade recente (10 min) ─────────
let chartActivity;
const ACTIVITY_WINDOW  = 10; // minutos
const ACTIVITY_BUCKETS = 20; // pontos no gráfico
const activityBuffer   = Array(ACTIVITY_BUCKETS).fill(0); // autorizados
const activityBufferBl = Array(ACTIVITY_BUCKETS).fill(0); // bloqueados
let activityTick = 0;

function initActivityChart() {
  const ctx = document.getElementById('chart-activity').getContext('2d');
  const labels = Array.from({ length: ACTIVITY_BUCKETS }, (_, i) =>
    i === ACTIVITY_BUCKETS - 1 ? 'agora' : `-${(ACTIVITY_BUCKETS - 1 - i) * (ACTIVITY_WINDOW * 60 / ACTIVITY_BUCKETS)}s`
  );
  chartActivity = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Autorizados',
          data: [...activityBuffer],
          borderColor:     COLORS.success,
          backgroundColor: COLORS.successFill,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
        {
          label: 'Bloqueados',
          data: [...activityBufferBl],
          borderColor:     COLORS.danger,
          backgroundColor: COLORS.dangerFill,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,18,32,0.95)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#f1f5f9',
          bodyColor:  '#94a3b8',
          padding: 10,
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 0, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
      },
      animation: { duration: 300 },
    },
  });

  // Avança o buffer a cada (ACTIVITY_WINDOW*60/ACTIVITY_BUCKETS) segundos
  const intervalMs = (ACTIVITY_WINDOW * 60 * 1000) / ACTIVITY_BUCKETS;
  setInterval(() => {
    activityBuffer.shift();   activityBuffer.push(0);
    activityBufferBl.shift(); activityBufferBl.push(0);
    chartActivity.data.datasets[0].data = [...activityBuffer];
    chartActivity.data.datasets[1].data = [...activityBufferBl];
    chartActivity.update('none');
  }, intervalMs);
}

// ── Atualização dos Gráficos ─────────────────────────────────
function updateCharts() {
  const logs = state.logs;

  // --- Barras por hora (últimas 24h) ---
  const now   = new Date();
  const hours = {};
  for (let h = 23; h >= 0; h--) {
    const d = new Date(now - h * 3600000);
    const label = d.getHours().toString().padStart(2, '0') + ':00';
    hours[label] = { auth: 0, blocked: 0 };
  }
  logs.forEach(e => {
    const d = new Date(e.timestamp);
    if (now - d > 86400000) return;
    const label = d.getHours().toString().padStart(2, '0') + ':00';
    if (hours[label]) {
      if (e.resultado === 'autorizado') hours[label].auth++;
      else hours[label].blocked++;
    }
  });
  chartHours.data.labels             = Object.keys(hours);
  chartHours.data.datasets[0].data   = Object.values(hours).map(h => h.auth);
  chartHours.data.datasets[1].data   = Object.values(hours).map(h => h.blocked);
  chartHours.update();

  // --- Pizza: motivos ---
  const reasons = {};
  logs.filter(e => e.resultado === 'bloqueado' || e.resultado === 'cookie_concedido').forEach(e => {
    const m = e.motivo || 'outro';
    reasons[m] = (reasons[m] || 0) + 1;
  });
  const rLabels = Object.keys(reasons);
  const rData   = Object.values(reasons);
  const rColors = rLabels.map(l => REASON_COLORS[l] || COLORS.info);

  chartReasons.data.labels                    = rLabels;
  chartReasons.data.datasets[0].data          = rData;
  chartReasons.data.datasets[0].backgroundColor = rColors;
  chartReasons.update();

  // Legenda customizada
  DOM.legendReasons.innerHTML = rLabels.map((l, i) => `
    <div class="legend-pill">
      <div class="legend-dot" style="background:${rColors[i]}"></div>
      <span>${formatMotivo(l)}</span>
      <strong>${rData[i]}</strong>
    </div>
  `).join('');
}

// ── Formatação ───────────────────────────────────────────────
function formatMotivo(m) {
  const map = {
    ip_bloqueado:        'IP Bloqueado',
    user_agent_restrito: 'Bot/Scraper',
    sem_cookie:          'Sem Cookie',
    pais_nao_permitido:  'País Negado',
    url_autorizacao:     'Auth URL',
    cookie_concedido:    'Cookie OK',
    outro:               'Outro',
  };
  return map[m] || m;
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day:    '2-digit', month: '2-digit',
    hour:   '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function badgeHtml(resultado) {
  if (resultado === 'autorizado') return `<span class="badge badge-ok">✅ Autorizado</span>`;
  if (resultado === 'cookie_concedido') return `<span class="badge badge-cookie">🍪 Cookie</span>`;
  return `<span class="badge badge-blocked">🚫 Bloqueado</span>`;
}

function cookieBadge(hasCookie) {
  return hasCookie
    ? `<span class="badge badge-cookie">✓ Sim</span>`
    : `<span class="badge badge-no-cookie">✗ Não</span>`;
}

function motivoBadge(motivo) {
  if (!motivo) return '<span class="badge badge-ok">—</span>';
  return `<span class="badge badge-motivo">${formatMotivo(motivo)}</span>`;
}

// ── Tabela ───────────────────────────────────────────────────
function applyFilters() {
  const search = state.search.toLowerCase().trim();
  const res    = state.filterResult;

  state.filtered = state.logs.filter(e => {
    if (res && e.resultado !== res) return false;
    if (search) {
      const haystack = [e.ip, e.pais, e.motivo, e.path, e.ua].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  // Ordenação
  state.filtered.sort((a, b) => {
    let va = a[state.sortKey] || '';
    let vb = b[state.sortKey] || '';
    if (state.sortKey === 'timestamp') { va = new Date(va); vb = new Date(vb); }
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  state.currentPage = 1;
  renderTable();
}

function renderTable() {
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const start = (state.currentPage - 1) * state.pageSize;
  const page  = state.filtered.slice(start, start + state.pageSize);

  DOM.tableCount.textContent = `${total} registro${total !== 1 ? 's' : ''} exibido${total !== 1 ? 's' : ''}`;

  if (page.length === 0) {
    DOM.logTbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <div>Nenhum registro encontrado</div>
          </div>
        </td>
      </tr>
    `;
    renderPagination(pages);
    return;
  }

  DOM.logTbody.innerHTML = page.map((e, i) => `
    <tr data-id="${e.id}" ${i === 0 && state.currentPage === 1 ? 'class="row-new"' : ''}>
      <td class="td-mono">${formatTime(e.timestamp)}</td>
      <td class="td-ip">${escHtml(e.ip || '--')}</td>
      <td>${escHtml(e.pais || '?')}</td>
      <td class="td-path" title="${escHtml(e.path || '')}">${escHtml(e.path || '--')}</td>
      <td>${cookieBadge(e.cookie)}</td>
      <td>${badgeHtml(e.resultado)}</td>
      <td>${motivoBadge(e.motivo)}</td>
    </tr>
  `).join('');

  renderPagination(pages);
}

function renderPagination(pages) {
  if (pages <= 1) { DOM.pagination.innerHTML = ''; return; }

  const p = state.currentPage;
  let html = '';

  // Botão anterior
  html += `<button class="page-btn" ${p === 1 ? 'disabled' : ''} data-page="${p - 1}">‹</button>`;

  // Páginas próximas
  const range = [];
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) range.push(i);
  } else {
    range.push(1);
    if (p > 3)  range.push('…');
    for (let i = Math.max(2, p-1); i <= Math.min(pages-1, p+1); i++) range.push(i);
    if (p < pages - 2) range.push('…');
    range.push(pages);
  }

  range.forEach(v => {
    if (v === '…') html += `<span style="padding:0.3rem 0.2rem;color:var(--clr-text-3)">…</span>`;
    else html += `<button class="page-btn ${v === p ? 'active' : ''}" data-page="${v}">${v}</button>`;
  });

  html += `<button class="page-btn" ${p === pages ? 'disabled' : ''} data-page="${p + 1}">›</button>`;

  DOM.pagination.innerHTML = html;
  DOM.pagination.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentPage = parseInt(btn.dataset.page);
      renderTable();
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Estatísticas ─────────────────────────────────────────────
function updateStats() {
  const total    = state.logs.length;
  const auth     = state.logs.filter(e => e.resultado === 'autorizado').length;
  const blocked  = state.logs.filter(e => e.resultado === 'bloqueado').length;
  const rate     = total > 0 ? Math.round((blocked / total) * 100) : 0;

  DOM.statTotal.textContent   = total.toLocaleString('pt-BR');
  DOM.statAuth.textContent    = auth.toLocaleString('pt-BR');
  DOM.statBlocked.textContent = blocked.toLocaleString('pt-BR');
  DOM.statRate.textContent    = rate + '%';
}

// ── SSE – Server-Sent Events ─────────────────────────────────
let sseRetryCount = 0;
let sseRetryTimer = null;

function connectSSE() {
  // Usamos fetch + ReadableStream pois EventSource não suporta headers customizados
  const controller = new AbortController();

  DOM.statusDot.className  = 'status-dot';
  DOM.statusText.textContent = 'Conectando…';

  fetch('/admin/stream', {
    headers: { 'Authorization': AUTH_HEADER },
    signal: controller.signal,
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DOM.statusDot.className   = 'status-dot connected';
      DOM.statusText.textContent = 'Conectado (live)';
      sseRetryCount = 0;
      showToast('✅ Conexão SSE estabelecida', 'success');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) {
            DOM.statusDot.className   = 'status-dot error';
            DOM.statusText.textContent = 'Desconectado';
            scheduleReconnect();
            return;
          }
          buffer += decoder.decode(value, { stream: true });

          // Processa eventos SSE no buffer
          const events = buffer.split('\n\n');
          buffer = events.pop(); // o último pode estar incompleto

          events.forEach(evt => {
            const lines  = evt.split('\n');
            let evtName  = 'message';
            let evtData  = '';
            lines.forEach(l => {
              if (l.startsWith('event: ')) evtName = l.slice(7).trim();
              if (l.startsWith('data: '))  evtData  = l.slice(6).trim();
            });
            if (evtData && evtName !== 'message') {
              handleSSEEvent(evtName, evtData);
            }
          });

          read();
        }).catch(err => {
          if (err.name !== 'AbortError') {
            DOM.statusDot.className   = 'status-dot error';
            DOM.statusText.textContent = 'Erro na conexão';
            scheduleReconnect();
          }
        });
      }
      read();
    })
    .catch(err => {
      DOM.statusDot.className   = 'status-dot error';
      DOM.statusText.textContent = 'Falha na conexão';
      if (err.message.includes('401')) {
        showToast('❌ Senha incorreta! Redirecionando para o login...', 'error', 3000);
        sessionStorage.removeItem('adminPass');
        setTimeout(() => { window.location.href = '/admin'; }, 2000);
        return;
      }
      scheduleReconnect();
    });

  return controller;
}

function scheduleReconnect() {
  if (sseRetryTimer) return;
  const delay = Math.min(1000 * Math.pow(2, sseRetryCount), 30000); // backoff exponencial
  sseRetryCount++;
  DOM.statusText.textContent = `Reconectando em ${Math.round(delay/1000)}s…`;
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    connectSSE();
  }, delay);
}

/**
 * Processa evento SSE recebido
 * @param {string} name - Nome do evento
 * @param {string} rawData - JSON string dos dados
 */
function handleSSEEvent(name, rawData) {
  let data;
  try { data = JSON.parse(rawData); }
  catch { return; }

  if (name === 'history') {
    // Carregamento inicial: substitui todos os logs
    state.logs = Array.isArray(data) ? data : [];
  } else if (name === 'log') {
    // Novos registros chegando em lote (debounced no servidor)
    const incoming = Array.isArray(data) ? data : [data];
    // Adiciona ao buffer de atividade
    incoming.forEach(e => {
      if (e.resultado === 'autorizado') activityBuffer[ACTIVITY_BUCKETS - 1]++;
      else                             activityBufferBl[ACTIVITY_BUCKETS - 1]++;
    });
    // Atualiza array principal (evita duplicatas por id)
    const existingIds = new Set(state.logs.map(e => e.id));
    incoming.filter(e => !existingIds.has(e.id)).forEach(e => state.logs.unshift(e));
    // Limita memória do cliente
    if (state.logs.length > 2000) state.logs = state.logs.slice(0, 2000);
  }

  updateStats();
  updateCharts();
  applyFilters();

  if (name === 'log') {
    const newData = Array.isArray(data) ? data : [data];
    // Atualiza gráfico de atividade visualmente
    chartActivity.data.datasets[0].data = [...activityBuffer];
    chartActivity.data.datasets[1].data = [...activityBufferBl];
    chartActivity.update('none');
    // Flash na linha nova
    setTimeout(() => {
      if (newData[0]) {
        const row = DOM.logTbody.querySelector(`[data-id="${newData[0].id}"]`);
        if (row) row.classList.add('row-new');
      }
    }, 100);
  }
}

// ── Export CSV ───────────────────────────────────────────────
function exportCSV() {
  const data = state.filtered.length ? state.filtered : state.logs;
  const headers = ['timestamp', 'ip', 'pais', 'path', 'cookie', 'resultado', 'motivo', 'ua'];
  const csvRows = [
    headers.join(','),
    ...data.map(e => headers.map(h => {
      const val = String(e[h] ?? '').replace(/"/g, '""');
      return `"${val}"`;
    }).join(','))
  ];
  const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `access-log-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 CSV exportado com sucesso!', 'success');
}

// ── Eventos de UI ────────────────────────────────────────────
DOM.searchInput.addEventListener('input', () => {
  state.search = DOM.searchInput.value;
  applyFilters();
});

DOM.filterResult.addEventListener('change', () => {
  state.filterResult = DOM.filterResult.value;
  applyFilters();
});

DOM.btnClearFilter.addEventListener('click', () => {
  state.search      = '';
  state.filterResult= '';
  DOM.searchInput.value    = '';
  DOM.filterResult.value   = '';
  applyFilters();
});

DOM.btnExport.addEventListener('click', exportCSV);

// Ordenação por clique no cabeçalho
document.getElementById('log-table').querySelector('thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = 'desc';
  }
  applyFilters();
});

// ── Inicialização ─────────────────────────────────────────────
function init() {
  initHoursChart();
  initReasonsChart();
  initActivityChart();
  applyFilters();
  connectSSE();
  carregarTransacoes();

  // Atualiza transações a cada 30s automaticamente
  setInterval(carregarTransacoes, 30_000);

  // Botão de atualizar manual
  const btnRefresh = document.getElementById('btn-refresh-tx');
  if (btnRefresh) btnRefresh.addEventListener('click', carregarTransacoes);
}

// ── Transações PIX ──────────────────────────────────────────────

async function carregarTransacoes() {
  try {
    const r = await fetch('/admin/api/transacoes', {
      headers: { Authorization: AUTH_HEADER }
    });
    if (r.status === 401) {
      sessionStorage.removeItem('adminPass');
      window.location.href = '/admin';
      return;
    }
    if (!r.ok) return;
    const data = await r.json();
    renderTransacoes(data.transacoes || []);
    atualizarStatPix(data.transacoes || []);
  } catch (e) {
    console.warn('[Admin] Erro ao carregar transações:', e.message);
  }
}

function atualizarStatPix(transacoes) {
  const totalVal = transacoes.reduce((s, t) => s + (t.valor || 0), 0);
  const elVal   = document.getElementById('stat-pix-total');
  const elCount = document.getElementById('badge-pix-count');
  if (elVal)   elVal.textContent   = 'R$ ' + totalVal.toFixed(2).replace('.', ',');
  if (elCount) elCount.textContent = transacoes.length + ' transaç' + (transacoes.length === 1 ? 'ão' : 'ões');
}

function renderTransacoes(transacoes) {
  const grid = document.getElementById('tx-grid');
  const count = document.getElementById('tx-count');
  if (!grid) return;

  if (count) count.textContent = transacoes.length + ' transaç' + (transacoes.length === 1 ? 'ão' : 'ões');

  if (transacoes.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;padding:40px">
        <div class="empty-icon">💳</div>
        <div>Nenhuma transação ainda…</div>
      </div>`;
    return;
  }

  grid.innerHTML = transacoes.map(tx => {
    const valor = 'R$ ' + (tx.valor || 0).toFixed(2).replace('.', ',');
    const data  = new Date(tx.criadoEm).toLocaleString('pt-BR');
    const comp  = tx.comprovante;

    let compHtml = '';
    if (comp) {
      const isPdf = comp.tipo === 'application/pdf';
      const url   = comp.url;
      if (isPdf) {
        compHtml = `
          <div class="tx-card-comp">
            <div class="tx-comp-pdf-icon" onclick="abrirModalComp('${url}','pdf')" title="Ver PDF">📄</div>
            <div class="tx-comp-info">
              <p>📎 ${comp.original || comp.arquivo}</p>
              <a href="${url}" target="_blank" rel="noopener">Abrir PDF ↗</a>
            </div>
          </div>`;
      } else {
        compHtml = `
          <div class="tx-card-comp">
            <img class="tx-comp-thumb" src="${url}" alt="Comprovante"
                 onclick="abrirModalComp('${url}','img')"
                 title="Clique para ampliar" />
            <div class="tx-comp-info">
              <p>📎 ${comp.original || comp.arquivo}</p>
              <a href="${url}" target="_blank" rel="noopener">Ver original ↗</a>
            </div>
          </div>`;
      }
    } else {
      compHtml = `<div class="tx-no-comp">⚠️ Comprovante não anexado</div>`;
    }

    return `
      <div class="tx-card">
        <div class="tx-card-header">
          <span class="tx-card-valor">${valor}</span>
          <span class="tx-card-badge">✅ Pago</span>
        </div>
        <div class="tx-card-info">
          <div class="tx-card-nome">${escHtml(tx.nome)}</div>
          <div class="tx-card-detalhe">
            <span>✉️ ${escHtml(tx.email)}</span>
            <span>📞 ${escHtml(tx.telefone)}</span>
          </div>
          <div class="tx-card-detalhe">
            <span>🪪 CPF: ${escHtml(tx.cpf)}</span>
          </div>
          <div class="tx-card-id">ID: ${escHtml(tx.id)}</div>
        </div>
        ${compHtml}
        <div class="tx-card-time">${data}</div>
      </div>`;
  }).join('');
}

function abrirModalComp(url, tipo) {
  const modal = document.getElementById('comp-modal');
  const img   = document.getElementById('comp-modal-img');
  const pdf   = document.getElementById('comp-modal-pdf');
  if (!modal) return;
  if (tipo === 'pdf') {
    img.style.display = 'none'; img.src = '';
    pdf.style.display = 'block'; pdf.src = url;
  } else {
    pdf.style.display = 'none'; pdf.src = '';
    img.style.display = 'block'; img.src = url;
  }
  modal.style.display = 'flex';
}

function fecharModalComp() {
  const modal = document.getElementById('comp-modal');
  if (modal) { modal.style.display = 'none'; }
  const img = document.getElementById('comp-modal-img');
  const pdf = document.getElementById('comp-modal-pdf');
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (pdf) { pdf.src = ''; pdf.style.display = 'none'; }
}

// Fecha modal com Esc
document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModalComp(); });

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
