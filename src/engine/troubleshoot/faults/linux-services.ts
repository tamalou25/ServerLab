/**
 * Pannes Linux sur les services (v2.9, #241) :
 * - `linux.service-stopped` : un service (ssh, apache2, smbd, named, isc-dhcp-server) est arrêté ;
 * - `linux.service-disabled` : arrêté ET désactivé au démarrage (`systemctl disable --now`) ;
 * - `linux.sshd-port` : sshd écoute sur un autre port (directive `Port`, relue au redémarrage) ;
 * - `linux.sshd-permitrootlogin` : `PermitRootLogin yes` passé à `no` ;
 * - `linux.fail2ban-banned` : l'adresse d'un poste est bannie par la prison sshd de fail2ban.
 * Casse et réparation sont des lignes de la console bash ; le symptôme se lit dans l'état.
 */
import type { HostDevice, LabState } from '../../model/schema'
import { fileText, parseSshd, runningConfigText, SSHD_CONFIG } from '../../services/linuxconfig'
import { enabledJails, isBanned } from '../../services/linuxfail2ban'
import type { FaultDef, FaultTargetParams } from '../types'
import {
  clientFor,
  clientName,
  filesOf,
  ipOf,
  linuxFault,
  linuxHostOf,
  linuxServers,
  nameOf,
  sedOrThrow,
  sedLine,
  unitActive,
  unitEnabled
} from './linux-common'

/** Services dont l'arrêt a un effet visible depuis un poste, avec leur libellé. */
const SERVICES: Record<string, { label: string; symptom: (client: string, server: string) => string }> = {
  ssh: {
    label: 'SSH',
    symptom: (c, s) => `Depuis ${c}, la connexion SSH vers ${s} est refusée (« Connection refused »).`
  },
  apache2: {
    label: 'Apache2',
    symptom: (c, s) => `Depuis ${c}, le site web hébergé par ${s} ne répond plus.`
  },
  smbd: {
    label: 'Samba',
    symptom: (c, s) => `Depuis ${c}, les dossiers partagés de ${s} ne sont plus accessibles.`
  },
  named: {
    label: 'Bind9',
    symptom: (c, s) => `Depuis ${c}, les noms de la zone gérée par ${s} ne sont plus résolus.`
  },
  'isc-dhcp-server': {
    label: 'isc-dhcp-server',
    symptom: (_c, s) => `Les postes du réseau n’obtiennent plus d’adresse IP du serveur DHCP ${s}.`
  }
}

const serviceLabel = (p: FaultTargetParams): string =>
  SERVICES[String(p['service'])]?.label ?? String(p['service'])

/** Services actifs des serveurs Linux, avec un poste qui observe. */
function serviceCandidates(state: LabState): FaultTargetParams[] {
  return linuxServers(state).flatMap((server) => {
    const client = clientFor(state, server)
    return Object.keys(SERVICES)
      .filter((unit) => unitActive(server, unit))
      .map((unit) => ({
        device: server.id,
        service: unit,
        ...(client ? { client: client.id } : {})
      }))
  })
}

const symptomOf = (state: LabState, p: FaultTargetParams): string =>
  (SERVICES[String(p['service'])]?.symptom ?? ((c: string, s: string) => `${c} n’atteint plus ${s}.`))(
    clientName(state, p),
    nameOf(state, p['device'])
  )

const stateHints = (state: LabState, p: FaultTargetParams): [string, string, string] => [
  symptomOf(state, p),
  `Le poste et le réseau fonctionnent : la cause est sur ${nameOf(state, p['device'])}. Regardez l’état de ses services.`,
  `Comparez ce que fait le service ${serviceLabel(p)} avec ce qui est attendu : systemctl donne son état, journalctl -u son historique.`
]

export const serviceStopped = linuxFault({
  id: 'linux.service-stopped',
  title: 'Service Linux arrêté',
  difficulty: 1,
  candidates: serviceCandidates,
  breakLines: (_s, p) => [`sudo systemctl stop ${String(p['service'])}`],
  fixLines: (_s, p) => [`sudo systemctl start ${String(p['service'])}`],
  healed: (s, p) => unitActive(linuxHostOf(s, p['device']), String(p['service'])),
  ticket: symptomOf,
  hints: stateHints,
  cause: (s, p) =>
    `Le service ${String(p['service'])} de ${nameOf(s, p['device'])} était arrêté : il ne répondait plus aux demandes des clients.`
})

export const serviceDisabled = linuxFault({
  id: 'linux.service-disabled',
  title: 'Service Linux arrêté et désactivé',
  difficulty: 2,
  candidates: (state) =>
    serviceCandidates(state).filter((p) =>
      unitEnabled(linuxHostOf(state, p['device']), String(p['service']))
    ),
  breakLines: (_s, p) => [`sudo systemctl disable --now ${String(p['service'])}`],
  fixLines: (_s, p) => [`sudo systemctl enable --now ${String(p['service'])}`],
  healed: (s, p) => {
    const host = linuxHostOf(s, p['device'])
    return unitActive(host, String(p['service'])) && unitEnabled(host, String(p['service']))
  },
  ticket: (s, p) =>
    `${symptomOf(s, p)} Un collègue a déjà relancé le service à la main une fois, mais le problème revient après chaque redémarrage du serveur.`,
  hints: (s, p) => [
    symptomOf(s, p),
    `Le service ${serviceLabel(p)} de ${nameOf(s, p['device'])} est arrêté, mais ce n’est pas tout : comparez son état actuel avec son démarrage automatique.`,
    `systemctl is-enabled et systemctl status indiquent si le service démarre tout seul au démarrage du serveur.`
  ],
  cause: (s, p) =>
    `Le service ${String(p['service'])} de ${nameOf(s, p['device'])} était arrêté et désactivé : il ne démarrait plus avec le serveur.`
})

// --- sshd : port ---------------------------------------------------------------------------------

const ALT_PORT = 2222
const PORT_LINE = /^#?\s*Port\s+22\s*$/m

export const sshdPort = linuxFault({
  id: 'linux.sshd-port',
  title: 'sshd écoute sur un autre port',
  difficulty: 2,
  candidates(state) {
    return linuxServers(state).flatMap((server) => {
      const line = PORT_LINE.exec(fileText(filesOf(server), SSHD_CONFIG) ?? '')?.[0]
      if (!line || !unitActive(server, 'ssh') || sedLine(SSHD_CONFIG, line, `Port ${ALT_PORT}`) === null)
        return []
      const client = clientFor(state, server)
      return [{ device: server.id, service: 'ssh', original: line, ...(client ? { client: client.id } : {}) }]
    })
  },
  breakLines: (_s, p) => [
    sedOrThrow(SSHD_CONFIG, String(p['original']), `Port ${ALT_PORT}`),
    'sudo systemctl restart ssh'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(SSHD_CONFIG, `Port ${ALT_PORT}`, String(p['original'])),
    'sudo systemctl restart ssh'
  ],
  healed(state, p) {
    const host = linuxHostOf(state, p['device'])
    return unitActive(host, 'ssh') && parseSshd(runningConfigText(host?.host.linux, 'ssh')).ports.includes(22)
  },
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, la connexion SSH vers ${nameOf(s, p['device'])} est refusée (« Connection refused »), alors que le service SSH est démarré.`,
  hints: (s, p) => [
    `La connexion SSH vers ${nameOf(s, p['device'])} est refusée alors que systemctl annonce le service actif.`,
    `Un service actif peut écouter ailleurs que là où on le cherche : regardez les ports en écoute sur ${nameOf(s, p['device'])} (ss -tlnp).`,
    `Le port d’écoute de sshd est fixé par sa configuration, relue seulement au redémarrage du service.`
  ],
  cause: (s, p) =>
    `Dans sshd_config de ${nameOf(s, p['device'])}, la directive Port avait été changée en ${ALT_PORT} : sshd n’écoutait plus sur le port 22.`
})

// --- sshd : PermitRootLogin ------------------------------------------------------------------------

const ROOT_LINE = /^PermitRootLogin yes\s*$/m

export const sshdPermitRoot = linuxFault({
  id: 'linux.sshd-permitrootlogin',
  title: 'PermitRootLogin refusé',
  difficulty: 2,
  candidates(state) {
    return linuxServers(state).flatMap((server) => {
      const text = fileText(filesOf(server), SSHD_CONFIG) ?? ''
      if (!unitActive(server, 'ssh') || !ROOT_LINE.test(text)) return []
      const client = clientFor(state, server)
      return [{ device: server.id, service: 'ssh', ...(client ? { client: client.id } : {}) }]
    })
  },
  breakLines: () => [
    sedOrThrow(SSHD_CONFIG, 'PermitRootLogin yes', 'PermitRootLogin no'),
    'sudo systemctl restart ssh'
  ],
  fixLines: () => [
    sedOrThrow(SSHD_CONFIG, 'PermitRootLogin no', 'PermitRootLogin yes'),
    'sudo systemctl restart ssh'
  ],
  healed(state, p) {
    const host = linuxHostOf(state, p['device'])
    return (
      unitActive(host, 'ssh') &&
      parseSshd(runningConfigText(host?.host.linux, 'ssh')).permitRootLogin === 'yes'
    )
  },
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, la connexion SSH en root vers ${nameOf(s, p['device'])} est refusée (« Permission denied »), même avec le bon mot de passe, alors que le service répond.`,
  hints: (s, p) => [
    `ssh root@${nameOf(s, p['device'])} répond « Permission denied » avec le bon mot de passe ; le service SSH est pourtant actif.`,
    `Le service accepte la connexion mais refuse ce compte : la décision se trouve dans la configuration de sshd sur ${nameOf(s, p['device'])}.`,
    `Cherchez la directive de sshd_config qui régit la connexion directe de root, puis souvenez-vous que sshd ne relit sa configuration qu’au redémarrage.`
  ],
  cause: (s, p) =>
    `Dans sshd_config de ${nameOf(s, p['device'])}, PermitRootLogin avait été passé de yes à no : root ne pouvait plus ouvrir de session SSH.`
})

// --- fail2ban --------------------------------------------------------------------------------------

export const fail2banBanned: FaultDef = linuxFault({
  id: 'linux.fail2ban-banned',
  title: 'Poste banni par fail2ban',
  difficulty: 2,
  candidates(state) {
    return linuxServers(state).flatMap((server) => {
      if (!unitActive(server, 'ssh') || !unitActive(server, 'fail2ban')) return []
      if (!enabledJails(server).some((j) => j.name === 'sshd')) return []
      return Object.values(state.devices)
        .filter((d): d is HostDevice => d.kind === 'client' && d.powered && d.id !== server.id)
        .flatMap((client) => {
          const address = ipOf(client)
          return address ? [{ device: server.id, service: 'ssh', client: client.id, ip: address }] : []
        })
    })
  },
  breakLines: (_s, p) => [`sudo fail2ban-client set sshd banip ${String(p['ip'])}`],
  fixLines: (_s, p) => [`sudo fail2ban-client set sshd unbanip ${String(p['ip'])}`],
  healed: (state, p) => {
    const host = linuxHostOf(state, p['device'])
    return !!host && !isBanned(host, state.clock, String(p['ip']))
  },
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, la connexion SSH vers ${nameOf(s, p['device'])} est refusée (« Connection refused ») alors que le service SSH est actif et que les autres postes se connectent.`,
  hints: (s, p) => [
    `Seul ${clientName(s, p)} n’arrive plus à se connecter en SSH à ${nameOf(s, p['device'])} ; le service est actif et écoute sur le bon port.`,
    `Un service de protection du serveur peut refuser une adresse précise : regardez ce que ${nameOf(s, p['device'])} filtre (journaux, fail2ban).`,
    `fail2ban-client status sshd liste les adresses bannies de la prison ; la même commande permet de lever un bannissement.`
  ],
  cause: (s, p) =>
    `L’adresse ${String(p['ip'])} de ${clientName(s, p)} était bannie par la prison sshd de fail2ban sur ${nameOf(s, p['device'])}.`
})

export const LINUX_SERVICE_FAULTS: readonly FaultDef[] = [
  serviceStopped,
  serviceDisabled,
  sshdPort,
  sshdPermitRoot,
  fail2banBanned
]
