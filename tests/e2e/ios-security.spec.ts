import { expect, test, type Page } from '@playwright/test'
import {
  addDevice,
  connect,
  createLab,
  setInterfaceEnabled,
  setInterfaceIpv4,
  unwrap,
  type DeviceKind,
  type IosModel,
  type LabState
} from '../../src/engine/index'
import { openLab } from './fixtures'
import { cableDevices, clickMenu, launchApp, openConsole, placeDevice, typeCommand } from './helpers'

/** PC1 (192.168.1.10) — R1 Gi0/0 ; R1 Gi0/1 — PC2 (192.168.2.10). Routeur adressé et actif. */
function aclLab(): LabState {
  let s = createLab()
  const ids: Record<string, string> = {}
  const add = (kind: DeviceKind, name: string, x: number, y: number, model?: IosModel) => {
    const r = unwrap(addDevice(s, { kind, position: { x, y }, name, ...(model ? { model } : {}) }))
    s = r.state
    ids[name] = r.value
  }
  add('client', 'PC1', 100, 250)
  add('router', 'R1', 330, 250, 'c1921')
  add('client', 'PC2', 560, 250)
  const port = (name: string, i: number) => s.devices[ids[name]!]!.interfaces[i]!.id
  const link = (a: string, ia: number, b: string, ib: number) => {
    s = unwrap(
      connect(s, { deviceId: ids[a]!, ifaceId: port(a, ia) }, { deviceId: ids[b]!, ifaceId: port(b, ib) })
    ).state
  }
  link('PC1', 0, 'R1', 0)
  link('PC2', 0, 'R1', 1)
  const ip = (name: string, i: number, address: string, gateway: string | null) => {
    s = unwrap(
      setInterfaceIpv4(s, ids[name]!, port(name, i), {
        addressing: 'static',
        address,
        mask: '24',
        gateway,
        dnsServers: []
      })
    ).state
  }
  ip('PC1', 0, '192.168.1.10', '192.168.1.1')
  ip('PC2', 0, '192.168.2.10', '192.168.2.1')
  ip('R1', 0, '192.168.1.1', null)
  ip('R1', 1, '192.168.2.1', null)
  s = unwrap(setInterfaceEnabled(s, ids.R1!, port('R1', 0), true)).state
  s = unwrap(setInterfaceEnabled(s, ids.R1!, port('R1', 1), true)).state
  return s
}

async function cli(page: Page, device: string, lines: string[]): Promise<void> {
  if ((await page.getByTestId(`device-window-${device}`).count()) === 0)
    await page.getByTestId(`device-${device}`).dblclick()
  for (const line of lines) await typeCommand(page, device, line)
}

test('IOS : une ACL bloque le ping de PC1 vers PC2, visible en Simulation', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, aclLab())
    await openConsole(page, 'PC1', 'cmd')
    await typeCommand(page, 'PC1', 'ping 192.168.2.10')
    const pcTerm = page.getByTestId('device-window-PC1').getByTestId('terminal-cmd')
    await expect(pcTerm).toContainText('Réponse de 192.168.2.10')
    await page.getByTestId('device-window-PC1').getByTestId('close-device-window').click()

    await cli(page, 'R1', [
      'en',
      'conf t',
      'access-list 101 deny icmp host 192.168.1.10 host 192.168.2.10',
      'access-list 101 permit ip any any',
      'int g0/0',
      'ip access-group 101 in',
      'end',
      'show access-lists'
    ])
    await expect(page.getByTestId('device-window-R1').getByTestId('terminal-ios')).toContainText(
      '10 deny icmp host 192.168.1.10 host 192.168.2.10'
    )
    await page.getByTestId('device-window-R1').getByTestId('close-device-window').click()

    // Le ping échoue, le refus est expliqué dans la trace de Simulation (minimap masquée : elle recouvrirait
    // PC2 une fois le panneau Simulation ouvert)
    await clickMenu(app, ['Affichage', 'Afficher la minimap'])
    await page.getByTestId('mode-simulation').click()
    await page.getByTestId('tool-pdu').click()
    await page.getByTestId('device-PC1').click()
    await page.getByTestId('device-PC2').click()
    await expect(page.getByTestId('simulation-panel')).toBeVisible()
    for (let i = 0; i < 12; i++) {
      if (await page.getByTestId('sim-step').isDisabled()) break
      await page.getByTestId('sim-step').click()
    }
    // Le dernier paquet (ICMP) est rejeté : la note de l'évènement explique le refus de la liste d'accès
    await page.getByTestId('sim-events').locator('tbody tr').filter({ hasText: 'ICMP' }).last().click()
    await expect(page.getByTestId('pdu-details')).toContainText('liste d’accès 101, entrée 10')
    await expect(page.getByTestId('pdu-list')).toContainText('Échec')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('IOS : port-security, une violation met le port en err-disabled', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'c2960', 300, 200)
    await placeDevice(page, 'client', 150, 400)
    await placeDevice(page, 'client', 450, 400)
    await cableDevices(page, 'PC1', 'Ethernet0', 'SW1', 'Fa0/1')
    await cli(page, 'SW1', [
      'en',
      'conf t',
      'int fa0/1',
      'switchport mode access',
      'switchport port-security mac-address 0000.0000.0001',
      'switchport port-security',
      'end',
      'show port-security interface fa0/1'
    ])
    const term = page.getByTestId('device-window-SW1').getByTestId('terminal-ios')
    await expect(term).toContainText('Port Status                : Secure-shutdown')
    await expect(term).toContainText('Security Violation Count   : 1')
    await typeCommand(page, 'SW1', 'show interfaces fa0/1')
    await expect(term).toContainText('FastEthernet0/1 is down, line protocol is down (err-disabled)')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
