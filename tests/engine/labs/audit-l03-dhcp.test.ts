/**
 * Régression de l'audit v2.11.1 (L-03, lab 50 : options DHCP).
 * Un état faux doit être refusé ; la solution officielle reste validée à 100 %.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLabStart, checkLab, parseLabText, type LabDefinition, type LabState } from '@engine/index'
import { run } from '../shell/helpers'

function load(file: string): { lab: LabDefinition; start: LabState } {
  const parsed = parseLabText(readFileSync(join(__dirname, '../../../labs', file), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.message)
  return { lab: parsed.lab, start: buildLabStart(parsed.lab.start) }
}
const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const ok = (s: LabState, lab: LabDefinition, crit: string) =>
  checkLab(s, lab).results.find((r) => r.id === crit)?.ok

describe('L-03 lab 50 : options DHCP', () => {
  const { lab, start } = load('lab-50-linux-dhcp.json')
  const write = (s: LabState, lines: string[]) => {
    lines.forEach((l, i) => {
      s = run(s, id(s, 'LSRV1'), `echo '${l}' | sudo tee ${i ? '-a ' : ''}/etc/dhcp/dhcpd.conf`, {
        shell: 'cmd'
      }).state
    })
    return s
  }
  const conf = (routers: boolean) => [
    'authoritative;',
    'subnet 192.168.20.0 netmask 255.255.255.0 {',
    '  range 192.168.20.100 192.168.20.110;',
    ...(routers ? ['  option routers 192.168.20.254;'] : []),
    '  option domain-name-servers 192.168.20.10;',
    '}'
  ]
  it('sans option routers, la passerelle n’est pas validée', () => {
    const s = write(start, conf(false))
    expect(ok(s, lab, 'routers')).toBe(false)
    expect(ok(s, lab, 'options')).toBe(true)
  })
  it('avec option routers, la passerelle est validée', () => {
    expect(ok(write(start, conf(true)), lab, 'routers')).toBe(true)
  })
})
