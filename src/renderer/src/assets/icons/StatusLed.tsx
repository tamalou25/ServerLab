/**
 * Voyant d'état d'un équipement : la couleur est toujours doublée d'une forme (WCAG 1.4.1),
 * lisible par un daltonien — rond plein (opérationnel), triangle (alerte), carré barré (éteint),
 * anneau (inactif, aucun câble).
 */
import type { DeviceHealth } from '@engine/index'

/** Forme associée à chaque état (exposée en data-shape pour les tests). */
export const LED_SHAPE = {
  ok: 'circle',
  warn: 'triangle',
  off: 'square',
  idle: 'ring'
} as const satisfies Record<DeviceHealth, string>

interface StatusLedProps {
  status: DeviceHealth
  /** Texte de l'état (infobulle et nom accessible). */
  label: string
  className?: string
  testId?: string
}

export function StatusLed({ status, label, className, testId }: StatusLedProps) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      className={className}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-shape={LED_SHAPE[status]}
    >
      <title>{label}</title>
      {status === 'ok' && <circle cx="6" cy="6" r="5" className="fill-ok stroke-canvas" strokeWidth={1.5} />}
      {status === 'warn' && (
        <path
          d="M6 .8 11.5 11H.5z"
          className="fill-warn stroke-canvas"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      )}
      {status === 'off' && (
        <>
          <rect
            x="1"
            y="1"
            width="10"
            height="10"
            rx="1"
            className="fill-danger stroke-canvas"
            strokeWidth={1.2}
          />
          <path d="M3.8 3.8l4.4 4.4M8.2 3.8 3.8 8.2" className="stroke-on-danger" strokeWidth={1.5} />
        </>
      )}
      {status === 'idle' && (
        <circle cx="6" cy="6" r="4.2" className="fill-canvas stroke-idle" strokeWidth={2.2} />
      )}
    </svg>
  )
}
