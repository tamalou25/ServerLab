// Sprite d'icônes (dessinées pour ServerLab) et duplication de la maquette en thème sombre et clair.
const S = 'fill="var(--sl-icon-fill)" stroke="var(--sl-icon)" stroke-width="2" stroke-linejoin="round"'
const A = 'fill="var(--sl-icon-2)"'
window.SPRITE = `<svg width="0" height="0" style="position:absolute"><defs>
<symbol id="i-server" viewBox="0 0 48 48"><rect x="14" y="5" width="20" height="38" rx="2" ${S}/><path d="M18 12h12M18 17h12M18 22h12" stroke="var(--sl-icon)" stroke-width="2"/><circle cx="20" cy="36" r="2" ${A}/><rect x="25" y="35" width="5" height="2" ${A}/></symbol>
<symbol id="i-linux-server" viewBox="0 0 48 48"><rect x="10" y="5" width="20" height="38" rx="2" ${S}/><path d="M14 12h12M14 17h12M14 22h12" stroke="var(--sl-icon)" stroke-width="2"/><circle cx="16" cy="36" r="2" ${A}/><rect x="27" y="27" width="17" height="15" rx="3" ${A}/><path d="M31 31l3 3-3 3M36 38h5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-client" viewBox="0 0 48 48"><rect x="5" y="8" width="38" height="25" rx="2" ${S}/><rect x="9" y="12" width="30" height="17" ${A} opacity=".35"/><path d="M24 33v6M15 41h18" stroke="var(--sl-icon)" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-linux" viewBox="0 0 48 48"><path d="M10 10h28v20H10z" ${S}/><path d="M4 34h40l-3 5H7z" ${S}/><path d="M15 16l4 4-4 4M22 25h8" fill="none" stroke="var(--sl-icon-2)" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-switch" viewBox="0 0 48 48"><rect x="3" y="17" width="42" height="14" rx="2" ${S}/><g ${A}><rect x="7" y="21" width="4" height="4"/><rect x="13" y="21" width="4" height="4"/><rect x="19" y="21" width="4" height="4"/><rect x="25" y="21" width="4" height="4"/><rect x="31" y="21" width="4" height="4"/></g><circle cx="40" cy="24" r="1.8" fill="var(--sl-icon)"/></symbol>
<symbol id="i-router" viewBox="0 0 48 48"><rect x="4" y="13" width="40" height="22" rx="11" ${S}/><g fill="none" stroke="var(--sl-icon-2)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 20h9M19 17l3 3-3 3"/><path d="M35 28h-9M29 25l-3 3 3 3"/></g></symbol>
<symbol id="i-cloud" viewBox="0 0 48 48"><path d="M14 36h22a8 8 0 0 0 1-16 11 11 0 0 0-21-2 9 9 0 0 0-2 18z" ${S}/><path d="M18 29h12" stroke="var(--sl-icon-2)" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-firewall" viewBox="0 0 48 48"><rect x="5" y="9" width="38" height="30" rx="2" ${S}/><path d="M5 19h38M5 29h38M17 9v10M31 9v10M11 19v10M24 19v10M37 19v10M17 29v10M31 29v10" stroke="var(--sl-icon)" stroke-width="2"/><rect x="18" y="20" width="12" height="8" ${A}/></symbol>
<symbol id="b-ios" viewBox="0 0 32 11"><rect width="32" height="11" rx="2" fill="var(--sl-icon-2)"/><text x="16" y="8.6" text-anchor="middle" font-family="Inter,sans-serif" font-size="9" font-weight="700" fill="#fff">IOS</text></symbol>
<!-- LED d'état : forme + couleur -->
<symbol id="l-ok" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--sl-ok)" stroke="var(--sl-canvas)" stroke-width="1.5"/></symbol>
<symbol id="l-warn" viewBox="0 0 12 12"><path d="M6 .8L11.5 11H.5z" fill="var(--sl-warn)" stroke="var(--sl-canvas)" stroke-width="1.2"/></symbol>
<symbol id="l-down" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="var(--sl-danger)" stroke="var(--sl-canvas)" stroke-width="1.2"/><path d="M3.8 3.8l4.4 4.4M8.2 3.8l-4.4 4.4" stroke="#fff" stroke-width="1.5"/></symbol>
<symbol id="l-idle" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="var(--sl-canvas)" stroke="var(--sl-idle)" stroke-width="2.2"/></symbol>
<!-- outils -->
<symbol id="t-new" viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3"/></symbol>
<symbol id="t-open" viewBox="0 0 16 16"><path d="M1.5 4h4l1.5 1.5h7.5v8h-13z"/></symbol>
<symbol id="t-save" viewBox="0 0 16 16"><path d="M2 2h10l2 2v10H2z M5 2v4h6V2 M5 14v-4h6v4"/></symbol>
<symbol id="t-undo" viewBox="0 0 16 16"><path d="M5 3L2 6l3 3 M2 6h8a4 4 0 0 1 0 8H7"/></symbol>
<symbol id="t-redo" viewBox="0 0 16 16"><path d="M11 3l3 3-3 3 M14 6H6a4 4 0 0 0 0 8h3"/></symbol>
<symbol id="t-select" viewBox="0 0 16 16"><path d="M3 2l10 5-4.5 1.5L7 13z"/></symbol>
<symbol id="t-cable" viewBox="0 0 16 16"><circle cx="3.5" cy="12.5" r="2"/><circle cx="12.5" cy="3.5" r="2"/><path d="M5 11c4 0 2-6 6-6"/></symbol>
<symbol id="t-pdu" viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="9" rx="1"/><path d="M2.5 4.5L8 9l5.5-4.5"/></symbol>
<symbol id="t-delete" viewBox="0 0 16 16"><path d="M2.5 4h11 M6 4V2.5h4V4 M4 4l.8 9.5h6.4L12 4"/></symbol>
<symbol id="t-note" viewBox="0 0 16 16"><path d="M3 2h10v8l-4 4H3z M9 14v-4h4"/></symbol>
<symbol id="t-zin" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14 M5 7h4 M7 5v4"/></symbol>
<symbol id="t-zout" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14 M5 7h4"/></symbol>
<symbol id="t-fit" viewBox="0 0 16 16"><path d="M2 6V2h4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4"/></symbol>
<symbol id="t-play" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></symbol>
<symbol id="t-step" viewBox="0 0 16 16"><path d="M3 2.5v11l7-5.5z M12.5 2.5v11"/></symbol>
<symbol id="t-reset" viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.8-4 M2 1.5V5h3.5"/></symbol>
</defs></svg>`
window.ic = (id, cls = 'i48') => `<svg class="${cls}"><use href="#${id}"/></svg>`
window.render = (title, html) => {
  document.body.insertAdjacentHTML('afterbegin', SPRITE)
  for (const theme of ['dark', 'light'])
    document.body.insertAdjacentHTML(
      'beforeend',
      `<h1>${title} — thème ${theme === 'dark' ? 'sombre' : 'clair'}</h1><div class="app" data-theme="${theme}">${html()}</div>`
    )
}
