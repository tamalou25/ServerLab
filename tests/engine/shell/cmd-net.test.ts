/**
 * net user / localgroup / group / accounts / start / stop (v2.7, Lot 3b).
 * Comportements sourcés Microsoft Learn :
 * - net user : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/net-user
 *   (/add, /delete, /domain, /active:{yes|no}, `*` = invite de mot de passe, /fullname, /comment)
 * - net localgroup (cc725622), net group (cc754051, groupes précédés de « * », colonnes de 25)
 * - net accounts (bb490698), net start (bb490713 : sans paramètre, services démarrés), net stop (bb490715)
 * Libellés français : à vérifier (docs/fidelite.md, Lot 3).
 */
import { describe, expect, it } from 'vitest'
import type { LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const user = (s: LabState, sam: string) => s.domains['lab.local']?.users.find((u) => u.sam === sam)

class Cmd {
  session: RunResult['session'] | undefined
  constructor(
    public state: LabState,
    private readonly host = 'SRV1'
  ) {}
  run(line: string, answers?: string[]): RunResult {
    const r = run(this.state, id(this.state, this.host), line, {
      shell: 'cmd',
      ...(answers ? { answers } : {}),
      ...(this.session ? { session: this.session } : {})
    })
    this.state = r.state
    this.session = r.session
    return r
  }
}

/** Session d'un utilisateur non administrateur sur SRV1. */
function asUser(state: LabState): LabState {
  const s = structuredClone(state)
  const d = s.devices[id(s, 'SRV1')] as unknown as { host: Record<string, unknown> }
  d.host.session = { user: 'jdupont', domain: 'LAB', logonServer: 'SRV1' }
  return s
}

describe('net user', () => {
  it('liste calculée depuis l’annuaire, détail d’un compte', () => {
    const cmd = new Cmd(buildReferenceLab())
    const list = cmd.run('net user').text
    expect(list).toContain('\\\\SRV1')
    expect(list).toContain('jdupont')
    const detail = cmd.run('net user jdupont').text
    expect(detail).toMatch(/^Nom d’utilisateur\s+jdupont$/m)
    expect(detail).toMatch(/\*GG_Compta/)
    expect(cmd.run('net user inconnu').errors).toContain('NET HELPMSG 2221')
  })
  it('création /add (mot de passe, /fullname), /active:no, changement de mot de passe, /delete', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('net user mmartin P@ssw0rd123 /add /fullname:"Marie Martin"').text).toContain(
      'La commande s’est terminée correctement.'
    )
    expect(user(cmd.state, 'mmartin')?.name).toBe('Marie Martin')
    expect(user(cmd.state, 'mmartin')?.enabled).toBe(true)
    cmd.run('net user mmartin /active:no')
    expect(user(cmd.state, 'mmartin')?.enabled).toBe(false)
    cmd.run('net user mmartin Nouveau#Pass2026')
    expect(user(cmd.state, 'mmartin')?.password).toBe('Nouveau#Pass2026')
    cmd.run('net user mmartin /delete')
    expect(user(cmd.state, 'mmartin')).toBeUndefined()
  })
  it('mot de passe * : invite masquée et confirmation', () => {
    const cmd = new Cmd(buildReferenceLab())
    const r = cmd.run('net user pdurand * /add', ['P@ssw0rd123', 'P@ssw0rd123'])
    expect(r.prompts).toHaveLength(2)
    expect(user(cmd.state, 'pdurand')).toBeDefined()
    expect(cmd.run('net user pdurand2 * /add', ['P@ssw0rd123', 'autre']).errors).toContain(
      'ne correspondent pas'
    )
  })
  it('erreurs : compte existant, mot de passe refusé (aucun compte), droits, argument invalide', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('net user jdupont P@ssw0rd123 /add').errors).toContain('Le compte existe déjà.')
    expect(cmd.run('net user /active:peutetre').errors).toBe('')
    expect(cmd.run('net user jdupont /active:peutetre').errors).toContain('La syntaxe de cette commande est')
    const user2 = new Cmd(asUser(cmd.state))
    expect(user2.run('net user x P@ssw0rd123 /add').errors).toContain('Erreur système 5.')
  })
  it('poste membre : /domain obligatoire (base SAM locale non simulée)', () => {
    const pc = new Cmd(buildReferenceLab(), 'PC1')
    expect(pc.run('net user').errors).toContain('SAM')
    expect(pc.run('net user /domain').text).toContain('jdupont')
  })
})

describe('net localgroup / net group', () => {
  it('liste avec astérisques, membres, création, ajout et retrait de membres, suppression', () => {
    const cmd = new Cmd(buildReferenceLab())
    const groups = cmd.run('net group').text
    expect(groups).toContain('*GG_Compta')
    expect(cmd.run('net group GG_Compta').text).toContain('jdupont')
    cmd.run('net group GG_RH /add')
    expect(cmd.state.domains['lab.local']?.groups.find((g) => g.name === 'GG_RH')?.scope).toBe('Global')
    cmd.run('net group GG_RH jdupont /add')
    expect(cmd.run('net group GG_RH').text).toContain('jdupont')
    cmd.run('net group GG_RH jdupont /delete')
    expect(cmd.run('net group GG_RH').text).not.toContain('jdupont')
    cmd.run('net group GG_RH /delete')
    expect(cmd.run('net group GG_RH').errors).toContain('NET HELPMSG 2220')
    cmd.run('net localgroup DL_Lecture /add')
    expect(cmd.state.domains['lab.local']?.groups.find((g) => g.name === 'DL_Lecture')?.scope).toBe(
      'DomainLocal'
    )
    expect(cmd.run('net localgroup').text).toContain('*DL_Lecture')
  })
  it('erreurs : membre inconnu (1332), groupe inexistant, droits', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('net group GG_Compta personne /add').errors).toContain('Erreur système 1332.')
    expect(cmd.run('net localgroup Absent').errors).toContain('NET HELPMSG 1376')
    expect(new Cmd(asUser(cmd.state)).run('net group X /add').errors).toContain('Accès refusé.')
  })
})

describe('net accounts, net start, net stop', () => {
  it('net accounts : stratégie calculée depuis les GPO du domaine', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('net accounts').text).toMatch(/^Longueur minimale du mot de passe :\s+\d+$/m)
    expect(cmd.run('net accounts /minpwlen:8').errors).toContain('n’est pas simulée')
  })
  it('net start : services dérivés des rôles installés ; démarrage et arrêt', () => {
    const cmd = new Cmd(buildReferenceLab())
    const list = cmd.run('net start').text
    expect(list).toContain('Ces services Windows sont démarrés :')
    expect(list).toContain('   Serveur DNS')
    expect(cmd.run('net start DNS').errors).toContain('déjà été démarré')
    expect(cmd.run('net start Inexistant').errors).toContain('NET HELPMSG 2185')
    expect(cmd.run('net stop DNS').text).toContain('Le service Serveur DNS a été arrêté.')
    expect(cmd.run('net start').text).not.toContain('   Serveur DNS')
    expect(new Cmd(buildReferenceLab(), 'PC1').run('net start').text).not.toContain('Serveur DNS')
  })
  it('net /? : syntaxe Microsoft Learn', () => {
    expect(new Cmd(buildReferenceLab()).run('net /?').text).toContain('net user [<UserName> {<Password> | *}')
  })
})
