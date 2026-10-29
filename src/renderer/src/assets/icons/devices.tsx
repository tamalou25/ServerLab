/**
 * Icônes d'équipements dessinées pour ServerLab (aucun emprunt à un éditeur tiers) : à plat, deux tons.
 * La forme porte la catégorie : tour (serveur), écran (poste), portable (poste Linux), boîtier plat
 * à ports (switch), boîtier arrondi à flèches (routeur), nuage (Internet), mur (pare-feu).
 * Trait et corps en currentColor (gris acier hérité du parent), détails en accent (--sl-icon-accent).
 */
import type { ReactNode } from 'react'

export interface DeviceGlyphProps {
  size?: number
  className?: string
  /** Accepté pour la compatibilité avec les icônes lucide ; le trait est fixe. */
  strokeWidth?: number
}

export type DeviceGlyph = (props: DeviceGlyphProps) => ReactNode

/** Corps de l'équipement : trait acier, remplissage acier très léger. */
const BODY = { fill: 'currentColor', fillOpacity: 0.12, stroke: 'currentColor', strokeWidth: 2 } as const
/** Trait de détail acier. */
const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' } as const
/** Détail en accent (traits). */
const ACCENT_LINE = {
  fill: 'none',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function glyph(children: ReactNode): DeviceGlyph {
  function Glyph({ size = 24, className }: DeviceGlyphProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    )
  }
  return Glyph
}

export const ServerGlyph = glyph(
  <>
    <rect x="14" y="5" width="20" height="38" rx="2" {...BODY} />
    <path d="M18 12h12M18 17h12M18 22h12" {...LINE} />
    <circle cx="20" cy="36" r="2" className="fill-icon-accent" />
    <rect x="25" y="35" width="5" height="2" className="fill-icon-accent" />
  </>
)

export const LinuxServerGlyph = glyph(
  <>
    <rect x="10" y="5" width="20" height="38" rx="2" {...BODY} />
    <path d="M14 12h12M14 17h12M14 22h12" {...LINE} />
    <circle cx="16" cy="36" r="2" className="fill-icon-accent" />
    <rect x="27" y="27" width="17" height="15" rx="3" className="fill-icon-accent" />
    <path d="M31 31l3 3-3 3M36 38h5" {...ACCENT_LINE} className="stroke-on-accent" />
  </>
)

export const ClientGlyph = glyph(
  <>
    <rect x="5" y="8" width="38" height="25" rx="2" {...BODY} />
    <rect x="9" y="12" width="30" height="17" className="fill-icon-accent" fillOpacity={0.35} />
    <path d="M24 33v6M15 41h18" {...LINE} strokeWidth={2.4} />
  </>
)

export const LinuxClientGlyph = glyph(
  <>
    <path d="M10 10h28v20H10z" {...BODY} />
    <path d="M4 34h40l-3 5H7z" {...BODY} />
    <path d="M15 16l4 4-4 4M22 25h8" {...ACCENT_LINE} className="stroke-icon-accent" />
  </>
)

export const SwitchGlyph = glyph(
  <>
    <rect x="3" y="17" width="42" height="14" rx="2" {...BODY} />
    <g className="fill-icon-accent">
      <rect x="7" y="21" width="4" height="4" />
      <rect x="13" y="21" width="4" height="4" />
      <rect x="19" y="21" width="4" height="4" />
      <rect x="25" y="21" width="4" height="4" />
      <rect x="31" y="21" width="4" height="4" />
    </g>
    <circle cx="40" cy="24" r="1.8" fill="currentColor" />
  </>
)

export const RouterGlyph = glyph(
  <>
    <rect x="4" y="13" width="40" height="22" rx="11" {...BODY} />
    <g {...ACCENT_LINE} className="stroke-icon-accent">
      <path d="M13 20h9M19 17l3 3-3 3" />
      <path d="M35 28h-9M29 25l-3 3 3 3" />
    </g>
  </>
)

export const CloudGlyph = glyph(
  <>
    <path d="M14 36h22a8 8 0 0 0 1-16 11 11 0 0 0-21-2 9 9 0 0 0-2 18z" {...BODY} />
    <path d="M18 29h12" {...ACCENT_LINE} strokeWidth={2.4} className="stroke-icon-accent" />
  </>
)

export const FirewallGlyph = glyph(
  <>
    <rect x="5" y="9" width="38" height="30" rx="2" {...BODY} />
    <path d="M5 19h38M5 29h38M17 9v10M31 9v10M11 19v10M24 19v10M37 19v10M17 29v10M31 29v10" {...LINE} />
    <rect x="18" y="20" width="12" height="8" className="fill-icon-accent" />
  </>
)
