/**
 * Point d'entrée du renderer React.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { applyThemeToDocument, initialTheme } from './store/ui'

// Thème appliqué avant le premier rendu (pas de flash de couleurs)
applyThemeToDocument(initialTheme())

// Un fichier glissé hors d'une zone de dépôt ne doit pas remplacer la page (le main refuse aussi
// cette navigation) : le dépôt par défaut du navigateur est annulé partout
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  })
}

const container = document.getElementById('root')
if (!container) throw new Error('Élément #root introuvable')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
