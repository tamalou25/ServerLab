import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { clickMenu, configureHostIp, launchApp } from './helpers'

test('Mode examen : chronomètre, sans indice, sortie signalée, note détaillée exportée', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'serverlab-examen-')), 'resultat')
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path
      })) as typeof dialog.showSaveDialog
    }, file)
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-01-adressage').click()

    // Démarrage : chronomètre de la durée du lab, plus de bouton Vérifier
    await page.getByTestId('exam-start').click()
    await page.getByTestId('modal-confirm').click()
    await expect(page.getByTestId('exam-banner')).toBeVisible()
    await expect(page.getByTestId('exam-timer')).toHaveText(/^(20:00|19:5\d)$/)
    await expect(page.getByTestId('lab-check')).toHaveCount(0)

    // Une partie du travail ; les indices restent masqués
    await configureHostIp(page, 'PC1', '192.168.10.10', '255.255.255.0', '192.168.10.254')
    await page.getByTestId('mission-tab-mission').click()
    await expect(page.getByTestId('lab-hint-pc1-ip')).toHaveCount(0)
    // Ni aide dépliable, ni résumé de vérification : rien dans le DOM avant la fin de l'examen
    await expect(page.locator('[data-testid^="lab-hint-"]')).toHaveCount(0)
    await expect(page.getByTestId('lab-verification')).toHaveCount(0)

    // Sortie de l'application (perte du focus) puis retour
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    await expect(page.getByTestId('exam-banner')).toContainText('1 sortie(s) de l’application signalée(s)')

    // Vérification finale unique : note détaillée
    await page.getByTestId('exam-finish').click()
    await page.getByTestId('modal-confirm').click()
    const result = page.getByTestId('exam-result')
    await expect(result.getByTestId('exam-ending')).toHaveText('Terminé par le candidat')
    await expect(result.getByTestId('exam-criteria').locator('[data-state="ok"]')).not.toHaveCount(0)
    await expect(result.getByTestId('exam-criteria').locator('[data-state="ko"]')).not.toHaveCount(0)
    await expect(result.getByTestId('exam-exits')).toContainText('Application quittée')
    const grade = await result.getByTestId('exam-grade').innerText()
    expect(grade).toMatch(/^\d+(,\d)?\s*\/ 20$/)

    // Export du résultat (extension complétée)
    await result.getByTestId('exam-export').click()
    await expect(page.getByText(`Résultat enregistré : ${file}.txt`)).toBeVisible()
    const text = readFileSync(`${file}.txt`, 'utf8')
    expect(text).toContain('Résultat d’examen — Adressage IP et routage entre deux réseaux')
    expect(text).toContain('Sorties du mode examen (1)')
    expect(text).toContain('Fin : terminé par le candidat')

    // Retour au lab : vérification normale de nouveau disponible
    await result.getByTestId('exam-close').click()
    await expect(page.getByTestId('lab-check')).toBeVisible()
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})

test('Mode examen : quitter le lab pendant l’épreuve est signalé comme abandon', async () => {
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-open-lab-01-adressage').click()
    await page.getByTestId('exam-start').click()
    await page.getByTestId('modal-confirm').click()
    await page.getByTestId('lab-quit').click()
    const result = page.getByTestId('exam-result')
    await expect(result.getByTestId('exam-ending')).toHaveText('Abandonné avant la fin')
    await expect(result.getByTestId('exam-exits')).toContainText('Examen abandonné')
    await expect(result.getByTestId('exam-grade')).toContainText('0')
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
