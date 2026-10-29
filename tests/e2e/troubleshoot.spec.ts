import { expect, test } from '@playwright/test'
import {
  addDevice,
  connect,
  createLab,
  setInterfaceIpv4,
  startTroubleshooting,
  unwrap,
  type DeviceKind,
  type LabState
} from '../../src/engine/index'
import { openLab } from './fixtures'
import { clickMenu, launchApp, openConsole, typeCommand } from './helpers'

/** Deux postes sur un switch, même réseau 192.168.1.0/24 : un lab sain pour le dépannage. */
function healthyLan(): LabState {
  let s = createLab()
  const add = (kind: DeviceKind, name: string, x: number, y: number) => {
    const r = unwrap(addDevice(s, { kind, position: { x, y }, name }))
    s = r.state
    return r.value
  }
  const pc1 = add('client', 'PC1', 200, 160)
  const pc2 = add('client', 'PC2', 560, 160)
  const sw = add('switch', 'SW1', 380, 320)
  const port = (id: string, i: number) => ({ deviceId: id, ifaceId: s.devices[id]?.interfaces[i]?.id ?? '' })
  s = unwrap(connect(s, port(pc1, 0), port(sw, 0))).state
  s = unwrap(connect(s, port(pc2, 0), port(sw, 1))).state
  for (const [id, address] of [
    [pc1, '192.168.1.10'],
    [pc2, '192.168.1.20']
  ] as const)
    s = unwrap(
      setInterfaceIpv4(s, id, port(id, 0).ifaceId, {
        addressing: 'static',
        address,
        mask: '24',
        gateway: null,
        dnsServers: []
      })
    ).state
  return s
}

/** Première graine qui tire un masque erroné (réseau, difficulté 1) : le scénario connaît la réparation. */
function maskSeed(lab: LabState): { seed: number; device: string; address: string } {
  for (let seed = 1; seed < 500; seed++) {
    const r = startTroubleshooting(lab, { seed, domain: 'reseau', difficulty: 1, count: 1 })
    const fault = r.ok ? r.value.faults[0] : undefined
    if (fault?.id !== 'net.wrong-mask') continue
    const device = lab.devices[String(fault.params['device'])]
    const address = device?.interfaces.find((i) => i.id === fault.params['iface'])?.address
    if (device && address) return { seed, device: device.name, address }
  }
  throw new Error('Aucune graine ne tire de masque erroné')
}

test('Dépannage : ticket, indice, « Le problème persiste », réparation à la console, bilan', async () => {
  const lab = healthyLan()
  const { seed, device, address } = maskSeed(lab)
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, lab)
    await clickMenu(app, ['Fichier', 'Lancer un dépannage…'])
    const dialog = page.getByTestId('tshoot-dialog')
    await dialog.getByTestId('tshoot-difficulty').selectOption('1')
    await dialog.getByTestId('tshoot-domain').selectOption('reseau')
    await dialog.getByTestId('tshoot-seed').fill(String(seed))
    await dialog.getByTestId('tshoot-launch').click()

    // Ticket sans la cause, graine affichée pour rejouer
    const panel = page.getByTestId('tshoot-panel')
    await expect(panel.getByTestId('tshoot-tickets')).toContainText('ne parvient plus à joindre')
    await expect(panel.getByTestId('tshoot-tickets')).not.toContainText('masque')
    await expect(panel.getByTestId('tshoot-seed-shown')).toHaveText(`graine ${seed}`)

    // Indice : compté
    await expect(panel.getByTestId('tshoot-hints-count')).toHaveText('0 / 3')
    await panel.getByTestId('tshoot-hint').click()
    await expect(panel.getByTestId('tshoot-hints-count')).toHaveText('1 / 3')
    await expect(panel.getByTestId('tshoot-hints')).toContainText('Indice 1')

    // Annuler ne revient jamais avant l'injection : seul l'indice est annulable
    await clickMenu(app, ['Édition', 'Annuler : Demander un indice'])
    await expect(panel.getByTestId('tshoot-hints')).toHaveCount(0)
    await expect(panel.getByTestId('tshoot-hints-count')).toHaveText('1 / 3')

    // Rien n'est réparé : le problème persiste, sans dire quoi
    await panel.getByTestId('tshoot-repaired').click()
    await expect(panel.getByTestId('tshoot-persists')).toHaveText('Le problème persiste.')

    // Réparation à la console : adresse retirée puis remise avec le bon masque
    await openConsole(page, device, 'powershell')
    const term = page.getByTestId(`device-window-${device}`).getByTestId('terminal-powershell')
    await typeCommand(page, device, 'Remove-NetIPAddress -InterfaceAlias Ethernet0 -Confirm:$false')
    await typeCommand(
      page,
      device,
      `New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress ${address} -PrefixLength 24`
    )
    await expect(term).toContainText(address)
    await page.getByTestId(`device-window-${device}`).getByTestId('close-device-window').click()

    await panel.getByTestId('tshoot-repaired').click()

    // Bilan : cause, correction officielle, chemin le plus court, indices
    const summary = page.getByTestId('tshoot-summary')
    await expect(summary.getByTestId('tshoot-outcome')).toHaveText('Problème résolu')
    await expect(summary.getByTestId('tshoot-cause')).toContainText('Le masque de sous-réseau')
    await expect(summary.getByTestId('tshoot-official')).toHaveText('1 commande(s)')
    await expect(summary.getByTestId('tshoot-playedcount')).toHaveText('2 commande(s)')
    await expect(summary.getByTestId('tshoot-verdict')).toContainText('1 commande de plus')
    await expect(summary.getByTestId('tshoot-repair-steps').locator('li')).toHaveCount(1)
    await expect(summary).toContainText('Indices utilisés')
    await summary.getByTestId('tshoot-summary-close').click()
    await expect(page.getByTestId('tshoot-summary')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Dépannage chronométré : indices désactivés, abandon, bilan et note d’examen', async () => {
  const lab = healthyLan()
  const { seed } = maskSeed(lab)
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, lab)
    await clickMenu(app, ['Fichier', 'Lancer un dépannage…'])
    const dialog = page.getByTestId('tshoot-dialog')
    await dialog.getByTestId('tshoot-domain').selectOption('reseau')
    await dialog.getByTestId('tshoot-seed').fill(String(seed))
    await dialog.getByTestId('tshoot-exam').check()
    await dialog.getByTestId('tshoot-minutes').fill('15')
    await dialog.getByTestId('tshoot-launch').click()

    const panel = page.getByTestId('tshoot-panel')
    await expect(panel.getByTestId('exam-timer')).toHaveText(/^(15:00|14:5\d)$/)
    await expect(panel.getByTestId('tshoot-hint')).toHaveCount(0)

    await panel.getByTestId('tshoot-giveup').click()
    await page.getByTestId('modal-confirm').click()
    const summary = page.getByTestId('tshoot-summary')
    await expect(summary.getByTestId('tshoot-outcome')).toHaveText('Dépannage abandonné')
    await expect(summary.getByTestId('tshoot-score')).toContainText('0')
    await expect(summary.getByTestId('tshoot-cause')).toContainText('Le masque de sous-réseau')
    await expect(summary.getByTestId('tshoot-exam-grade')).toContainText('0 / 20')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
