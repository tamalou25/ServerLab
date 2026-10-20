import { expect, test } from '@playwright/test'
import {
  addDevice,
  command,
  connect,
  dispatch,
  localToken,
  setInterfaceIpv4,
  unwrap,
  type LabState
} from '../../src/engine/index'
import { domainLab, openLab } from './fixtures'
import { launchApp, typeCommand } from './helpers'

/** Lab de domaine + partage Compta (GG_Compta : modification) + poste Linux statique. */
function linuxLab(): LabState {
  let s = domainLab()
  const srv = Object.values(s.devices).find((d) => d.name === 'SRV1')!.id
  const shared = dispatch(
    s,
    command(
      'files.shareFolder',
      srv,
      { name: 'Compta', path: 'C:\\Compta', change: ['LAB\\GG_Compta'] },
      localToken('SRV1', 'Administrateur')
    )
  )
  if (!shared.ok) throw new Error(shared.error.message)
  // NTFS : GG_Compta peut modifier le contenu du dossier partagé
  const ntfs = dispatch(
    shared.state,
    command(
      'files.setNtfsEntry',
      srv,
      'C:\\Compta',
      // Identifiant du groupe (comme le sélecteur de comptes de l'onglet Sécurité)
      shared.state.domains['lab.local']!.groups.find((g) => g.name === 'GG_Compta')!.id,
      { allow: ['Modify'], deny: [] },
      localToken('SRV1', 'Administrateur')
    )
  )
  if (!ntfs.ok) throw new Error(ntfs.error.message)
  s = ntfs.state
  const lnx = unwrap(addDevice(s, { kind: 'client', os: 'linux', position: { x: 560, y: 320 } }))
  s = lnx.state
  const sw = Object.values(s.devices).find((d) => d.name === 'SW1')!
  const used = new Set(Object.values(s.links).flatMap((l) => [l.a.ifaceId, l.b.ifaceId]))
  const port = sw.interfaces.find((i) => !used.has(i.id))!
  const eth0 = s.devices[lnx.value]!.interfaces[0]!.id
  s = unwrap(connect(s, { deviceId: lnx.value, ifaceId: eth0 }, { deviceId: sw.id, ifaceId: port.id })).state
  return unwrap(
    setInterfaceIpv4(s, lnx.value, eth0, {
      addressing: 'static',
      address: '192.168.1.50',
      mask: '24',
      gateway: null,
      dnsServers: ['192.168.1.1']
    })
  ).state
}

test('Poste Linux : console bash, jonction au domaine, partage monté selon les droits', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, linuxLab())
    await page.getByTestId('device-LNX1').dblclick()
    const win = page.getByTestId('device-window-LNX1')
    await expect(win.getByTestId('tab-desktop')).toHaveCount(0)
    await win.getByTestId('tab-console').click()
    const terminal = win.getByTestId('console-bash')
    await expect(terminal).toContainText('Ubuntu 22.04 LTS (simulé)')
    await expect(terminal).toContainText('etudiant@LNX1:~$')

    await typeCommand(page, 'LNX1', 'ip a')
    await expect(terminal).toContainText('inet 192.168.1.50/24 brd 192.168.1.255 scope global eth0')

    await typeCommand(page, 'LNX1', 'sudo realm join -U Administrateur lab.local')
    await expect(terminal).toContainText('Password for Administrateur:')
    await typeCommand(page, 'LNX1', 'P@ssw0rd')
    await typeCommand(page, 'LNX1', 'realm list')
    await expect(terminal).toContainText('configured: kerberos-member')

    await typeCommand(page, 'LNX1', 'sudo mount -t cifs //srv1/Compta /mnt/compta -o username=jdupont')
    await expect(terminal).toContainText('Password for jdupont@//srv1/Compta:')
    await typeCommand(page, 'LNX1', 'Azerty123!')
    await typeCommand(page, 'LNX1', 'touch /mnt/compta/rapport.txt')
    await typeCommand(page, 'LNX1', 'ls /mnt/compta')
    await expect(terminal).not.toContainText('Permission denied')
    await expect(terminal.getByText('rapport.txt', { exact: true })).toBeVisible()

    // mmartin n'est pas membre de GG_Compta : connexion au partage refusée
    await typeCommand(page, 'LNX1', 'sudo mount -t cifs //srv1/Compta /mnt/autre -o username=mmartin')
    await typeCommand(page, 'LNX1', 'Azerty123!')
    await expect(terminal).toContainText('mount error(13): Permission denied')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Palette : serveur Linux posé, console bash ouverte', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await page.getByTestId('palette-linux-server').click()
    await page.getByTestId('topology-canvas').click({ position: { x: 400, y: 300 } })
    await expect(page.getByTestId('device-LSRV1')).toBeVisible()
    await expect(page.getByTestId('properties-panel')).toContainText('Serveur Linux')
    await page.getByTestId('device-LSRV1').dblclick()
    const win = page.getByTestId('device-window-LSRV1')
    await expect(win.getByTestId('tab-desktop')).toHaveCount(0)
    await win.getByTestId('tab-console').click()
    await expect(win.getByTestId('console-bash')).toContainText('admin@LSRV1:~$')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Palette : poste Linux placé sur le canvas', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await page.getByTestId('palette-linux').click()
    await page.getByTestId('topology-canvas').click({ position: { x: 400, y: 300 } })
    await expect(page.getByTestId('device-LNX1')).toBeVisible()
    await expect(page.getByTestId('properties-panel')).toContainText('Poste Linux')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
