/**
 * Interface web d'administration du pare-feu (webConfigurator simulé), affichée dans le navigateur d'un
 * poste du lab après une connexion autorisée par le pare-feu (moteur : `pfWebRequest`).
 *
 * Interface en anglais, comme le produit réel (le webConfigurator de pfSense n'est pas localisé ici) ; le
 * reste de l'application reste en français. Voir docs/fidelite.md (P-40 et suivants).
 *
 * Aucune logique métier ici : toute modification est une commande nommée (`pf.*`). Comme sur pfSense,
 * « Save » met la modification en attente et « Apply Changes » l'applique (un lot unique dans le journal) ;
 * les pages lisent l'état prévisualisé (état du lab + modifications en attente).
 */
import { useMemo, useRef, useState } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import { batch, dispatch, pfAuthenticate, type AnyCommand, type LabState, type PfDevice } from '@engine/index'
import { runCommandOk } from '../../../../lib/run'
import { useLabStore } from '../../../../store/lab'
import { AliasesPage } from './Aliases'
import { DashboardPage, DhcpPage, DnsPage, RoutingPage } from './Dashboard'
import { AssignmentsPage, InterfacePage } from './Interfaces'
import { NatPage } from './Nat'
import { RulesPage } from './Rules'
import { FirewallLogPage, StatesPage } from './Status'
import { Alert, Btn, Panel, SessionContext, inputCls, type PfPage, type PfSession } from './ui'

/** Rejoue les modifications en attente ; celles que l'état courant refuse sont ignorées. */
function replay(lab: LabState, pending: AnyCommand[]): LabState {
  let state = lab
  for (const c of pending) {
    const r = dispatch(state, c)
    if (r.ok) state = r.state
  }
  return state
}

const MENUS: { label: string; items: { page: PfPage; label: string }[] }[] = [
  { label: 'System', items: [{ page: 'routing', label: 'Routing' }] },
  { label: 'Interfaces', items: [{ page: 'interfaces', label: 'Assignments' }] },
  {
    label: 'Firewall',
    items: [
      { page: 'aliases', label: 'Aliases' },
      { page: 'nat', label: 'NAT' },
      { page: 'rules', label: 'Rules' }
    ]
  },
  {
    label: 'Services',
    items: [
      { page: 'dhcp', label: 'DHCP Server' },
      { page: 'dns', label: 'DNS Resolver' }
    ]
  },
  {
    label: 'Status',
    items: [
      { page: 'dashboard', label: 'Dashboard' },
      { page: 'logs', label: 'System Logs > Firewall' }
    ]
  },
  { label: 'Diagnostics', items: [{ page: 'states', label: 'States' }] }
]

/** Domaine de configuration modifié, pour le texte de la bannière « Apply Changes ». */
function areaOf(page: PfPage): string {
  if (page === 'rules') return 'firewall rule'
  if (page === 'aliases') return 'alias'
  if (page === 'nat') return 'NAT'
  if (page.startsWith('interface')) return 'interface'
  return 'firewall'
}

export function PfSenseWeb({ firewallId, url }: { firewallId: string; url: string }) {
  const lab = useLabStore((s) => s.lab)
  const [loggedIn, setLoggedIn] = useState(false)
  const [page, setPage] = useState<PfPage>('dashboard')
  const [open, setOpen] = useState<string | null>(null)
  const pendingRef = useRef<AnyCommand[]>([])
  const [pending, setPendingState] = useState<AnyCommand[]>([])
  const setPending = (c: AnyCommand[]) => {
    pendingRef.current = c
    setPendingState(c)
  }
  const preview = useMemo(() => replay(lab, pending), [lab, pending])
  const device = preview.devices[firewallId]
  const firewall = device && device.kind === 'firewall' ? (device as PfDevice) : null

  if (!firewall) return <Alert kind="error">Ce pare-feu n’existe plus dans le lab.</Alert>
  if (!loggedIn) return <LoginPage firewall={firewall} url={url} onLogin={() => setLoggedIn(true)} />

  const session: PfSession = {
    firewallId,
    lab: preview,
    firewall,
    pending: pending.length,
    navigate: (p) => setPage(p),
    stage: (command) => {
      const work = replay(useLabStore.getState().lab, pendingRef.current)
      const r = dispatch(work, command)
      if (!r.ok) return r.error.message
      setPending([...pendingRef.current, command])
      return null
    },
    now: (command) => runCommandOk(command)
  }
  const apply = () => {
    if (runCommandOk(batch('pfSense : Apply Changes', pendingRef.current))) setPending([])
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="-m-8 min-h-full bg-[#f4f5f7] text-[13px] text-[#1b1b1b]" data-testid="pf-web">
        <nav className="flex items-center gap-1 bg-[#212121] px-3 text-[13px] text-white">
          <span className="mr-3 py-2 font-semibold" data-testid="pf-hostname">
            {firewall.pf.hostname}
          </span>
          {MENUS.map((m) => (
            <div key={m.label} className="relative">
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-2 hover:bg-[#3a3a3a]"
                onClick={() => setOpen(open === m.label ? null : m.label)}
                data-testid={`pf-menu-${m.label}`}
              >
                {m.label} <ChevronDown size={12} />
              </button>
              {open === m.label && (
                <ul className="absolute left-0 top-full z-10 min-w-48 bg-[#2d2d2d] py-1 shadow">
                  {m.items.map((it) => (
                    <li key={it.page}>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left hover:bg-[#444]"
                        data-testid={`pf-nav-${it.page}`}
                        onClick={() => {
                          setPage(it.page)
                          setOpen(null)
                        }}
                      >
                        {it.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-2 hover:bg-[#3a3a3a]"
            onClick={() => {
              setLoggedIn(false)
              setPending([])
            }}
            data-testid="pf-logout"
          >
            <LogOut size={13} /> Logout
          </button>
        </nav>
        <main className="p-4">
          {pending.length > 0 && (
            <Alert kind="warn" testId="pf-apply-banner">
              <div className="flex items-center justify-between gap-3">
                <span>
                  The {areaOf(page)} configuration has been changed. The changes must be applied for them to
                  take effect.
                </span>
                <Btn kind="success" testId="pf-apply" onClick={apply}>
                  Apply Changes
                </Btn>
              </div>
            </Alert>
          )}
          <PageBody page={page} />
        </main>
      </div>
    </SessionContext.Provider>
  )
}

function PageBody({ page }: { page: PfPage }) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />
    case 'interfaces':
      return <AssignmentsPage />
    case 'interface:wan':
      return <InterfacePage ifaceKey="wan" />
    case 'interface:lan':
      return <InterfacePage ifaceKey="lan" />
    case 'interface:opt1':
      return <InterfacePage ifaceKey="opt1" />
    case 'rules':
      return <RulesPage />
    case 'aliases':
      return <AliasesPage />
    case 'nat':
      return <NatPage />
    case 'logs':
      return <FirewallLogPage />
    case 'states':
      return <StatesPage />
    case 'dhcp':
      return <DhcpPage />
    case 'dns':
      return <DnsPage />
    case 'routing':
      return <RoutingPage />
  }
}

function LoginPage({ firewall, url, onLogin }: { firewall: PfDevice; url: string; onLogin: () => void }) {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const r = pfAuthenticate(useLabStore.getState().lab, firewall.id, user, password)
    if (r.ok) onLogin()
    else {
      setError(r.error.message)
      setPassword('')
    }
  }
  return (
    <div className="-m-8 min-h-full bg-[#212121] p-8" data-testid="pf-login">
      <div className="mx-auto mt-10 max-w-sm">
        <Panel title={`Login to ${firewall.pf.hostname}`}>
          {error && (
            <Alert kind="error" testId="pf-login-error">
              {error}
            </Alert>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <label className="mb-1 block text-[12px] font-semibold" htmlFor="pf-user">
              Username
            </label>
            <input
              id="pf-user"
              className={`${inputCls} mb-3 w-full`}
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="off"
              data-testid="pf-login-user"
            />
            <label className="mb-1 block text-[12px] font-semibold" htmlFor="pf-pass">
              Password
            </label>
            <input
              id="pf-pass"
              type="password"
              className={`${inputCls} mb-3 w-full`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              data-testid="pf-login-password"
            />
            <Btn type="submit" testId="pf-login-submit">
              Sign In
            </Btn>
          </form>
          <p className="mt-3 text-[11px] text-[#666]">{url}</p>
        </Panel>
      </div>
    </div>
  )
}
