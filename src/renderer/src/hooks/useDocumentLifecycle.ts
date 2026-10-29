/**
 * Cycle de vie du document : titre de la fenêtre, autosave (60 s), fichier au démarrage,
 * ouverture depuis l'extérieur et enregistrement avant fermeture.
 */
import { useEffect } from 'react'
import {
  displayName,
  openExternalDocument,
  saveDocument,
  serializeCurrent,
  startupDocument
} from '../lib/document'
import { useT } from '../lib/i18n'
import { useLabStore } from '../store/lab'
import { useUiStore } from '../store/ui'

export const AUTOSAVE_INTERVAL_MS = 60_000

export function useDocumentLifecycle(): void {
  const fileName = useLabStore((s) => s.fileName)
  const filePath = useLabStore((s) => s.filePath)
  const dirty = useLabStore((s) => s.dirty)
  // Nom par défaut traduit (« Sans titre », « Untitled ») : recalculé au changement de langue
  const { lang } = useT()
  const name = displayName(fileName, filePath)

  // Titre de la fenêtre + état transmis au main (confirmation à la fermeture)
  useEffect(() => {
    document.title = `${name}${dirty ? ' *' : ''} — ServerLab`
    window.serverlab?.setDocumentState({ name, dirty })
  }, [name, dirty, lang])

  useEffect(() => {
    const api = window.serverlab
    if (!api) return
    void api.appInfo().then((info) => useUiStore.getState().setAppVersion(info.version))
    void startupDocument()

    // Copie de récupération toutes les 60 s si le document a été modifié
    const timer = setInterval(() => {
      if (!useLabStore.getState().dirty) return
      // Échec (disque plein, droits, contenu refusé) : l'heure de la dernière copie n'avance pas
      void Promise.resolve()
        .then(() => api.writeAutosave(serializeCurrent()))
        .then((written) => {
          if (written) useUiStore.getState().setLastAutosave(Date.now())
        })
        .catch((e: unknown) => console.warn('Copie de récupération impossible :', e))
    }, AUTOSAVE_INTERVAL_MS)

    const offOpened = api.onFileOpened((file) => void openExternalDocument(file))
    const offClose = api.onCloseRequested(() => {
      void saveDocument().then((saved) => {
        if (saved) api.confirmClose()
      })
    })
    return () => {
      clearInterval(timer)
      offOpened()
      offClose()
    }
  }, [])
}
