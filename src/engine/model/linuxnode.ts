/**
 * Nœud du système de fichiers Linux simulé (champ facultatif `host.linux.files`, v2.9). Fichier du
 * modèle (et non de la console) pour que le schéma .slab n'importe rien du shell.
 */
import { z } from 'zod'

export const LinuxNodeSchema = z.object({
  type: z.enum(['file', 'dir']),
  /** Droits Unix sur 12 bits (0o755, 0o4755, 0o1777…). */
  mode: z.number().int().min(0).max(0o7777),
  owner: z.string(),
  group: z.string(),
  /** Contenu texte (même limite que MAX_FILE_CONTENT) ; absent = contenu fourni par le système ou vide. */
  content: z.string().max(65536).optional(),
  /** Date de modification : horloge du lab (ms). */
  mtime: z.number().default(0)
})
export type LinuxNode = z.infer<typeof LinuxNodeSchema>
