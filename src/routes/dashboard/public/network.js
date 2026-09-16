/* QwenProxy dashboard network page.
 * Card/filter mechanics follow QwenGate public/network.js. Adapted to the
 * real QwenProxy event shape from GET /dashboard/network/events:
 * flat entries {timestamp, requestId, route, method, path, status,
 * latencyMs, model, stream, accountEmail, ok, error, errorReason,
 * retryCount, attemptedAccounts}. No headers/bodies are captured or shown.
 */

function methodBadgeClass(method) {
  var m = (method || 'GET').toUpperCase();
  if (m === 'GET') return 'badge-method-get';
  if (m === 'POST') return 'badge-method-post';
  if (m === 'PUT') return 'badge-method-put';
  if (m === 'DELETE') return 'badge-method-delete';
  if (m === 'PATCH') return 'badge-method-patch';
  return 'badge-neutral';
}

function statusBadgeClass(status) {
  if (status >= 500) return 'badge-danger';
  if (status >= 400) return 'badge-warning';
  if (status >= 200 && status < 300) return 'badge-success';
  return 'badge-neutral';
}

function durationClass(ms) {
  if (ms == null) return '';
  return ms > 500 ? 'slow' : 'fast';
}

function truncatePath(path, maxLen) {
  if (!path) return '—';
  maxLen = maxLen || 60;
  if (path.length <= maxLen) return path;
  return path.substring(0, maxLen - 3) + '...';
}

/* ── State ── */
var allEntries = [];

/* ── Filter ── */
function onFilterChange() {
  renderNetworkEntries(allEntries);
}

function getFilters() {
  return {
    method: document.getElementById('methodFilter').value.toUpperCase(),
    status: document.getElementById('statusFilter').value,
    category: document.getElementById('categoryFilter').value,
  };
}

function matchesFilters(entry, filters) {
  if (filters.method) {
    var method = (entry.method || 'GET').toUpperCase();
    if (method !== filters.method) return false;
  }
  if (filters.status) {
    var status = entry.status || 0;
    var cat = filters.status;
    if (cat === '2xx' && (status < 200 || status >= 300)) return false;
    if (cat === '4xx' && (status < 400 || status >= 500)) return false;
    if (cat === '5xx' && (status < 500 || status >= 600)) return false;
  }
  if (filters.category) {
    if ((entry.route || 'other') !== filters.category) return false;
  }
  return true;
}

/* ── Fetch ── */
async function fetchNetworkEntries() {
  var data = await apiFetch('/dashboard/network/events?limit=100');
  var emptyEl = document.getElementById('netEmpty');
  var errorEl = document.getElementById('netError');
  if (!data || !data.entries || !Array.isArray(data.entries)) {
    emptyEl.style.display = '';
    errorEl.style.display = 'none';
    allEntries = [];
    renderNetworkEntries([]);
    document.getElementById('entryCount').textContent = '0';
    return;
  }
  emptyEl.style.display = 'none';
  errorEl.style.display = 'none';
  allEntries = data.entries;
  document.getElementById('entryCount').textContent = allEntries.length;
  renderNetworkEntries(allEntries);
}

function renderNetworkEntries(entries) {
  var container = document.getElementById('netContainer');
  var filters = getFilters();
  var filtered = entries.filter(function (e) {
    return matchesFilters(e, filters);
  });
  var filteredCountEl = document.getElementById('filteredCount');
  if (filteredCountEl) {
    var total = entries.length;
    filteredCountEl.textContent = filtered.length === total ? total + ' entries' : filtered.length + ' of ' + total + ' entries';
  }

  /* Keep empty/error state inside container, clear everything else */
  var emptyEl = document.getElementById('netEmpty');
  var errorEl = document.getElementById('netError');
  container.innerHTML = '';
  container.appendChild(emptyEl);
  container.appendChild(errorEl);

  if (filtered.length === 0) {
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  for (var i = 0; i < filtered.length; i++) {
    var e = filtered[i];
    var card = document.createElement('div');
    card.className = 'net-entry';

    /* ── Entry Header ── */
    card.innerHTML =
      '<div class="net-entry-header" onclick="toggleEntry(this)">' +
      '<span class="badge ' +
      methodBadgeClass(e.method) +
      '">' +
      escHtml((e.method || 'GET').toUpperCase()) +
      '</span>' +
      '<span class="net-url" title="' +
      escHtml(e.path || '') +
      '">' +
      escHtml(truncatePath(e.path)) +
      '</span>' +
      '<span class="net-meta">' +
      (e.status != null
        ? '<span class="badge ' + statusBadgeClass(e.status) + '">' + e.status + '</span>'
        : '<span class="badge badge-neutral">—</span>') +
      ' <span class="badge badge-neutral">' +
      escHtml(e.route || 'other') +
      '</span>' +
      '</span>' +
      '<span class="net-duration ' +
      durationClass(e.latencyMs) +
      '">' +
      (e.latencyMs != null ? Math.round(e.latencyMs) + 'ms' : '—') +
      '</span>' +
      '<span class="net-time">' +
      fmtTime(e.timestamp) +
      '</span>' +
      '</div>' +
      '<div class="net-entry-body">' +
      renderEntryDetail(e) +
      '</div>';

    container.appendChild(card);
  }
}

/* ── Render Entry Detail ── */
function renderEntryDetail(entry) {
  var metaParts = [];
  if (entry.requestId) metaParts.push('<span class="badge badge-neutral">req ' + escHtml(entry.requestId) + '</span>');
  if (entry.model) metaParts.push('<span class="badge badge-accent">' + escHtml(entry.model) + '</span>');
  if (entry.accountEmail) metaParts.push('<span class="badge badge-neutral">' + escHtml(entry.accountEmail) + '</span>');
  if (entry.stream === true) metaParts.push('<span class="net-stat">stream</span>');
  if (entry.stream === false) metaParts.push('<span class="net-stat">non-stream</span>');
  if (entry.retryCount > 0) metaParts.push('<span class="net-stat">' + entry.retryCount + ' retries</span>');
  if (entry.attemptedAccounts > 1) metaParts.push('<span class="net-stat">' + entry.attemptedAccounts + ' accounts tried</span>');
  if (entry.errorReason) metaParts.push('<span class="net-stat">reason: ' + escHtml(entry.errorReason) + '</span>');

  var html = '';
  if (metaParts.length > 0) {
    html += '<div class="net-meta-row">' + metaParts.join('') + '</div>';
  }

  html += '<div class="detail-grid">';

  /* Error if present */
  if (entry.error) {
    html +=
      '<div class="detail-section">' +
      '<div class="section-header"><span class="section-arrow">▶</span> Error</div>' +
      '<div class="section-body" style="background:var(--danger-soft)"><pre style="color:var(--danger)">' +
      escHtml(entry.error) +
      '</pre></div>' +
      '</div>';
  } else {
    html +=
      '<div class="detail-section">' +
      '<div class="section-header"><span class="section-arrow">▶</span> Result</div>' +
      '<div class="section-body"><pre>' +
      escHtml(entry.ok ? 'OK' : 'HTTP ' + entry.status) +
      '</pre></div>' +
      '</div>';
  }

  html += '</div>';
  return html;
}

/* ── Toggle entry card ── */
function toggleEntry(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}

/* ── Init ── */
function init() {
  fetchNetworkEntries();
  createPoller(fetchNetworkEntries, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
