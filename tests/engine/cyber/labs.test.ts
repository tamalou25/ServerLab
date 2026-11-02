/**
 * Labs de la v2.6 (durcissement L2 Cisco, durcissement AD complet) : départ incomplet, solution
 * saisie comme le ferait l'étudiant (console IOS, PowerShell, GPO) validée à 100 %.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  auditLab,
  buildLabStart,
  checkLab,
  command,
  DEFAULT_DOMAIN_POLICY_ID,
  dispatch,
  evaluateCheck,
  parseLab,
  runIosScript,
  type AnyCommand,
  type LabDefinition,
  type LabState
} from '@engine/index'
import l2 from '../../../labs/lab-29-durcissement-l2.json'
import ad from '../../../labs/lab-30-durcissement-ad-complet.json'
import { run } from '../shell/helpers'

// Solution enregistrée en commandes nommées et rejouée comme un rendu (mode enseignant, #405)
vi.mock('@engine/index', async (importOriginal) =>
  (await import('../teacher/recorder')).instrumentEngine(importOriginal)
)

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const load = (raw: unknown): LabDefinition => {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.lab
}
const apply = (s: LabState, cmd: AnyCommand): LabState => {
  const r = dispatch(s, cmd as Parameters<typeof dispatch>[1])
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}

const SOLUTIONS: Record<string, (s: LabState) => LabState> = {
  'lab-29-durcissement-l2': (s) => {
    s = runIosScript(s, id(s, 'SW1'), [
      'enable',
      'configure terminal',
      'ip dhcp snooping',
      'ip dhcp snooping vlan 1',
      'ip arp inspection vlan 1',
      'vlan 999',
      'exit',
      'interface Gi0/1',
      'switchport mode access',
      'switchport port-security',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'interface Gi0/2',
      'switchport nonegotiate',
      'switchport trunk native vlan 999',
      ...['Fa0/1', 'Fa0/2', 'Fa0/3'].flatMap((p) => [
        `interface ${p}`,
        'switchport mode access',
        'switchport port-security'
      ]),
      'end',
      'write memory'
    ])
    for (const pc of ['PC1', 'PC2']) s = run(s, id(s, pc), 'ipconfig /renew', { shell: 'cmd' }).state
    return s
  },
  'lab-30-durcissement-ad-complet': (s) => {
    const srv = id(s, 'SRV1')
    const ps = (line: string) => {
      s = run(s, srv, line).state
    }
    ps("Remove-ADGroupMember -Identity 'Admins du domaine' -Members jdupont,stagiaire -Confirm:$false")
    ps('Set-ADUser svc-sauvegarde -PasswordNeverExpires $false')
    ps('Disable-ADAccount ancien.employe')
    ps('Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force')
    ps("Revoke-SmbShareAccess -Name Commun -AccountName 'Tout le monde' -Force")
    ps('Grant-SmbShareAccess -Name Commun -AccountName LAB\\GG_Personnel -AccessRight Change -Force')
    s = apply(
      s,
      command('gpo.updateSettings', 'lab.local', DEFAULT_DOMAIN_POLICY_ID, {
        computer: {
          minPasswordLength: 12,
          passwordComplexity: true,
          lockoutThreshold: 5,
          auditLogon: 'SuccessAndFailure'
        }
      })
    )
    s = run(s, id(s, 'PC1'), 'Set-NetFirewallProfile -All -Enabled True').state
    return s
  }
}

describe('Labs de la v2.6', () => {
  for (const raw of [l2, ad]) {
    const lab = load(raw)
    it(`${lab.id} : départ incomplet (audit < 100), solution validée à 100 %`, () => {
      const start = buildLabStart(lab.start)
      expect(auditLab(start).score).toBeLessThan(100)
      for (const c of lab.criteria)
        if (c.check.type === 'auditRule')
          expect(evaluateCheck(start, c.check), `${lab.id} › ${c.id}`).toBe(false)
      const after = checkLab(SOLUTIONS[lab.id]!(start), lab)
      expect(after.results.filter((r) => !r.ok).map((r) => r.id)).toEqual([])
    })
  }

  it('aucun indice ne contient la valeur attendue', () => {
    for (const raw of [l2, ad])
      for (const c of load(raw).criteria) {
        const value = (c.check as { value?: string }).value
        if (value) expect(c.hint.toLowerCase()).not.toContain(value.toLowerCase())
      }
  })
})
