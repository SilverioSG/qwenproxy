/* QwenProxy dashboard usage page.
 * Layout follows QwenGate public/usage.js + usage.html. Honest adaptation:
 * QwenProxy keeps no daily history — the window is "since process start"
 * (in-memory ring). No today/yesterday/7-days, no rate-limit walls, no
 * daily budgets are shown or implied.
 */

function fmtNum(n) {
  return (n == null ? 0 : n).toLocaleString('en-US');
}

function fmtLatency(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function renderWindow(data) {
  var w = (data && data.window) || {};
  var label = w.label || 'since process start (in-memory)';
  var since = w.since ? fmtTime(w.since) : '';
  setText('dataWindow', 'Requests per account × model, ' + label + (since ? ' · since ' + since : ''));
}

function renderKpis(data) {
  var t = (data && data.totals) || {};
  var accounts = (data && data.accounts) || [];
  setText('kpiToday', fmtNum(t.totalRequests));
  setText('kpiTodaySub', fmtNum(t.totalRequests) + ' requests in window');
  setText('kpiWeek', fmtNum(t.successCount));
  setText('kpiWeekSub', t.totalRequests > 0 ? Math.round((t.successCount / t.totalRequests) * 100) + '% success' : '');
  setText('kpiAccounts', fmtNum(accounts.length));
  setText('kpiAccountsSub', 'accounts with activity');
  setText('kpiWalls', fmtNum(t.errorCount));
  setText('kpiWallsSub', t.totalRequests > 0 ? Math.round((t.errorCount / t.totalRequests) * 100) + '% errors' : 'no errors');
}

function renderAccountRows(data) {
  var accounts = (data && data.accounts) || [];
  var modelsByAccount = {};
  var allModels = (data && data.models) || [];
  if (accounts.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('usageBody').innerHTML = '';
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  void modelsByAccount;
  void allModels;
  var rows = accounts
    .map(function (a) {
      var chips = '';
      var perModel = a.perModel || [];
      if (perModel.length > 0) {
        chips = perModel
          .map(function (m) {
            return '<span class="model-chip">' + escHtml(m.model) + ' <b>' + fmtNum(m.requests) + '</b></span>';
          })
          .join('');
      } else {
        chips = '<span style="color:var(--text-secondary);font-size:0.75rem">—</span>';
      }
      return (
        '<tr>' +
        '<td>' +
        escHtml(a.email || a.accountId) +
        '</td>' +
        '<td class="num">' +
        fmtNum(a.totalRequests) +
        '</td>' +
        '<td class="num" style="color:var(--success)">' +
        fmtNum(a.successCount) +
        '</td>' +
        '<td class="num" style="color:' +
        (a.errorCount > 0 ? 'var(--danger)' : 'inherit') +
        '">' +
        fmtNum(a.errorCount) +
        '</td>' +
        '<td>' +
        chips +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  document.getElementById('usageBody').innerHTML = rows;
}

function renderModelRows(data) {
  var models = (data && data.models) || [];
  var tbody = document.getElementById('modelBody');
  if (!tbody) return;
  if (models.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No model activity in window</div></td></tr>';
    return;
  }
  tbody.innerHTML = models
    .map(function (m) {
      var total = m.totalRequests || 0;
      var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
      var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
      return (
        '<tr>' +
        '<td>' +
        escHtml(m.model) +
        '</td>' +
        '<td class="num">' +
        fmtNum(m.totalRequests) +
        '</td>' +
        '<td class="num" style="color:var(--success)">' +
        fmtNum(m.successCount) +
        '</td>' +
        '<td class="num" style="color:' +
        (m.errorCount > 0 ? 'var(--danger)' : 'inherit') +
        '">' +
        fmtNum(m.errorCount) +
        '</td>' +
        '<td>' +
        fmtTime(m.lastActivity) +
        ' <span class="badge ' +
        rateClass +
        '">' +
        rate +
        '%</span>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
}

async function refreshUsage() {
  var data = await apiFetch('/api/usage');
  if (!data) return;
  renderWindow(data);
  renderKpis(data);
  renderAccountRows(data);
  renderModelRows(data);
}

function init() {
  refreshUsage();
  createPoller(refreshUsage, 5000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
