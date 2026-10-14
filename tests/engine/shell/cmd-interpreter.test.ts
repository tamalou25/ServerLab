/**
 * Interpréteur de l'Invite de commandes (v2.7, Lot 3a). Comportements sourcés Microsoft Learn
 * (fr-fr, windows-commands) :
 * - cmd (Remarks : &, &&, ||, >) : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/cmd
 * - set : …/windows-commands/set_1 · type : …/type · cd : …/cd · copy : …/copy · move : …/move · ren : …/ren
 * Les libellés français des messages (« 1 fichier(s) copié(s). »…) ne figurent pas sur Learn :
 * comportement testé, libellé « à vérifier » (docs/fidelite.md, Lot 3).
 */
import { describe, expect, it } from 'vitest'
import { findNode, type LabState, type ServerDevice } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run, type RunResult } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const node = (s: LabState, path: string) => findNode((s.devices[id(s, 'SRV1')] as ServerDevice).storage, path)

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

describe('cmd : opérateurs &, &&, ||', () => {
  it('& exécute les deux commandes', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('echo un & echo deux').text).toBe('un\ndeux')
  })
  it('&& : la suivante seulement si la précédente réussit (Learn, cmd)', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('echo a && echo b').text).toBe('a\nb')
    const r = cmd.run('type C:\\absent.txt && echo jamais')
    expect(r.text).not.toContain('jamais')
    expect(r.errors).toContain('introuvable')
  })
  it('|| : la suivante seulement si la précédente échoue', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('type C:\\absent.txt || echo secours').text).toContain('secours')
    expect(cmd.run('echo ok || echo jamais').text).toBe('ok')
  })
  it('^& et guillemets : caractère ordinaire', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('echo a ^& b').text).toBe('a & b')
    expect(cmd.run('echo "a & b"').text).toBe('"a & b"')
  })
  it('canal | et redirection < : message honnête ; && sans commande : erreur de syntaxe', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('ipconfig | more').errors).toContain('n’est pas simulé')
    expect(cmd.run('sort < a.txt').errors).toContain('n’est pas simulée')
    expect(cmd.run('echo a &&').errors).toBe('La syntaxe de la commande n’est pas correcte.')
  })
})

describe('cmd : redirections > et >>', () => {
  it('> crée ou remplace, >> ajoute (CRLF)', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('echo bonjour > C:\\Scripts\\r.txt').text).toBe('')
    expect(node(cmd.state, 'C:\\Scripts\\r.txt')?.content).toBe('bonjour\r\n')
    cmd.run('echo suite>>C:\\Scripts\\r.txt')
    expect(node(cmd.state, 'C:\\Scripts\\r.txt')?.content).toBe('bonjour\r\nsuite\r\n')
    cmd.run('echo neuf > C:\\Scripts\\r.txt')
    expect(cmd.run('type C:\\Scripts\\r.txt').text).toBe('neuf')
  })
  it('sortie calculée depuis l’état : hostname redirigé', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('hostname > C:\\Scripts\\h.txt')
    expect(node(cmd.state, 'C:\\Scripts\\h.txt')?.content).toBe('SRV1\r\n')
  })
  it('erreurs à l’écran sauf 2> ; nul ; dossier introuvable', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('type C:\\absent.txt > C:\\Scripts\\e.txt').errors).toContain('introuvable')
    cmd.run('type C:\\absent.txt 2> C:\\Scripts\\e2.txt')
    expect(node(cmd.state, 'C:\\Scripts\\e2.txt')?.content).toContain('introuvable')
    expect(cmd.run('echo x > nul').text).toBe('')
    expect(cmd.run('echo x > C:\\Absent\\x.txt').errors).toBe('Le chemin d’accès spécifié est introuvable.')
  })
  it('droits : redirection refusée pour un utilisateur sans écriture', () => {
    const cmd = new Cmd(buildReferenceLab())
    const state = structuredClone(cmd.state)
    const d = state.devices[id(state, 'SRV1')] as unknown as { host: Record<string, unknown> }
    d.host.session = { user: 'jdupont', domain: 'LAB', logonServer: 'DC1' }
    const user = new Cmd(state)
    expect(user.run('echo x > C:\\Windows\\x.txt').errors).toBe('Accès refusé.')
  })
})

describe('cmd : set', () => {
  it('définit, développe, liste par préfixe, efface (Learn, set)', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('set testVar=TEST^^1')
    // Valeur TEST^1 (Learn) ; à l'echo, le ^ redevient un caractère d'échappement
    expect(cmd.run('echo %testvar%').text).toBe('TEST1')
    expect(cmd.run('set test').text).toBe('testVar=TEST^1')
    cmd.run('set testVar=')
    expect(cmd.run('echo %testVar%').text).toBe('%testVar%')
    expect(cmd.run('set testVar').errors).toContain('n’est pas définie')
  })
  it('set seul : variables du lab, triées', () => {
    const cmd = new Cmd(buildReferenceLab())
    const lines = cmd.run('set').text.split('\n')
    expect(lines).toContain('COMPUTERNAME=SRV1')
    expect(lines).toEqual([...lines].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
  })
  it('expansion avant découpage : set x=1 & echo %x% affiche l’ancienne valeur', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('set x=1 & echo %x%').text).toBe('%x%')
    expect(cmd.run('echo %x%').text).toBe('1')
  })
  it('/a et /p : non simulés', () => {
    const cmd = new Cmd(buildReferenceLab())
    expect(cmd.run('set /a x=1+1').errors).toContain('n’est pas simulée')
  })
})

describe('cmd : type, cd, copy, move, ren', () => {
  it('type : contenu, plusieurs fichiers, introuvable, dossier', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('echo un> C:\\Scripts\\a.txt & echo deux> C:\\Scripts\\b.txt')
    expect(cmd.run('type C:\\Scripts\\a.txt C:\\Scripts\\b.txt').text).toBe('un\ndeux')
    expect(cmd.run('type C:\\absent.txt').errors).toBe('Le fichier spécifié est introuvable.')
    expect(cmd.run('type C:\\Scripts').errors).toBe('Accès refusé.')
    expect(cmd.run('type').errors).toBe('La syntaxe de la commande n’est pas correcte.')
  })
  it('cd : /d, cd X: affiche, introuvable', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('cd /d C:\\Scripts')
    expect(cmd.session?.cwd).toBe('C:\\Scripts')
    expect(cmd.run('cd C:').text).toBe('C:\\Scripts')
    expect(cmd.run('cd C:\\Absent').errors).toBe('Le chemin d’accès spécifié est introuvable.')
    cmd.run('cd ..')
    expect(cmd.session?.cwd).toBe('C:\\')
  })
  it('copy : copie, sans destination (dossier courant), sur lui-même, remplacement /y et confirmation', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('echo texte> C:\\Scripts\\a.txt')
    expect(cmd.run('copy C:\\Scripts\\a.txt C:\\Scripts\\b.txt').text).toBe('        1 fichier(s) copié(s).')
    expect(node(cmd.state, 'C:\\Scripts\\b.txt')?.content).toBe('texte\r\n')
    cmd.run('cd C:\\Scripts')
    expect(cmd.run('copy a.txt').errors).toBe('Le fichier ne peut pas être copié sur lui-même.')
    const ask = cmd.run('copy a.txt b.txt', ['N'])
    expect(ask.prompts[0]).toBe('Remplacer C:\\Scripts\\b.txt (Oui/Non/Tous) : ')
    expect(ask.text).toContain('0 fichier(s) copié(s).')
    expect(cmd.run('copy /y a.txt b.txt').prompts).toEqual([])
    expect(cmd.run('copy absent.txt x.txt').errors).toBe('Le fichier spécifié est introuvable.')
    expect(cmd.run('copy *.txt C:\\').errors).toContain('génériques')
    expect(cmd.run('copy /z a.txt c.txt').errors).toContain('n’est pas simulée')
  })
  it('move : fichier, renommage d’un dossier, refus d’écraser un dossier', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('echo m> C:\\Scripts\\m.txt & mkdir C:\\Dest')
    expect(cmd.run('move C:\\Scripts\\m.txt C:\\Dest').text).toBe('        1 fichier(s) déplacé(s).')
    expect(node(cmd.state, 'C:\\Scripts\\m.txt')).toBeUndefined()
    expect(node(cmd.state, 'C:\\Dest\\m.txt')?.content).toBe('m\r\n')
    expect(cmd.run('move C:\\Dest C:\\Arrivee').text).toBe('        1 répertoire(s) déplacé(s).')
    expect(node(cmd.state, 'C:\\Arrivee\\m.txt')).toBeDefined()
    expect(cmd.run('move C:\\absent.txt C:\\Arrivee').errors).toBe('Le fichier spécifié est introuvable.')
    expect(cmd.run('move C:\\Arrivee').errors).toBe('La syntaxe de la commande n’est pas correcte.')
  })
  it('ren : renomme, refuse un chemin dans le nouveau nom (Learn), doublon', () => {
    const cmd = new Cmd(buildReferenceLab())
    cmd.run('echo r> C:\\Scripts\\r.txt & echo s> C:\\Scripts\\s.txt')
    expect(cmd.run('ren C:\\Scripts\\r.txt t.txt').errors).toBe('')
    expect(node(cmd.state, 'C:\\Scripts\\t.txt')).toBeDefined()
    expect(cmd.run('ren C:\\Scripts\\t.txt C:\\u.txt').errors).toBe(
      'La syntaxe de la commande n’est pas correcte.'
    )
    expect(cmd.run('ren C:\\Scripts\\t.txt s.txt').errors).toBe(
      'Un fichier en double existe, ou le fichier est introuvable.'
    )
    expect(cmd.run('rename C:\\Scripts\\absent.txt v.txt').errors).toBe(
      'Un fichier en double existe, ou le fichier est introuvable.'
    )
  })
})

describe('cmd : aide /?', () => {
  it('syntaxe Microsoft Learn et message honnête, aide propre conservée (ping)', () => {
    const cmd = new Cmd(buildReferenceLab())
    const copy = cmd.run('copy /?').text
    expect(copy).toContain('n’est pas reproduite par ServerLab')
    expect(copy).toContain('copy [/d] [/v] [/n] [/y | /-y] [/z]')
    expect(copy).toContain('windows-commands/copy')
    expect(cmd.run('dir /?').text).toContain('windows-commands/dir')
    expect(cmd.run('ping /?').text).toContain('Utilisation : ping')
  })
})
