/**
 * Régression de l'audit v2.11.1 (L-01, lab 26 : priorité HSRP).
 * Un état faux doit être refusé ; la solution officielle reste validée à 100 %.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLabStart,
  checkLab,
  parseLabText,
  runIosScript,
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

describe('L-01 lab 26 : priorité HSRP', () => {
  const { lab, start } = load('lab-26-ios-hsrp.json')
  const group = (priority: string[]) => [
    'enable',
    'configure terminal',
    'interface Gi0/0',
    'standby 1 ip 192.168.1.254',
    ...priority,
    'end'
  ]
  it('l’énoncé donne la priorité attendue', () => {
    expect(lab.statement).toContain('110')
  })
  it('priorité par défaut (100) refusée, 110 acceptée, solution à 100 %', () => {
    const faux = runIosScript(start, id(start, 'R1'), group(['standby 1 priority 100', 'standby 1 preempt']))
    expect(ok(faux, lab, 'prio')).toBe(false)
    let s = runIosScript(start, id(start, 'R1'), group(['standby 1 priority 110', 'standby 1 preempt']))
    s = runIosScript(s, id(s, 'R2'), group([]))
    expect(checkLab(s, lab).passed).toBe(lab.criteria.length)
  })
})
