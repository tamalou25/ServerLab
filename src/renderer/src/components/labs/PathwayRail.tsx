/**
 * Frise du parcours : un segment par étape, rempli selon l'état réel (terminée, à revoir, conseillée, à
 * faire). Décorative : le décompte textuel voisin porte l'information pour les lecteurs d'écran.
 */
import type { StepStatus } from '@engine/index'

const SEGMENT: Record<StepStatus['state'], string> = {
  termine: 'bg-ok',
  'a-revoir': 'bg-warn',
  recommande: 'bg-accent',
  disponible: 'bg-surface-3'
}

export function PathwayRail({ steps }: { steps: readonly StepStatus[] }) {
  return (
    <div className="flex gap-1" aria-hidden data-testid="pathway-rail">
      {steps.map((s) => (
        <span
          key={s.step.id}
          title={s.step.title}
          data-state={s.state}
          className={`h-1.5 min-w-2 flex-1 rounded-full ${SEGMENT[s.state]}`}
        />
      ))}
    </div>
  )
}
