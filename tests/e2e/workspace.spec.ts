import { expect, test } from '@playwright/test'
import { clickMenu, launchApp, placeDevice } from './helpers'

test('Espaces : Atelier par défaut, Mission après l’ouverture d’un lab, sélection et fenêtres préservées', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    const rail = page.getByTestId('app-rail')
    await expect(rail.getByTestId('rail-atelier')).toHaveAttribute('aria-current', 'page')
    await expect(rail.getByTestId('rail-mission')).toBeDisabled()
    await expect(rail.getByTestId('rail-teacher')).toHaveCount(0)
    await expect(page.getByTestId('header-workspace')).toHaveText('Atelier')
    // Espace Mission demandé sans lab : refusé, l'Atelier reste affiché
    await clickMenu(app, ['Affichage', 'Espace', 'Mission'])
    await expect(page.getByText('Cet espace n’est pas disponible pour le moment.')).toBeVisible()
    await expect(rail.getByTestId('rail-atelier')).toHaveAttribute('aria-current', 'page')

    // Un lab ouvert bascule sur l'espace Mission : contexte à gauche, lecteur à droite, plan au centre
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-01-adressage').click()
    await expect(rail.getByTestId('rail-mission')).toHaveAttribute('aria-current', 'page')
    // Le titre n'est affiché qu'une fois (lecteur) ; la barre latérale donne le régime et les consoles
    await expect(page.getByTestId('mission-regime')).toHaveAttribute('data-regime', 'lab')
    await expect(page.getByTestId('lab-title')).toHaveCount(1)
    await expect(page.getByTestId('mission-sidebar')).not.toContainText('Adressage IP')
    await expect(page.getByTestId('mission-reader').getByTestId('lab-panel')).toBeVisible()
    await expect(page.getByTestId('lab-check')).toBeVisible()
    await expect(page.getByTestId('inspector')).toHaveCount(0)

    // Le plan reste utilisable : sélection d'un équipement, visible dans l'onglet Résumé du lecteur
    await page.getByTestId('device-PC1').click()
    await page.getByTestId('mission-tab-summary').click()
    await expect(page.getByTestId('properties-panel')).toContainText('PC1')
    await page.getByTestId('device-PC1').dblclick()
    await expect(page.getByTestId('device-window-PC1')).toBeVisible()

    // Retour à l'Atelier : sélection, fenêtre et document inchangés
    await rail.getByTestId('rail-atelier').click()
    await expect(page.getByTestId('inspector')).toBeVisible()
    await expect(page.getByTestId('palette')).toBeVisible()
    await expect(page.getByTestId('properties-panel')).toContainText('PC1')
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
    await expect(page.getByTestId('device-window-PC1')).toBeVisible()
    await expect(page.getByTestId('mission-sidebar')).toHaveCount(0)
    await clickMenu(app, ['Affichage', 'Espace', 'Mission'])
    await expect(page.getByTestId('mission-reader')).toBeVisible()
    await expect(page.getByTestId('mission-tab-summary')).toHaveAttribute('aria-selected', 'true')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Espace Enseignant : page recouvrante, plan inerte, raccourcis et fenêtres neutralisés, retour à l’Atelier', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await placeDevice(page, 'server', 300, 200)
    await page.getByTestId('device-SRV1').dblclick()
    await expect(page.getByTestId('device-window-SRV1')).toBeVisible()

    await clickMenu(app, ['Affichage', 'Mode enseignant'])
    const rail = page.getByTestId('app-rail')
    await expect(rail.getByTestId('rail-teacher')).toBeVisible()
    await rail.getByTestId('rail-teacher').click()
    const workspace = page.getByTestId('teacher-workspace')
    await expect(workspace).toBeVisible()
    await expect(page.getByTestId('header-workspace')).toHaveText('Enseignant')
    // Le titre reçoit le focus ; la zone recouverte est inerte ; les fenêtres d'équipement sont retirées
    await expect(workspace.getByRole('heading', { level: 1 })).toBeFocused()
    await expect(page.getByTestId('palette')).toHaveCount(1)
    expect(await page.getByTestId('palette').evaluate((el) => el.closest('[inert]') !== null)).toBe(true)
    await expect(page.getByTestId('device-window-SRV1')).toHaveCount(0)
    await expect(page.getByTestId('simulation-panel')).toHaveCount(0)
    // Raccourcis du canvas sans effet : l'outil reste Sélection, l'équipement n'est pas supprimé
    await page.keyboard.press('c')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await clickMenu(app, ['Édition', 'Tout sélectionner'])
    await clickMenu(app, ['Édition', 'Supprimer'])
    await rail.getByTestId('rail-atelier').click()
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('device-SRV1')).toBeVisible()
    await expect(page.getByTestId('device-window-SRV1')).toBeVisible()
    await expect(rail.getByTestId('rail-teacher')).toBeFocused()

    // Mode désactivé depuis l'espace Enseignant : retour à l'Atelier, entrée du rail retirée
    await rail.getByTestId('rail-teacher').click()
    await expect(workspace).toBeVisible()
    await clickMenu(app, ['Affichage', 'Mode enseignant'])
    await expect(workspace).toHaveCount(0)
    await expect(rail.getByTestId('rail-teacher')).toHaveCount(0)
    await expect(rail.getByTestId('rail-atelier')).toHaveAttribute('aria-current', 'page')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Panneaux redimensionnables : poignée au clavier, largeur bornée et mémorisée', async () => {
  const { app, close, page, consoleErrors, userData } = await launchApp()
  try {
    const handle = page.getByTestId('inspector-resize')
    await expect(handle).toHaveAttribute('aria-valuenow', '348')
    await handle.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(handle).toHaveAttribute('aria-valuenow', '380')
    await page.keyboard.press('End')
    await expect(handle).toHaveAttribute('aria-valuenow', '480')
    await page.keyboard.press('Home')
    await expect(handle).toHaveAttribute('aria-valuenow', '280')
    await page.keyboard.press('Enter')
    await expect(handle).toHaveAttribute('aria-valuenow', '348')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('inspector')).toHaveCSS('width', '364px')

    // Lecteur de mission : bouton Élargir (560 px) puis retour
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-01-adressage').click()
    await expect(page.getByTestId('mission-resize')).toHaveAttribute('aria-valuenow', '440')
    await page.getByTestId('mission-expand').click()
    await expect(page.getByTestId('mission-reader')).toHaveCSS('width', '560px')
    await expect(page.getByTestId('mission-expand')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('mission-expand').click()
    await expect(page.getByTestId('mission-reader')).toHaveCSS('width', '440px')
    expect(consoleErrors).toEqual([])
    await close()

    // Largeur de l'inspecteur retrouvée au lancement suivant (préférence du poste)
    const second = await launchApp({ userData })
    try {
      await expect(second.page.getByTestId('inspector-resize')).toHaveAttribute('aria-valuenow', '364')
    } finally {
      await second.close()
    }
  } finally {
    await close().catch(() => undefined)
  }
})
