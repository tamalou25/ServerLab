/**
 * `sc qc`, `tasklist /svc` et `net stop` avec dépendants (v2.8, chantier A, issue #225).
 *
 * Sources Microsoft Learn : exemple `sc qc netlogon` d'un contrôleur de domaine
 * (troubleshoot-netlogon-service-startup-failures), page SC de la bibliothèque TechNet (champs de
 * `qc`), page tasklist (/svc sans sortie d'exemple).
 */
import { describe, expect, it } from 'vitest'
import { installFeatures, unwrap, type LabState } from '@engine/index'
import { expectGolden } from '../golden/golden'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from '../shell/helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''
const cmd = (s: LabState, line: string) => run(s, id(s, 'SRV1'), line, { shell: 'cmd' })
const ps = (s: LabState, line: string) => run(s, id(s, 'SRV1'), line, { shell: 'powershell' })

describe('sc qc', () => {
  it('Netlogon d’un contrôleur de domaine : disposition de l’exemple Learn (golden)', () => {
    const r = cmd(buildReferenceLab(), 'sc qc netlogon')
    expect(r.errors).toBe('')
    expectGolden(r.text, 'cmd/sc-qc-netlogon')
  })

  it('START_TYPE suit le type de démarrage, comme sc query et Get-Service', () => {
    let s = buildReferenceLab()
    for (const [scStart, startType, label] of [
      ['demand', 'Manual', '3 DEMAND_START'],
      ['disabled', 'Disabled', '4 DISABLED'],
      ['auto', 'Automatic', '2 AUTO_START']
    ] as const) {
      const cfg = cmd(s, `sc config Netlogon start= ${scStart}`)
      expect(cfg.errors).toBe('')
      s = cfg.state
      expect(cmd(s, 'sc qc Netlogon').text).toContain(`START_TYPE         : ${label}`)
      expect(ps(s, 'Get-Service Netlogon | Select-Object -ExpandProperty StartType').text).toContain(
        startType
      )
    }
  })

  it('DEPENDENCIES et DISPLAY_NAME sont ceux de Get-Service ; l’état du service ne change pas qc', () => {
    const s = buildReferenceLab()
    const deps = ps(s, 'Get-Service Netlogon -RequiredServices').text
    const qc = cmd(s, 'sc qc Netlogon').text
    for (const d of ['LanmanWorkstation', 'LanmanServer']) {
      expect(deps).toContain(d)
      expect(qc).toContain(`: ${d}`)
    }
    const stopped = cmd(cmd(s, 'net stop Netlogon').state, 'sc qc Netlogon')
    expect(stopped.text).toBe(qc)
    // même état affiché par sc query
    expect(cmd(stopped.state, 'sc query Netlogon').text).toContain('STOPPED')
    expect(qc).toContain('DISPLAY_NAME       : Ouverture de session réseau')
  })

  it('service sans source : message honnête, aucune valeur inventée', () => {
    const r = cmd(buildReferenceLab(), 'sc qc W32Time')
    expect(r.errors).toContain('n’est pas simulée dans ServerLab')
    expect(r.errors).not.toMatch(/BINARY_PATH_NAME\s+:|svchost\.exe|LocalSystem/)
  })

  it('service inexistant : erreur 1060', () => {
    expect(cmd(buildReferenceLab(), 'sc qc Inconnu').errors).toContain('[SC] OpenService échec(s) 1060 :')
  })
})

describe('tasklist /svc', () => {
  it('refusé avec un message honnête (ni liste de processus ni services inventés)', () => {
    const r = cmd(buildReferenceLab(), 'tasklist /svc')
    expect(r.errors).toContain('/svc')
    expect(r.errors).toContain('n’est pas simulée dans ServerLab')
  })
  it('les autres options de tasklist fonctionnent toujours', () => {
    expect(cmd(buildReferenceLab(), 'tasklist /nh').text).toContain('lsass.exe')
  })
})

describe('net stop avec dépendants', () => {
  it('aucune invite O/N n’est affichée tant qu’aucune source ne donne le texte exact', () => {
    let s = buildReferenceLab()
    s = unwrap(installFeatures(s, id(s, 'SRV1'), ['Web-Server'], { includeManagementTools: true })).state
    const r = cmd(s, 'net stop WAS')
    expect(r.prompts).toEqual([])
    expect(r.errors).toContain('n’est pas simulée dans ServerLab')
  })
})
