/**
 * Contenu texte des fichiers simulés (format .slab v17) : écriture, ajout, taille selon l'encodage,
 * autorisations NTFS, limite de taille. Annuler/rétablir : tests/engine/commands/catalog.test.ts.
 * Encodages : https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1
 */
import { describe, expect, it } from 'vitest'
import {
  createItem,
  encodedSize,
  findNode,
  localToken,
  MAX_FILE_CONTENT,
  unwrap,
  WELL_KNOWN_SIDS,
  writeFileContent,
  type LabState,
  type ServerDevice
} from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'

const admin = { account: 'BUILTIN\\Administrateurs', sids: [WELL_KNOWN_SIDS.administrators], admin: true }
const srv = (s: LabState) => Object.values(s.devices).find((d) => d.name === 'SRV1') as ServerDevice
const node = (s: LabState, path: string) => findNode(srv(s).storage, path)
const fail = (r: ReturnType<typeof writeFileContent>) => (r.ok ? '' : r.error.code)

describe('contenu des fichiers', () => {
  it('crée le fichier, remplace puis ajoute ; taille selon l’encodage', () => {
    let s = buildReferenceLab()
    const id = srv(s).id
    s = unwrap(writeFileContent(s, id, 'C:\\Scripts\\a.txt', 'abc\r\n', admin)).state
    expect(node(s, 'C:\\Scripts\\a.txt')).toMatchObject({ content: 'abc\r\n', size: 5, kind: 'file' })
    s = unwrap(writeFileContent(s, id, 'C:\\Scripts\\a.txt', 'é', admin, { encoding: 'UTF8' })).state
    expect(node(s, 'C:\\Scripts\\a.txt')).toMatchObject({ content: 'é', size: 5 })
    s = unwrap(
      writeFileContent(s, id, 'C:\\Scripts\\a.txt', 'é', admin, { append: true, encoding: 'UTF8' })
    ).state
    expect(node(s, 'C:\\Scripts\\a.txt')).toMatchObject({ content: 'éé', size: 7 })
    expect(encodedSize('ab', 'Unicode')).toBe(6)
    expect(encodedSize('ab', 'ASCII')).toBe(2)
  })

  it('erreurs : dossier parent absent, dossier visé, droits insuffisants, taille maximale', () => {
    const s = buildReferenceLab()
    const id = srv(s).id
    expect(fail(writeFileContent(s, id, 'C:\\Absent\\a.txt', 'x', admin))).toBe('PathNotFound')
    expect(fail(writeFileContent(s, id, 'C:\\Scripts', 'x', admin))).toBe('AccessDenied')
    // Utilisateurs : lecture seule sur C:\ (héritée)
    const created = unwrap(createItem(s, id, 'C:\\Lecture', 'folder', admin)).state
    const user = { ...localToken('SRV1', 'Invité'), admin: false }
    expect(fail(writeFileContent(created, id, 'C:\\Lecture\\a.txt', 'x', user))).toBe('AccessDenied')
    const big = 'x'.repeat(MAX_FILE_CONTENT + 1)
    expect(fail(writeFileContent(s, id, 'C:\\Scripts\\big.txt', big, admin))).toBe('ContentTooLarge')
  })
})
