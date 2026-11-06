/**
 * Critères de lab des serveurs et postes Linux (v2.9, #241) : service actif, contenu et droits d'un
 * fichier, port en écoute, paquet installé. Chaque évaluateur lit l'état simulé (mêmes fonctions que
 * `systemctl`, `cat`, `ls -l`, `ss`, `dpkg`) ; la configuration d'un service est jugée sur le fichier,
 * son effet (port, hôtes virtuels) sur la configuration en vigueur, relue au redémarrage.
 *
 * Fiabilisation (v2.12) : un fichier de configuration conforme ne prouve pas que le service l'applique
 * ni que l'usage fonctionne. `linuxConfigApplied` exige que la configuration en vigueur soit celle des
 * fichiers (service redémarré ou rechargé) ; `smbAccess` rejoue l'accès d'un compte à un partage depuis
 * un poste (réseau, smbd, base Samba, smb.conf en vigueur, droits Unix), en réussite comme en refus.
 */
import { z } from 'zod'
import { isLinuxHost } from '../model/host'
import type { LabState } from '../model/schema'
import { defineCriterion, type CriterionType } from '../roles/types'
import { findUnit } from '../services/linuxcatalog'
import { configTextOf } from '../services/linuxconfig'
import { fileText } from '../services/linuxconfig'
import { smbProbe } from '../roles/files/smbprobe'
import { isInstalled } from '../services/linuxpackages'
import { linuxSockets, unitStatus } from '../services/linuxsystem'
import { hostFiles } from '../services/linuxtree'
import { hostByName } from './lookup'

const linuxHost = (state: LabState, name: string) => {
  const host = hostByName(state, name)
  return isLinuxHost(host) ? host : undefined
}

export const LINUX_CRITERIA: CriterionType[] = [
  defineCriterion(
    z.object({
      type: z.literal('linuxServiceActive'),
      device: z.string(),
      /** Nom de l'unité systemd (ssh, apache2, smbd, named, isc-dhcp-server, fail2ban…). */
      unit: z.string(),
      /** false : le service doit être arrêté. */
      active: z.boolean().default(true),
      /** Démarrage au boot (`systemctl enable`) attendu, facultatif. */
      enabled: z.boolean().optional()
    }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      const unit = findUnit(check.unit)
      if (!host || !unit || !isInstalled(host, unit.pkg)) return false
      const status = unitStatus(host, unit)
      return (
        status.active === (check.active ?? true) &&
        (check.enabled === undefined || status.enabled === check.enabled)
      )
    },
    'Service Linux actif ou arrêté'
  ),
  defineCriterion(
    z.object({
      type: z.literal('linuxFileContains'),
      device: z.string(),
      path: z.string(),
      /** Texte cherché (ou expression régulière si `regex`), sur le contenu actuel du fichier. */
      text: z.string(),
      regex: z.boolean().default(false),
      /** false : le texte doit être absent. */
      present: z.boolean().default(true)
    }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      if (!host) return false
      const content = fileText(hostFiles(host), check.path)
      // Fichier absent : le texte y est absent (utile après a2dissite ou rm)
      if (content === null) return check.present === false
      let found: boolean
      try {
        found = check.regex ? new RegExp(check.text, 'm').test(content) : content.includes(check.text)
      } catch {
        return false
      }
      return found === (check.present !== false)
    },
    'Contenu d’un fichier Linux'
  ),
  defineCriterion(
    z.object({
      type: z.literal('linuxFileMode'),
      device: z.string(),
      path: z.string(),
      /** Droits en octal (« 755 », « 0640 »). */
      mode: z.string().regex(/^[0-7]{3,4}$/),
      owner: z.string().optional(),
      group: z.string().optional()
    }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      const node = host ? hostFiles(host)[check.path] : undefined
      if (!node) return false
      return (
        (node.mode & 0o7777) === parseInt(check.mode, 8) &&
        (check.owner === undefined || node.owner === check.owner) &&
        (check.group === undefined || node.group === check.group)
      )
    },
    'Droits d’un fichier ou dossier Linux'
  ),
  defineCriterion(
    z.object({
      type: z.literal('linuxPortListening'),
      device: z.string(),
      port: z.number().int().min(1).max(65535),
      proto: z.enum(['tcp', 'udp']).default('tcp'),
      /** false : le port ne doit pas être en écoute. */
      listening: z.boolean().default(true)
    }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      if (!host) return false
      const open = linuxSockets(host).some((s) => s.port === check.port && s.proto === (check.proto ?? 'tcp'))
      return open === (check.listening !== false)
    },
    'Port en écoute sur un serveur Linux'
  ),
  defineCriterion(
    z.object({ type: z.literal('linuxPackageInstalled'), device: z.string(), package: z.string() }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      return !!host && isInstalled(host, check.package)
    },
    'Paquet Debian installé'
  ),
  defineCriterion(
    z.object({
      type: z.literal('linuxConfigApplied'),
      device: z.string(),
      /** Unité dont la configuration est relue au (re)démarrage : ssh, apache2, smbd, named, isc-dhcp-server, fail2ban, rsyslog. */
      unit: z.string()
    }),
    (state, check) => {
      const host = linuxHost(state, check.device)
      const unit = findUnit(check.unit)
      if (!host || !unit || !isInstalled(host, unit.pkg)) return false
      const current = configTextOf(check.unit, hostFiles(host))
      if (current === null) return false
      // Un instantané n'existe que si les fichiers ont changé depuis le dernier (re)démarrage ou
      // rechargement : sans instantané, le service applique les fichiers actuels
      const snapshot = host.host.linux?.loaded?.[check.unit]
      return snapshot === undefined || snapshot === current
    },
    'Configuration Linux relue par le service (redémarré ou rechargé)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('smbAccess'),
      /** Poste (Linux ou Windows) d'où l'accès est tenté. */
      from: z.string(),
      /** Serveur Samba (nom ou adresse IPv4). */
      server: z.string(),
      share: z.string(),
      /** Compte Samba ; absent : session anonyme (invité). */
      user: z.string().optional(),
      /** Mot de passe ; absent : celui enregistré dans la base Samba (l'utilisateur tape son mot de passe). */
      password: z.string().optional(),
      /** L'écriture doit réussir (création d'un fichier à la racine du partage, à blanc). */
      write: z.boolean().default(false),
      /** false : l'accès (lecture, ou écriture si `write`) doit être REFUSÉ. */
      success: z.boolean().default(true)
    }),
    (state, check) => {
      const client = hostByName(state, check.from)
      if (!client) return false
      const r = smbProbe(state, client.id, check.server, check.share, {
        user: check.user ?? null,
        ...(check.password !== undefined ? { password: check.password } : {}),
        write: check.write ?? false
      })
      return r.ok === (check.success !== false)
    },
    'Accès à un partage Samba depuis un poste (réussite ou refus)'
  )
]
