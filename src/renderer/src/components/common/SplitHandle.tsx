/**
 * Poignée de redimensionnement d'un panneau latéral : glisser à la souris (capture du pointeur),
 * flèches au clavier (16 px), Origine / Fin (bornes), double-clic (largeur par défaut). Accessible en
 * `role="separator"` avec la valeur courante ; visible au survol et au focus seulement.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

const STEP = 16

export interface SplitHandleProps {
  /** Côté du panneau sur lequel la poignée est posée : bord gauche d'un panneau à droite, ou inverse. */
  edge: 'left' | 'right'
  width: number
  min: number
  max: number
  onResize: (width: number) => void
  onReset: () => void
  /** Nom accessible (ex. « Largeur de l'inspecteur »). */
  label: string
  testId?: string
}

export function SplitHandle({ edge, width, min, max, onResize, onReset, label, testId }: SplitHandleProps) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  // Panneau à droite (poignée sur son bord gauche) : tirer vers la gauche l'élargit
  const sign = edge === 'left' ? -1 : 1

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    onResize(drag.current.width + sign * (e.clientX - drag.current.x))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === 'left' ? 'ArrowLeft' : 'ArrowRight'
    const shrink = edge === 'left' ? 'ArrowRight' : 'ArrowLeft'
    if (e.key === grow) onResize(width + STEP)
    else if (e.key === shrink) onResize(width - STEP)
    else if (e.key === 'Home') onResize(min)
    else if (e.key === 'End') onResize(max)
    else if (e.key === 'Enter') onReset()
    else return
    e.preventDefault()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`group/split absolute top-0 bottom-0 z-10 w-2 cursor-col-resize select-none outline-none ${
        edge === 'left' ? '-left-1' : '-right-1'
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover/split:bg-accent group-focus-visible/split:bg-accent"
      />
    </div>
  )
}
