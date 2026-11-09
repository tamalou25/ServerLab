/**
 * Badge de difficulté d'un lab (catalogue, accueil, mission) : trois barres de niveau et le libellé, la
 * couleur n'est qu'un renfort.
 */
import type { LabDefinition } from '@engine/index'
import { useT } from '../../lib/i18n'
import { Badge, type BadgeTone } from '../common/Badge'

const LEVELS: Record<LabDefinition['difficulty'], { tone: BadgeTone; level: number }> = {
  Débutant: { tone: 'ok', level: 1 },
  Intermédiaire: { tone: 'warn', level: 2 },
  Avancé: { tone: 'danger', level: 3 }
}

const BAR_HEIGHTS = ['h-1', 'h-[7px]', 'h-2.5']

export function DifficultyBadge({ difficulty }: { difficulty: LabDefinition['difficulty'] }) {
  const { t } = useT()
  const { tone, level } = LEVELS[difficulty]
  return (
    <Badge
      tone={tone}
      icon={
        <span className="flex items-end gap-px" aria-hidden>
          {BAR_HEIGHTS.map((height, i) => (
            <span
              key={height}
              className={`w-[3px] rounded-[1px] bg-current ${height} ${i < level ? '' : 'opacity-30'}`}
            />
          ))}
        </span>
      }
    >
      {t(`difficulty.${difficulty}`)}
    </Badge>
  )
}
