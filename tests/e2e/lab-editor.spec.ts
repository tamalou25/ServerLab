import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { domainLab, openLab } from './fixtures'
import { clickMenu, launchApp } from './helpers'

test('Éditeur de labs : énoncé, critère testé sur le lab courant, export puis import avec indices progressifs', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'serverlab-editeur-')), 'mon-lab')
  const { app, close, page, consoleErrors } = await launchApp()
  try {
    await openLab(app, page, domainLab())
    // Dialogues natifs simulés : enregistrement puis ouverture du même fichier
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path
      })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [`${path}.json`]
      })) as typeof dialog.showOpenDialog
      // « Enregistrer les modifications ? » : Ne pas enregistrer
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    }, file)

    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-create').click()
    const editor = page.getByTestId('lab-editor')
    await expect(editor.getByTestId('editor-start-info')).toHaveText('Topologie de départ : 3 équipement(s)')
    await editor.getByTestId('editor-title').fill('Serveur web de la compta')
    await editor.getByTestId('editor-summary').fill('Installer IIS sur SRV1.')
    await editor.getByTestId('editor-statement').fill('## Objectif\n\nInstallez le rôle **IIS** sur SRV1.')
    await editor.getByTestId('editor-preview-toggle').click()
    await expect(editor.getByTestId('editor-preview').getByRole('heading')).toHaveText('Objectif')

    // Critère construit sans code, testé sur le lab courant
    await editor.getByTestId('editor-new-type').selectOption('featureInstalled')
    await editor.getByTestId('editor-add-criterion').click()
    const criterion = editor.getByTestId('editor-criterion-0')
    await expect(criterion.getByTestId('editor-error')).toContainText('obligatoire')
    await criterion.getByTestId('editor-label').fill('IIS est installé sur SRV1')
    await criterion.getByTestId('editor-field-device').fill('SRV1')
    await criterion.getByTestId('editor-field-feature').fill('Web-Server')
    await expect(criterion.getByTestId('editor-error')).toHaveCount(0)
    await criterion.getByTestId('editor-hint-0').fill('Un rôle s’ajoute depuis le Gestionnaire de serveur.')
    await criterion.getByTestId('editor-add-hint').click()
    await criterion
      .getByTestId('editor-hint-1')
      .fill('Gérer › Ajouter des rôles et fonctionnalités › Serveur Web (IIS).')
    await criterion.getByTestId('editor-test').click()
    await expect(criterion.getByTestId('editor-result')).toHaveAttribute('data-state', 'ko')

    // Export JSON (extension complétée), contenu validé
    await editor.getByTestId('editor-export').click()
    await expect(page.getByText(`Lab exporté : ${file}.json`)).toBeVisible()
    const exported = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as {
      id: string
      title: string
      start: { snapshot: { app: string } }
      criteria: { hint: string; hints: string[] }[]
    }
    expect(exported.id).toBe('custom-serveur-web-de-la-compta')
    expect(exported.start.snapshot.app).toBe('ServerLab')
    expect(exported.criteria[0]?.hints).toHaveLength(1)
    await editor.getByTestId('editor-close').click()

    // Import depuis le sélecteur : le lab s'ouvre, indices progressifs après un échec
    await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
    await page.getByTestId('lab-import').click()
    await expect(page.getByTestId('lab-title')).toHaveText('Serveur web de la compta')
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await page.getByTestId('lab-check').click()
    await page.getByTestId('lab-hint-toggle-c1').click()
    const hint = page.getByTestId('lab-hint-c1')
    await expect(hint).toContainText('Gestionnaire de serveur')
    await expect(hint).not.toContainText('Serveur Web (IIS)')
    await page.getByTestId('lab-more-hint-c1').click()
    await expect(hint).toContainText(
      'Indice 2 : Gérer › Ajouter des rôles et fonctionnalités › Serveur Web (IIS).'
    )
    await expect(page.getByTestId('lab-more-hint-c1')).toHaveCount(0)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
