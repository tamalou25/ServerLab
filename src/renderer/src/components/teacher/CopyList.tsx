/**
 * Liste des copies importées : recherche, initiales, nom, temps et indices, note, badges d'état ;
 * fichiers refusés listés à part comme « rendu invalide » (jamais sélectionnables).
 */
import { FileWarning, Search } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../lib/i18n'
import { useGradingStore, type GradedCopy } from '../../store/grading'
import { EmptyState } from '../common/EmptyState'
import { CopyStatusBadges } from './CopyStatusBadges'

const fmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

/** Initiales d'un nom (deux lettres au plus). */
export function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function CopyList({ copies }: { copies: GradedCopy[] }) {
  const { t } = useT()
  const selected = useGradingStore((s) => s.selected)
  const rejected = useGradingStore((s) => s.rejected)
  const [query, setQuery] = useState('')
  const q = normalize(query.trim())
  const shown = q ? copies.filter((c) => normalize(c.submission.student.name).includes(q)) : copies
  return (
    <div className="flex flex-col rounded-panel border border-line bg-panel" data-testid="grading-list">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <h3 className="text-ui font-semibold text-fg">{t('grading.list.title')}</h3>
        <span className="ml-auto rounded-sm bg-surface-2 px-1.5 py-0.5 text-meta font-semibold text-fg-muted">
          {copies.length}
        </span>
      </div>
      {copies.length > 3 && (
        <label className="m-2 flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface px-2 text-fg-subtle focus-within:border-accent">
          <Search size={13} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('grading.list.search')}
            aria-label={t('grading.list.search')}
            className="min-w-0 flex-1 bg-transparent text-dense text-fg outline-none placeholder:text-fg-subtle"
            data-testid="grading-search"
          />
        </label>
      )}
      {copies.length === 0 && rejected.length === 0 && (
        <EmptyState title={t('grading.list.empty')} testId="grading-list-empty">
          {t('grading.list.emptyHint')}
        </EmptyState>
      )}
      <ul className="flex flex-col">
        {shown.map((c) => {
          const name = c.submission.student.name
          const active = c.file === selected
          return (
            <li key={c.file} className="border-t border-line first:border-t-0">
              <button
                type="button"
                onClick={() => useGradingStore.getState().set({ selected: c.file })}
                aria-pressed={active}
                className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors ${
                  active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2'
                }`}
                data-testid={`grading-row-${name}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-meta font-semibold text-fg-muted">
                  {initials(name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense font-semibold text-fg">{name}</span>
                  <span className="block text-meta text-fg-subtle">
                    {minutes(c.correction.elapsedMs)} ·{' '}
                    {t('grading.list.hints', { count: c.correction.hintsTaken })}
                  </span>
                  <span className="mt-1 block">
                    <CopyStatusBadges correction={c.correction} compact />
                  </span>
                </span>
                <span className="text-title font-semibold text-fg tabular-nums">
                  {fmt(c.correction.grade.value)}
                </span>
              </button>
            </li>
          )
        })}
        {rejected.map((r) => (
          <li
            key={`rejected-${r.file}`}
            className="flex items-start gap-2.5 border-t border-line px-3 py-2.5 text-dense text-fg-muted"
            data-testid={`grading-rejected-${r.file}`}
            title={r.message}
          >
            <FileWarning size={16} className="mt-0.5 shrink-0 text-danger-text" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate font-semibold text-fg">{r.file}</span>
              <span className="block text-meta text-danger-text">{t('grading.status.invalid')}</span>
              <span className="line-clamp-2 text-meta text-fg-subtle">{r.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
