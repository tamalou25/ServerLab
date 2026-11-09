/**
 * Taille CSS de la fenêtre (px), mise à jour au redimensionnement. Sert aux seuils de repli des panneaux
 * (1 366 × 768 à 125 % = 1 093 × 614 px CSS) et aux bornes des largeurs redimensionnables.
 */
import { useEffect, useState } from 'react'

export interface WindowSize {
  width: number
  height: number
}

function read(): WindowSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function useWindowSize(): WindowSize {
  const [size, setSize] = useState<WindowSize>(read)
  useEffect(() => {
    const onResize = () => setSize(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/** Seuils de largeur (px CSS) des replis : « serré » sous 1 200, « étroit » sous 1 024. */
export const NARROW_WIDTH = 1200
export const COMPACT_HEIGHT = 680
