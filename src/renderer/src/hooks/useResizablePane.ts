/**
 * Largeur d'un panneau redimensionnable : valeur mémorisée sur le poste (préférence), bornée à
 * l'affichage entre `min` et `max` (la préférence n'est jamais réécrite par la borne : un écran plus
 * large retrouve la largeur choisie).
 */
import { useCallback, useState } from 'react'
import { readPref, writePref } from '../lib/prefs'

export interface ResizablePaneOptions {
  /** Clé de préférence (`serverlab.<clé>`). */
  key: string
  defaultWidth: number
  min: number
  /** Borne haute à l'affichage (peut dépendre de la fenêtre). */
  max: number
}

export interface ResizablePane {
  /** Largeur affichée (bornée). */
  width: number
  /** Largeur demandée (persistée), avant borne. */
  requested: number
  setWidth: (width: number) => void
  reset: () => void
  min: number
  max: number
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export function useResizablePane({ key, defaultWidth, min, max }: ResizablePaneOptions): ResizablePane {
  const [requested, setRequested] = useState(() => {
    const stored = readPref<number>(key, defaultWidth)
    return Number.isFinite(stored) ? stored : defaultWidth
  })
  const setWidth = useCallback(
    (width: number) => {
      const next = Math.round(clamp(width, min, max))
      setRequested(next)
      writePref(key, next)
    },
    [key, min, max]
  )
  const reset = useCallback(() => {
    setRequested(defaultWidth)
    writePref(key, defaultWidth)
  }, [key, defaultWidth])
  const bounded = clamp(requested, min, Math.max(min, max))
  return { width: bounded, requested, setWidth, reset, min, max: Math.max(min, max) }
}
