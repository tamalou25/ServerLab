/**
 * Critères de lab des serveurs et postes Linux (v2.9, #241) : service actif, contenu et droits d'un
 * fichier, port en écoute, paquet installé. Chaque évaluateur lit l'état simulé (mêmes fonctions que
 * `systemctl`, `cat`, `ls -l`, `ss`, `dpkg`) ; la configuration d'un service est jugée sur le fichier,
 * son effet (port, hôtes virtuels) sur la configuration en vigueur, relue au redémarrage.
 */
import { z } from 'zod'
import { isLinuxHost } from '../model/host'
import type { LabState } from '../model/schema'
import { defineCriterion, type CriterionType } from '../roles/types'
import { findUnit } from '../services/linuxcatalog'
import { fileText } from '../services/linuxconfig'
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
  )
]
