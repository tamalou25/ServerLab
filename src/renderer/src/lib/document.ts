/**
 * Opérations sur le document : nouveau, ouvrir, enregistrer, récupération après incident.
 * Le contenu est validé par le moteur (parseSlab) ; le main ne fait que lire/écrire.
 */
import { createLab, parseSlab, serializeSlab } from '@engine/index'
import { UNTITLED, useLabStore } from '../store/lab'
import { useConsoleStore } from '../store/console'
import { useDesktopStore } from '../store/desktop'
import { useLabsStore } from '../store/labs'
import { useSimStore } from '../store/sim'
import { useTutorialStore } from '../store/tutorial'
import { useUiStore } from '../store/ui'
import { getFlowInstance } from './flow'
import { labById } from './labCatalog'
import { t } from './i18n'

function api() {
  return window.serverlab
}

/** Nom du document affiché (« Sans titre » / « Untitled » selon la langue tant qu'il n'a pas de nom). */
export function documentName(): string {
  const { filePath, fileName } = useLabStore.getState()
  return displayName(fileName, filePath)
}

/** Nom affiché pour un nom de fichier : le nom par défaut est traduit. */
export function displayName(fileName: string, filePath: string | null): string {
  return filePath === null && fileName === UNTITLED ? t('main.untitled') : fileName
}

/** Sérialise le document courant au format .slab. */
export function serializeCurrent(): string {
  const { lab } = useLabStore.getState()
  const fileName = documentName()
  const viewport = getFlowInstance()?.getViewport() ?? null
  return serializeSlab(lab, {
    savedAt: new Date().toISOString(),
    appVersion: useUiStore.getState().appVersion,
    viewport,
    meta: { title: fileName.replace(/\.slab$/i, ''), labId: useLabsStore.getState().active?.id ?? '' }
  })
}

/** Réinitialise l'interface liée au document (sélection, fenêtres, câblage). */
export function resetDocumentUi(): void {
  const ui = useUiStore.getState()
  ui.clearSelection()
  ui.setCableStart(null)
  ui.setPduSource(null)
  ui.clearPduResults()
  for (const w of ui.windows) ui.closeWindow(w.deviceId)
  useSimStore.getState().discard()
  useConsoleStore.getState().reset()
  useDesktopStore.getState().reset()
  ui.setLastAutosave(null)
}

/** Charge un contenu .slab ; affiche une erreur explicite s'il est invalide. */
export function loadContent(
  content: string,
  file: { path: string | null; name: string },
  dirty = false
): boolean {
  const parsed = parseSlab(content)
  if (!parsed.ok) {
    useUiStore.getState().showModal({ title: t('document.openFailed'), message: parsed.message })
    return false
  }
  resetDocumentUi()
  useLabStore.getState().load(parsed.doc.lab, file, parsed.doc.ui.viewport, dirty)
  // Lab pédagogique enregistré avec le document : le panneau Lab est rétabli
  const lab = parsed.doc.meta.labId ? labById(parsed.doc.meta.labId) : undefined
  useLabsStore.getState().setActive(lab ?? null)
  if (lab) useUiStore.getState().openMission()
  return true
}

/**
 * Si le document a des modifications non enregistrées, demande quoi faire.
 * Renvoie vrai si l'on peut continuer (enregistré ou abandonné).
 */
export async function confirmDiscard(): Promise<boolean> {
  const { dirty } = useLabStore.getState()
  if (!dirty) return true
  const choice = await api().askSaveChanges(documentName())
  if (choice === 'cancel') return false
  if (choice === 'save') return saveDocument()
  return true
}

/** Nouveau lab vide. Renvoie faux si l'utilisateur a annulé (« Enregistrer les modifications ? »). */
export async function newDocument(): Promise<boolean> {
  if (!(await confirmDiscard())) return false
  resetDocumentUi()
  useLabsStore.getState().setActive(null)
  useLabStore.getState().load(createLab(), { path: null, name: UNTITLED })
  await api().clearAutosave()
  return true
}

export async function openDocument(): Promise<void> {
  if (!(await confirmDiscard())) return
  const res = await api().openFile()
  if (!res.ok) {
    if (!res.canceled)
      useUiStore.getState().showModal({ title: t('document.openFailed'), message: res.error ?? '' })
    return
  }
  if (loadContent(res.value.content, { path: res.value.path, name: res.value.name })) {
    await api().clearAutosave()
  }
}

export async function openRecentDocument(path: string): Promise<void> {
  if (!(await confirmDiscard())) return
  const res = await api().openRecent(path)
  if (!res.ok) {
    useUiStore.getState().showModal({ title: t('document.openFailed'), message: res.error ?? '' })
    return
  }
  if (loadContent(res.value.content, { path: res.value.path, name: res.value.name })) {
    await api().clearAutosave()
  }
}

/** Ouvre un fichier transmis par le système (double-clic sur un .slab). */
export async function openExternalDocument(file: {
  path: string
  name: string
  content: string
}): Promise<void> {
  if (!(await confirmDiscard())) return
  loadContent(file.content, { path: file.path, name: file.name })
}

/** Enregistre le document. Renvoie vrai en cas de succès. */
export async function saveDocument(saveAs = false): Promise<boolean> {
  const { filePath } = useLabStore.getState()
  const fileName = documentName()
  const content = serializeCurrent()
  const res =
    filePath && !saveAs
      ? await api().saveFile(filePath, content)
      : await api().saveFileAs(content, fileName.replace(/\.slab$/i, ''))
  if (!res.ok) {
    if (!res.canceled)
      useUiStore.getState().showModal({ title: t('document.saveFailed'), message: res.error ?? '' })
    return false
  }
  const path = res.value
  const name = path.split(/[\\/]/).pop() ?? path
  useLabStore.getState().markSaved(path, name)
  await api().clearAutosave()
  useUiStore.getState().notify('success', t('document.saved', { name }))
  return true
}

/**
 * Lancement sans fichier : écran d'accueil et tutoriel (carte de bienvenue par-dessus l'accueil),
 * sauf si l'utilisateur les a désactivés.
 */
async function showHomeAtStartup(): Promise<void> {
  const [home, tutorial] = await Promise.all([api().homeAtStartup(), api().tutorialAtStartup()])
  if (home) useUiStore.getState().setHome(true)
  if (tutorial) useTutorialStore.getState().offer()
}

/**
 * Au démarrage : ouvre le fichier passé au lancement, sinon propose la récupération, sinon
 * (ou si la récupération est refusée) affiche l'écran d'accueil.
 */
export async function startupDocument(): Promise<void> {
  const pending = await api().getPendingFile()
  if (pending) {
    loadContent(pending.content, { path: pending.path, name: pending.name })
    return
  }
  const recovered = await api().recoverAutosave()
  if (!recovered) return showHomeAtStartup()
  const parsed = parseSlab(recovered)
  if (!parsed.ok) {
    await api().clearAutosave()
    return showHomeAtStartup()
  }
  useUiStore.getState().showModal({
    title: t('document.recovery.title'),
    message: t('document.recovery.message'),
    confirmLabel: t('document.recovery.restore'),
    cancelLabel: t('document.recovery.ignore'),
    onConfirm: () => {
      const title = parsed.doc.meta.title || t('main.untitled')
      loadContent(recovered, { path: null, name: t('document.recovered', { title }) }, true)
    },
    onCancel: () => {
      void api().clearAutosave()
      void showHomeAtStartup()
    }
  })
}
