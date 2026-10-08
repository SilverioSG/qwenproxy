/* QwenProxy dashboard overview.
 * Based on QwenGate public/overview.js. Adapted to QwenProxy adapters:
 * - /accounts entries carry {ready, available, cooldown_...} instead of
 *   {authenticated, totalRequests, throttled...}.
 * - /system/logs is UNSUPPORTED in V1 (501) — tolerated, panel keeps its
 *   empty state instead of failing.
 * - Model health has no per-model counters in V1 — tolerated (empty state).
 */
/* ── Uptime tracking ── */
var uptimeSeconds = 0;
var uptimeBase = 0;
function updateUptime() {
  if (uptimeBase === 0) return;
  var elapsed = uptimeSeconds + Math.floor((Date.now() - uptimeBase) / 1000);
  var str = fmtDuration(elapsed);
  setText('kpiUptime', str);
  setText('kpiUptimeSub', '');
  setText('headerUptime', str);
}
/* ── KPI + Health ──
 * TOTAL ACCOUNTS comes from /accounts (configured accounts) — never from
 * /health, whose QwenProxy shape carries no `accounts` object (that gap
 * zeroed the KPI). READY (headers-ready, warmed) and AVAILABLE (usable by
 * the pool, including standby) stay separate counters from separate fields.
 */
async function refreshHealth() {
  var data = await apiFetch('/health');
  var uptimeData = await apiFetch('/metrics/uptime');
  if (uptimeData && uptimeData.uptimeSeconds != null) {
    uptimeSeconds = uptimeData.uptimeSeconds;
    uptimeBase = Date.now();
    updateUptime();
  }
  var acctData = await apiFetch('/accounts');
  var total = 0;
  var avail = 0;
  var ready = 0;
  if (Array.isArray(acctData)) {
    total = acctData.length;
    for (var i = 0; i < acctData.length; i++) {
      var a = acctData[i];
      if (a.available) avail++;
      if (a.ready || a.authenticated) ready++;
    }
  }
  // QwenGate-shaped /health fallback (only when /accounts is unreachable).
  if (total === 0 && data && data.accounts) {
    if (data.accounts.total != null) total = data.accounts.total;
    if (data.accounts.available != null) avail = data.accounts.available;
  }
  setText('kpiTotalAccounts', total);
  setText('kpiTotalAccountsSub', avail + ' available');
  setText('kpiAuthenticated', ready);
  var readyPct = total > 0 ? Math.round((ready / total) * 100) : 0;
  setText('kpiAuthenticatedSub', readyPct + '% of ' + total);
  if (Array.isArray(acctData)) {
    var totalReqs = 0;
    var haveReqs = false;
    for (var j = 0; j < acctData.length; j++) {
      if (typeof acctData[j].totalRequests === 'number') {
        totalReqs += acctData[j].totalRequests;
        haveReqs = true;
      }
    }
    if (haveReqs) setText('kpiTotalRequests', totalReqs);
  }
  var mon = await apiFetch('/metrics/monitor');
  if (mon && mon.totals && typeof mon.totals.totalRequests === 'number') {
    setText('kpiTotalRequests', mon.totals.totalRequests);
    // Primary failure metric: failed backend/protection requests (aborts out).
    var failed = mon.totals.failedRequests != null ? mon.totals.failedRequests : mon.totals.totalErrors || 0;
    var aborts = mon.totals.clientAborts || 0;
    var prot = mon.totals.protectionEvents || 0;
    var sub = failed + ' failed';
    if (aborts > 0) sub += ' · ' + aborts + ' aborted';
    if (prot > 0) sub += ' · ' + prot + ' protection';
    setText('kpiTotalRequestsSub', sub);
  }
}
/* ── Pool Stats ── */
async function refreshPool() {
  var data = await apiFetch('/pool/stats');
  if (!data) return;
  var inUse = data.inUse || 0;
  var wait = data.waiting == null ? '—' : data.waiting;
  var avail = data.available || 0;
  var total = data.total || 0;
  setText('poolActive', inUse);
  setText('poolWaiting', wait);
  setText('poolAvailable', avail);
  setText('poolTotal', total);
  setText('kpiActiveSessions', inUse);
  setText('kpiActiveSessionsSub', 'of ' + total + ' accounts');
  setText('kpiQueue', wait);
  setText('kpiQueueSub', data.waiting == null ? 'unsupported' : 'queued');
  var pct = total > 0 ? Math.min(100, Math.round((inUse / total) * 100)) : 0;
  var bar = document.getElementById('poolBarFill');
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--accent)';
}
/* ── Model Health (no counters in V1) ── */
async function refreshModelHealth() {
  var data = await apiFetch('/metrics/model-health');
  var tbody = document.getElementById('modelBody');
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No model activity recorded</div></td></tr>';
    return;
  }
  var keys = Object.keys(data).sort();
  var rows = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i],
      m = data[k];
    var total = (m.successCount || 0) + (m.errorCount || 0);
    var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
    var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(k) +
      '</td>' +
      '<td>' +
      (m.successCount || 0) +
      '</td>' +
      '<td>' +
      (m.errorCount || 0) +
      '</td>' +
      '<td><span class="badge ' +
      rateClass +
      '">' +
      rate +
      '%</span></td>' +
      '<td>' +
      fmtTime(m.lastActivity) +
      '</td>' +
      '</tr>';
  }
  tbody.innerHTML = rows;
}
/* ── System Logs ──
 * Dedupe by seen-ids dictionary (not string max-comparison): backend ids
 * are sequential `log-N`, where "log-10" <= "log-9" lexicographically and a
 * max-id filter would freeze the panel past 9 entries. The backend ring is
 * capped at 200, so the dict stays bounded by pruning to recent keys.
 */
var _seenSysLogIds = {};
var _seenSysLogOrder = [];
var _seenSysLogCap = 500;
function _markSysLogSeen(id) {
  if (_seenSysLogIds[id]) return;
  _seenSysLogIds[id] = true;
  _seenSysLogOrder.push(id);
  if (_seenSysLogOrder.length > _seenSysLogCap) {
    var drop = _seenSysLogOrder.splice(0, _seenSysLogOrder.length - _seenSysLogCap);
    for (var d = 0; d < drop.length; d++) delete _seenSysLogIds[drop[d]];
  }
}
async function refreshSysLogs() {
  var data = await apiFetch('/system/logs');
  var container = document.getElementById('sysLogsContainer');
  var empty = document.getElementById('sysLogsEmpty');
  if (!data || !Array.isArray(data) || data.length === 0) return;
  empty.style.display = 'none';
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var l = data[i];
    if (!l.id || _seenSysLogIds[l.id]) continue;
    _markSysLogSeen(l.id);
    var lvl = (l.level || 'info').toLowerCase();
    var cls = lvl === 'debug' ? 'log-debug' : lvl === 'warn' || lvl === 'warning' ? 'log-warn' : lvl === 'error' ? 'log-error' : 'log-info';
    html +=
      '<div class="sys-log-entry">' +
      '<span class="sys-log-ts">' +
      fmtTime(l.timestamp) +
      '</span>' +
      '<span class="sys-log-level ' +
      cls +
      '">' +
      escHtml(lvl) +
      '</span>' +
      '<span class="sys-log-cat">' +
      escHtml(l.category || '') +
      '</span>' +
      '<span class="sys-log-msg">' +
      escHtml(l.message || '') +
      '</span>' +
      '</div>';
    if (lvl === 'error' || lvl === 'warn') {
      showNotif(lvl, l.category || '', l.message || '');
    }
  }
  if (!html) return;
  container.insertAdjacentHTML('afterbegin', html);
}
function showNotif(level, category, message) {
  var container = document.getElementById('notifContainer') || document.body;
  var notifs = container.querySelectorAll('.notif');
  while (notifs.length >= 5) {
    notifs[0].remove();
    notifs = container.querySelectorAll('.notif');
  }
  var el = document.createElement('div');
  el.className = 'notif notif-' + level;
  el.innerHTML =
    '<strong>' +
    escHtml(level.toUpperCase()) +
    '</strong>' +
    (category ? ' [' + escHtml(category) + ']' : '') +
    ' ' +
    escHtml(message.length > 120 ? message.substring(0, 120) + '...' : message);
  container.appendChild(el);
  setTimeout(function () {
    if (el.parentNode) el.remove();
  }, 6000);
}
/* ── Init ── */
function init() {
  refreshHealth();
  refreshPool();
  refreshModelHealth();
  refreshSysLogs();
  createPoller(refreshHealth, 2000);
  createPoller(refreshPool, 2000);
  createPoller(refreshSysLogs, 2000);
  createPoller(refreshModelHealth, 3000);
  setInterval(updateUptime, 1000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
