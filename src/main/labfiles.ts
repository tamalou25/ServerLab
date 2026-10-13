/**
 * Import et export des labs créés avec l'éditeur (fichiers JSON) : dialogues natifs uniquement,
 * taille bornée. Le contenu est validé par le moteur côté renderer (schéma zod du format de lab).
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { MAX_LAB_BYTES, type FileResult } from '../shared/ipc'
import { writeAtomic } from './atomic'
import { t } from './i18n'

/** Filtre des dialogues (libellé dans la langue de l'interface). */
const labFilters = () => [{ name: t('main.filter.labJson'), extensions: ['json'] }]

/** Dialogue « Ouvrir » : texte du fichier choisi (au plus MAX_LAB_BYTES). */
export async function importLabFile(win: BrowserWindow): Promise<FileResult<string>> {
  const res = await dialog.showOpenDialog(win, {
    title: t('main.dialog.importLab'),
    filters: labFilters(),
    properties: ['openFile']
  })
  const path = res.filePaths[0]
  if (res.canceled || !path) return { ok: false, canceled: true }
  try {
    if ((await fs.stat(path)).size > MAX_LAB_BYTES) return { ok: false, error: t('main.error.labTooLarge') }
    return { ok: true, value: await fs.readFile(path, 'utf8') }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Dialogue « Enregistrer sous » puis écriture du lab (JSON). Renvoie le chemin choisi. */
export async function exportLabFile(
  win: BrowserWindow,
  content: unknown,
  suggestedName: unknown
): Promise<FileResult<string>> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_LAB_BYTES)
    return { ok: false, error: t('main.error.params') }
  const name =
    typeof suggestedName === 'string' && /^[^\\/:*?"<>|]{1,80}$/.test(suggestedName) ? suggestedName : 'lab'
  const res = await dialog.showSaveDialog(win, {
    title: t('main.dialog.exportLab'),
    defaultPath: join(app.getPath('documents'), `${name}.json`),
    filters: labFilters()
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  const path = extname(res.filePath).toLowerCase() === '.json' ? res.filePath : `${res.filePath}.json`
  try {
    await writeAtomic(path, content)
    return { ok: true, value: path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Résultat d'examen : dialogue « Enregistrer sous » puis fichier texte. */
export async function exportExamResult(
  win: BrowserWindow,
  content: unknown,
  suggestedName: unknown
): Promise<FileResult<string>> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_LAB_BYTES)
    return { ok: false, error: t('main.error.params') }
  const name =
    typeof suggestedName === 'string' && /^[^\\/:*?"<>|]{1,80}$/.test(suggestedName)
      ? suggestedName
      : 'resultat-examen'
  const res = await dialog.showSaveDialog(win, {
    title: t('main.dialog.exportExam'),
    defaultPath: join(app.getPath('documents'), `${name}.txt`),
    filters: [{ name: t('main.filter.text'), extensions: ['txt'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  const path = extname(res.filePath).toLowerCase() === '.txt' ? res.filePath : `${res.filePath}.txt`
  try {
    await writeAtomic(path, content)
    return { ok: true, value: path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
