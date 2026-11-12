/**
 * Régression de l'audit v2.11.1 (L-02, lab 8 : refus RDP lié à l'état).
 * Un état faux doit être refusé ; la solution officielle reste validée à 100 %.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLabStart,
  checkLab,
  command,
  dispatch,
  installFeatures,
  parseLabText,
  unwrap,
  type LabDefinition,
  type LabState
} from '@engine/index'

function load(file: string): { lab: LabDefinition; start: LabState } {
  const parsed = parseLabText(readFileSync(join(__dirname, '../../../labs', file), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.message)
  return { lab: parsed.lab, start: buildLabStart(parsed.lab.start) }
}
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const ok = (s: LabState, lab: LabDefinition, crit: string) =>
  checkLab(s, lab).results.find((r) => r.id === crit)?.ok

describe('L-02 lab 8 : refus RDP', () => {
  const { lab, start } = load('lab-08-rds.json')
  const srv = id(start, 'SRV1')
  const pc1 = id(start, 'PC1')
  const connect = (s: LabState, user: string, password = 'Azerty123!') =>
    unwrap(dispatch(s, command('rds.connect', pc1, { computer: 'srv1.lab.local', user, password }))).state
  const base = () =>
    unwrap(installFeatures(start, srv, ['RDS-RD-Server'], { includeManagementTools: true })).state
  const withCollection = (s: LabState, groups: string[]) =>
    unwrap(dispatch(s, command('rds.addCollection', srv, { name: 'Bureautique', userGroups: groups }))).state

  it('refus avant la création de la collection : denied reste rouge', () => {
    const s = connect(base(), 'LAB\\pdurand')
    expect(ok(s, lab, 'denied')).toBe(false)
  })
  it('refus pour mot de passe faux : denied reste rouge', () => {
    const s = connect(withCollection(base(), ['LAB\\GG_Compta']), 'LAB\\pdurand', 'faux')
    expect(ok(s, lab, 'denied')).toBe(false)
  })
  it('refus puis collection rouverte à pdurand : denied redevient rouge', () => {
    let s = connect(withCollection(base(), ['LAB\\GG_Compta']), 'LAB\\pdurand')
    expect(ok(s, lab, 'denied')).toBe(true)
    s = unwrap(
      dispatch(
        s,
        command('rds.setCollectionUserGroups', srv, 'Bureautique', ['LAB\\GG_Compta', 'LAB\\pdurand'])
      )
    ).state
    expect(ok(s, lab, 'denied')).toBe(false)
  })
})
