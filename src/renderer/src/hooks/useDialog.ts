/**
 * Comportement commun des boîtes de dialogue modales (audit U-02) : focus placé dans la boîte à
 * l'ouverture et rendu à l'élément d'origine à la fermeture, Tab et Maj+Tab confinés à la boîte,
 * Échap pour fermer, titre relié par `aria-labelledby`.
 */
import { useEffect, useId, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useDialog(active: boolean, onClose?: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // Dernière fonction de fermeture, sans relancer l'effet à chaque rendu
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const node = ref.current
    if (!active || !node) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && close.current) {
        e.preventDefault()
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null
      )
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const current = document.activeElement
      if (e.shiftKey && (current === first || current === node)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && current === last) {
        e.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      if (previous?.isConnected) previous.focus()
    }
  }, [active])

  return { ref, titleId }
}
