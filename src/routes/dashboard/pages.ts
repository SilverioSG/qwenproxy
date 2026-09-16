/**
 * QwenProxy dashboard pages (V1).
 *
 * Visual/functional source of truth: QwenGate
 * `src/routes/dashboard/` (overview / accounts / monitor / settings).
 * Adapted to QwenProxy native data; Usage and Network pages are deferred
 * to a later version (no real usage history / network capture exists yet,
 * and V1 must not fabricate data).
 *
 * Pages are served unauthenticated (static admin UI); every data endpoint
 * requires verifyApiKey. No secrets are ever injected into the HTML.
 */

interface NavItem {
  id: string;
  label: string;
  href: string;
  svg: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    href: "/dashboard",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  },
  {
    id: "accounts",
    label: "Accounts",
    href: "/dashboard/accounts",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  },
  {
    id: "usage",
    label: "Usage",
    href: "/dashboard/usage",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  },
  {
    id: "network",
    label: "Network",
    href: "/dashboard/network",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  },
  {
    id: "monitor",
    label: "Monitor",
    href: "/dashboard/monitor",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/dashboard/settings",
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  },
];

const LOGO = `<img src="/dashboard/static/logo.svg" width="60" height="60" alt="QwenProxy">`;

export function sidebarHtml(activePageId: string): string {
  const navLinks = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.id === activePageId ? " active" : ""}">${item.svg}<span>${item.label}</span></a>`,
  ).join("\n");

  const dmToggle = `<div class="dm-row">
    <svg id="dmMoon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
    <svg id="dmSun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
    <div class="dm-switch" id="dmSwitch" onclick="toggleDarkMode()">
      <div class="dm-ball" id="dmBall"></div>
    </div>
    <span id="dmLabel">Dark</span>
  </div>`;

  return `<aside class="sidebar">
    <div class="sidebar-header">
      <h1 style="display:flex;align-items:center;gap:8px">
        ${LOGO}
        QwenProxy
      </h1>
    </div>
    <nav class="sidebar-nav">
${navLinks}
    </nav>
    <div class="sidebar-footer" style="display:flex;flex-direction:column;gap:6px">
      ${dmToggle}
      <span class="live-indicator"><span class="live-dot"></span>Live</span>
    </div>
  </aside>`;
}

export const overviewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Dashboard Overview</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/overview.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml("overview")}
  <main class="main-content">
    <div class="page-header">
      <h1>Dashboard Overview</h1>
      <div class="page-header-right">
        <span class="uptime-text">Uptime: <span id="headerUptime">—</span></span>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-left">

        <!-- KPI Grid -->
        <div class="kpi-grid" id="kpiGrid">
          <div class="kpi-card"><span class="kpi-label">Total Accounts</span><span class="kpi-value" id="kpiTotalAccounts">—</span><span class="kpi-sub" id="kpiTotalAccountsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Ready</span><span class="kpi-value" id="kpiAuthenticated">—</span><span class="kpi-sub" id="kpiAuthenticatedSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Active Streams</span><span class="kpi-value" id="kpiActiveSessions">—</span><span class="kpi-sub" id="kpiActiveSessionsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Queued</span><span class="kpi-value" id="kpiQueue">—</span><span class="kpi-sub" id="kpiQueueSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalRequests">—</span><span class="kpi-sub" id="kpiTotalRequestsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Uptime</span><span class="kpi-value" id="kpiUptime">—</span><span class="kpi-sub" id="kpiUptimeSub"></span></div>
        </div>

        <!-- Account Pool -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Account Pool</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="pool-grid" id="poolGrid">
                <div class="pool-stat"><div class="pool-stat-value" id="poolActive">—</div><div class="pool-stat-label">Active</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolAvailable">—</div><div class="pool-stat-label">Available</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolTotal">—</div><div class="pool-stat-label">Total</div></div>
              </div>
              <div class="pool-bar"><div class="pool-bar-fill" id="poolBarFill" style="width:0%"></div></div>
            </div>
          </div>
        </div>

        <!-- Model Health -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Model Health</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="tbl-wrap">
                <table id="modelTable">
                  <thead><tr><th>Model</th><th>Success</th><th>Errors</th><th>Rate</th><th>Last Activity</th></tr></thead>
                  <tbody id="modelBody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

      </div>
      <div class="overview-right">

        <!-- System Logs -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">System Logs</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content" id="sysLogsContainer">
              <div class="empty-state" id="sysLogsEmpty">No system logs yet</div>
            </div>
          </div>
        </div>

      </div>
    </div>
</main>

<div id="notifContainer"></div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/overview.js"></script>
</body>
</html>`;

export const accountsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Accounts</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/accounts.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml("accounts")}
  <main class="main-content">
    <div class="page-header">
      <h1>Accounts</h1>
    </div>

    <!-- Error Display -->
    <div class="error-box" id="errorBox" style="display:none"></div>

    <!-- Add Account Form -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">Add Account</span>
      </div>
      <div class="panel-body open">
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;background:var(--bg-elevated);padding:10px 14px;border-radius:var(--radius-sm)"><strong>Note:</strong> accounts are stored encrypted in the local database. Adding an account does not log it in; warmup/validation happens in the background.</div>
        <form class="account-form" id="addForm">
          <input type="email" class="account-input" id="emailInput" placeholder="Email" required autocomplete="email">
          <input type="password" class="account-input" id="passwordInput" placeholder="Password" required autocomplete="new-password">
          <button type="submit" class="account-btn" id="addBtn">Add Account</button>
        </form>
      </div>
    </div>

    <!-- Accounts Table -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">Accounts</span>
        <span id="acctCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table id="acctTable">
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>Cooldown</th>
                <th>In Flight</th>
                <th>Headers</th>
                <th>Priority</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="acctBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="emptyState">No accounts configured. Add one above.</div>
      </div>
    </div>

  </main>
</div>

<!-- Confirmation Modal -->
<div class="modal-overlay" id="confirmOverlay">
  <div class="modal">
    <h3>Remove Account</h3>
    <p>Are you sure you want to remove <strong id="confirmEmail"></strong>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="confirmNo">Cancel</button>
      <button class="modal-confirm" id="confirmYes">Remove</button>
    </div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toastContainer"></div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/accounts.js"></script>
</body>
</html>`;

export const monitorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Monitor</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/overview.css">
  <link rel="stylesheet" href="/dashboard/static/monitor.css">
</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml("monitor")}
  <main class="main-content">
    <div class="page-header">
      <h1>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Monitor
      </h1>
      <div class="page-header-right">
        <span class="badge badge-accent" id="entryCountBadge">— entries</span>
      </div>
    </div>

    <!-- KPI Grid (V1: global live counters only) -->
    <div class="monitor-kpi-grid" id="kpiGrid">
      <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalReqs">—</span><span class="kpi-sub" id="kpiTotalReqsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Success</span><span class="kpi-value" id="kpiSuccess">—</span><span class="kpi-sub" id="kpiSuccessSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Errors</span><span class="kpi-value" id="kpiErrors">—</span><span class="kpi-sub" id="kpiErrorsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Avg Latency</span><span class="kpi-value" id="kpiAvgLat">—</span><span class="kpi-sub" id="kpiAvgLatSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">P95 Latency</span><span class="kpi-value" id="kpiP95Lat">—</span><span class="kpi-sub" id="kpiP95LatSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Median</span><span class="kpi-value" id="kpiMedianLat">—</span><span class="kpi-sub" id="kpiMedianLatSub"></span></div>
    </div>

    <!-- Mode Comparison (unsupported in V1: no per-mode counters yet) -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Mode Comparison</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="mode-comparison" id="modeComparison">
            <div class="mode-card">
              <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Streaming</h3>
              <div class="mode-stats">
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrReqs">—</div><div class="mode-stat-label">Requests</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrErrors">—</div><div class="mode-stat-label">Errors</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrLat">—</div><div class="mode-stat-label">Avg Latency</div></div>
              </div>
              <div class="mode-bar-row">
                <span class="mode-bar-label">Success</span>
                <div class="mode-bar-track"><div class="mode-bar-fill success" id="modeStrBar" style="width:0%"></div></div>
                <span class="mode-bar-num" id="modeStrPct">0%</span>
              </div>
            </div>
            <div class="mode-card">
              <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/></svg> Non-Streaming</h3>
              <div class="mode-stats">
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsReqs">—</div><div class="mode-stat-label">Requests</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsErrors">—</div><div class="mode-stat-label">Errors</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsLat">—</div><div class="mode-stat-label">Avg Latency</div></div>
              </div>
              <div class="mode-bar-row">
                <span class="mode-bar-label">Success</span>
                <div class="mode-bar-track"><div class="mode-bar-fill success" id="modeNsBar" style="width:0%"></div></div>
                <span class="mode-bar-num" id="modeNsPct">0%</span>
              </div>
            </div>
          </div>
          <div class="empty-state" id="modeUnsupported">Per-mode counters are not collected in V1.</div>
        </div>
      </div>
    </div>

    <!-- Per-Account Monitoring Table (unsupported in V1) -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Per-Account Metrics</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="empty-state" id="emptyMonitor">Per-account history is not collected in V1. See Accounts for live per-account state.</div>
          <div class="tbl-wrap">
            <table id="monitorTable" style="display:none">
              <thead><tr><th>Account</th><th>Total</th><th>Success</th><th>Errors</th><th>Rate</th><th>Avg Lat</th><th>P95</th><th>Median</th><th>Modes</th><th>Recent Errors</th></tr></thead>
              <tbody id="monitorBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Error Summary (unsupported in V1) -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Top Errors</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="empty-state" id="errorSummaryEmpty">No error aggregation in V1.</div>
          <ul id="errorSummaryList" style="display:none"></ul>
        </div>
      </div>
    </div>

    <div class="page-header-right" style="margin-top:12px">
      <span class="badge badge-neutral" id="timeRange">Live counters since boot (global only)</span>
    </div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/monitor.js"></script>
</body>
</html>`;

export const settingsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Settings</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/settings.css">
</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml("settings")}
  <main class="main-content">

<div class="settings-header">
  <h1>Settings <span class="badge badge-neutral">read-only</span></h1>
</div>

<div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;background:var(--bg-elevated);padding:10px 14px;border-radius:var(--radius-sm)">Configuration is managed via <strong>.env</strong> and requires a restart. The API key is never displayed here.</div>

<div class="settings-sections" id="settingsSections"></div>
<div id="settingsMessage"></div>

<div class="toast-container" id="toastContainer"></div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/settings.js"></script>
</body>
</html>`;

export const usageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Usage</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/overview.css">
<link rel="stylesheet" href="/dashboard/static/usage.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml("usage")}
  <main class="main-content">
    <div class="page-header">
      <h1>Usage</h1>
      <div class="page-header-right">
        <span class="uptime-text" id="dataWindow">Requests per account × model, since process start</span>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="kpi-grid" id="kpiGrid">
      <div class="kpi-card"><span class="kpi-label">Requests</span><span class="kpi-value" id="kpiToday">—</span><span class="kpi-sub" id="kpiTodaySub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Success</span><span class="kpi-value" id="kpiWeek">—</span><span class="kpi-sub" id="kpiWeekSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Active Accounts</span><span class="kpi-value" id="kpiAccounts">—</span><span class="kpi-sub" id="kpiAccountsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Errors</span><span class="kpi-value" id="kpiWalls">—</span><span class="kpi-sub" id="kpiWallsSub"></span></div>
    </div>

    <!-- Per-account table -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Per-Account Breakdown</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="tbl-wrap">
            <table id="usageTable">
              <thead>
                <tr>
                  <th>Account</th>
                  <th class="num">Requests</th>
                  <th class="num">Success</th>
                  <th class="num">Errors</th>
                  <th>Per-Model</th>
                </tr>
              </thead>
              <tbody id="usageBody"></tbody>
            </table>
          </div>
          <div class="empty-state" id="emptyState" style="display:none">No usage recorded yet — send a few requests and this fills up.</div>
        </div>
      </div>
    </div>

    <!-- Per-model totals -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Model Totals</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="tbl-wrap">
            <table id="modelTable">
              <thead>
                <tr>
                  <th>Model</th>
                  <th class="num">Requests</th>
                  <th class="num">Success</th>
                  <th class="num">Errors</th>
                  <th>Last Activity</th>
                </tr>
              </thead>
              <tbody id="modelBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>

<script src="/dashboard/static/shared.js"></script>
<script src="/dashboard/static/usage.js"></script>
</body>
</html>`;

export const networkHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QwenProxy — Network</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/network.css">
</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml("network")}
  <main class="main-content">

<div class="page-header">
  <h1>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
    Network
    <span class="count-badge" id="entryCount">0</span>
  </h1>
  <div class="page-header-right">
    <span class="uptime-text">Last 200 HTTP requests (in-memory)</span>
  </div>
</div>

<div class="controls">
  <label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500">Filter</label>
  <select class="filter-select" id="methodFilter" onchange="onFilterChange()">
    <option value="">All Methods</option>
    <option value="GET">GET</option>
    <option value="POST">POST</option>
    <option value="PUT">PUT</option>
    <option value="PATCH">PATCH</option>
    <option value="DELETE">DELETE</option>
  </select>
  <select class="filter-select" id="statusFilter" onchange="onFilterChange()">
    <option value="">All Status</option>
    <option value="2xx">2xx Success</option>
    <option value="4xx">4xx Client Error</option>
    <option value="5xx">5xx Server Error</option>
  </select>
  <select class="filter-select" id="categoryFilter" onchange="onFilterChange()">
    <option value="">All Routes</option>
    <option value="Chat">Chat</option>
    <option value="Responses">Responses</option>
    <option value="Anthropic">Anthropic</option>
    <option value="completions">Completions</option>
    <option value="media">Media</option>
    <option value="models">Models</option>
    <option value="dashboard">Dashboard</option>
    <option value="system">System</option>
    <option value="other">Other</option>
  </select>
  <span class="entry-count" id="filteredCount"></span>
</div>

<div class="net-container" id="netContainer">
  <div class="empty-state" id="netEmpty" style="display:none">No network entries recorded yet</div>
  <div class="error-state" id="netError" style="display:none"></div>
</div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/network.js"></script>
</body>
</html>`;
