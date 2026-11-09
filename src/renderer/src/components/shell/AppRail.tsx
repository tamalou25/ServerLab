/**
 * Rail des espaces (colonne de gauche, sombre dans les deux thèmes) : Atelier, Mission, Labs
 * (sélecteur de labs), Enseignant (si le mode est activé) et, en bas, Aide. Les espaces
 * indisponibles restent visibles mais désactivés, avec l'explication en infobulle.
 */
import { CircleHelp, Compass, GraduationCap, Library, Network, type LucideIcon } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { requestWorkspace, useWorkspace } from '../../lib/workspace'
import { useLabsStore } from '../../store/labs'
import { useTeacherStore } from '../../store/teacher'
import { useUiStore, type Workspace } from '../../store/ui'
import { useWindowSize, NARROW_WIDTH } from '../../hooks/useWindowSize'
import { Tooltip } from '../common/Tooltip'

interface RailButtonProps {
  icon: LucideIcon
  label: string
  hint?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  testId: string
  compact: boolean
}

function RailButton({
  icon: Icon,
  label,
  hint,
  active,
  disabled,
  onClick,
  testId,
  compact
}: RailButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? label : undefined}
      title={disabled ? hint : undefined}
      data-testid={testId}
      className={`flex w-full flex-col items-center gap-1 rounded-panel py-2 text-meta font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-accent text-on-accent' : 'text-on-rail hover:bg-rail-hover hover:text-on-rail-active'
      }`}
    >
      <Icon size={compact ? 20 : 21} aria-hidden />
      {!compact && <span className="leading-none">{label}</span>}
    </button>
  )
  return compact ? (
    <div className="w-full [&>span]:w-full">
      <Tooltip label={label}>{button}</Tooltip>
    </div>
  ) : (
    button
  )
}

export function AppRail() {
  const { t } = useT()
  const { workspace, available } = useWorkspace()
  const teacher = useTeacherStore((s) => s.enabled)
  const { width } = useWindowSize()
  const compact = width < NARROW_WIDTH
  const go = (ws: Workspace) => () => requestWorkspace(ws)
  return (
    <nav
      aria-label={t('workspace.label')}
      data-testid="app-rail"
      className={`flex shrink-0 flex-col gap-1 border-r border-line bg-rail px-1.5 py-2 ${compact ? 'w-12' : 'w-16'}`}
    >
      <RailButton
        icon={Network}
        label={t('workspace.atelier')}
        active={workspace === 'atelier'}
        onClick={go('atelier')}
        testId="rail-atelier"
        compact={compact}
      />
      <RailButton
        icon={Compass}
        label={t('workspace.mission')}
        hint={t('workspace.missionHint')}
        active={workspace === 'mission'}
        disabled={!available.mission}
        onClick={go('mission')}
        testId="rail-mission"
        compact={compact}
      />
      <RailButton
        icon={Library}
        label={t('workspace.labs')}
        onClick={() => useLabsStore.getState().setPickerOpen(true, 'builtin')}
        testId="rail-labs"
        compact={compact}
      />
      {teacher && (
        <RailButton
          icon={GraduationCap}
          label={t('workspace.teacher')}
          hint={t('workspace.teacherHint')}
          active={workspace === 'teacher'}
          disabled={!available.teacher}
          onClick={go('teacher')}
          testId="rail-teacher"
          compact={compact}
        />
      )}
      <div className="flex-1" />
      <RailButton
        icon={CircleHelp}
        label={t('workspace.help')}
        onClick={() => useUiStore.getState().setHelpPanel('guide')}
        testId="rail-help"
        compact={compact}
      />
    </nav>
  )
}
