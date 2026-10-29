/* eslint-disable -- maquette statique hors application, scripts navigateur à globaux partagés */
// Morceaux communs des maquettes (barre d'outils, canvas d'un lab, barre d'état).
const b = (id, on) => `<span class="btn ${on ? 'on' : ''}" title="${id}">${ic('t-' + id, 'i16')}</span>`
window.toolbar =
  () => `<div class="tb" role="toolbar">${b('new')}${b('open')}${b('save')}<span class="sep"></span>${b('undo')}${b('redo')}<span class="sep"></span>${b('select', 1)}${b('cable')}${b('pdu')}${b('delete')}${b('note')}<span class="sep"></span>${b('zout')}<span class="mono" style="font-size:11px;color:var(--sl-fg-muted);width:40px;text-align:center">100 %</span>${b('zin')}${b('fit')}
<div class="seg" role="radiogroup"><span>◷ Temps réel</span><span class="on">▸ Simulation</span></div></div>`
const N = [
  ['DC01', 'server', '192.168.10.10', 'ok', 120, 90, 1],
  ['SRV-LNX', 'linux-server', '192.168.10.20', 'warn', 120, 250],
  ['RTR-1921', 'router', '192.168.10.254', 'ok', 380, 170, 0, 1],
  ['SW-2960', 'switch', '—', 'ok', 380, 330, 0, 1],
  ['PC-01', 'client', '192.168.20.11', 'ok', 600, 280],
  ['PC-LNX', 'linux', 'APIPA 169.254.3.7', 'down', 600, 420],
  ['PFSENSE', 'firewall', '203.0.113.2', 'idle', 580, 70],
  ['Internet', 'cloud', '', 'ok', 780, 70]
]
window.canvas = (extra = '') => {
  const pos = Object.fromEntries(N.map((n) => [n[0], [n[4] + 32, n[5] + 32]]))
  const L = [
    ['DC01', 'RTR-1921', 'ok'],
    ['SRV-LNX', 'RTR-1921', 'ok'],
    ['RTR-1921', 'SW-2960', 'ok'],
    ['SW-2960', 'PC-01', 'ok'],
    ['SW-2960', 'PC-LNX', 'down'],
    ['RTR-1921', 'PFSENSE', 'ok'],
    ['PFSENSE', 'Internet', 'ok']
  ]
  const wires = L.map(([a, c, s]) => {
    const [x1, y1] = pos[a],
      [x2, y2] = pos[c],
      d = Math.hypot(x2 - x1, y2 - y1),
      ux = (x2 - x1) / d,
      uy = (y2 - y1) / d
    const led = (x, y) => `<use href="#l-${s}" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${s === 'down' ? 'var(--sl-danger)' : 'var(--sl-fg-subtle)'}" stroke-width="2" ${s === 'down' ? 'stroke-dasharray="5 4"' : ''}/>${led(x1 + ux * 46, y1 + uy * 46)}${led(x2 - ux * 46, y2 - uy * 46)}`
  }).join('')
  const nodes = N.map(
    ([nm, k, ip, h, x, y, sel, ios]) =>
      `<div class="node ${sel ? 'sel' : ''}" style="left:${x}px;top:${y}px"><div class="box">${ic('i-' + k)}${ios ? `<svg class="ios"><use href="#b-ios"/></svg>` : ''}<svg class="led"><use href="#l-${h}"/></svg></div><div class="nm">${nm}</div>${ip ? `<div class="ip">${ip}</div>` : ''}</div>`
  ).join('')
  return `<div class="canvas"><svg class="wires">${wires}
  <g><rect x="487" y="194" width="22" height="16" rx="3" fill="#a855f7"/><path d="M489 197l9 7 9-7" stroke="#fff" fill="none" stroke-width="1.5"/></g></svg>${nodes}
  <span class="plabel" style="left:440px;top:268px">Gi0/1</span><span class="plabel" style="left:408px;top:300px">Gi0/0</span>
  <div class="tip" style="left:300px;top:340px;max-width:250px"><b>SW-2960 Fa0/2 ↔ PC-LNX eth0</b><br>100 Mbit/s · cuivre droit<br><span class="dg-t">■ Liaison inactive (down)</span> : port administrativement fermé</div>
  <div class="note" style="left:30px;top:470px">Note : VLAN 20 = postes. Le DHCP est relayé par RTR-1921.</div>${extra}</div>`
}
window.statusbar = () =>
  `<div class="sb"><span>8 équipements · 7 câbles</span><span>Outil : <b style="color:var(--sl-fg)">Sélection</b></span><span style="color:var(--sl-accent-text)">2 PDU en attente</span><span style="margin-left:auto" class="mono">100 %</span><span><svg width="9" height="9" viewBox="0 0 12 12"><use href="#l-warn"/></svg> Modifié (auto 14:32)</span></div>`
const P = { ARP: '#eab308', ICMP: '#22c55e', DHCP: '#a855f7', DNS: '#06b6d4', TCP: '#3b82f6' }
window.chips = () =>
  Object.entries(P)
    .map(
      ([p, c], i) =>
        `<span class="chip ${i === 4 ? 'off' : ''}"><span class="sw" style="background:${c}"></span>${p}</span>`
    )
    .join(' ')
window.events =
  () => `<table><thead><tr><th>#</th><th>Temps</th><th>Source</th><th>Destination</th><th>Protocole</th><th>Couche</th><th>Info</th></tr></thead><tbody>
${[
  ['1', '0,000', 'PC-01', 'FF:FF…', 'DHCP', 'L7', 'DISCOVER xid 0x3a1f', '✓'],
  ['2', '0,002', 'SW-2960', 'RTR-1921', 'DHCP', 'L2', 'Relais vers 192.168.10.10', '✓'],
  ['3', '0,004', 'RTR-1921', 'DC01', 'DHCP', 'L3', 'Unicast relayé (giaddr .20.254)', '✓'],
  ['4', '0,009', 'DC01', 'RTR-1921', 'DHCP', 'L7', 'OFFER 192.168.20.11', '✓'],
  ['5', '0,014', 'SW-2960', 'PC-LNX', 'ARP', 'L2', 'Who has 192.168.20.12 ? — abandonné', '✕']
]
  .map(
    (r, i) =>
      `<tr class="${i === 3 ? 'on' : ''}"><td>${r[0]}</td><td class="mono">${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td><span class="sw" style="background:${P[r[4]]}"></span> ${r[4]}</td><td>${r[5]}</td><td>${r[7] === '✓' ? '<span class="ok-t">✓</span>' : '<span class="dg-t">✕</span>'} ${r[6]}</td></tr>`
  )
  .join('')}</tbody></table>`
window.simbar = () =>
  `<div class="simbar"><b style="font-size:13px">Simulation</b><span class="sep" style="width:1px;height:16px;background:var(--sl-line);margin:0 6px"></span><span class="btn">${ic('t-reset', 'i16')}</span><span class="btn on">${ic('t-play', 'i16')}</span><span class="btn">${ic('t-step', 'i16')}</span><span style="color:var(--sl-fg-muted);margin-left:6px">Vitesse</span><span class="mono" style="border:1px solid var(--sl-line);border-radius:4px;padding:1px 6px">1×</span><span style="color:var(--sl-fg-muted);margin-left:8px">Pas 4 / 9</span><span style="margin-left:auto;display:flex;gap:4px">${chips()}</span><span class="btn" title="Réduire">▾</span></div>`
window.inspector = (
  tab = 0
) => `<aside class="insp"><div class="tabs">${['Résumé', 'Lab', 'Audit', 'Dépannage'].map((t, i) => `<span class="${i === tab ? 'on' : ''}">${t}</span>`).join('')}</div>
<div class="sec" style="display:flex;gap:10px;align-items:center"><div class="node" style="position:static;width:48px"><svg style="width:40px;height:40px"><use href="#i-server"/></svg></div><div><div style="font-size:15px;font-weight:600">DC01</div><div style="color:var(--sl-fg-muted)">Serveur · Windows Server 2022</div></div></div>
<div class="sec"><h3>État</h3><span class="state ok-t"><svg width="12" height="12"><use href="#l-ok"/></svg> En fonctionnement</span><div style="color:var(--sl-fg-muted);margin-top:4px">3 rôles · 0 alerte</div></div>
<div class="sec"><h3>Réseau</h3><dl class="kv"><dt>Ethernet0</dt><dd class="mono">192.168.10.10/24</dd><dt>Passerelle</dt><dd class="mono">192.168.10.254</dd><dt>DNS</dt><dd class="mono">127.0.0.1</dd><dt>MAC</dt><dd class="mono">00:15:5D:00:00:0A</dd></dl></div>
<div class="sec"><h3>Rôles</h3><div style="display:flex;flex-wrap:wrap;gap:4px"><span class="chip">AD DS</span><span class="chip">DNS</span><span class="chip">DHCP</span></div></div>
<div class="sec" style="display:flex;gap:6px"><span class="chip" style="border-radius:4px;padding:3px 10px">Console</span><span class="chip" style="border-radius:4px;padding:3px 10px">Bureau</span><span class="chip" style="border-radius:4px;padding:3px 10px">Éteindre</span></div></aside>`
