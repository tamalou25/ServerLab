/**
 * Observateur d'événements simplifié (journal Système, Sécurité…).
 */
import { useState } from 'react'
import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { HostDevice } from '@engine/index'
import { formatSimTime } from '../../../lib/format'
import { Section } from '../../common/ui'
import { t } from '../../../lib/i18n'

const LEVELS = {
  information: {
    get label() {
      return t('level.information')
    },
    icon: Info,
    cls: 'text-info-text'
  },
  warning: {
    get label() {
      return t('level.warning')
    },
    icon: TriangleAlert,
    cls: 'text-warn-text'
  },
  error: {
    get label() {
      return t('level.error')
    },
    icon: CircleAlert,
    cls: 'text-danger-text'
  }
} as const

export function EventLogView({ device }: { device: HostDevice }) {
  const entries = [...device.host.eventLog].reverse()
  const [selected, setSelected] = useState<number | null>(entries[0]?.id ?? null)
  const current = entries.find((e) => e.id === selected)
  return (
    <Section title={t('win.events', { count: entries.length })}>
      <div className="max-h-64 overflow-y-auto rounded border border-line">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-2 text-left text-fg-muted">
            <tr>
              <th className="px-2 py-1 font-medium">{t('win.niveau')}</th>
              <th className="px-2 py-1 font-medium">{t('win.dateEtHeure')}</th>
              <th className="px-2 py-1 font-medium">{t('win.journal')}</th>
              <th className="px-2 py-1 font-medium">{t('win.source')}</th>
              <th className="px-2 py-1 font-medium">ID</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-fg-subtle">
                  {t('win.aucunEvenement')}
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const level = LEVELS[e.level]
              const Icon = level.icon
              return (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e.id)}
                  tabIndex={0}
                  aria-selected={e.id === selected}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      setSelected(e.id)
                    }
                  }}
                  className={`cursor-pointer border-t border-line ${e.id === selected ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
                >
                  <td className="px-2 py-1">
                    <span className={`flex items-center gap-1 ${level.cls}`}>
                      <Icon size={12} /> {level.label}
                    </span>
                  </td>
                  <td className="px-2 py-1 font-mono">{formatSimTime(e.time)}</td>
                  <td className="px-2 py-1">{e.log}</td>
                  <td className="px-2 py-1">{e.source}</td>
                  <td className="px-2 py-1">{e.eventId}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {current && (
        <p className="selectable mt-2 rounded bg-surface-2 p-2 text-xs text-fg">{current.message}</p>
      )}
    </Section>
  )
}
