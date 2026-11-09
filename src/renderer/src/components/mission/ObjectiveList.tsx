/**
 * Objectifs d'un lab (critères) : symbole et texte d'état (« À vérifier », « Validé », « Non validé »)
 * d'après le dernier clic sur Vérifier. Le résultat (constat du moteur) et l'aide (indices rédigés par
 * l'auteur du lab) sont séparés : l'aide d'un objectif non validé se déplie à la demande, puis les indices
 * suivants un par un (comptés). Un objectif n'est jamais présenté comme validé sans résultat réel.
 */
import { ChevronDown, CircleCheck, CircleDashed, CircleX, Lightbulb } from 'lucide-react'
import type { LabDefinition, LabProgress } from '@engine/index'
import { useT } from '../../lib/i18n'
import { useLabsStore } from '../../store/labs'

type State = 'pending' | 'ok' | 'ko'

const ICONS = {
  pending: { Icon: CircleDashed, cls: 'text-fg-subtle' },
  ok: { Icon: CircleCheck, cls: 'text-ok-text' },
  ko: { Icon: CircleX, cls: 'text-danger-text' }
} as const

export function ObjectiveList({
  lab,
  progress,
  showHints
}: {
  lab: LabDefinition
  /** Dernier résultat de Vérifier (null : pas encore vérifié, ou masqué en examen). */
  progress: LabProgress | null
  /** Aide proposée sous les objectifs non validés (jamais en examen ni en épreuve). */
  showHints: boolean
}) {
  const { t } = useT()
  const labels: Record<State, string> = {
    pending: t('lab.status.pending'),
    ok: t('lab.valide'),
    ko: t('lab.nonValide')
  }
  return (
    <ol className="flex flex-col" data-testid="lab-criteria">
      {lab.criteria.map((c, index) => {
        const r = progress?.results.find((x) => x.id === c.id)
        const state: State = !r ? 'pending' : r.ok ? 'ok' : 'ko'
        const { Icon, cls } = ICONS[state]
        return (
          <li
            key={c.id}
            className="flex gap-2.5 border-b border-line py-2.5 last:border-b-0"
            data-testid={`lab-criterion-${c.id}`}
            data-state={state}
          >
            <Icon size={16} className={`mt-[3px] shrink-0 ${cls}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className={`flex-1 text-body ${state === 'ok' ? 'text-fg-muted' : 'text-fg'}`}>
                  <span className="mr-1.5 font-mono text-meta text-fg-subtle">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {c.label}
                </span>
                <span className={`mt-[3px] shrink-0 text-meta font-semibold ${cls}`}>{labels[state]}</span>
              </div>
              {showHints && state === 'ko' && <Hints id={c.id} levels={[c.hint, ...c.hints]} />}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Aide d'un objectif non validé : repliée par défaut ; le premier indice à l'ouverture (non compté, comme
 * avant), puis les suivants à la demande (comptés par niveau dans la progression).
 */
function Hints({ id, levels }: { id: string; levels: string[] }) {
  const { t } = useT()
  const open = useLabsStore((s) => s.hintsOpen[id] ?? false)
  const level = useLabsStore((s) => s.hintLevels[id] ?? 0)
  const shown = levels.slice(0, level + 1)
  const panelId = `lab-hint-panel-${id}`
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => useLabsStore.getState().toggleHint(id)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1 rounded-control py-0.5 text-dense font-medium text-accent-text hover:underline"
        data-testid={`lab-hint-toggle-${id}`}
      >
        <Lightbulb size={13} aria-hidden />
        {open ? t('lab.hintHide') : t('lab.hintShow')}
        <ChevronDown size={13} aria-hidden className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-1.5 flex flex-col gap-1.5 rounded-control border-l-2 border-warn bg-warn-soft/50 px-3 py-2 text-dense text-fg"
          data-testid={`lab-hint-${id}`}
        >
          {shown.map((hint, i) => (
            <p key={i}>
              <span className="font-semibold text-warn-text">
                {shown.length > 1 ? t('lab.hintN', { n: i + 1 }) : t('lab.hint')}
              </span>
              {hint}
            </p>
          ))}
          {level + 1 < levels.length && (
            <button
              type="button"
              onClick={() => useLabsStore.getState().revealHint(id)}
              className="self-start text-dense font-medium text-accent-text hover:underline"
              title={t('lab.hintNextNote')}
              data-testid={`lab-more-hint-${id}`}
            >
              {t('lab.hintNext', { n: level + 2, total: levels.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
