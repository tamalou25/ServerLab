/**
 * Outils de fichiers de l'Invite de commandes jamais exercés ailleurs : icacls (accorder, refuser,
 * retirer, héritage, erreurs) et net (share, view, aide), sur le lab de référence.
 */
import { describe, expect, it } from 'vitest'
import { findNode, type LabState, type ServerDevice } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const srv = (s: LabState) => s.devices[id(s, 'SRV1')] as ServerDevice

class Cmd {
  session: RunResult['session'] | undefined
  constructor(public state: LabState) {}
  run(line: string): RunResult {
    const r = run(this.state, id(this.state, 'SRV1'), line, {
      shell: 'cmd',
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

describe('icacls', () => {
  it('aide, accorder, refuser, lister (refus explicite en tête, puis hérités), retirer', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('icacls').text).toContain('ICACLS nom /grant[:r] Sid:perm')
    cmd.run('md C:\\Data')
    expect(cmd.run('icacls C:\\Data /grant LAB\\GG_Compta:(OI)(CI)M').text).toContain(
      '1 fichiers correctement traités ; échec du traitement de 0 fichiers'
    )
    cmd.run('icacls C:\\Data /deny LAB\\jdupont:W')
    const acl = cmd.run('icacls C:\\Data').text.split('\n')
    expect(acl[0]).toBe('C:\\Data LAB\\jdupont:(OI)(CI)(DENY)(W)')
    expect(acl[1]?.trim()).toBe('LAB\\GG_Compta:(OI)(CI)(M)')
    expect(acl.slice(2).join('\n')).toContain('BUILTIN\\Administrateurs:(I)(OI)(CI)(F)')
    cmd.run('icacls C:\\Data /remove:d LAB\\jdupont')
    cmd.run('icacls C:\\Data /remove LAB\\GG_Compta')
    const after = cmd.run('icacls C:\\Data').text
    expect(after).not.toContain('jdupont')
    expect(after).not.toContain('GG_Compta')
  })

  it('héritage désactivé : les entrées héritées deviennent explicites', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('md C:\\Data')
    cmd.run('icacls C:\\Data /inheritance:d')
    const node = findNode(srv(cmd.state).storage, 'C:\\Data')
    expect(node?.inherits).toBe(false)
    expect(cmd.run('icacls C:\\Data').text).not.toContain('(I)')
  })

  it('erreurs : option inconnue, héritage invalide, compte inconnu', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('md C:\\Data')
    expect(cmd.run('icacls C:\\Data /bad').errors).toBe('Paramètre non valide « /bad »')
    expect(cmd.run('icacls C:\\Data /inheritance:x').errors).toBe('Paramètre non valide « /inheritance:x »')
    const unknown = cmd.run('icacls C:\\Data /grant Inconnu:F')
    expect(unknown.errors).toContain('Aucun mappage entre les noms de compte et les ID de sécurité')
    expect(unknown.text).toContain('0 fichiers correctement traités ; échec du traitement de 1 fichiers')
  })
})

describe('net', () => {
  it('share : créer, lister, détailler, view, supprimer', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('md C:\\Data')
    expect(cmd.run('net share Data=C:\\Data /grant:"Tout le monde",FULL /remark:Donnees').text).toContain(
      'Data a été partagé correctement.'
    )
    const list = cmd.run('net share').text
    expect(list).toMatch(/^ADMIN\$\s+C:\\Windows\s+Administration à distance$/m)
    expect(list).toMatch(/^Data\s+C:\\Data\s+Donnees$/m)
    const detail = cmd.run('net share Data').text
    expect(detail).toMatch(/Chemin\s+C:\\Data/)
    expect(detail).toMatch(/Autorisation\s+Tout le monde, FULL/)
    expect(cmd.run('net view \\\\SRV1').text).toMatch(/^Data\s+Disque\s+Donnees$/m)
    expect(cmd.run('net share Data /delete').text).toContain('Data a été supprimé.')
    expect(srv(cmd.state).storage.shares).toEqual([])
  })

  it('share : partage inconnu, suppression en double ; aide et sous-commande non simulée', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('net share Inconnu').errors).toContain('Erreur système 2310.')
    expect(cmd.run('net share Inconnu /delete').errors).toContain('Ce partage n’existe pas.')
    expect(cmd.run('net').text).toContain('La syntaxe de cette commande est :')
    expect(cmd.run('net time /rtsdomain').errors).toContain('n’est pas simulée')
  })

  it('outils sans argument : syntaxe incorrecte ; dossier introuvable', () => {
    const cmd = new Cmd(buildReferenceLab())
    for (const tool of ['mkdir', 'rmdir', 'del'])
      expect(cmd.run(tool).errors).toBe('La syntaxe de la commande n’est pas correcte.')
    expect(cmd.run('dir C:\\Introuvable').errors).toBe('Fichier introuvable')
  })
})
