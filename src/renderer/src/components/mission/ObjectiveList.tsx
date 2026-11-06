/**
 * Objectifs d'un lab (critères) : symbole et texte d'état (« À vérifier », « Validé », « Non validé »)
 * d'après le dernier clic sur Vérifier, indices progressifs sous un objectif non validé. Un objectif
 * n'est jamais présenté comme validé sans résultat réel du moteur.
 */
import { CircleCheck, CircleDashed, CircleX, Lightbulb } from 'lucide-react'
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
  /** Indices affichés sous les objectifs non validés (jamais en examen ni en épreuve). */
  showHints: boolean
}) {
  const { t } = useT()
  const labels: Record<State, string> = {
    pending: t('lab.status.pending'),
    ok: t('lab.valide'),
    ko: t('lab.nonValide')
  }
  return (
    <ol className="flex flex-col gap-1.5" data-testid="lab-criteria">
      {lab.criteria.map((c, index) => {
        const r = progress?.results.find((x) => x.id === c.id)
        const state: State = !r ? 'pending' : r.ok ? 'ok' : 'ko'
        const { Icon, cls } = ICONS[state]
        return (
          <li
            key={c.id}
            className={`flex gap-2.5 rounded-panel border px-3 py-2 ${
              state === 'ok'
                ? 'border-ok/40 bg-ok-soft/40'
                : state === 'ko'
                  ? 'border-line bg-surface'
                  : 'border-line'
            }`}
            data-testid={`lab-criterion-${c.id}`}
            data-state={state}
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className={`flex-1 text-body ${state === 'ok' ? 'text-fg' : 'text-fg'}`}>
                  <span className="mr-1.5 font-mono text-meta text-fg-subtle">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {c.label}
                </span>
                <span className={`mt-0.5 shrink-0 text-meta font-medium ${cls}`}>{labels[state]}</span>
              </div>
              {showHints && state === 'ko' && <Hints id={c.id} levels={[c.hint, ...c.hints]} />}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Indices progressifs d'un objectif : le premier, puis les suivants à la demande (comptés par niveau). */
function Hints({ id, levels }: { id: string; levels: string[] }) {
  const { t } = useT()
  const level = useLabsStore((s) => s.hintLevels[id] ?? 0)
  const shown = levels.slice(0, level + 1)
  return (
    <div
      className="mt-2 flex flex-col gap-1.5 rounded-control border border-warn/30 bg-warn-soft/50 px-2.5 py-2 text-dense text-warn-text"
      data-testid={`lab-hint-${id}`}
    >
      {shown.map((hint, i) => (
        <div key={i} className="flex gap-1.5">
          <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">
              {shown.length > 1 ? t('lab.hintN', { n: i + 1 }) : t('lab.hint')}
            </span>
            {hint}
          </span>
        </div>
      ))}
      {level + 1 < levels.length && (
        <button
          type="button"
          onClick={() => useLabsStore.getState().revealHint(id)}
          className="self-start text-meta font-medium text-accent-text hover:underline"
          data-testid={`lab-more-hint-${id}`}
        >
          {t('lab.hintNext', { n: level + 2, total: levels.length })}
        </button>
      )}
    </div>
  )
}
