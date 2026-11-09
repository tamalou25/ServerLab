/**
 * Catalogue des exercices fournis : recherche au clavier, filtres fondés sur les métadonnées réelles
 * (difficulté, durée annoncée, appartenance au parcours, réussite enregistrée), nombre de résultats,
 * remise à zéro et état « aucun résultat ». Le filtrage est pur (`shared/catalog.ts`).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleCheck, Clock, Route, Search, SearchX, X } from 'lucide-react'
import { PATHWAY_PME } from '@engine/index'
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filterCatalog,
  type CatalogDifficulty,
  type CatalogDuration,
  type CatalogFilters,
  type CatalogStatus
} from '@shared/catalog'
import { useT } from '../../lib/i18n'
import { LABS } from '../../lib/labCatalog'
import { openLab } from '../../lib/labs'
import { loadProgress } from '../../lib/progress'
import { useProgressStore } from '../../store/progress'
import { Badge } from '../common/Badge'
import { Chip } from '../common/Chip'
import { EmptyState } from '../common/EmptyState'
import { Button } from '../common/ui'
import { DifficultyBadge } from './DifficultyBadge'

const DIFFICULTIES: CatalogDifficulty[] = ['Débutant', 'Intermédiaire', 'Avancé']
const DURATIONS: CatalogDuration[] = ['short', 'medium', 'long']
const STATUSES: CatalogStatus[] = ['todo', 'done']

/** Numéro de la première étape du parcours qui réutilise chaque lab. */
const PATHWAY_STEP = new Map<string, number>()
PATHWAY_PME.steps.forEach((step, i) => {
  if (!PATHWAY_STEP.has(step.labId)) PATHWAY_STEP.set(step.labId, i + 1)
})
const PATHWAY_LAB_IDS: ReadonlySet<string> = new Set(PATHWAY_STEP.keys())
const LAB_NUMBER = new Map(LABS.map((lab, i) => [lab.id, i + 1]))

export function LabCatalog() {
  const { t, tp } = useT()
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS)
  const attempts = useProgressStore((s) => s.attempts)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    void loadProgress()
    search.current?.focus()
  }, [])

  const succeededLabIds = useMemo(
    () => new Set((attempts ?? []).filter((a) => a.success).map((a) => a.labId)),
    [attempts]
  )
  const results = useMemo(
    () => filterCatalog(LABS, filters, { pathwayLabIds: PATHWAY_LAB_IDS, succeededLabIds }),
    [filters, succeededLabIds]
  )
  const active = activeFilterCount(filters)
  const patch = (change: Partial<CatalogFilters>) => setFilters((f) => ({ ...f, ...change }))
  const reset = () => {
    setFilters(EMPTY_FILTERS)
    search.current?.focus()
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Flèche bas : premier résultat ; Entrée : ouvre l'exercice s'il est le seul retenu
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      list.current?.querySelector<HTMLElement>('button')?.focus()
    } else if (e.key === 'Enter' && results.length === 1) {
      void openLab(results[0]!)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lab-catalog">
      <div className="flex flex-col gap-2.5 border-b border-line px-5 py-3">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            ref={search}
            type="search"
            value={filters.query}
            onChange={(e) => patch({ query: e.target.value })}
            onKeyDown={onSearchKey}
            placeholder={t('catalog.search.placeholder')}
            aria-label={t('catalog.search.label')}
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full rounded-control border border-line-strong bg-surface pr-9 pl-8 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:hidden"
            data-autofocus
            data-testid="catalog-search"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => {
                patch({ query: '' })
                search.current?.focus()
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-control p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              aria-label={t('catalog.search.clear')}
              data-testid="catalog-search-clear"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FilterGroup label={t('catalog.filter.difficulty')}>
            {DIFFICULTIES.map((d) => (
              <Chip
                key={d}
                pressed={filters.difficulty === d}
                onToggle={() => patch({ difficulty: filters.difficulty === d ? null : d })}
                testId={`catalog-difficulty-${d}`}
              >
                {t(`difficulty.${d}`)}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label={t('catalog.filter.duration')}>
            {DURATIONS.map((d) => (
              <Chip
                key={d}
                pressed={filters.duration === d}
                onToggle={() => patch({ duration: filters.duration === d ? null : d })}
                testId={`catalog-duration-${d}`}
              >
                {t(`catalog.duration.${d}`)}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label={t('catalog.filter.progress')}>
            <Chip
              pressed={filters.pathwayOnly}
              onToggle={() => patch({ pathwayOnly: !filters.pathwayOnly })}
              testId="catalog-pathway"
              title={t('catalog.pathway.hint')}
            >
              {t('catalog.pathway')}
            </Chip>
            {STATUSES.map((s) => (
              <Chip
                key={s}
                pressed={filters.status === s}
                onToggle={() => patch({ status: filters.status === s ? null : s })}
                testId={`catalog-status-${s}`}
                title={t('catalog.status.hint')}
              >
                {t(`catalog.status.${s}`)}
              </Chip>
            ))}
          </FilterGroup>
          <div className="ml-auto flex min-h-7 items-center gap-2 text-dense text-fg-muted">
            <span role="status" aria-live="polite" className="tabular-nums" data-testid="catalog-count">
              {active === 0
                ? tp('catalog.count.all', LABS.length)
                : tp('catalog.count.filtered', results.length, { total: LABS.length })}
            </span>
            {active > 0 && (
              <Button variant="ghost" size="sm" onClick={reset} data-testid="catalog-reset">
                <X size={13} aria-hidden /> {tp('catalog.reset', active)}
              </Button>
            )}
          </div>
        </div>
      </div>
      {results.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('catalog.empty.title')}
          action={
            <Button onClick={reset} data-testid="catalog-empty-reset">
              {t('catalog.empty.reset')}
            </Button>
          }
          className="flex-1"
          testId="catalog-empty"
        >
          {t('catalog.empty.detail')}
        </EmptyState>
      ) : (
        <ul
          ref={list}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5"
          data-testid="catalog-list"
        >
          {results.map((lab) => {
            const step = PATHWAY_STEP.get(lab.id)
            return (
              <li
                key={lab.id}
                className="flex items-start gap-3 border-b border-line py-3 last:border-b-0"
                data-testid={`catalog-lab-${lab.id}`}
              >
                <span className="mt-0.5 w-6 shrink-0 font-mono text-dense text-fg-subtle" aria-hidden>
                  {String(LAB_NUMBER.get(lab.id) ?? 0).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-ui font-semibold text-fg">{lab.title}</span>
                    <DifficultyBadge difficulty={lab.difficulty} />
                    <span className="inline-flex items-center gap-1 text-meta text-fg-muted">
                      <Clock size={12} aria-hidden />
                      {lab.duration}
                    </span>
                    {step !== undefined && (
                      <span className="inline-flex items-center gap-1 text-meta text-fg-muted">
                        <Route size={12} aria-hidden />
                        {t('catalog.pathwayStep', { n: step })}
                      </span>
                    )}
                    {succeededLabIds.has(lab.id) && (
                      <Badge tone="ok" icon={<CircleCheck size={12} aria-hidden />}>
                        {t('catalog.succeeded')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-dense leading-relaxed text-fg-muted">{lab.summary}</p>
                </div>
                <Button
                  onClick={() => void openLab(lab)}
                  aria-label={t('catalog.open', { title: lab.title })}
                  data-testid={`lab-open-${lab.id}`}
                >
                  {t('lab.open')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-meta font-medium text-fg-subtle">{label}</span>
      {children}
    </div>
  )
}
