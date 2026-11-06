/**
 * Critères de lab du rôle Fichiers (partages, accès effectif, lecteurs réseau, accès à un partage Samba
 * depuis un poste : réseau, smbd, base Samba, smb.conf en vigueur, droits Unix, en réussite comme en refus).
 */
import { z } from 'zod'
import { hostByName, sameName, serverByName } from '../../labs/lookup'
import { defineCriterion } from '../types'
import { effectiveAccess, PERMS, principalToken, resolvePrincipal } from './acl'
import { findNode, nodePath } from './paths'
import { sessionDrives } from './smb'
import { smbProbe } from './smbprobe'

const PermSchema = z.enum(PERMS)

export const filesCriteria = [
  defineCriterion(
    z.object({
      type: z.literal('fileExists'),
      server: z.string(),
      /** Chemin local du fichier (C:\Dossier\fichier.txt). */
      path: z.string(),
      /** Texte que le contenu doit comporter (insensible à la casse), optionnel. */
      contains: z.string().optional()
    }),
    (state, check) => {
      const server = serverByName(state, check.server)
      const node = server ? findNode(server.storage, check.path) : undefined
      if (!node || node.kind !== 'file') return false
      return (
        check.contains === undefined ||
        (node.content ?? '').toLowerCase().includes(check.contains.toLowerCase())
      )
    },
    'Fichier présent'
  ),
  defineCriterion(
    z.object({ type: z.literal('share'), server: z.string(), name: z.string(), path: z.string().optional() }),
    (state, check) => {
      const server = serverByName(state, check.server)
      const share = server?.storage.shares.find((s) => sameName(s.name, check.name))
      return (
        !!server &&
        !!share &&
        (check.path === undefined || sameName(nodePath(server.storage, share.folderId), check.path))
      )
    },
    'Dossier partagé'
  ),
  defineCriterion(
    z.object({
      type: z.literal('effectiveAccess'),
      server: z.string(),
      path: z.string(),
      account: z.string(),
      /** Accès au travers de ce partage (partage ∩ NTFS). */
      share: z.string().optional(),
      allow: z.array(PermSchema).default([]),
      deny: z.array(PermSchema).default([])
    }),
    (state, check) => {
      const server = serverByName(state, check.server)
      if (!server) return false
      const node = findNode(server.storage, check.path)
      if (node === undefined) return false
      const principal = resolvePrincipal(state, server, check.account)
      const token = principal ? principalToken(state, server, principal) : null
      if (!token) return false
      const share = check.share
        ? server.storage.shares.find((s) => sameName(s.name, check.share ?? ''))
        : undefined
      if (check.share && !share) return false
      const rights = effectiveAccess(server.storage, node?.id ?? null, token, share)
      const allowed = new Set(rights.filter((r) => r.allowed).map((r) => r.perm))
      return check.allow.every((p) => allowed.has(p)) && check.deny.every((p) => !allowed.has(p))
    },
    'Accès effectif d’un compte (partage et NTFS)'
  ),
  defineCriterion(
    z.object({
      type: z.literal('driveMapped'),
      device: z.string(),
      letter: z.string(),
      path: z.string(),
      account: z.string().optional()
    }),
    (state, check) => {
      const host = hostByName(state, check.device)
      if (!host) return false
      const account =
        check.account ??
        (host.host.session ? `${host.host.session.domain ?? host.name}\\${host.host.session.user}` : null)
      return sessionDrives(host, account).some(
        (d) => d.letter === check.letter.replace(/:$/, '').toUpperCase() && sameName(d.path, check.path)
      )
    },
    'Lecteur réseau connecté'
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
