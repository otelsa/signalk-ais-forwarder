const STATUS_URL = '/plugins/signalk-ais-forwarder/status'
const REFRESH_MS = 5000

const kpisEl = document.querySelector('#kpis')
const statusPillEl = document.querySelector('#status-pill')
const statusTextEl = document.querySelector('#status-text')
const endpointsBodyEl = document.querySelector('#endpoints-body')
const endpointsEmptyEl = document.querySelector('#endpoints-empty')
const targetsBodyEl = document.querySelector('#targets-body')
const targetsEmptyEl = document.querySelector('#targets-empty')
const logEl = document.querySelector('#log')
const refreshEl = document.querySelector('#refresh')

refreshEl.addEventListener('click', () => refresh())

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c]
  )
}

function ageText(seconds) {
  if (seconds === null || seconds === undefined) return '--'
  if (seconds < 60) return `vor ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `vor ${minutes}m`
  const hours = Math.round(minutes / 60)
  return `vor ${hours}h`
}

function ageFromTimestamp(ms) {
  if (!ms) return null
  return Math.round((Date.now() - ms) / 1000)
}

function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function kpi(label, value, sub) {
  return `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>
  `
}

function renderKpis(s) {
  kpisEl.innerHTML = [
    kpi(
      'Aktive Ziele',
      s.targetsTracked,
      `${s.targetsSeenTotal} insgesamt seit Start`
    ),
    kpi(
      'Nachrichten/Min',
      s.messagesSentLastMinute,
      `${s.messagesSentTotal} gesamt`
    ),
    kpi('Letzte Übertragung', ageText(s.lastForwardAgeSeconds)),
    kpi(
      'Endpunkte',
      s.endpoints.length,
      s.endpoints.some((e) => e.lastError) ? 'mit Fehlern' : 'ok'
    ),
    kpi('Laufzeit', fmtUptime(s.uptimeSeconds))
  ].join('')
}

function renderStatusPill(s) {
  let cls = 'ok',
    text = 'läuft'
  if (!s.enabled) {
    cls = 'bad'
    text = 'gestoppt'
  } else if (s.endpoints.length === 0) {
    cls = 'warn'
    text = 'keine Endpunkte'
  } else if (s.endpoints.some((e) => e.lastError)) {
    cls = 'warn'
    text = 'läuft, mit Fehlern'
  }
  statusPillEl.className = `status-pill ${cls}`
  statusTextEl.textContent = text
}

function renderEndpoints(s) {
  endpointsEmptyEl.hidden = s.endpoints.length > 0
  endpointsBodyEl.innerHTML = s.endpoints
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.ipaddress)}:${e.port}</td>
        <td>${e.messagesSent}</td>
        <td>${e.bytesSent}</td>
        <td>${ageText(ageFromTimestamp(e.lastSendAt))}</td>
        <td class="${e.lastError ? 'error-text' : ''}">${e.lastError ? escapeHtml(e.lastError) : '--'}</td>
      </tr>
    `
    )
    .join('')
}

function renderTargets(s) {
  targetsEmptyEl.hidden = s.targets.length > 0
  targetsBodyEl.innerHTML = s.targets
    .map(
      (t) => `
      <tr>
        <td class="mono">${escapeHtml(t.mmsi)}</td>
        <td>${t.name ? escapeHtml(t.name) : '--'}</td>
        <td><span class="class-badge ${t.aisClass.toLowerCase()}">${t.aisClass}</span></td>
        <td>${ageText(ageFromTimestamp(t.lastSeenAt))}</td>
        <td>${ageText(ageFromTimestamp(t.lastForwardAt))}</td>
      </tr>
    `
    )
    .join('')
}

function renderLog(s) {
  if (s.recentMessages.length === 0) {
    logEl.innerHTML = `<div class="panel-empty">Noch keine Nachrichten gesendet.</div>`
    return
  }
  logEl.innerHTML = s.recentMessages
    .map(
      (m) =>
        `<div><span class="at">${new Date(m.at).toLocaleTimeString('de-DE')}</span>${escapeHtml(m.nmea)}</div>`
    )
    .join('')
}

function renderError(message) {
  statusPillEl.className = 'status-pill bad'
  statusTextEl.textContent = 'nicht erreichbar'
  kpisEl.innerHTML = `<div class="panel-empty">Status konnte nicht geladen werden: ${escapeHtml(message)}</div>`
}

async function refresh() {
  refreshEl.disabled = true
  try {
    const response = await fetch(STATUS_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const s = await response.json()
    renderStatusPill(s)
    renderKpis(s)
    renderEndpoints(s)
    renderTargets(s)
    renderLog(s)
  } catch (err) {
    renderError(err.message || String(err))
  } finally {
    refreshEl.disabled = false
  }
}

refresh()
setInterval(refresh, REFRESH_MS)
