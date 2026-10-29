/**
 * Badge de difficulté d'un lab (sélecteur de labs, écran d'accueil).
 */
import type { LabDefinition } from '@engine/index'
import { useT } from '../../lib/i18n'

const DIFFICULTY_CLASS: Record<LabDefinition['difficulty'], string> = {
  Débutant: 'bg-ok-soft text-ok-text',
  Intermédiaire: 'bg-warn-soft text-warn-text',
  Avancé: 'bg-danger-soft text-danger-text'
}

export function DifficultyBadge({ difficulty }: { difficulty: LabDefinition['difficulty'] }) {
  const { t } = useT()
  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-meta font-semibold ${DIFFICULTY_CLASS[difficulty]}`}>
      {t(`difficulty.${difficulty}`)}
    </span>
  )
}
