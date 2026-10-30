/**
 * `execute` (sans journal) donne le même résultat que `dispatch` : même décision, même état, même erreur.
 * Il sert aux essais de réparation du tirage des pannes (#376), qui n'enregistrent rien.
 */
import { describe, expect, it } from 'vitest'
import { dispatch, execute, type AnyCommand } from '@engine/index'
import { BASES } from '../troubleshoot/bases'

describe('execute', () => {
  const lab = BASES[0]!.build()
  const device = Object.values(lab.devices)[0]!

  it('même état que dispatch pour une commande acceptée', () => {
    const command: AnyCommand = { type: 'topology.renameDevice', args: [device.id, 'RenommeExecute'] }
    const a = dispatch(lab, command)
    const b = execute(lab, command)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(b.state).toEqual(a.state)
  })

  it('même erreur que dispatch pour une commande refusée ou inconnue', () => {
    for (const command of [
      { type: 'topology.renameDevice', args: ['inconnu', 'X'] },
      { type: 'commande.inconnue', args: [] }
    ] as AnyCommand[]) {
      const a = dispatch(lab, command)
      const b = execute(lab, command)
      expect(a.ok).toBe(false)
      expect(b.ok).toBe(false)
      if (!a.ok && !b.ok) expect(b.error).toEqual(a.error)
    }
  })
})
