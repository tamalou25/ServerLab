/**
 * Écran d'accueil : affiché au lancement sans fichier, labs récents (nom, dossier, date ; fichier
 * disparu signalé et retirable), nouveau lab, labs fournis, Fichier > Accueil, préférence
 * « Afficher l'accueil au démarrage ».
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addDevice, createLab, PATHWAY_PME, serializeSlab, unwrap } from '../../src/engine/index'
import { clickMenu, launchApp } from './helpers'

const home = (page: Page) => page.getByTestId('home-screen')

/** Lab d'un seul serveur, enregistré dans un fichier .slab. */
function writeLab(path: string): void {
  const lab = unwrap(
    addDevice(createLab(), { kind: 'server', position: { x: 200, y: 200 }, name: 'SRV1' })
  ).state
  writeFileSync(path, serializeSlab(lab, { savedAt: '2026-10-05T10:00:00.000Z', appVersion: '1.0.0' }))
}

test('premier lancement : accueil, labs fournis, nouveau lab, Fichier > Accueil', async () => {
  const { app, close, page, consoleErrors } = await launchApp({ home: true })
  try {
    await expect(home(page)).toBeVisible()
    await expect(page.getByTestId('home-recent-empty')).toHaveText('Aucun lab récent.')
    await expect(home(page)).toContainText('Ctrl+N')

    // Nouveau profil : le parcours est l'action principale, sans prétendre reprendre une session
    const next = page.getByTestId('home-next')
    await expect(next).toHaveAttribute('data-state', 'first')
    await expect(next).toContainText('Commencer le parcours')
    await expect(next).toContainText('1. Relier le bureau et l’atelier')
    await expect(next).toContainText('aucun travail en cours n’est repris')
    await expect(page.getByTestId('home-progress')).toContainText('0 / 12 étapes')
    await expect(page.getByTestId('home-tutorial')).toContainText('premier ping')

    // Sélection utile au lieu des 60 exercices : les labs « Débutant », puis l'accès au catalogue complet
    const total = readdirSync(resolve(__dirname, '../../labs')).filter((f) => f.endsWith('.json')).length
    const selection = page.locator('[data-testid^="home-lab-"]')
    await expect(selection).not.toHaveCount(0)
    expect(await selection.count()).toBeLessThan(10)
    const first = page.getByTestId('home-lab-lab-01-adressage')
    await expect(first).toContainText('Adressage IP et routage entre deux réseaux')
    await expect(first).toContainText('Débutant')
    await expect(first).toContainText('20 min')
    await expect(page.getByTestId('home-lab-lab-05-ntfs')).toHaveCount(0)
    await expect(page.getByTestId('home-catalog')).toContainText(`Voir les ${total} exercices`)
    await page.getByTestId('home-catalog').click()
    await expect(page.getByTestId('catalog-count')).toHaveText(`${total} exercices`)
    await expect(page.getByTestId('catalog-lab-lab-05-ntfs')).toContainText('Avancé')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('lab-picker')).toHaveCount(0)
    await expect(home(page)).toBeVisible()

    // Le canvas, masqué, ne reçoit pas les raccourcis (C : outil Câble)
    await page.keyboard.press('c')
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')

    // Nouveau lab : l'accueil laisse place au canvas
    await page.getByTestId('home-new').click()
    await expect(home(page)).toHaveCount(0)
    await expect(page.getByTestId('topology-canvas')).toBeVisible()
    await expect(page).toHaveTitle('Sans titre — ServerLab')

    // Fichier > Accueil le rouvre ; Échap le ferme
    await clickMenu(app, ['Fichier', 'Accueil'])
    await expect(home(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(home(page)).toHaveCount(0)

    // Un document chargé depuis le menu (Fichier > Nouveau) ferme aussi l'accueil
    await clickMenu(app, ['Fichier', 'Accueil'])
    await expect(home(page)).toBeVisible()
    await clickMenu(app, ['Fichier', 'Nouveau'])
    await expect(home(page)).toHaveCount(0)

    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('récents : fichier introuvable signalé puis retiré, fichier existant ouvert', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'serverlab-e2e-'))
  const folder = mkdtempSync(join(tmpdir(), 'serverlab-labs-'))
  const existing = join(folder, 'revision-dhcp.slab')
  const missing = join(folder, 'disparu.slab')
  writeLab(existing)
  // Tutoriel désactivé : seul l'écran d'accueil est vérifié ici
  writeFileSync(join(userData, 'settings.json'), '{ "language": "fr", "showTutorialOnStartup": false }')
  const now = Date.now()
  writeFileSync(
    join(userData, 'recent.json'),
    JSON.stringify([
      { path: existing, name: 'revision-dhcp.slab', openedAt: new Date(now).toISOString() },
      { path: missing, name: 'disparu.slab', openedAt: new Date(now - 86_400_000).toISOString() }
    ])
  )
  const recentPaths = () =>
    (JSON.parse(readFileSync(join(userData, 'recent.json'), 'utf8')) as { path: string }[]).map((r) => r.path)

  // Accueil non désactivé : affiché, comme pour un nouvel utilisateur
  const first = await launchApp({ userData })
  try {
    const rows = first.page.getByTestId('home-recent')
    await expect(rows).toHaveCount(2)

    // Fichier existant : nom, dossier, date
    await expect(rows.nth(0)).toContainText('revision-dhcp.slab')
    await expect(rows.nth(0)).toContainText(folder)
    await expect(rows.nth(0)).toContainText('Aujourd’hui')
    await expect(rows.nth(0)).not.toHaveAttribute('data-missing')

    // Fichier disparu : signalé, non ouvrable, retirable
    await expect(rows.nth(1)).toHaveAttribute('data-missing', 'true')
    await expect(rows.nth(1)).toContainText('Introuvable')
    await expect(rows.nth(1)).toContainText('Hier')
    await expect(rows.nth(1).getByRole('button', { name: /^disparu\.slab/ })).toBeDisabled()
    await rows.nth(1).getByTestId('home-recent-remove').click()
    await expect(rows).toHaveCount(1)
    await expect.poll(recentPaths).toEqual([existing])

    // Fichier supprimé pendant que l'accueil est affiché : erreur, puis signalé introuvable
    rmSync(existing)
    await rows
      .nth(0)
      .getByRole('button', { name: /^revision-dhcp\.slab/ })
      .click()
    await expect(first.page.getByTestId('modal')).toContainText('Fichier introuvable.')
    await first.page.getByTestId('modal-confirm').click()
    await expect(home(first.page)).toBeVisible()
    await expect(rows.nth(0)).toHaveAttribute('data-missing', 'true')
  } finally {
    await first.close()
  }

  // Relancement : l'entrée retirée ne revient pas ; le fichier retrouvé s'ouvre depuis l'accueil
  writeLab(existing)
  const second = await launchApp({ userData })
  try {
    const rows = second.page.getByTestId('home-recent')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).not.toHaveAttribute('data-missing')
    await rows
      .nth(0)
      .getByRole('button', { name: /^revision-dhcp\.slab/ })
      .click()
    await expect(home(second.page)).toHaveCount(0)
    await expect(second.page).toHaveTitle('revision-dhcp.slab — ServerLab')
    await expect(second.page.locator('.react-flow__node')).toHaveCount(1)
    expect(second.consoleErrors).toEqual([])
  } finally {
    await second.close()
  }
})

test('lab fourni ouvert depuis l’accueil ; « Afficher au démarrage » décoché conservé', async () => {
  const first = await launchApp({ home: true })
  try {
    await first.page.getByTestId('home-lab-lab-02-dhcp').click()
    await expect(home(first.page)).toHaveCount(0)
    await expect(first.page.getByTestId('lab-title')).toHaveText(
      'Distribuer les adresses avec un serveur DHCP'
    )

    await clickMenu(first.app, ['Fichier', 'Accueil'])
    const atStartup = first.page.getByTestId('home-at-startup')
    await expect(atStartup).toBeChecked()
    await atStartup.uncheck()
    await expect
      .poll(() => JSON.parse(readFileSync(join(first.userData, 'settings.json'), 'utf8')) as unknown)
      .toMatchObject({ showHomeOnStartup: false })
  } finally {
    await first.close()
  }

  // Relancement sans fichier : directement le canvas ; la case reste décochée
  const second = await launchApp({ userData: first.userData })
  try {
    await expect(second.page.getByTestId('topology-canvas')).toBeVisible()
    // Laisse au démarrage le temps de lire la préférence avant de vérifier l'absence d'accueil
    await second.page.waitForTimeout(500)
    await expect(home(second.page)).toHaveCount(0)
    await clickMenu(second.app, ['Fichier', 'Accueil'])
    await expect(second.page.getByTestId('home-at-startup')).not.toBeChecked()
  } finally {
    await second.close()
  }
})

test('parcours terminé : l’accueil ne recommande plus d’étape et renvoie au catalogue', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'serverlab-e2e-'))
  writeFileSync(join(userData, 'settings.json'), '{ "language": "fr", "showTutorialOnStartup": false }')
  // Une réussite récente par étape, dans le mode exigé (examen pour la révision différée)
  const finishedAt = new Date().toISOString()
  const attempts = PATHWAY_PME.steps.map((step, i) => ({
    id: `test-${i}`,
    labId: step.labId,
    mode: step.mode === 'exam' ? 'exam' : 'lab',
    finishedAt,
    passed: 1,
    total: 1,
    success: true,
    hintsUsed: 0,
    hintsAvailable: 0,
    gaveUp: false,
    competences: [...step.competences],
    pathwayId: PATHWAY_PME.id,
    stepId: step.id
  }))
  writeFileSync(join(userData, 'progress.json'), JSON.stringify({ formatVersion: 1, attempts }))
  const { close, page, consoleErrors } = await launchApp({ userData })
  try {
    const next = page.getByTestId('home-next')
    await expect(next).toHaveAttribute('data-state', 'done')
    await expect(next).toContainText('Parcours terminé')
    await expect(page.getByTestId('home-next-open')).toHaveCount(0)
    await expect(page.getByTestId('home-progress')).toContainText('12 / 12 étapes')
    await expect(page.getByTestId('home-pathway')).toContainText('Parcours terminé')
    // Sélection : seulement des exercices réellement travaillés, aucun « pour débuter »
    await expect(page.locator('[data-testid^="home-step-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="home-lab-"]')).toHaveCount(3)
    await next.getByTestId('home-next-catalog').click()
    await expect(page.getByTestId('catalog-search')).toBeFocused()
    await page.getByTestId('catalog-status-done').click()
    await expect(page.locator('[data-testid^="catalog-lab-"]')).toHaveCount(
      new Set(PATHWAY_PME.steps.map((s) => s.labId)).size
    )
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
