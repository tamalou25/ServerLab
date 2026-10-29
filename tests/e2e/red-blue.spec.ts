import { expect, test } from '@playwright/test'
import { redBlueLab } from '../cyber-lab'
import { openLab } from './fixtures'
import { launchApp } from './helpers'

const SCENARIOS = ['auth-repetee', 'compte-service', 'reutilisation-acces', 'usurpation-arp', 'saut-de-vlan']

test('Mode Red/Blue : partie Red jouable du début à l’écran de fin', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, redBlueLab())
    // Le panneau Scénarios fait partie du mode Simulation
    await page.getByTestId('mode-simulation').click()
    await page.getByTestId('game-open').click()
    await expect(page.getByTestId('game-setup')).toBeVisible()

    // Red : tous les scénarios, dans l'ordre de l'attaque
    await page.getByTestId('game-play-red').click()
    await expect(page.getByTestId('game-side')).toHaveText('Vous jouez Red')
    for (const id of SCENARIOS) await page.getByTestId(`game-pick-${id}`).check()
    await page.getByTestId('game-begin').click()
    await expect(page.getByTestId('game-turn')).toHaveText('Tour 1/8')

    for (let i = 0; i < SCENARIOS.length; i++) await page.getByTestId('game-next').click()

    // Écran de fin : résultat, score par camp, chronologie
    await expect(page.getByTestId('game-over')).toBeVisible()
    await expect(page.getByTestId('game-verdict')).toBeVisible()
    await expect(page.getByTestId('game-score-red')).toContainText('Scénarios réussis')
    await expect(page.getByTestId('game-score-blue')).toContainText('Attaques bloquées')
    await expect(page.getByTestId('game-timeline')).toContainText(
      'Red · Authentification répétée sur un compte'
    )

    // Rejouer ramène au choix du camp
    await page.getByTestId('game-again').click()
    await expect(page.getByTestId('game-setup')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Mode Red/Blue : partie Blue (durcissement, analyse des journaux)', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, redBlueLab())
    // Le panneau Scénarios fait partie du mode Simulation
    await page.getByTestId('mode-simulation').click()
    await page.getByTestId('game-open').click()
    await page.getByTestId('game-play-blue').click()
    await expect(page.getByTestId('game-side')).toHaveText('Vous jouez Blue')

    // Préparation : verrouillage de compte et inspection ARP avant l'attaque
    await page.getByTestId('game-harden-lockout').click()
    await page.getByTestId('game-harden-dai').click()
    await page.getByTestId('game-begin').click()
    await expect(page.getByTestId('game-turn')).toHaveText('Tour 1/8')

    // Chaque tour : Red joue un scénario, Blue analyse les journaux
    for (let i = 0; i < SCENARIOS.length; i++) {
      if (await page.getByTestId('game-over').isVisible()) break
      await page.getByTestId('game-analyse').click()
    }
    await expect(page.getByTestId('game-over')).toBeVisible()
    await expect(page.getByTestId('game-score-blue')).toContainText('Attaques bloquées')
    await expect(page.getByTestId('game-score-blue')).toContainText('Contre-mesures appliquées : 2')
    await expect(page.getByTestId('game-timeline')).toContainText(
      'Blue · contre-mesure : Activer le verrouillage de compte'
    )
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
