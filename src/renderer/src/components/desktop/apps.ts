/**
 * Applications du Bureau simulé : métadonnées (titre, icône, taille, commande Exécuter,
 * place dans le menu Démarrer…). Les applications des rôles (DHCP, DNS, Active Directory…) sont
 * déclarées par les modules de rôles du moteur et habillées dans roleViews.ts. Les composants
 * sont associés dans renderApp.tsx.
 */
import {
  Cog,
  ShieldCheck,
  EthernetPort,
  FolderOpen,
  Monitor,
  Network,
  PackagePlus,
  Play,
  ScrollText,
  ServerCog,
  SlidersHorizontal,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { roleViews, viewAvailable, type HostDevice } from '@engine/index'
import { roleViewStyle } from './roleViews'

export interface DesktopApp {
  id: string
  label: string
  icon: LucideIcon
  /** Couleur de l'icône (barre des tâches, menus, barre de titre). */
  color: string
  /** Taille par défaut de la fenêtre. */
  size: { w: number; h: number }
  /** Ouverte agrandie (Gestionnaire de serveur). */
  maximized?: boolean
  /** Boîte de dialogue : taille fixe, pas de bouton Agrandir. */
  dialog?: boolean
  /** Commandes reconnues par la boîte Exécuter et la recherche (en minuscules). */
  run?: string[]
  /** Place dans le menu Démarrer. */
  start?: 'top' | 'admin' | 'system'
  /** Outil d'administration (menu Outils du Gestionnaire de serveur). */
  tool?: boolean
  /** Épinglée dans la barre des tâches. */
  pinned?: (device: HostDevice) => boolean
  /** Élément du Panneau de configuration (concerné par les restrictions de stratégie). */
  controlPanel?: boolean
  available: (device: HostDevice) => boolean
  /** Titre de la fenêtre si différent du libellé (ex. nom de la carte réseau). */
  title?: (device: HostDevice, arg?: string) => string
}

const isServer = (device: HostDevice) => device.kind === 'server'
const always = () => true

/** Nom de la carte réseau passée en paramètre. */
function ifaceName(device: HostDevice, arg?: string): string {
  return device.interfaces.find((i) => i.id === arg)?.name ?? 'Ethernet'
}

/** Applications du système de base. */
const CORE_APPS: DesktopApp[] = [
  {
    id: 'servermanager',
    label: 'Gestionnaire de serveur',
    icon: ServerCog,
    color: 'text-sky-500',
    size: { w: 1000, h: 680 },
    maximized: true,
    run: ['servermanager', 'servermanager.exe'],
    start: 'top',
    pinned: isServer,
    available: isServer
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    icon: SquareTerminal,
    color: 'text-blue-500',
    size: { w: 740, h: 440 },
    run: ['powershell', 'powershell.exe'],
    start: 'top',
    pinned: always,
    available: always
  },
  {
    id: 'cmd',
    label: 'Invite de commandes',
    icon: TerminalSquare,
    color: 'text-neutral-400',
    size: { w: 700, h: 420 },
    run: ['cmd', 'cmd.exe'],
    start: 'system',
    pinned: (d) => d.kind === 'client',
    available: always
  },
  {
    id: 'ncpa',
    label: 'Connexions réseau',
    icon: Network,
    color: 'text-emerald-500',
    size: { w: 660, h: 400 },
    run: ['ncpa.cpl', 'control netconnections'],
    start: 'system',
    controlPanel: true,
    available: always
  },
  {
    id: 'netstatus',
    label: 'État de la connexion',
    icon: EthernetPort,
    color: 'text-emerald-500',
    size: { w: 380, h: 450 },
    dialog: true,
    title: (d, arg) => `État de ${ifaceName(d, arg)}`,
    available: always
  },
  {
    id: 'netprops',
    label: 'Propriétés de la connexion',
    icon: EthernetPort,
    color: 'text-emerald-500',
    size: { w: 390, h: 470 },
    dialog: true,
    title: (d, arg) => `Propriétés de ${ifaceName(d, arg)}`,
    available: always
  },
  {
    id: 'netdetails',
    label: 'Détails de connexion réseau',
    icon: EthernetPort,
    color: 'text-emerald-500',
    size: { w: 420, h: 420 },
    dialog: true,
    available: always
  },
  {
    id: 'ipv4',
    label: 'Propriétés de : Protocole Internet version 4 (TCP/IPv4)',
    icon: EthernetPort,
    color: 'text-emerald-500',
    size: { w: 430, h: 500 },
    dialog: true,
    available: always
  },
  {
    id: 'sysdm',
    label: 'Propriétés système',
    icon: Monitor,
    color: 'text-indigo-400',
    size: { w: 430, h: 480 },
    dialog: true,
    run: ['sysdm.cpl', 'control sysdm.cpl', 'system'],
    start: 'system',
    controlPanel: true,
    available: always
  },
  {
    id: 'sysdmname',
    label: 'Modification du nom ou du domaine de l’ordinateur',
    icon: Monitor,
    color: 'text-indigo-400',
    size: { w: 380, h: 460 },
    dialog: true,
    available: always
  },
  {
    id: 'control',
    label: 'Panneau de configuration',
    icon: SlidersHorizontal,
    color: 'text-sky-400',
    size: { w: 780, h: 520 },
    run: ['control', 'control.exe', 'control panel'],
    start: 'system',
    controlPanel: true,
    available: always
  },
  {
    id: 'eventvwr',
    label: 'Observateur d’événements',
    icon: ScrollText,
    color: 'text-amber-500',
    size: { w: 920, h: 580 },
    run: ['eventvwr', 'eventvwr.msc', 'eventvwr.exe'],
    start: 'admin',
    tool: true,
    available: always
  },
  {
    id: 'wf',
    label: 'Pare-feu Windows Defender avec fonctions avancées de sécurité',
    icon: ShieldCheck,
    color: 'text-emerald-700',
    size: { w: 980, h: 600 },
    run: ['wf.msc', 'wf'],
    start: 'admin',
    tool: true,
    available: always
  },
  {
    id: 'services',
    label: 'Services',
    icon: Cog,
    color: 'text-slate-500',
    size: { w: 900, h: 520 },
    run: ['services.msc', 'services'],
    start: 'admin',
    tool: true,
    available: always
  },
  {
    id: 'explorer',
    label: 'Explorateur de fichiers',
    icon: FolderOpen,
    color: 'text-amber-500',
    size: { w: 820, h: 500 },
    run: ['explorer', 'explorer.exe', 'ce pc'],
    start: 'system',
    pinned: always,
    available: always
  },
  {
    id: 'run',
    label: 'Exécuter',
    icon: Play,
    color: 'text-sky-400',
    size: { w: 410, h: 220 },
    dialog: true,
    start: 'system',
    available: always
  },
  {
    id: 'addroles',
    label: 'Assistant Ajout de rôles et de fonctionnalités',
    icon: PackagePlus,
    color: 'text-sky-500',
    size: { w: 800, h: 580 },
    title: (_d, arg) =>
      arg === 'remove'
        ? 'Assistant Suppression de rôles et de fonctionnalités'
        : 'Assistant Ajout de rôles et de fonctionnalités',
    available: isServer
  },
  {
    id: 'recycle',
    label: 'Corbeille',
    icon: Trash2,
    color: 'text-slate-400',
    size: { w: 640, h: 400 },
    available: always
  }
]

/** Vues déclarées par les modules de rôles (registre du moteur) + apparence associée ici. */
const ROLE_APPS: DesktopApp[] = roleViews().map((view) => ({
  id: view.app,
  label: view.label,
  run: view.run,
  tool: view.tool,
  dialog: view.dialog,
  start: view.tool ? 'admin' : undefined,
  available: (device) => viewAvailable(view, device),
  ...roleViewStyle(view.app)
}))

export const DESKTOP_APPS: DesktopApp[] = [...CORE_APPS, ...ROLE_APPS]

export function appInfo(id: string): DesktopApp | undefined {
  return DESKTOP_APPS.find((a) => a.id === id)
}

/** Recherche une application par commande Exécuter (ncpa.cpl, dsa.msc…). */
export function appByCommand(command: string): DesktopApp | undefined {
  const c = command.trim().toLowerCase().replace(/\s+/g, ' ')
  return DESKTOP_APPS.find((a) => a.run?.includes(c))
}
