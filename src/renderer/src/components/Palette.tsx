/**
 * Palette d'équipements (panneau de gauche, rétractable) : onglets par famille (« Tous » par défaut),
 * vignettes de 48 px avec nom, recherche. Glisser un équipement vers le canvas, ou cliquer dessus
 * puis cliquer sur le canvas. Repliée, la palette garde une colonne d'icônes utilisables.
 */
import { useState, type DragEvent } from 'react'
import { PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react'
import {
  DEVICE_ICONS,
  paletteDescription,
  paletteLabel,
  paletteModel,
  type PaletteKind
} from '../lib/devices'
import { useT } from '../lib/i18n'
import { readPref, writePref } from '../lib/prefs'
import { useUiStore } from '../store/ui'

/** Type MIME utilisé pour le glisser-déposer depuis la palette. */
export const DND_DEVICE_MIME = 'application/x-serverlab-device'

type FamilyId = 'servers' | 'clients' | 'network' | 'cisco' | 'firewall' | 'internet'

interface PaletteGroup {
  /** Identifiant de la famille ; libellé : `palette.group.<id>`. */
  id: FamilyId
  kinds: PaletteKind[]
}

const GROUPS: PaletteGroup[] = [
  { id: 'servers', kinds: ['server', 'linux-server'] },
  { id: 'clients', kinds: ['client', 'linux'] },
  { id: 'network', kinds: ['switch', 'router'] },
  { id: 'cisco', kinds: ['c1921', 'c2811', 'c2960', 'c9200'] },
  { id: 'firewall', kinds: ['firewall'] },
  { id: 'internet', kinds: ['cloud'] }
]

/** Comparaison insensible à la casse et aux accents. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

interface PaletteState {
  collapsed: boolean
  /** Famille affichée (« all » : toutes, regroupées). */
  family: FamilyId | 'all'
}

const DEFAULT_STATE: PaletteState = { collapsed: false, family: 'all' }

function startDrag(e: DragEvent, kind: PaletteKind) {
  e.dataTransfer.setData(DND_DEVICE_MIME, kind)
  e.dataTransfer.effectAllowed = 'copy'
}

/** Vignette d'un équipement : icône de 48 px et nom (modèle dans l'infobulle). */
function Tile({ kind, active, onArm }: { kind: PaletteKind; active: boolean; onArm: () => void }) {
  const { t } = useT()
  const Icon = DEVICE_ICONS[kind]
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => startDrag(e, kind)}
      onClick={onArm}
      aria-pressed={active}
      title={t('palette.dragHint', { description: paletteDescription(kind) })}
      data-testid={`palette-${kind}`}
      className={`flex flex-col items-center gap-0.5 rounded-md border px-0.5 pt-1 pb-1.5 text-center transition-colors ${
        active
          ? 'border-accent bg-accent-soft text-fg'
          : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg'
      }`}
    >
      <Icon size={48} />
      <span className="line-clamp-3 text-meta leading-tight text-fg">{paletteLabel(kind)}</span>
    </button>
  )
}

export function Palette() {
  const armed = useUiStore((s) => s.armed)
  const setArmed = useUiStore((s) => s.setArmed)
  const [state, setState] = useState<PaletteState>(() => ({
    ...DEFAULT_STATE,
    ...readPref<Partial<PaletteState>>('palette', DEFAULT_STATE)
  }))
  const [query, setQuery] = useState('')
  const { t } = useT()
  const update = (patch: Partial<PaletteState>) => {
    const next = { ...state, ...patch }
    setState(next)
    writePref('palette', next)
  }

  // Recherche sur les libellés de la langue affichée (douze entrées : aucun calcul à mémoriser)
  const q = normalize(query.trim())
  const matches = q
    ? new Set(
        GROUPS.flatMap((g) => g.kinds).filter((k) =>
          normalize(`${paletteLabel(k)} ${paletteModel(k)} ${paletteDescription(k)}`).includes(q)
        )
      )
    : null

  const arm = (kind: PaletteKind) => setArmed(armed === kind ? null : kind)

  if (state.collapsed) {
    return (
      <aside
        className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel py-2"
        aria-label={t('palette.label')}
        data-testid="palette"
      >
        <button
          type="button"
          onClick={() => update({ collapsed: false })}
          className="mb-1 rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
          title={t('palette.expand')}
          aria-label={t('palette.expand')}
          data-testid="palette-toggle"
        >
          <PanelLeftOpen size={16} />
        </button>
        {GROUPS.flatMap((g) => g.kinds).map((kind) => {
          const Icon = DEVICE_ICONS[kind]
          return (
            <button
              key={kind}
              type="button"
              draggable
              onDragStart={(e) => startDrag(e, kind)}
              onClick={() => arm(kind)}
              aria-pressed={armed === kind}
              aria-label={paletteLabel(kind)}
              title={`${paletteLabel(kind)} — ${paletteModel(kind)}`}
              data-testid={`palette-${kind}`}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
                armed === kind
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg'
              }`}
            >
              <Icon size={24} />
            </button>
          )
        })}
      </aside>
    )
  }

  // Une recherche en cours porte sur toutes les familles
  const family = matches ? 'all' : state.family
  const groups = GROUPS.filter((g) => family === 'all' || g.id === family)
    .map((g) => ({ ...g, kinds: g.kinds.filter((k) => !matches || matches.has(k)) }))
    .filter((g) => g.kinds.length > 0)
  const tabs: { id: FamilyId | 'all'; count: number }[] = [
    { id: 'all', count: GROUPS.reduce((n, g) => n + g.kinds.length, 0) },
    ...GROUPS.map((g) => ({ id: g.id, count: g.kinds.length }))
  ]

  return (
    <aside
      className="flex w-[220px] shrink-0 flex-col border-r border-line bg-panel"
      aria-label={t('palette.label')}
      data-testid="palette"
    >
      <div className="flex h-9 items-center justify-between border-b border-line pr-1.5 pl-3">
        <span className="text-title font-semibold text-fg">{t('palette.title')}</span>
        <button
          type="button"
          onClick={() => update({ collapsed: true })}
          className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
          title={t('palette.collapse')}
          aria-label={t('palette.collapse')}
          data-testid="palette-toggle"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div
        className="flex flex-wrap gap-1 border-b border-line px-2 py-2"
        role="tablist"
        aria-label={t('palette.tabs')}
      >
        {tabs.map((tab) => {
          const selected = family === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              // Cliquer l'onglet actif revient à « Tous »
              onClick={() => {
                setQuery('')
                update({ family: selected && tab.id !== 'all' ? 'all' : tab.id })
              }}
              data-testid={`palette-group-${tab.id}`}
              data-kinds={tab.id === 'all' ? undefined : GROUPS.find((g) => g.id === tab.id)?.kinds.join(' ')}
              className={`rounded px-1.5 py-0.5 text-meta font-medium transition-colors ${
                selected
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
              }`}
            >
              {t(`palette.group.${tab.id}`)} <span className="opacity-75">{tab.count}</span>
            </button>
          )
        })}
      </div>
      <div className="px-2 pt-2 pb-1">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-fg-subtle focus-within:border-accent">
          <Search size={13} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.search')}
            aria-label={t('palette.search')}
            className="min-w-0 flex-1 bg-transparent text-dense text-fg outline-none placeholder:text-fg-subtle"
            data-testid="palette-search"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title={t('palette.clear')}
              aria-label={t('palette.clear')}
              className="hover:text-fg"
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="tabpanel">
        {groups.map((group) => (
          <section key={group.id} className="mt-1.5" aria-label={t(`palette.group.${group.id}`)}>
            {family === 'all' && (
              <h3 className="mb-1 px-0.5 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
                {t(`palette.group.${group.id}`)}
              </h3>
            )}
            <div className="grid grid-cols-3 gap-1.5">
              {group.kinds.map((kind) => (
                <Tile key={kind} kind={kind} active={armed === kind} onArm={() => arm(kind)} />
              ))}
            </div>
          </section>
        ))}
        {matches && matches.size === 0 && (
          <p className="px-2 py-4 text-center text-dense text-fg-subtle">{t('palette.noMatch')}</p>
        )}
      </div>
      <p className="border-t border-line px-3 py-2 text-meta leading-snug text-fg-subtle">
        {t('palette.help')}
      </p>
    </aside>
  )
}
