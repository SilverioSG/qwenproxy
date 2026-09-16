/* QwenProxy dashboard shared helpers.
 * Based on QwenGate public/shared.js. Differences (deliberate):
 * - No window.API_KEY: the key lives in sessionStorage and is only sent as
 *   Authorization: Bearer on data fetches (DeepSeek-Gate adapter pattern).
 * - 401 triggers a minimal key prompt with retry (same pattern).
 * - Dark mode is a local preference (localStorage); QwenProxy has no
 *   server-side DARK_MODE / config PUT in V1.
 */
/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
var DASHBOARD_KEY_NAME = 'qwenproxyApiKey';
function authHeaders() {
  try {
    var apiKey = window.sessionStorage.getItem(DASHBOARD_KEY_NAME) || '';
    return apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
  } catch {
    return {};
  }
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(),
    m = d.getMinutes(),
    s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0 || s > 0) parts.push(s + 's');
  return parts.join(' ');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}
async function apiFetch(url, options) {
  try {
    var init = { headers: authHeaders() };
    if (options && options.method) {
      init.method = options.method;
      init.headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders());
      if (options.body !== undefined) init.body = options.body;
    }
    var res = await fetch(url, init);
    if (res.status === 401) {
      var apiKey = window.prompt('Dashboard API key');
      if (!apiKey) return null;
      try {
        window.sessionStorage.setItem(DASHBOARD_KEY_NAME, apiKey);
      } catch {
        return null;
      }
      init.headers = init.method
        ? Object.assign({ 'Content-Type': 'application/json' }, authHeaders())
        : authHeaders();
      res = await fetch(url, init);
    }
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function createPoller(fn, baseInterval) {
  var timer = null,
    failures = 0,
    running = false;
  function tick() {
    if (!running) return;
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        r.then(
          function () {
            failures = 0;
            schedule();
          },
          function () {
            failures++;
            schedule();
          },
        );
        return;
      }
      failures = 0;
    } catch {
      failures++;
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    var delay = Math.min(baseInterval * Math.pow(2, Math.min(failures, 3)), baseInterval * 8);
    timer = setTimeout(tick, delay);
  }
  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function start() {
    if (!running) {
      running = true;
      failures = 0;
      tick();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  start();
  return { start: start, stop: stop };
}

/* ── Dark Mode (local preference only in V1) ── */
function applyDarkMode(enabled) {
  var html = document.documentElement;
  var label = document.getElementById('dmLabel');
  var sw = document.getElementById('dmSwitch');
  var moon = document.getElementById('dmMoon');
  var sun = document.getElementById('dmSun');
  if (enabled) {
    html.classList.add('dark-mode');
    if (label) label.textContent = 'Dark';
    if (moon) moon.style.display = '';
    if (sun) sun.style.display = 'none';
    if (sw) sw.classList.add('active');
  } else {
    html.classList.remove('dark-mode');
    if (label) label.textContent = 'Light';
    if (moon) moon.style.display = 'none';
    if (sun) sun.style.display = '';
    if (sw) sw.classList.remove('active');
  }
}

function loadDarkModePref() {
  try {
    var v = window.localStorage.getItem('qwenproxyDarkMode');
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    /* ignore */
  }
  return typeof window.DARK_MODE !== 'undefined' ? !!window.DARK_MODE : false;
}

function toggleDarkMode() {
  var next = !document.documentElement.classList.contains('dark-mode');
  applyDarkMode(next);
  try {
    window.localStorage.setItem('qwenproxyDarkMode', String(next));
  } catch {
    /* ignore */
  }
}

/* Apply dark mode on load */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    applyDarkMode(loadDarkModePref());
  });
} else {
  applyDarkMode(loadDarkModePref());
}
