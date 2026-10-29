/**
 * Gestionnaire de serveur : tableau de bord (démarrage rapide, vignettes des rôles), Serveur local
 * (propriétés cliquables, événements, services, rôles), Tous les serveurs, pages des rôles,
 * menus Gérer / Outils / Afficher / Aide et notifications de configuration post-déploiement.
 */
import { useState, type ReactNode } from 'react'
import {
  ChevronRight,
  Flag,
  LayoutDashboard,
  RefreshCw,
  Server,
  ServerCog,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import {
  controlledDomain,
  dhcpServerOf,
  effectiveIpv4,
  featureInfo,
  nodePath,
  computerServices,
  roleModules,
  type EventLogEntry,
  type LabState,
  type ServiceInfo,
  type ServerDevice
} from '@engine/index'
import { launch } from '../../../lib/desktop'
import { formatSimTime } from '../../../lib/format'
import { isAlert, START_TYPE_LABELS, statusLabel } from '../../../lib/services'
import { useLabStore } from '../../../store/lab'
import { MessageBox } from '../shell/classic'
import { DESKTOP_APPS } from '../apps'
import { roleIcon } from '../roleViews'

type Page = 'dashboard' | 'local' | 'all' | `role:${string}`

interface RoleDef {
  feature: string
  label: string
  icon: LucideIcon
  /** Sources d'événements propres au rôle. */
  sources: string[]
  /** Fonctionnalités de type rôle du module (le rôle est affiché si l'une est installée). */
  roleFeatures: string[]
}

/** Rôles affichés en vignettes : modules du registre dont la fonctionnalité principale est un rôle. */
const ROLES: RoleDef[] = roleModules()
  .filter((m) => featureInfo(m.feature)?.role)
  .map((m) => ({
    feature: m.feature,
    label: m.displayName,
    icon: roleIcon(m.id),
    sources: m.events.sources,
    roleFeatures: m.features.filter((f) => f.role).map((f) => f.name)
  }))
  .sort((a, b) => a.feature.localeCompare(b.feature))

/** Services système simulés : ceux du système, puis ceux déclarés par les rôles installés. */
const servicesOf = (lab: LabState, device: ServerDevice) => computerServices(lab, device.id)

/** Ligne de service ; arrêté alors que le démarrage est automatique : signalé en rouge. */
function serviceRow(server: string, s: ServiceInfo): ReactNode[] {
  const cells = [server, s.display, s.name, statusLabel(s), START_TYPE_LABELS[s.startType]]
  if (!isAlert(s)) return cells
  return cells.map((c, i) => (
    <span
      key={i}
      className="font-semibold text-[#c42b1c]"
      data-testid={i === 0 ? `sm-alert-${s.name}` : undefined}
    >
      {c}
    </span>
  ))
}

interface Notification {
  id: string
  title: string
  text: string
  action?: { label: string; app: string; testId: string }
}

function notificationsOf(device: ServerDevice, dc: boolean): Notification[] {
  const list: Notification[] = []
  if (device.host.features.includes('AD-Domain-Services') && !dc)
    list.push({
      id: 'adds',
      title: 'Configuration post-déploiement',
      text: `Configuration requise pour : Services AD DS à ${device.name}`,
      action: {
        label: 'Promouvoir ce serveur en contrôleur de domaine',
        app: 'adpromote',
        testId: 'promote-dc'
      }
    })
  if (dhcpServerOf(device)?.configured === false)
    list.push({
      id: 'dhcp',
      title: 'Configuration post-déploiement',
      text: `Configuration requise pour : Serveur DHCP à ${device.name}`,
      action: { label: 'Terminer la configuration DHCP', app: 'dhcppost', testId: 'dhcp-postinstall' }
    })
  if (device.host.pendingReboot)
    list.push({
      id: 'reboot',
      title: 'Redémarrage en attente',
      text: 'Un redémarrage est nécessaire pour terminer la configuration de ce serveur.'
    })
  return list
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="mb-4 border border-[#d9d9d9] bg-white">
      <div className="flex items-baseline gap-3 border-b border-[#e5e5e5] px-3 py-2">
        <h3 className="text-sm font-semibold tracking-wide text-[#333] uppercase">{title}</h3>
        {subtitle && <span className="text-xs text-[#666]">{subtitle}</span>}
      </div>
      <div className="p-3">{children}</div>
    </section>
  )
}

function Table({ columns, rows, empty }: { columns: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-[#555]">
        <tr>
          {columns.map((c) => (
            <th key={c} className="border-b border-[#e5e5e5] px-2 py-1 font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="px-2 py-2 text-[#777]">
              {empty}
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-[#e5f3ff]">
            {r.map((c, j) => (
              <td key={j} className="selectable px-2 py-1">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function eventRows(device: ServerDevice, events: EventLogEntry[]): ReactNode[][] {
  const level = { information: 'Information', warning: 'Avertissement', error: 'Erreur' }
  return events
    .slice(-12)
    .reverse()
    .map((e) => [device.name, e.eventId, level[e.level], e.source, e.log, formatSimTime(e.time)])
}

export function ServerManager({ device }: { device: ServerDevice }) {
  const [page, setPage] = useState<Page>('dashboard')
  const [menu, setMenu] = useState<'manage' | 'tools' | 'view' | 'help' | 'flag' | null>(null)
  const [welcome, setWelcome] = useState(true)
  const [about, setAbout] = useState(false)
  const lab = useLabStore((s) => s.lab)
  const domains = lab.domains
  const dc = !!controlledDomain({ domains }, device.id)
  const notifications = notificationsOf(device, dc)
  // Un rôle est affiché dès qu'un de ses services de rôle est installé (Serveur de fichiers par défaut)
  const installedRoles = ROLES.filter((r) => r.roleFeatures.some((f) => device.host.features.includes(f)))
  const tools = DESKTOP_APPS.filter((a) => a.tool && a.available(device)).sort((a, b) =>
    a.label.localeCompare(b.label, 'fr')
  )
  const fqdn = device.host.domain ? `${device.name}.${device.host.domain}` : device.name
  const ips = device.interfaces
    .map((i) => effectiveIpv4(i)?.address)
    .filter(Boolean)
    .join(', ')

  const pageTitle =
    page === 'dashboard'
      ? 'Tableau de bord'
      : page === 'local'
        ? 'Serveur local'
        : page === 'all'
          ? 'Tous les serveurs'
          : (ROLES.find((r) => `role:${r.feature}` === page)?.label ?? '')

  const navItem = (id: Page, label: string, Icon: LucideIcon) => (
    <button
      key={id}
      type="button"
      onClick={() => setPage(id)}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
        page === id ? 'bg-[#cfe3f7] font-semibold text-black' : 'text-[#222] hover:bg-[#e5f3ff]'
      }`}
      data-testid={`sm-nav-${id.replace('role:', '')}`}
    >
      <Icon size={15} className={page === id ? 'text-[#1e5fa8]' : 'text-[#5a6b7d]'} />
      <span className="truncate">{label}</span>
    </button>
  )

  const menuButton = (id: 'manage' | 'tools' | 'view' | 'help', label: string, testId: string) => (
    <button
      type="button"
      onClick={() => setMenu(menu === id ? null : id)}
      className={`px-3 py-1 text-xs ${menu === id ? 'bg-[#cfe3f7]' : 'hover:bg-[#e5f3ff]'}`}
      data-testid={testId}
    >
      {label}
    </button>
  )

  const menuItem = (label: string, onClick: () => void, testId?: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setMenu(null)
        onClick()
      }}
      className="block w-full px-4 py-1.5 text-left text-xs hover:bg-[#cfe3f7] disabled:text-[#999] disabled:hover:bg-transparent"
      data-testid={testId}
    >
      {label}
    </button>
  )

  const propertyLink = (text: string, onClick: () => void, testId?: string) => (
    <button
      type="button"
      onClick={onClick}
      className="text-left text-[#0066cc] hover:underline"
      data-testid={testId}
    >
      {text}
    </button>
  )

  const serverRow = () => [
    fqdn,
    ips || '—',
    <span className="text-[#1a7f37]">En ligne - Compteurs de performances non démarrés</span>,
    'Activé',
    device.host.pendingReboot ? 'Redémarrage en attente' : 'À jour'
  ]

  const roleBanner = (feature: string) => {
    const n = notifications.find(
      (x) => (feature === 'AD-Domain-Services' && x.id === 'adds') || (feature === 'DHCP' && x.id === 'dhcp')
    )
    if (!n?.action) return null
    const action = n.action
    return (
      <div className="mb-3 flex items-center gap-3 border border-[#e3c35e] bg-[#fff8db] px-3 py-2 text-xs">
        <TriangleAlert size={14} className="text-[#9a6700]" />
        <span className="flex-1">{n.text}</span>
        <button
          type="button"
          className="text-[#0066cc] hover:underline"
          onClick={() => launch(device.id, action.app)}
        >
          Plus…
        </button>
      </div>
    )
  }

  let content: ReactNode
  if (page === 'dashboard')
    content = (
      <>
        {welcome && (
          <section className="mb-4 flex border border-[#d9d9d9] bg-white" data-testid="sm-welcome">
            <div className="w-40 shrink-0 bg-[#1e5fa8] p-3 text-xs text-white">
              <div className="font-semibold">DÉMARRAGE RAPIDE</div>
              <div className="mt-6 text-white/70">NOUVEAUTÉS</div>
              <div className="mt-2 text-white/70">EN SAVOIR PLUS</div>
            </div>
            <div className="flex-1 p-4">
              <h2 className="mb-3 text-lg font-light text-[#1e3287]">
                BIENVENUE DANS GESTIONNAIRE DE SERVEUR
              </h2>
              <ol className="flex flex-col gap-2 text-sm">
                {[
                  {
                    label: 'Configurer ce serveur local',
                    onClick: () => setPage('local'),
                    testId: 'sm-quick-local'
                  },
                  {
                    label: 'Ajouter des rôles et des fonctionnalités',
                    onClick: () => launch(device.id, 'addroles'),
                    testId: 'add-roles-link'
                  },
                  { label: 'Ajouter d’autres serveurs à gérer' },
                  { label: 'Créer un groupe de serveurs' },
                  { label: 'Connecter ce serveur aux services cloud' }
                ].map((item, i) => (
                  <li key={item.label} className="flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#1e5fa8] text-xs text-white">
                      {i + 1}
                    </span>
                    {item.onClick ? (
                      <button
                        type="button"
                        onClick={item.onClick}
                        className="text-[#0066cc] hover:underline"
                        data-testid={item.testId}
                      >
                        {item.label}
                      </button>
                    ) : (
                      <span className="text-[#888]">{item.label}</span>
                    )}
                  </li>
                ))}
              </ol>
              <div className="mt-3 text-right">
                <button
                  type="button"
                  onClick={() => setWelcome(false)}
                  className="text-xs text-[#0066cc] hover:underline"
                >
                  Masquer
                </button>
              </div>
            </div>
          </section>
        )}
        <div className="mb-2 flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-[#333] uppercase">Rôles et groupes de serveurs</h3>
          <span className="text-xs text-[#666]">
            Rôles : {installedRoles.length} | Groupes de serveurs : 1 | Nombre total de serveurs : 1
          </span>
        </div>
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3"
          data-testid="sm-role-tiles"
        >
          {[
            ...installedRoles.map((r) => ({
              id: `role:${r.feature}` as Page,
              label: r.label,
              icon: r.icon,
              sources: r.sources
            })),
            { id: 'local' as Page, label: 'Serveur local', icon: Server, sources: [] as string[] },
            { id: 'all' as Page, label: 'Tous les serveurs', icon: ServerCog, sources: [] as string[] }
          ].map((tile) => {
            const errors = device.host.eventLog.filter(
              (e) => e.level === 'error' && (tile.sources.length === 0 || tile.sources.includes(e.source))
            ).length
            const roleNotice =
              (tile.id === 'role:AD-Domain-Services' && notifications.some((n) => n.id === 'adds')) ||
              (tile.id === 'role:DHCP' && notifications.some((n) => n.id === 'dhcp'))
            const tileFeature = tile.id.startsWith('role:') ? tile.id.slice(5) : null
            const servicesOk = !servicesOf(lab, device).some(
              (x) => isAlert(x) && (tileFeature === null || x.role === tileFeature)
            )
            const rows: [string, boolean][] = [
              ['Gérabilité', !roleNotice],
              ['Événements', errors === 0],
              ['Services', servicesOk],
              ['Performances', true],
              ['Résultats BPA', true]
            ]
            return (
              <div key={tile.id} className="border border-[#d9d9d9] bg-white text-xs">
                <button
                  type="button"
                  onClick={() => setPage(tile.id)}
                  className="flex w-full items-center gap-2 bg-[#1e5fa8] px-2 py-2 text-left text-white hover:bg-[#2a6dbb]"
                >
                  <tile.icon size={16} />
                  <span className="flex-1 truncate font-semibold">{tile.label}</span>
                  <span className="text-base font-light">1</span>
                </button>
                {rows.map(([label, ok]) => (
                  <div key={label} className="flex items-center gap-2 border-t border-[#f0f0f0] px-2 py-1">
                    <span className={`h-3 w-1 ${ok ? 'bg-[#1a7f37]' : 'bg-[#c42b1c]'}`} />
                    {label}
                    {label === 'Événements' && errors > 0 && (
                      <span className="ml-auto text-[#c42b1c]">{errors}</span>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </>
    )
  else if (page === 'local')
    content = (
      <>
        <Section title="Propriétés" subtitle={`Pour ${device.name}`}>
          <div className="grid grid-cols-2 gap-x-8 text-xs" data-testid="sm-local-properties">
            <dl className="grid grid-cols-[170px_1fr] gap-y-1.5">
              <dt className="text-[#555]">Nom de l’ordinateur</dt>
              <dd>{propertyLink(device.name, () => launch(device.id, 'sysdm'), 'sm-local-name')}</dd>
              <dt className="text-[#555]">{device.host.domain ? 'Domaine' : 'Groupe de travail'}</dt>
              <dd>
                {propertyLink(
                  device.host.domain ?? device.host.workgroup,
                  () => launch(device.id, 'sysdm'),
                  'sm-local-domain'
                )}
              </dd>
              <dt className="mt-3 text-[#555]">Pare-feu</dt>
              <dd className="mt-3">{device.host.domain ? 'Domaine : Actif' : 'Public : Actif'}</dd>
              <dt className="text-[#555]">Gestion à distance</dt>
              <dd>Activé</dd>
              <dt className="text-[#555]">Bureau à distance</dt>
              <dd>Désactivé</dd>
              <dt className="text-[#555]">Association de cartes réseau</dt>
              <dd>Désactivé</dd>
              {device.interfaces.map((i) => {
                const eff = effectiveIpv4(i)
                const text = !eff
                  ? 'Non connecté'
                  : eff.source === 'static'
                    ? `${eff.address}, compatible IPv6`
                    : eff.source === 'dhcp'
                      ? 'Adresse IPv4 attribuée par DHCP, compatible IPv6'
                      : 'Adresse IPv4 automatique (APIPA), compatible IPv6'
                return [
                  <dt key={`${i.id}-k`} className="text-[#555]">
                    {i.name}
                  </dt>,
                  <dd key={`${i.id}-v`}>
                    {propertyLink(text, () => launch(device.id, 'ncpa'), `sm-local-${i.name}`)}
                  </dd>
                ]
              })}
            </dl>
            <dl className="grid grid-cols-[170px_1fr] gap-y-1.5">
              <dt className="text-[#555]">Dernières mises à jour installées</dt>
              <dd>Jamais</dd>
              <dt className="text-[#555]">Fuseau horaire</dt>
              <dd>(UTC+01:00) Paris</dd>
              <dt className="mt-3 text-[#555]">Version du système</dt>
              <dd className="mt-3">Système serveur (simulé) Standard</dd>
              <dt className="text-[#555]">Processeurs</dt>
              <dd>Processeur virtuel (simulé)</dd>
              <dt className="text-[#555]">Mémoire installée (RAM)</dt>
              <dd>4 Go</dd>
              <dt className="text-[#555]">Espace disque total</dt>
              <dd>60 Go</dd>
            </dl>
          </div>
        </Section>
        <Section
          title="Événements"
          subtitle={`Tous les événements | ${device.host.eventLog.length} au total`}
        >
          <Table
            columns={['Nom du serveur', 'ID', 'Gravité', 'Source', 'Journal', 'Date et heure']}
            rows={eventRows(device, device.host.eventLog)}
            empty="Aucun événement."
          />
        </Section>
        <Section title="Services" subtitle="Tous les services">
          <Table
            columns={['Nom du serveur', 'Nom complet', 'Nom du service', 'État', 'Type de démarrage']}
            rows={servicesOf(lab, device).map((s) => serviceRow(device.name, s))}
            empty="Aucun service."
          />
        </Section>
        <Section
          title="Rôles et fonctionnalités"
          subtitle={`Tous les rôles et fonctionnalités | ${device.host.features.length} au total`}
        >
          <Table
            columns={['Nom du serveur', 'Nom', 'Type']}
            rows={device.host.features.map((name) => {
              const info = featureInfo(name)
              return [device.name, info?.displayName ?? name, info?.role ? 'Rôle' : 'Fonctionnalité']
            })}
            empty="Aucun rôle installé."
          />
        </Section>
      </>
    )
  else if (page === 'all')
    content = (
      <>
        <Section title="Serveurs" subtitle="Tous les serveurs | 1 au total">
          <Table
            columns={['Nom du serveur', 'Adresse IPv4', 'Gérabilité', 'Activation', 'Mises à jour']}
            rows={[serverRow()]}
            empty="Aucun serveur."
          />
        </Section>
        <Section title="Événements" subtitle="Tous les événements">
          <Table
            columns={['Nom du serveur', 'ID', 'Gravité', 'Source', 'Journal', 'Date et heure']}
            rows={eventRows(
              device,
              device.host.eventLog.filter((e) => e.level !== 'information')
            )}
            empty="Aucun avertissement ni erreur."
          />
        </Section>
      </>
    )
  else {
    const role = ROLES.find((r) => `role:${r.feature}` === page)
    content = role && (
      <>
        {roleBanner(role.feature)}
        <Section title="Serveurs" subtitle="Tous les serveurs | 1 au total">
          <Table
            columns={['Nom du serveur', 'Adresse IPv4', 'Gérabilité', 'Activation', 'Mises à jour']}
            rows={[serverRow()]}
            empty="Aucun serveur."
          />
        </Section>
        {role.feature === 'FileAndStorage-Services' && (
          <Section title="Partages" subtitle={`Tous les partages | ${device.storage.shares.length} au total`}>
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => launch(device.id, 'newshare')}
                className="rounded-sm border border-[#adadad] bg-[#e1e1e1] px-2 py-0.5 text-xs hover:border-[#0078d7] hover:bg-[#e5f1fb]"
                data-testid="sm-new-share"
              >
                Tâches › Nouveau partage…
              </button>
            </div>
            <Table
              columns={['Partage', 'Chemin local', 'Protocole', 'Disponibilité', 'Description']}
              rows={device.storage.shares.map((sh) => [
                <button
                  key="n"
                  type="button"
                  className="text-left text-[#1e5aa8] hover:underline"
                  onClick={() =>
                    launch(device.id, 'fileprops', {
                      arg: nodePath(device.storage, sh.folderId)
                    })
                  }
                  data-testid={`sm-share-${sh.name}`}
                >
                  {sh.name}
                </button>,
                nodePath(device.storage, sh.folderId),
                'SMB',
                'Non en cluster',
                sh.description
              ])}
              empty="Aucun partage. Utilisez Tâches › Nouveau partage pour en créer un."
            />
          </Section>
        )}
        <Section title="Événements" subtitle={`${role.label} | événements du rôle`}>
          <Table
            columns={['Nom du serveur', 'ID', 'Gravité', 'Source', 'Journal', 'Date et heure']}
            rows={eventRows(
              device,
              device.host.eventLog.filter((e) => role.sources.includes(e.source))
            )}
            empty="Aucun événement pour ce rôle."
          />
        </Section>
        <Section title="Services" subtitle={role.label}>
          <Table
            columns={['Nom du serveur', 'Nom complet', 'Nom du service', 'État', 'Type de démarrage']}
            rows={servicesOf(lab, device)
              .filter((s) => s.role === role.feature)
              .map((s) => serviceRow(device.name, s))}
            empty="Aucun service pour ce rôle."
          />
        </Section>
      </>
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-[#f2f2f2] text-black" data-testid="servermanager">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[#d9d9d9] bg-white pr-2 pl-4">
        <span className="text-lg font-light text-[#333]">Gestionnaire de serveur</span>
        <ChevronRight size={18} className="text-[#999]" />
        <span className="text-lg font-light text-[#333]" data-testid="sm-page-title">
          {pageTitle}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded p-1.5 text-[#555] hover:bg-[#e5f3ff]" title="Actualiser">
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => setMenu(menu === 'flag' ? null : 'flag')}
            className={`relative rounded p-1.5 hover:bg-[#e5f3ff] ${menu === 'flag' ? 'bg-[#cfe3f7]' : ''}`}
            title="Notifications"
            data-testid="sm-notifications"
          >
            <Flag size={16} className="text-[#555]" />
            {notifications.length > 0 && (
              <TriangleAlert size={11} className="absolute right-0 bottom-0 fill-[#ffcc00] text-black" />
            )}
          </button>
          {menuButton('manage', 'Gérer', 'sm-manage')}
          {menuButton('tools', 'Outils', 'sm-tools')}
          {menuButton('view', 'Afficher', 'sm-view')}
          {menuButton('help', 'Aide', 'sm-help')}
        </div>
      </header>
      {menu && (
        <>
          <div className="absolute inset-0 z-20" onClick={() => setMenu(null)} />
          <div
            className={`absolute top-12 z-30 border border-[#ccc] bg-white py-1 shadow-lg ${menu === 'flag' ? 'right-48 w-80' : 'right-2 w-72'}`}
            data-testid={`sm-menu-${menu}`}
          >
            {menu === 'flag' &&
              (notifications.length === 0 ? (
                <p className="px-4 py-2 text-xs text-[#777]">Aucune notification.</p>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className="border-b border-[#eee] px-4 py-2 text-xs last:border-0">
                    <div className="mb-0.5 flex items-center gap-1.5 font-semibold">
                      <TriangleAlert size={12} className="fill-[#ffcc00] text-black" /> {n.title}
                    </div>
                    <div className="text-[#444]">{n.text}</div>
                    {n.action && (
                      <button
                        type="button"
                        className="mt-1 text-[#0066cc] hover:underline"
                        onClick={() => {
                          setMenu(null)
                          if (n.action) launch(device.id, n.action.app)
                        }}
                        data-testid={n.action.testId}
                      >
                        {n.action.label}
                      </button>
                    )}
                  </div>
                ))
              ))}
            {menu === 'manage' && (
              <>
                {menuItem(
                  'Ajouter des rôles et fonctionnalités',
                  () => launch(device.id, 'addroles'),
                  'add-roles'
                )}
                {menuItem(
                  'Supprimer des rôles et fonctionnalités',
                  () => launch(device.id, 'addroles', { arg: 'remove' }),
                  'remove-roles'
                )}
                {menuItem('Ajouter des serveurs', () => undefined, undefined, true)}
                {menuItem('Créer un groupe de serveurs', () => undefined, undefined, true)}
              </>
            )}
            {menu === 'tools' &&
              (tools.length === 0 ? (
                <p className="px-4 py-2 text-xs text-[#777]">
                  Aucun outil : installez un rôle et ses outils de gestion.
                </p>
              ) : (
                tools.map((t) => menuItem(t.label, () => launch(device.id, t.id), `sm-tool-${t.id}`))
              ))}
            {menu === 'view' &&
              menuItem(
                welcome ? 'Masquer la vignette de bienvenue' : 'Afficher la vignette de bienvenue',
                () => setWelcome(!welcome)
              )}
            {menu === 'help' && menuItem('À propos du Gestionnaire de serveur', () => setAbout(true))}
          </div>
        </>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="w-52 shrink-0 overflow-y-auto border-r border-[#d9d9d9] bg-[#f9f9f9] py-2">
          {navItem('dashboard', 'Tableau de bord', LayoutDashboard)}
          {navItem('local', 'Serveur local', Server)}
          {navItem('all', 'Tous les serveurs', ServerCog)}
          {installedRoles.map((r) => navItem(`role:${r.feature}`, r.label, r.icon))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="app-servermanager-content">
          {content}
        </main>
      </div>
      {about && (
        <MessageBox
          title="À propos du Gestionnaire de serveur"
          icon="info"
          message="Gestionnaire de serveur (simulé) — ServerLab. Les rôles et fonctionnalités sont installés dans le moteur de simulation, sans aucune commande système réelle."
          buttons={[{ label: 'OK', primary: true, onClick: () => setAbout(false) }]}
        />
      )}
    </div>
  )
}
