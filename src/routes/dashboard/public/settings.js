/* QwenProxy dashboard settings page (V1: read-only).
 * QwenProxy configuration lives in .env / environment and is parsed at
 * import time (zod) — there is no safe runtime PUT in V1, so this page
 * renders the safe subset exposed by GET /api/config and makes every
 * field read-only. Never displays secrets (the adapter only sends
 * `apiKeyConfigured: true/false`).
 */

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

var SETTINGS_SECTIONS = [
  {
    title: 'Server',
    desc: 'Host, port and API-key status. Managed via .env.',
    fields: [
      { key: 'PORT', label: 'PORT' },
      { key: 'HOST', label: 'HOST' },
      { key: 'apiKeyConfigured', label: 'API_KEY configured' },
    ],
  },
  {
    title: 'Upstream',
    desc: 'Qwen upstream base URL, chat mode and warmup pool.',
    fields: [
      { key: 'QWEN_BASE_URL', label: 'QWEN_BASE_URL' },
      { key: 'QWEN_CHAT_MODE', label: 'QWEN_CHAT_MODE' },
      { key: 'QWEN_CHAT_POOL_SIZE', label: 'QWEN_CHAT_POOL_SIZE' },
    ],
  },
  {
    title: 'Concurrency',
    desc: 'Per-account stream slots.',
    fields: [{ key: 'ACCOUNT_MAX_CONCURRENT_STREAMS', label: 'ACCOUNT_MAX_CONCURRENT_STREAMS' }],
  },
];

/* ── Render (read-only) ── */
function renderSettingsForm(data) {
  var container = document.getElementById('settingsSections');
  var html = '';
  for (var s = 0; s < SETTINGS_SECTIONS.length; s++) {
    var section = SETTINGS_SECTIONS[s];
    html +=
      '<fieldset class="settings-section">' +
      '<div class="settings-section-title">' +
      escHtml(section.title) +
      '</div>' +
      '<p class="settings-section-desc">' +
      escHtml(section.desc) +
      '</p>' +
      '<div class="settings-fields">';
    for (var f = 0; f < section.fields.length; f++) {
      var field = section.fields[f];
      var val = data && data[field.key] !== undefined ? String(data[field.key]) : '—';
      html +=
        '<label class="settings-field">' +
        '<span class="settings-label">' +
        escHtml(field.label) +
        '</span>' +
        '<input class="settings-input" type="text" value="' +
        escHtml(val) +
        '" disabled readonly>' +
        '</label>';
    }
    html += '</div></fieldset>';
  }
  container.innerHTML = html;
}

async function loadSettings() {
  var data = await apiFetch('/api/config');
  if (!data) {
    var msg = document.getElementById('settingsMessage');
    if (msg) msg.textContent = 'Could not load configuration (unauthorized or unavailable).';
    return;
  }
  renderSettingsForm(data);
}

/* ── Init ── */
function init() {
  loadSettings();
  createPoller(loadSettings, 15000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
