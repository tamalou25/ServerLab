/**
 * Pannes Linux de Bind9 et d'isc-dhcp-server (v2.9, #241) :
 * - `linux.named-syntax` : `;` oublié dans named.conf.local (named refuse de démarrer) ;
 * - `linux.named-missing-record` : enregistrement A de la zone commenté (NXDOMAIN après rechargement) ;
 * - `linux.dhcpd-interfaces` : `INTERFACESv4=""` (dhcpd n'écoute sur aucune interface) ;
 * - `linux.dhcpd-syntax` : `;` oublié dans dhcpd.conf (dhcpd refuse de démarrer).
 * Symptômes lus avec les fonctions des consoles : named-checkconf, réponse de named, dhcpd -t.
 */
import type { HostDevice, LabState } from '../../model/schema'
import { bindReply, checkConf, loadServer, runningServer } from '../../services/linuxbind'
import { DHCP_DEFAULT, DHCPD_CONF, fileText } from '../../services/linuxconfig'
import { dhcpdStartProblem, runningDhcpd } from '../../services/linuxdhcp'
import type { FaultDef, FaultTargetParams } from '../types'
import {
  clientFor,
  clientName,
  filesOf,
  linuxFault,
  linuxHostOf,
  linuxServers,
  nameOf,
  sedLine,
  sedOrThrow,
  unitActive
} from './linux-common'

const NAMED_LOCAL = '/etc/bind/named.conf.local'

const base = (state: LabState, server: HostDevice, service: string): FaultTargetParams => {
  const client = clientFor(state, server)
  return { device: server.id, service, ...(client ? { client: client.id } : {}) }
}

// --- named : syntaxe ---------------------------------------------------------------------------------

const namedValid = (host: HostDevice | undefined): boolean => {
  if (!host) return false
  const files = filesOf(host)
  return unitActive(host, 'named') && checkConf((p) => fileText(files, p)).ok
}

export const namedSyntax = linuxFault({
  id: 'linux.named-syntax',
  title: 'Erreur de syntaxe dans la configuration de named',
  difficulty: 2,
  candidates: (state) =>
    linuxServers(state).flatMap((server) => {
      const line = /^\s*(file\s+"[^"]+";)\s*$/m.exec(fileText(filesOf(server), NAMED_LOCAL) ?? '')?.[1]
      if (!line || !unitActive(server, 'named')) return []
      return sedLine(NAMED_LOCAL, line, line.slice(0, -1)) === null
        ? []
        : [{ ...base(state, server, 'named'), line }]
    }),
  breakLines: (_s, p) => [
    sedOrThrow(NAMED_LOCAL, String(p['line']), String(p['line']).slice(0, -1)),
    'sudo systemctl restart named'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(NAMED_LOCAL, String(p['line']).slice(0, -1), String(p['line'])),
    'sudo systemctl restart named'
  ],
  healed: (state, p) => namedValid(linuxHostOf(state, p['device'])),
  ticket: (s, p) =>
    `Après l’ajout d’une zone sur ${nameOf(s, p['device'])}, le service DNS ne démarre plus : depuis ${clientName(s, p)}, plus aucun nom n’est résolu par ce serveur.`,
  hints: (s, p) => [
    `Le serveur DNS ${nameOf(s, p['device'])} ne répond plus à ${clientName(s, p)} ; le service named n’est pas actif.`,
    `named refuse de démarrer quand sa configuration est invalide : contrôlez-la avec l’outil prévu et lisez le message.`,
    `named-checkconf indique le fichier et la ligne en cause ; relisez la ponctuation de la déclaration de zone.`
  ],
  cause: (s, p) =>
    `Dans ${NAMED_LOCAL} de ${nameOf(s, p['device'])}, la ligne « ${String(p['line'])} » avait perdu son point-virgule : la configuration était invalide et named ne démarrait plus.`
})

// --- named : enregistrement manquant ------------------------------------------------------------------

const A_RECORD = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?A\s+\d+\.\d+\.\d+\.\d+$/

/** Enregistrements A (ligne, fichier de zone, nom absolu) des zones directes primaires chargées. */
function records(host: HostDevice): { line: string; file: string; fqdn: string }[] {
  const files = filesOf(host)
  const server = loadServer(host, (p) => fileText(files, p))
  if (!server.check.ok) return []
  const out: { line: string; file: string; fqdn: string }[] = []
  for (const { zone, load } of server.zones) {
    if (zone.type !== 'primary' || zone.file === null || !load || zone.name.endsWith('.arpa')) continue
    const dir = server.check.model.directory.replace(/\/$/, '')
    const file = zone.file.startsWith('/') ? zone.file : `${dir}/${zone.file}`
    for (const raw of (fileText(files, file) ?? '').split('\n')) {
      const m = A_RECORD.exec(raw)
      if (!m || m[1] === '@') continue
      const name = m[1] as string
      out.push({ line: raw, file, fqdn: name.endsWith('.') ? name.slice(0, -1) : `${name}.${zone.name}` })
    }
  }
  return out
}

const answer = (host: HostDevice | undefined, fqdn: string) =>
  host ? bindReply(runningServer(host), fqdn, 'A', '127.0.0.1') : null

export const namedMissingRecord = linuxFault({
  id: 'linux.named-missing-record',
  title: 'Enregistrement DNS manquant dans la zone',
  difficulty: 2,
  candidates: (state) =>
    linuxServers(state).flatMap((server) =>
      unitActive(server, 'named')
        ? records(server)
            .filter((r) => sedLine(r.file, r.line, `;${r.line}`, { whole: true }) !== null)
            .map((r) => ({ ...base(state, server, 'named'), file: r.file, line: r.line, name: r.fqdn }))
        : []
    ),
  breakLines: (_s, p) => [
    sedOrThrow(String(p['file']), String(p['line']), `;${String(p['line'])}`, { whole: true }),
    'sudo rndc reload'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(String(p['file']), `;${String(p['line'])}`, String(p['line']), { whole: true }),
    'sudo rndc reload'
  ],
  healed: (state, p) => {
    const r = answer(linuxHostOf(state, p['device']), String(p['name']))
    return r?.kind === 'answer' && r.records.length > 0
  },
  symptom: (state, p) => answer(linuxHostOf(state, p['device']), String(p['name']))?.kind === 'nxdomain',
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, « ${String(p['name'])} » ne se résout plus (nom introuvable), alors que le serveur DNS ${nameOf(s, p['device'])} répond aux autres noms de la zone.`,
  hints: (s, p) => [
    `« ${String(p['name'])} » est introuvable depuis ${clientName(s, p)} ; les autres noms de la zone se résolvent.`,
    `Le serveur répond « ce nom n’existe pas » : regardez ce que contient le fichier de la zone sur ${nameOf(s, p['device'])}.`,
    `Un enregistrement peut être absent du fichier, ou présent mais ignoré ; named ne relit les zones qu’au rechargement (rndc reload).`
  ],
  cause: (s, p) =>
    `Dans le fichier de zone ${String(p['file'])} de ${nameOf(s, p['device'])}, l’enregistrement de ${String(p['name'])} était commenté : le nom n’existait plus pour les clients.`
})

// --- isc-dhcp-server -----------------------------------------------------------------------------------

const dhcpOk = (host: HostDevice | undefined): boolean =>
  !!host && unitActive(host, 'isc-dhcp-server') && dhcpdStartProblem(host, runningDhcpd(host)) === null

const dhcpHints = (s: LabState, p: FaultTargetParams): [string, string] => [
  `Les postes n’obtiennent plus d’adresse de ${nameOf(s, p['device'])} ; le service isc-dhcp-server n’est pas actif.`,
  `Le service refuse de démarrer : lisez son état et son journal (systemctl status, journalctl -u isc-dhcp-server).`
]

export const dhcpdInterfaces = linuxFault({
  id: 'linux.dhcpd-interfaces',
  title: 'isc-dhcp-server sans interface d’écoute',
  difficulty: 2,
  candidates: (state) =>
    linuxServers(state).flatMap((server) => {
      const line = /^INTERFACESv4="[^"]+"$/m.exec(fileText(filesOf(server), DHCP_DEFAULT) ?? '')?.[0]
      return line && unitActive(server, 'isc-dhcp-server')
        ? [{ ...base(state, server, 'isc-dhcp-server'), line }]
        : []
    }),
  breakLines: (_s, p) => [
    sedOrThrow(DHCP_DEFAULT, String(p['line']), 'INTERFACESv4=""', { whole: true }),
    'sudo systemctl restart isc-dhcp-server'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(DHCP_DEFAULT, 'INTERFACESv4=""', String(p['line']), { whole: true }),
    'sudo systemctl restart isc-dhcp-server'
  ],
  healed: (state, p) => dhcpOk(linuxHostOf(state, p['device'])),
  ticket: (s, p) =>
    `Plus aucun poste n’obtient d’adresse IP du serveur DHCP ${nameOf(s, p['device'])} depuis son dernier redémarrage ; ${clientName(s, p)} reste sans bail.`,
  hints: (s, p) => [
    ...dhcpHints(s, p),
    `Le journal dit sur quelles interfaces le serveur doit écouter : vérifiez le fichier /etc/default/isc-dhcp-server.`
  ],
  cause: (s, p) =>
    `Dans /etc/default/isc-dhcp-server de ${nameOf(s, p['device'])}, INTERFACESv4 était vide : dhcpd n’écoutait sur aucune interface et ne démarrait pas.`
})

export const dhcpdSyntax = linuxFault({
  id: 'linux.dhcpd-syntax',
  title: 'Erreur de syntaxe dans dhcpd.conf',
  difficulty: 2,
  candidates: (state) =>
    linuxServers(state).flatMap((server) => {
      const line = /^\s*(option routers [^;\s]+;)\s*$/m.exec(fileText(filesOf(server), DHCPD_CONF) ?? '')?.[1]
      return line &&
        unitActive(server, 'isc-dhcp-server') &&
        sedLine(DHCPD_CONF, line, line.slice(0, -1)) !== null
        ? [{ ...base(state, server, 'isc-dhcp-server'), line }]
        : []
    }),
  breakLines: (_s, p) => [
    sedOrThrow(DHCPD_CONF, String(p['line']), String(p['line']).slice(0, -1)),
    'sudo systemctl restart isc-dhcp-server'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(DHCPD_CONF, String(p['line']).slice(0, -1), String(p['line'])),
    'sudo systemctl restart isc-dhcp-server'
  ],
  healed: (state, p) => dhcpOk(linuxHostOf(state, p['device'])),
  ticket: (s, p) =>
    `Après une modification de l’étendue DHCP de ${nameOf(s, p['device'])}, le service ne redémarre plus : ${clientName(s, p)} n’obtient plus d’adresse.`,
  hints: (s, p) => [
    ...dhcpHints(s, p),
    `dhcpd -t contrôle dhcpd.conf et indique la ligne en cause ; relisez la ponctuation de la ligne signalée.`
  ],
  cause: (s, p) =>
    `Dans dhcpd.conf de ${nameOf(s, p['device'])}, la ligne « ${String(p['line'])} » avait perdu son point-virgule : dhcpd refusait de démarrer.`
})

export const LINUX_NET_FAULTS: readonly FaultDef[] = [
  namedSyntax,
  namedMissingRecord,
  dhcpdInterfaces,
  dhcpdSyntax
]
