/**
 * Badges d'état d'une copie, dérivés de la correction (copyStatus) : signalée, rejeu interrompu,
 * oral à renseigner, critères validés. Icône et texte, jamais la couleur seule.
 */
import { CircleCheck, CircleDashed, CircleX, Flag, MessageCircleQuestion, OctagonAlert } from 'lucide-react'
import { copyStatus, type Correction } from '@engine/index'
import { useT } from '../../lib/i18n'
import { Badge } from '../common/Badge'

export function CopyStatusBadges({
  correction,
  compact = false
}: {
  correction: Correction
  compact?: boolean
}) {
  const { t } = useT()
  const status = copyStatus(correction)
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="copy-status">
      {status.replayFailed ? (
        <Badge tone="danger" icon={<OctagonAlert size={11} aria-hidden />}>
          {t('grading.status.replayFailed')}
        </Badge>
      ) : status.flagged ? (
        <Badge tone="warn" icon={<Flag size={11} aria-hidden />} title={t('grading.flagged')}>
          {t('grading.status.flagged')}
        </Badge>
      ) : null}
      {!compact && status.oralPending && (
        <Badge tone="neutral" icon={<MessageCircleQuestion size={11} aria-hidden />}>
          {t('grading.status.oralPending')}
        </Badge>
      )}
      <Badge
        tone={status.criteria === 'complete' ? 'ok' : status.criteria === 'none' ? 'danger' : 'neutral'}
        icon={
          status.criteria === 'complete' ? (
            <CircleCheck size={11} aria-hidden />
          ) : status.criteria === 'none' ? (
            <CircleX size={11} aria-hidden />
          ) : (
            <CircleDashed size={11} aria-hidden />
          )
        }
      >
        {t('grading.status.criteria', { passed: status.passed, total: status.total })}
      </Badge>
    </span>
  )
}
