import { describe, expect, it } from 'vitest'
import { build } from '../helpers'
import { run } from './helpers'

function srv() {
  const { state, ids } = build([['server', 'SRV1']])
  return { state, id: ids.SRV1! }
}
const echo = (s: ReturnType<typeof srv>, t: string) => run(s.state, s.id, `echo ${t}`, { shell: 'cmd' }).text

describe('Invite de commandes : variables d’environnement', () => {
  it('%COMPUTERNAME% et %username% (insensible à la casse)', () => {
    const s = srv()
    expect(echo(s, '%COMPUTERNAME%')).toBe('SRV1')
    expect(echo(s, '%computername%')).toBe('SRV1')
    expect(echo(s, '%username%')).not.toContain('%')
  })
  it('variable inconnue et % isolé laissés littéraux', () => {
    const s = srv()
    expect(echo(s, '%INCONNUE%')).toBe('%INCONNUE%')
    expect(echo(s, '50%')).toBe('50%')
    expect(echo(s, '100% %COMPUTERNAME%')).toBe('100% SRV1')
  })
  it('deux variables sur une ligne', () => {
    const s = srv()
    expect(echo(s, '%COMPUTERNAME%-%USERNAME%')).toMatch(/^SRV1-\S+$/)
  })
  it('groupe de travail : USERDOMAIN = nom machine, LOGONSERVER = \\\\NOMMACHINE', () => {
    const s = srv()
    expect(echo(s, '%USERDOMAIN%')).toBe('SRV1')
    expect(echo(s, '%LOGONSERVER%')).toBe('\\\\SRV1')
  })
  it('SystemRoot et windir', () => {
    const s = srv()
    expect(echo(s, '%SystemRoot% %windir%')).toBe('C:\\Windows C:\\Windows')
  })
  it('membre d’un domaine : USERDOMAIN et LOGONSERVER issus de la session', () => {
    const s = srv()
    const state = structuredClone(s.state)
    const d = state.devices[s.id] as unknown as { host: Record<string, unknown> }
    d.host.domain = 'lab.local'
    d.host.session = { user: 'jdupont', domain: 'LAB', logonServer: 'DC1' }
    const r = (t: string) => run(state, s.id, `echo ${t}`, { shell: 'cmd' }).text
    expect(r('%USERDOMAIN%')).toBe('LAB')
    expect(r('%LOGONSERVER%')).toBe('\\\\DC1')
    expect(r('%USERNAME%')).toBe('jdupont')
  })
})
