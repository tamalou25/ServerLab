import { expect, test } from '@playwright/test'
import { launchApp, openConsole, openTool, placeDevice, typeCommand } from './helpers'

test('Services : DNS arrêté puis redémarré dans services.msc, alerte rouge du Gestionnaire de serveur', async () => {
  const { close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 220, 160)
    await openConsole(page, 'SRV1', 'powershell')
    await typeCommand(page, 'SRV1', 'Install-WindowsFeature DNS -IncludeManagementTools')
    const srv = page.getByTestId('device-window-SRV1')
    await expect(srv.getByTestId('terminal-powershell')).toContainText('Serveur DNS')

    await openTool(page, 'SRV1', 'services')
    const svc = srv.getByTestId('app-services')
    await expect(svc.getByTestId('svc-status-DNS')).toHaveText('En cours d’exécution')
    await svc.getByTestId('svc-row-DNS').click()
    await svc.getByTestId('svc-stop').click()
    await expect(svc.getByTestId('svc-status-DNS')).toHaveText('Arrêté')

    // Démarrage automatique + arrêté : signalé en rouge dans le Gestionnaire de serveur
    await srv.getByTestId('sm-nav-local').dispatchEvent('click')
    await expect(srv.getByTestId('sm-alert-DNS')).toBeVisible()

    await svc.getByTestId('svc-restart').click()
    await expect(svc.getByTestId('svc-status-DNS')).toHaveText('En cours d’exécution')

    // Propriétés : type de démarrage modifiable, dépendances en lecture seule
    await svc.getByTestId('svc-properties').click()
    await svc.getByRole('tab', { name: 'Dépendances' }).click()
    await expect(svc.getByTestId('svc-deps')).toContainText('aucune')
    await svc.getByRole('tab', { name: 'Général' }).click()
    await svc.getByTestId('svc-starttype').selectOption('Manual')
    await svc.getByTestId('svc-ok').click()
    await expect(svc.getByTestId('svc-start-DNS')).toHaveText('Manuel')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
