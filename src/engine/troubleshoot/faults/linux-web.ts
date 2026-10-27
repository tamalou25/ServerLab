/**
 * Pannes Linux d'Apache2 (v2.9, #241), sur le site activé (`/etc/apache2/sites-enabled`) :
 * - `linux.apache-syntax` : directive mal orthographiée dans le site, puis redémarrage (service en échec) ;
 * - `linux.apache-vhost` : DocumentRoot du site erroné (dossier absent), site rechargé : « 404 Not Found » ;
 * - `linux.apache-docroot-perms` : droits du DocumentRoot trop restrictifs : « 403 Forbidden ».
 * Le symptôme est lu dans l'état : `apache2ctl configtest` (fichiers), configuration en vigueur (relue au
 * rechargement), droits Unix du dossier.
 */
import type { HostDevice, LabState } from '../../model/schema'
import { configTest } from '../../services/linuxapache'
import { apacheConfig } from '../../services/linuxapachehost'
import { fileText, resolveLink } from '../../services/linuxconfig'
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

const SITES_ENABLED = '/etc/apache2/sites-enabled/'

/** Sites activés : fichier de configuration (lien suivi) et DocumentRoot qu'il déclare. */
function enabledRoots(host: HostDevice): { file: string; root: string }[] {
  const files = filesOf(host)
  const out: { file: string; root: string }[] = []
  for (const [path, node] of Object.entries(files)) {
    if (!path.startsWith(SITES_ENABLED) || path.slice(SITES_ENABLED.length).includes('/')) continue
    const target = node.link === undefined ? path : resolveLink(path, node.link)
    const text = fileText(files, target) ?? ''
    for (const m of text.matchAll(/^\s*DocumentRoot\s+(\S+)\s*$/gm))
      out.push({ file: target, root: m[1] as string })
  }
  return out
}

/** Candidats : un DocumentRoot d'un site activé sur un Apache en fonctionnement. */
function siteCandidates(
  state: LabState,
  ok: (host: HostDevice, root: string) => boolean
): FaultTargetParams[] {
  return linuxServers(state).flatMap((server) => {
    if (!unitActive(server, 'apache2')) return []
    const client = clientFor(state, server)
    return enabledRoots(server)
      .filter((s) => ok(server, s.root))
      .slice(0, 1)
      .map((s) => ({
        device: server.id,
        service: 'apache2',
        file: s.file,
        root: s.root,
        ...(client ? { client: client.id } : {})
      }))
  })
}

const configValid = (host: HostDevice | undefined): boolean =>
  !!host && configTest(apacheConfig(host, 'live')).ok

export const apacheSyntax = linuxFault({
  id: 'linux.apache-syntax',
  title: 'Erreur de syntaxe dans la configuration d’Apache',
  difficulty: 2,
  candidates: (state) =>
    siteCandidates(
      state,
      (_h, root) => sedLine('/x', `DocumentRoot ${root}`, `DocumentRot ${root}`) !== null
    ),
  breakLines: (_s, p) => [
    sedOrThrow(String(p['file']), `DocumentRoot ${String(p['root'])}`, `DocumentRot ${String(p['root'])}`),
    'sudo systemctl restart apache2'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(String(p['file']), `DocumentRot ${String(p['root'])}`, `DocumentRoot ${String(p['root'])}`),
    'sudo systemctl restart apache2'
  ],
  healed: (state, p) => {
    const host = linuxHostOf(state, p['device'])
    return unitActive(host, 'apache2') && configValid(host)
  },
  ticket: (s, p) =>
    `Après une modification du site web de ${nameOf(s, p['device'])}, le serveur Apache ne redémarre plus : depuis ${clientName(s, p)}, la page ne s’affiche plus.`,
  hints: (s, p) => [
    `Le site web de ${nameOf(s, p['device'])} ne répond plus depuis ${clientName(s, p)} ; le service Apache n’est pas actif.`,
    `Un redémarrage échoue quand la configuration est invalide : demandez à Apache de la contrôler et lisez le message d’erreur.`,
    `Le message donne le fichier et le numéro de ligne fautifs : relisez la directive en cause (orthographe).`
  ],
  cause: (s, p) =>
    `Dans ${String(p['file'])} de ${nameOf(s, p['device'])}, la directive DocumentRoot était mal orthographiée (DocumentRot) : la configuration était invalide et Apache refusait de démarrer.`
})

export const apacheVhost = linuxFault({
  id: 'linux.apache-vhost',
  title: 'Hôte virtuel Apache erroné',
  difficulty: 2,
  candidates: (state) =>
    siteCandidates(
      state,
      (_h, root) => sedLine('/x', `DocumentRoot ${root}`, `DocumentRoot ${root}-old`) !== null
    ),
  breakLines: (_s, p) => [
    sedOrThrow(
      String(p['file']),
      `DocumentRoot ${String(p['root'])}`,
      `DocumentRoot ${String(p['root'])}-old`
    ),
    'sudo systemctl reload apache2'
  ],
  fixLines: (_s, p) => [
    sedOrThrow(
      String(p['file']),
      `DocumentRoot ${String(p['root'])}-old`,
      `DocumentRoot ${String(p['root'])}`
    ),
    'sudo systemctl reload apache2'
  ],
  healed: (state, p) => {
    const host = linuxHostOf(state, p['device'])
    if (!host || !unitActive(host, 'apache2')) return false
    const running = apacheConfig(host, 'running')
    return [running.main, ...running.vhosts].some((v) => v.documentRoot === String(p['root']))
  },
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, le site web de ${nameOf(s, p['device'])} répond « 404 Not Found » alors qu’Apache fonctionne et que les pages existent toujours sur le serveur.`,
  hints: (s, p) => [
    `Apache de ${nameOf(s, p['device'])} répond, mais par « 404 Not Found » : les fichiers du site ne sont pas trouvés.`,
    `Le serveur cherche les pages à un autre endroit que celui où elles sont : comparez le DocumentRoot du site avec le contenu de /var/www.`,
    `Regardez le journal d’erreurs d’Apache, puis le fichier du site dans sites-enabled ; n’oubliez pas de recharger Apache après la correction.`
  ],
  cause: (s, p) =>
    `Dans ${String(p['file'])} de ${nameOf(s, p['device'])}, le DocumentRoot désignait ${String(p['root'])}-old (dossier inexistant) au lieu de ${String(p['root'])}.`
})

const modeOf = (host: HostDevice | undefined, path: string): number | null => {
  const node = host ? filesOf(host)[path] : undefined
  return node ? node.mode & 0o777 : null
}

export const apacheDocrootPerms = linuxFault({
  id: 'linux.apache-docroot-perms',
  title: 'Droits insuffisants sur le DocumentRoot',
  difficulty: 2,
  candidates: (state) =>
    siteCandidates(state, (host, root) => {
      const node = filesOf(host)[root]
      return !!node && node.type === 'dir' && node.owner !== 'www-data' && (node.mode & 0o005) !== 0
    }).map((p) => ({
      ...p,
      mode: (modeOf(linuxHostOf(state, p['device']), String(p['root'])) ?? 0o755).toString(8)
    })),
  breakLines: (_s, p) => [`sudo chmod 700 ${String(p['root'])}`],
  fixLines: (_s, p) => [`sudo chmod ${String(p['mode'])} ${String(p['root'])}`],
  healed: (state, p) =>
    modeOf(linuxHostOf(state, p['device']), String(p['root'])) === parseInt(String(p['mode']), 8),
  ticket: (s, p) =>
    `Depuis ${clientName(s, p)}, le site web de ${nameOf(s, p['device'])} répond « 403 Forbidden » alors qu’Apache fonctionne et que les pages sont bien présentes.`,
  hints: (s, p) => [
    `Apache de ${nameOf(s, p['device'])} répond, mais par « 403 Forbidden » : l’accès aux pages est interdit.`,
    `Apache s’exécute avec son propre compte (www-data) : a-t-il le droit de lire le dossier du site ? Examinez le journal d’erreurs d’Apache.`,
    `ls -ld sur le DocumentRoot montre propriétaire, groupe et droits ; comparez avec un dossier de site qui fonctionne.`
  ],
  cause: (s, p) =>
    `Le dossier ${String(p['root'])} de ${nameOf(s, p['device'])} avait les droits 700 au lieu de ${String(p['mode'])} : le compte www-data d’Apache ne pouvait plus le traverser.`
})

export const LINUX_WEB_FAULTS: readonly FaultDef[] = [apacheSyntax, apacheVhost, apacheDocrootPerms]
