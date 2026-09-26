/* QwenProxy dashboard accounts page.
 * Layout/styling follow QwenGate public/accounts.js. Rewritten for real
 * QwenProxy data — no invented fields:
 * - No token TTL (no legacy JWT semantics), no throttle badges, no
 *   enable/disable toggle (no native `disabled` flag), no browser
 *   screencast login, no password retrieval.
 * - Actions map 1:1 to native business logic:
 *   POST /v1/accounts (addAccount), DELETE /v1/accounts/:id (removeAccount),
 *   POST /v1/accounts/:id/reset-cooldown (clearAccountCooldown).
 */

function fmtCooldown(ms) {
  if (ms == null || ms < 0) return '—';
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  s %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

/* ── Accounts Table (real QwenProxy fields) ── */
function getStatus(acct) {
  if (acct.cooldown) return 'cooldown';
  if (acct.ready) return 'live';
  if (acct.hasActiveContext && !acct.headersReady) return 'warming';
  return 'standby';
}

function getStatusLabel(status) {
  if (status === 'live') return 'Ready';
  if (status === 'cooldown') return 'Cooldown';
  if (status === 'warming') return 'Warming';
  return 'Standby';
}

function makeCooldownBadge(acct) {
  if (acct.cooldown) {
    var label = 'Cooldown';
    if (acct.cooldown_reason) label += ' · ' + acct.cooldown_reason;
    if (acct.cooldown_remaining_ms != null) label += ' · ' + fmtCooldown(acct.cooldown_remaining_ms);
    return '<span class="badge badge-warning">' + escHtml(label) + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var status = getStatus(a);
    var label = getStatusLabel(status);
    var headers = a.headersReady
      ? '<span class="badge badge-success">ready</span>'
      : a.hasActiveContext
        ? '<span class="badge badge-neutral">warming</span>'
        : '<span class="badge badge-neutral">standby</span>';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(a.email) +
      '</td>' +
      '<td><div class="auth-status"><span class="auth-dot ' +
      status +
      '"></span>' +
      label +
      '</div></td>' +
      '<td>' +
      makeCooldownBadge(a) +
      '</td>' +
      '<td>' +
      (a.inFlight || 0) +
      '</td>' +
      '<td>' +
      headers +
      '</td>' +
      '<td style="font-family:var(--mono);font-size:0.75rem">' +
      (a.priority != null ? escHtml(String(a.priority)) : '—') +
      '</td>' +
      '<td><div class="action-cell">' +
      '<button class="account-btn small" data-id="' +
      escHtml(a.id) +
      '" data-action="reset">Reset cooldown</button>' +
      '<button class="account-btn small" data-id="' +
      escHtml(a.id) +
      '" data-action="verify">Verify manually</button>' +
      '<button class="account-btn small danger" data-id="' +
      escHtml(a.id) +
      '" data-email="' +
      escHtml(a.email) +
      '" data-action="remove">Remove</button>' +
      '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
}

/* ── Add Account (native addAccount) ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function () {
    try {
      var res = await fetch('/v1/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error ? result.error : 'Failed to add account (' + res.status + ')',
        );
      }
      showToast('Account added: ' + email, 'success');
      document.getElementById('addForm').reset();
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Account';
    }
  })();
}

/* ── Reset cooldown (native clearAccountCooldown) ── */
async function handleResetCooldown(id, email) {
  setError(null);
  try {
    var res = await fetch('/v1/accounts/' + encodeURIComponent(id) + '/reset-cooldown', {
      method: 'POST',
      headers: authHeaders(),
    });
    var result;
    try {
      result = await res.json();
    } catch {
      result = null;
    }
    if (!res.ok) {
      throw new Error(result && result.error ? result.error : 'Failed to reset cooldown (' + res.status + ')');
    }
    showToast('Cooldown cleared: ' + email, 'success');
    loadAccounts();
  } catch (e) {
    setError(e.message);
    showToast(e.message, 'error');
  }
}

/* ── Remove Account (native removeAccount) ── */
async function handleVerifyManually(id, btn) {
  setError(null);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening…';
  }
  try {
    var res = await fetch('/v1/accounts/' + encodeURIComponent(id) + '/manual-verification/start', {
      method: 'POST',
      headers: authHeaders(),
    });
    var result;
    try {
      result = await res.json();
    } catch {
      result = null;
    }
    if (!res.ok) {
      throw new Error(result && result.error ? result.error : 'Failed to start verification (' + res.status + ')');
    }
    showToast('Visible browser opened. Complete login manually, then wait for validation.', 'info');
    pollVerifyStatus(id, btn);
  } catch (e) {
    setError(e.message);
    showToast(e.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Verify manually';
    }
  }
}

async function pollVerifyStatus(id, btn) {
  for (var i = 0; i < 200; i++) {
    await new Promise(function (r) { setTimeout(r, 3000); });
    var res;
    try {
      res = await fetch('/v1/accounts/' + encodeURIComponent(id) + '/manual-verification/status', {
        headers: authHeaders(),
      });
      var st = await res.json();
    } catch {
      continue;
    }
    var state = st && st.state;
    if (btn) {
      if (state === 'waiting') btn.textContent = 'Waiting — send a test message in Qwen…';
      else if (state === 'authenticated') btn.textContent = 'Authenticated — send a test message…';
      else if (state === 'verifying') btn.textContent = 'Chat detected — verifying…';
      else if (state === 'opening') btn.textContent = 'Opening…';
    }
    if (state === 'verified') {
      showToast('Account verified and ready.', 'success');
      break;
    }
    if (state === 'failed' || state === 'cancelled') {
      showToast('Verification ' + state + (st.detail ? ': ' + st.detail : ''), state === 'cancelled' ? 'info' : 'error');
      break;
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Verify manually';
  }
  loadAccounts();
}

function handleRemove(id, email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/v1/accounts/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(result && result.error ? result.error : 'Failed to remove account (' + res.status + ')');
      }
      showToast('Account removed: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function () {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Init ── */
function init() {
  var form = document.getElementById('addForm');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) return;
    handleAdd(email, password);
  });
  document.getElementById('acctTable').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    var email = btn.getAttribute('data-email') || '';
    if (action === 'reset') handleResetCooldown(id, email || id);
    else if (action === 'remove') handleRemove(id, email || id);
    else if (action === 'verify') handleVerifyManually(id, btn);
  });
  loadAccounts();
  createPoller(loadAccounts, 3000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
