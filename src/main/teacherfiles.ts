/**
 * Fichiers du mode enseignant (.slabsujet, .slabrendu, .slabcorrection, CSV de la classe) :
 * dialogues natifs uniquement, type et taille vérifiés ici, écriture atomique. Le contenu est
 * validé par le moteur côté renderer (schémas zod stricts).
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  MAX_TEACHER_BYTES,
  MAX_TEACHER_FILES,
  TEACHER_EXTENSIONS,
  TEACHER_FILE_KINDS,
  type FileResult,
  type OpenedFile,
  type TeacherFileKind
} from '../shared/ipc'
import { writeAtomic } from './atomic'
import { t } from './i18n'

function isKind(value: unknown): value is TeacherFileKind {
  return typeof value === 'string' && (TEACHER_FILE_KINDS as readonly string[]).includes(value)
}

const filters = (kind: TeacherFileKind) => [
  { name: t(`main.filter.teacher.${kind}`), extensions: [TEACHER_EXTENSIONS[kind]] }
]

/** Dialogue « Enregistrer sous » puis écriture atomique. Renvoie le chemin choisi. */
export async function saveTeacherFile(
  win: BrowserWindow,
  kind: unknown,
  content: unknown,
  suggestedName: unknown
): Promise<FileResult<string>> {
  if (
    !isKind(kind) ||
    typeof content !== 'string' ||
    Buffer.byteLength(content, 'utf8') > MAX_TEACHER_BYTES[kind]
  )
    return { ok: false, error: t('main.error.params') }
  const ext = TEACHER_EXTENSIONS[kind]
  const name =
    typeof suggestedName === 'string' && /^[^\\/:*?"<>|]{1,80}$/.test(suggestedName) ? suggestedName : kind
  const res = await dialog.showSaveDialog(win, {
    title: t(`main.dialog.teacherSave.${kind}`),
    defaultPath: join(app.getPath('documents'), `${name}.${ext}`),
    filters: filters(kind)
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  const path = extname(res.filePath).toLowerCase() === `.${ext}` ? res.filePath : `${res.filePath}.${ext}`
  try {
    await writeAtomic(path, content)
    return { ok: true, value: path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Dialogue « Ouvrir » : plusieurs rendus à la fois, un seul fichier sinon. */
export async function openTeacherFiles(win: BrowserWindow, kind: unknown): Promise<FileResult<OpenedFile[]>> {
  if (!isKind(kind) || kind === 'csv') return { ok: false, error: t('main.error.params') }
  const res = await dialog.showOpenDialog(win, {
    title: t(`main.dialog.teacherOpen.${kind}`),
    filters: filters(kind),
    properties: kind === 'rendu' ? ['openFile', 'multiSelections'] : ['openFile']
  })
  if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
  if (res.filePaths.length > MAX_TEACHER_FILES)
    return { ok: false, error: t('main.error.teacherTooMany', { max: MAX_TEACHER_FILES }) }
  const files: OpenedFile[] = []
  try {
    for (const path of res.filePaths) {
      if ((await fs.stat(path)).size > MAX_TEACHER_BYTES[kind])
        return { ok: false, error: t('main.error.teacherTooLarge', { name: basename(path) }) }
      files.push({ path, name: basename(path), content: await fs.readFile(path, 'utf8') })
    }
    return { ok: true, value: files }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
