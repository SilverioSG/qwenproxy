/* QwenProxy dashboard monitor page.
 * Based on QwenGate public/monitor.js. V1 serves global live counters only:
 * - KPIs render real totals (requests.total / requests.errors / avg latency).
 * - p95 / median are null in V1 (no percentile collection) → "—".
 * - Mode comparison, per-account table and top-errors need per-request
 *   instrumentation that does not exist yet — the static unsupported
 *   notices in monitorHtml stay visible; this script only fills what
 *   the adapter really provides.
 */

/* Format milliseconds for display */
function fmtLatency(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}

function fmtNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function pctClass(rate) {
  if (rate == null) return 'badge-neutral';
  if (rate >= 95) return 'badge-success';
  if (rate >= 80) return 'badge-warning';
  return 'badge-danger';
}

function latencyClass(ms) {
  if (ms == null) return '';
  if (ms < 2000) return 'badge-success';
  if (ms < 5000) return 'badge-warning';
  return 'badge-danger';
}

/* ── Main render (global counters only) ── */
async function refreshMonitor() {
  var data = await apiFetch('/metrics/monitor');
  if (!data) return;

  // ── KPI Row ──
  var t = data.totals || {};
  setText('kpiTotalReqs', fmtNumber(t.totalRequests));
  setText('kpiTotalReqsSub', (t.totalRequests || 0) + ' total');
  setText('kpiSuccess', fmtNumber(t.totalSuccess));
  setText('kpiSuccessSub', t.totalRequests > 0 ? Math.round((t.totalSuccess / t.totalRequests) * 100) + '% rate' : '');
  setText('kpiErrors', fmtNumber(t.totalErrors));
  setText('kpiErrorsSub', (t.overallErrorRate != null ? t.overallErrorRate : '—') + '% err rate');
  setText('kpiAvgLat', fmtLatency(t.overallAvgLatencyMs));
  setText('kpiAvgLatSub', t.overallAvgLatencyMs != null ? 'avg response time' : 'not collected');
  setText('kpiP95Lat', fmtLatency(t.p95LatencyMs));
  setText('kpiP95LatSub', t.p95LatencyMs != null ? '95th percentile' : 'not collected in V1');
  setText('kpiMedianLat', fmtLatency(t.medianLatencyMs));
  setText('kpiMedianLatSub', t.medianLatencyMs != null ? 'median' : 'not collected in V1');

  // Entry count badge
  var entryBadge = document.getElementById('entryCountBadge');
  if (entryBadge) {
    entryBadge.textContent = fmtNumber(data.totalEntries) + ' entries';
    entryBadge.className = 'badge ' + (t.totalErrors > 0 ? 'badge-warning' : 'badge-accent');
  }

  // ── Data window label (honest scope: ring, not process lifetime) ──
  var timeEl = document.getElementById('timeRange');
  if (timeEl) {
    var windowLabel =
      (data.capabilities && data.capabilities.window) ||
      'Last 1000 logical AI requests';
    if (data.timeRange && data.timeRange.from && data.timeRange.to) {
      timeEl.textContent =
        windowLabel +
        ' · ' +
        fmtTime(data.timeRange.from) +
        ' to ' +
        fmtTime(data.timeRange.to);
    } else {
      timeEl.textContent = windowLabel;
    }
  }

  // ── Mode Comparison (only if the adapter provides it) ──
  var mc = data.modeComparison || {};
  if (mc.streaming || mc.nonStreaming) {
    renderModeSide('Str', mc.streaming);
    renderModeSide('Ns', mc.nonStreaming);
    var note = document.getElementById('modeUnsupported');
    if (note) note.style.display = 'none';
  }

  // ── Per-Account Table (only if the adapter provides rows) ──
  var accts = data.accounts || [];
  if (accts.length > 0) {
    var emptyEl = document.getElementById('emptyMonitor');
    var tableEl = document.getElementById('monitorTable');
    if (emptyEl) emptyEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';
    renderAccountRows(accts);
  }

  // ── Error Summary (only if the adapter provides it) ──
  if (data.topErrors && data.topErrors.length > 0) {
    renderErrorSummary(data.topErrors);
  }
}

function renderAccountRows(accts) {
  var tbodyEl = document.getElementById('monitorBody');
  if (!tbodyEl) return;
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var rate = a.successCount && a.totalRequests ? Math.round((a.successCount / a.totalRequests) * 100) : 0;
    var modeHtml = '';
    if (a.byMode && a.byMode.streaming) {
      modeHtml += '<span class="mode-badge str">S ' + a.byMode.streaming.totalRequests + '</span>';
    }
    if (a.byMode && a.byMode.nonStreaming) {
      modeHtml += '<span class="mode-badge nonstr">NS ' + a.byMode.nonStreaming.totalRequests + '</span>';
    }
    if (!modeHtml) modeHtml = '—';
    var errHtml = '';
    if (a.recentErrors && a.recentErrors.length > 0) {
      var shown = a.recentErrors.slice(0, 3);
      for (var j = 0; j < shown.length; j++) {
        var err = shown[j];
        errHtml +=
          '<div style="font-size:0.65rem;color:var(--danger);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px" title="' +
          escHtml(err) +
          '">• ' +
          escHtml(err.length > 60 ? err.substring(0, 60) + '...' : err) +
          '</div>';
      }
      if (a.recentErrors.length > 3) {
        errHtml += '<div style="font-size:0.6rem;color:var(--text-secondary)">+' + (a.recentErrors.length - 3) + ' more</div>';
      }
    } else {
      errHtml = '<span style="color:var(--success);font-size:0.7rem">None</span>';
    }
    var avgLatClass = latencyClass(a.avgLatencyMs);
    var p95Class = latencyClass(a.p95LatencyMs);
    var medClass = latencyClass(a.medianLatencyMs);
    rows +=
      '<tr>' +
      '<td class="email-cell mono" title="' +
      escHtml(a.email) +
      '">' +
      escHtml(a.email) +
      '</td>' +
      '<td class="mono">' +
      a.totalRequests +
      '</td>' +
      '<td class="mono" style="color:var(--success)">' +
      a.successCount +
      '</td>' +
      '<td class="mono" style="color:' +
      (a.errorCount > 0 ? 'var(--danger)' : '') +
      '">' +
      a.errorCount +
      '</td>' +
      '<td><span class="badge ' +
      pctClass(rate) +
      '">' +
      rate +
      '%</span></td>' +
      '<td class="mono"><span class="badge ' +
      avgLatClass +
      '">' +
      fmtLatency(a.avgLatencyMs) +
      '</span></td>' +
      '<td class="mono"><span class="badge ' +
      p95Class +
      '">' +
      fmtLatency(a.p95LatencyMs) +
      '</span></td>' +
      '<td class="mono"><span class="badge ' +
      medClass +
      '">' +
      fmtLatency(a.medianLatencyMs) +
      '</span></td>' +
      '<td class="mode-cell">' +
      modeHtml +
      '</td>' +
      '<td>' +
      errHtml +
      '</td>' +
      '</tr>';
  }
  tbodyEl.innerHTML = rows;
}

function renderModeSide(suffix, mode) {
  if (!mode) {
    setText('mode' + suffix + 'Reqs', '0');
    setText('mode' + suffix + 'Errors', '0');
    setText('mode' + suffix + 'Lat', '—');
    document.getElementById('mode' + suffix + 'Bar').style.width = '0%';
    setText('mode' + suffix + 'Pct', '0%');
    return;
  }
  setText('mode' + suffix + 'Reqs', fmtNumber(mode.totalRequests));
  setText('mode' + suffix + 'Errors', mode.errorCount || 0);
  setText('mode' + suffix + 'Lat', fmtLatency(mode.avgLatencyMs));

  var pct = mode.totalRequests > 0 ? Math.round(((mode.totalRequests - (mode.errorCount || 0)) / mode.totalRequests) * 100) : 0;
  var bar = document.getElementById('mode' + suffix + 'Bar');
  bar.style.width = pct + '%';
  bar.style.background = pct >= 90 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--danger)';
  setText('mode' + suffix + 'Pct', pct + '%');
}

function renderErrorSummary(errors) {
  var emptyEl = document.getElementById('errorSummaryEmpty');
  var listEl = document.getElementById('errorSummaryList');

  if (!errors || errors.length === 0) {
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (listEl) listEl.style.display = '';

  var html = '';
  for (var i = 0; i < errors.length; i++) {
    var e = errors[i];
    var badgeCls = e.count > 5 ? 'badge-danger' : e.count > 2 ? 'badge-warning' : 'badge-neutral';
    html +=
      '<li class="error-item">' +
      '<span class="badge ' +
      badgeCls +
      '" style="font-size:0.72rem;min-width:30px;text-align:center">' +
      e.count +
      '</span>' +
      '<span class="error-msg">' +
      escHtml(e.message) +
      '</span>' +
      '</li>';
  }
  listEl.innerHTML = html;
}

/* ── Init ── */
function init() {
  refreshMonitor();
  createPoller(refreshMonitor, 4000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
