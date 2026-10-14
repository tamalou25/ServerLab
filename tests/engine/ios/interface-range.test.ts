/**
 * interface range : plages de ports, mode config-if-range, application de chaque commande à toutes
 * les interfaces de la plage, erreurs (marqueur ^ sous le jeton fautif), macros non simulées et
 * annuler/rétablir par les patches de shell.exec.
 *
 * Sources :
 * - https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/configuration/guide/scg2960/swint.html
 *   (« Configuring a Range of Interfaces » : jusqu'à cinq plages, espace obligatoire avant le tiret,
 *   type répété après chaque virgule, invite Switch(config-if-range)#, commandes exécutées à la saisie)
 * - https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-i1.html
 *   (interface range { type number [- interface number] [,] ... | macro word }, mode de configuration globale)
 */
import { describe, expect, it } from 'vitest'
import { applyStatePatches, command, createShellSession, dispatch, type LabState } from '@engine/index'
import { createLab } from '../helpers'
import { addIos, IosConsole, router } from './helpers'
import { unsimulatedIosMessage } from '@engine/shell/unsimulated'

function sw(): IosConsole {
  const r = addIos(createLab(), 'c2960', 'Switch')
  const c = new IosConsole(r.state, r.id)
  c.lines('en', 'conf t')
  return c
}

const CARET = (col: number): string[] => [
  `${' '.repeat(col)}^`,
  "% Invalid input detected at '^' marker.",
  ''
]

const ifaceOf = (c: IosConsole, name: string) =>
  Object.values(c.state.devices)[0]?.interfaces.find((i) => i.name === name)

describe('interface range', () => {
  it('plage fa0/1 - 5 : invite config-if-range et toutes les interfaces sélectionnées', () => {
    const c = sw()
    expect(c.run('interface range fa0/1 - 5')).toEqual([])
    expect(c.prompt).toBe('Switch(config-if-range)#')
    expect(c.session.ios?.ifaces).toHaveLength(5)
  })

  it('commande appliquée à chaque interface (switchport access vlan, description)', () => {
    const c = sw()
    c.lines('vlan 10', 'exit', 'interface range fa0/1 - 3 , gi0/1 - 2')
    c.lines('switchport mode access', 'switchport access vlan 10', 'description Postes')
    const run = c.run('do show running-config')
    for (const name of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'GigabitEthernet0/1']) {
      const at = run.indexOf(`interface ${name}`)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(run.slice(at + 1, at + 4)).toEqual([
        ' description Postes',
        ' switchport access vlan 10',
        ' switchport mode access'
      ])
    }
    const fa4 = run.indexOf('interface FastEthernet0/4')
    expect(run[fa4 + 1]).toBe('!')
  })

  it('shutdown sur une plage : messages %LINK pour chaque port', () => {
    const c = sw()
    c.run('interface range fa0/1 - 2')
    const out = c.run('shutdown')
    expect(out).toEqual([
      '%LINK-5-CHANGED: Interface FastEthernet0/1, changed state to administratively down',
      '%LINK-5-CHANGED: Interface FastEthernet0/2, changed state to administratively down'
    ])
    expect(ifaceOf(c, 'Fa0/1')?.enabled).toBe(false)
    expect(ifaceOf(c, 'Fa0/3')?.enabled).toBe(true)
  })

  it('routeur 1921 : interface range g0/0 - 1, invite (config-if-range)#', () => {
    const c = router()
    c.lines('en', 'conf t')
    expect(c.run('int range g0/0 - 1')).toEqual([])
    expect(c.prompt).toBe('R1(config-if-range)#')
    c.run('no shutdown')
    const d = Object.values(c.state.devices)[0]
    expect(d?.interfaces.filter((i) => i.enabled).map((i) => i.name)).toEqual(['Gi0/0', 'Gi0/1'])
  })

  it('formes acceptées : type séparé du numéro, virgule collée, port seul', () => {
    const c = sw()
    c.run('interface range fastEthernet 0/1 - 2, gi0/1')
    expect(c.prompt).toBe('Switch(config-if-range)#')
    expect(c.session.ios?.ifaces).toHaveLength(3)
  })

  it('exit et end quittent la plage ; commande globale depuis la plage', () => {
    const c = sw()
    c.run('interface range fa0/1 - 2')
    c.run('exit')
    expect(c.prompt).toBe('Switch(config)#')
    c.run('interface range fa0/1 - 2')
    c.run('hostname SW1')
    expect(c.prompt).toBe('SW1(config)#')
  })

  it('erreurs : ^ sous le jeton fautif', () => {
    const c = sw()
    const p = 'Switch(config)#'.length
    // Tiret collé : refusé (le guide 2960 exige une espace avant le tiret)
    expect(c.run('interface range fa0/1-5')).toEqual(CARET(p + 'interface range '.length))
    // Dernier port inexistant
    expect(c.run('interface range fa0/1 - 30')).toEqual(CARET(p + 'interface range fa0/1 - '.length))
    // Second élément de la liste invalide
    expect(c.run('interface range fa0/1 - 2 , xyz0/1')).toEqual(
      CARET(p + 'interface range fa0/1 - 2 , '.length)
    )
    // Sixième plage (cinq au plus)
    expect(c.run('interface range fa0/1 , fa0/2 , fa0/3 , fa0/4 , fa0/5 , fa0/6')).toEqual(
      CARET(p + 'interface range fa0/1 , fa0/2 , fa0/3 , fa0/4 , fa0/5 , '.length)
    )
    expect(c.prompt).toBe('Switch(config)#')
    expect(c.run('interface range')).toEqual(['% Incomplete command.', ''])
  })

  it('interface range macro et plages de VLAN : message honnête', () => {
    const c = sw()
    expect(c.run('interface range macro enet_list')).toEqual([
      `% ${unsimulatedIosMessage('interface range macro')}`
    ])
    expect(c.run('interface range vlan 10 - 20')).toEqual([
      `% ${unsimulatedIosMessage('interface range vlan')}`
    ])
    expect(c.prompt).toBe('Switch(config)#')
  })

  it('annuler : les patches de shell.exec rétablissent toutes les interfaces', () => {
    const c = sw()
    c.run('interface range fa0/1 - 4')
    const before: LabState = c.state
    const session = { ...createShellSession(before, c.session.deviceId, 'ios'), ios: c.session.ios }
    const r = dispatch(before, command('shell.exec', session, 'shutdown', []))
    if (!r.ok || !r.entry) throw new Error('shell.exec')
    const dev = (s: LabState) => Object.values(s.devices)[0]
    expect(dev(r.state)?.interfaces.filter((i) => !i.enabled)).toHaveLength(4)
    const undone = applyStatePatches(r.state, r.entry.inversePatches)
    expect(dev(undone)?.interfaces.every((i) => i.enabled)).toBe(true)
    const redone = applyStatePatches(undone, r.entry.patches)
    expect(dev(redone)?.interfaces.filter((i) => !i.enabled)).toHaveLength(4)
  })
})
