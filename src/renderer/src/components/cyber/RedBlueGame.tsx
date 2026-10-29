/**
 * Mode Red/Blue : écran de partie (choix du camp, préparation, tours, écran de fin). Interface et
 * score uniquement : les scénarios et les contre-mesures sont ceux du moteur.
 */
import { useEffect, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { ArrowDown, ArrowUp, Swords, X } from 'lucide-react'
import {
  COUNTERMEASURES,
  availableCountermeasures,
  scenariosOf,
  scoreOf,
  type GameState,
  type LabState,
  type Move,
  type Score,
  type TimelineEntry
} from '@engine/index'
import type { MessageKey } from '@shared/i18n'
import { useT, type Translator } from '../../lib/i18n'
import { useGameStore } from '../../store/game'
import { useLabStore } from '../../store/lab'
import { Button } from '../common/ui'

type T = Translator['t']

const scenarioName = (t: T, id: string): string => t(`game.sc.${id}` as MessageKey)
const cmName = (t: T, id: string): string => t(`game.cm.${id}` as MessageKey)

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

export function RedBlueGame() {
  const { open, game, seconds, closeDialog, reset, tick } = useGameStore()
  const lab = useLabStore((s) => s.lab)
  const { t } = useT()
  const timed = seconds !== null
  const { ref, titleId } = useDialog(open, closeDialog)

  // Minuteur de la partie (une seconde par tick)
  useEffect(() => {
    if (!open || game?.phase !== 'running' || !timed) return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [open, game?.phase, timed, tick])

  if (!open) return null
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[350] flex items-center justify-center bg-scrim outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="flex max-h-[88vh] w-[760px] max-w-[96vw] flex-col rounded-md border border-line bg-overlay shadow-lg"
        data-testid="game"
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Swords size={16} className="text-accent" />
          <h2 id={titleId} className="flex-1 text-title font-semibold text-fg">
            {t('game.title')}
          </h2>
          {game && (
            <span className="text-xs text-fg-muted" data-testid="game-side">
              {t('game.you', { side: t(`game.side.${game.side}`) })}
            </span>
          )}
          <Button variant="ghost" onClick={closeDialog} aria-label={t('game.close')} data-testid="game-close">
            <X size={14} />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!game ? (
            <Setup lab={lab} />
          ) : game.phase === 'prep' ? (
            <Prep game={game} lab={lab} />
          ) : game.phase === 'running' ? (
            <Running game={game} lab={lab} seconds={seconds} />
          ) : (
            <Over game={game} score={scoreOf(game, lab)} onAgain={reset} />
          )}
        </div>
      </div>
    </div>
  )
}

// --- Choix du camp ----------------------------------------------------------------------------

function Setup({ lab }: { lab: LabState }) {
  const { t } = useT()
  const create = useGameStore((s) => s.create)
  const [seed, setSeed] = useState(1)
  const { maxTurns, blueBudget, timerSeconds } = lab.cyber.game
  const timer =
    timerSeconds === null ? t('game.setup.noTimer') : t('game.setup.seconds', { count: timerSeconds })
  return (
    <div className="space-y-4" data-testid="game-setup">
      <p className="text-ui text-fg-muted">{t('game.setup.intro')}</p>
      <p className="text-xs text-fg-subtle">
        {t('game.setup.rules', { turns: maxTurns, budget: blueBudget, timer })}
      </p>
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        {t('game.setup.seed')}
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(Math.trunc(Number(e.target.value)) || 0)}
          className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-fg"
          data-testid="game-seed"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        {(['red', 'blue'] as const).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => create(side, seed)}
            className="rounded-md border border-line bg-surface p-3 text-left hover:border-accent disabled:opacity-40"
            disabled={lab.cyber.game.aiSide === side}
            data-testid={`game-play-${side}`}
          >
            <div className="text-ui font-semibold text-fg">{t(`game.setup.${side}`)}</div>
            <div className="mt-1 text-xs text-fg-muted">{t(`game.setup.${side}Hint`)}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// --- Préparation ------------------------------------------------------------------------------

function Prep({ game, lab }: { game: GameState; lab: LabState }) {
  const { t } = useT()
  const { setPlan, hardenInPrep, begin } = useGameStore()
  return (
    <div className="space-y-4" data-testid="game-prep">
      <h3 className="text-ui font-semibold text-fg">{t('game.prep.title')}</h3>
      {game.side === 'red' ? (
        <RedPlan plan={game.redPlan} onChange={setPlan} />
      ) : (
        <>
          <p className="text-xs text-fg-muted">
            {t('game.prep.blue', { left: game.blueBudget - game.hardened.length })}
          </p>
          <Countermeasures game={game} lab={lab} onApply={hardenInPrep} />
        </>
      )}
      <Button
        variant="primary"
        onClick={begin}
        data-testid="game-begin"
        disabled={game.side === 'red' && game.redPlan.length === 0}
      >
        {t('game.prep.begin')}
      </Button>
    </div>
  )
}

/** Choix et ordre des scénarios de Red. */
function RedPlan({ plan, onChange }: { plan: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT()
  const lab = useLabStore((s) => s.lab)
  const all = scenariosOf(lab).map((s) => s.id)
  const move = (id: string, dir: -1 | 1) => {
    const i = plan.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= plan.length) return
    const next = [...plan]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">{t('game.prep.red')}</p>
      {all.map((id) => (
        <div
          key={id}
          className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs"
        >
          <input
            type="checkbox"
            checked={plan.includes(id)}
            onChange={(e) => onChange(e.target.checked ? [...plan, id] : plan.filter((x) => x !== id))}
            data-testid={`game-pick-${id}`}
          />
          <span className="flex-1 text-fg">{scenarioName(t, id)}</span>
          {plan.includes(id) && (
            <>
              <span className="text-fg-subtle">#{plan.indexOf(id) + 1}</span>
              <Button
                variant="ghost"
                aria-label={t('game.scenario.up')}
                onClick={() => move(id, -1)}
                data-testid={`game-up-${id}`}
              >
                <ArrowUp size={12} />
              </Button>
              <Button
                variant="ghost"
                aria-label={t('game.scenario.down')}
                onClick={() => move(id, 1)}
                data-testid={`game-down-${id}`}
              >
                <ArrowDown size={12} />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/** Contre-mesures proposées à Blue (budget et utilité tirés du moteur). */
function Countermeasures({
  game,
  lab,
  onApply
}: {
  game: GameState
  lab: LabState
  onApply: (id: string) => void
}) {
  const { t } = useT()
  const usable = new Set(availableCountermeasures(lab).map((c) => c.id))
  const left = game.blueBudget - game.hardened.length
  return (
    <div className="space-y-2">
      {COUNTERMEASURES.map((c) => (
        <div
          key={c.id}
          className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs"
        >
          <div className="flex-1">
            <div className="text-fg">{cmName(t, c.id)}</div>
            <div className="font-mono text-meta text-fg-subtle">
              {t(`game.cm.hint.${c.id}` as MessageKey)}
            </div>
          </div>
          <Button
            onClick={() => onApply(c.id)}
            disabled={!usable.has(c.id) || left <= 0}
            data-testid={`game-harden-${c.id}`}
          >
            {t('game.cm.apply')}
          </Button>
        </div>
      ))}
      {usable.size === 0 && <p className="text-xs text-fg-muted">{t('game.cm.none')}</p>}
    </div>
  )
}

// --- Tours ------------------------------------------------------------------------------------

function Running({ game, lab, seconds }: { game: GameState; lab: LabState; seconds: number | null }) {
  const { t } = useT()
  const { playTurn, giveUp } = useGameStore()
  const blue = (move: Move) => playTurn(move)
  return (
    <div className="space-y-4" data-testid="game-running">
      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span data-testid="game-turn">{t('game.run.turn', { turn: game.turn, max: game.maxTurns })}</span>
        {seconds !== null && (
          <span data-testid="game-timer">{t('game.run.timer', { time: clock(seconds) })}</span>
        )}
      </div>
      {game.side === 'red' ? (
        <div className="space-y-2">
          <Button
            variant="primary"
            onClick={() => playTurn()}
            disabled={game.redCursor >= game.redPlan.length}
            data-testid="game-next"
          >
            {t('game.run.redNext')}
          </Button>
          {game.redCursor >= game.redPlan.length && (
            <p className="text-xs text-fg-muted">{t('game.run.redDone')}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">{t('game.run.blueHint')}</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => blue({ kind: 'analyse' })} data-testid="game-analyse">
              {t('game.run.blueAnalyse')}
            </Button>
            <Button onClick={() => blue({ kind: 'pass' })} data-testid="game-pass">
              {t('game.run.bluePass')}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            {t('game.cm.budgetLeft', { left: game.blueBudget - game.hardened.length })}
          </p>
          <Countermeasures game={game} lab={lab} onApply={(id) => blue({ kind: 'harden', id })} />
        </div>
      )}
      <Timeline entries={game.timeline} />
      <Button variant="ghost" onClick={giveUp} data-testid="game-giveup">
        {t('game.run.give')}
      </Button>
    </div>
  )
}

// --- Fin de partie ----------------------------------------------------------------------------

function Over({ game, score, onAgain }: { game: GameState; score: Score; onAgain: () => void }) {
  const { t } = useT()
  const verdict = score.outcome === 'draw' ? 'draw' : score.outcome === game.side ? 'win' : 'lose'
  const none = t('game.score.none')
  return (
    <div className="space-y-4" data-testid="game-over">
      <div className="rounded-md border border-line bg-surface p-4 text-center">
        <div className="text-title font-semibold text-fg" data-testid="game-verdict">
          {t(`game.over.${verdict}`)}
        </div>
        {score.outcome !== 'draw' && (
          <div className="text-xs text-fg-muted">
            {t('game.over.winner', { side: t(`game.side.${score.outcome}`) })}
          </div>
        )}
        <div className="text-xs text-fg-subtle">{t(`game.over.reason.${game.endReason ?? 'completed'}`)}</div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="space-y-1 rounded-md border border-line bg-surface p-3" data-testid="game-score-red">
          <div className="font-semibold text-fg">{t('game.score.red')}</div>
          <div>{t('game.score.succeeded', { done: score.red.succeeded, total: score.red.attempted })}</div>
          <div>{t('game.score.accounts', { list: score.red.compromisedAccounts.join(', ') || none })}</div>
          <div>{t('game.score.machines', { list: score.red.controlledMachines.join(', ') || none })}</div>
          <div>{t('game.score.flows', { count: score.red.interceptedFlows })}</div>
          <div>{t('game.score.hops', { count: score.red.hoppedHosts })}</div>
        </div>
        <div className="space-y-1 rounded-md border border-line bg-surface p-3" data-testid="game-score-blue">
          <div className="font-semibold text-fg">{t('game.score.blue')}</div>
          <div>{t('game.score.blocked', { count: score.blue.blocked })}</div>
          <div>{t('game.score.detected', { count: score.blue.detected, missed: score.blue.undetected })}</div>
          <div>
            {score.blue.averageDetectionTurns === null
              ? t('game.score.noDetection')
              : t('game.score.detection', { turns: score.blue.averageDetectionTurns.toFixed(1) })}
          </div>
          <div>{t('game.score.countermeasures', { count: score.blue.countermeasures })}</div>
        </div>
      </div>
      <Timeline entries={game.timeline} />
      <Button variant="primary" onClick={onAgain} data-testid="game-again">
        {t('game.over.again')}
      </Button>
    </div>
  )
}

// --- Chronologie ------------------------------------------------------------------------------

function entryText(t: T, e: TimelineEntry): string {
  const ref = e.ref ?? ''
  switch (e.kind) {
    case 'scenario':
      return t(e.success ? 'game.tl.scenario.ok' : 'game.tl.scenario.ko', { name: scenarioName(t, ref) })
    case 'harden':
      return t('game.tl.harden', { name: cmName(t, ref) })
    case 'analyse':
      return t('game.tl.analyse')
    case 'detection':
      return t('game.tl.detection', { name: scenarioName(t, ref) })
    default:
      return t('game.tl.end')
  }
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const { t } = useT()
  if (entries.length === 0) return null
  return (
    <div data-testid="game-timeline">
      <h3 className="mb-1 text-ui font-semibold text-fg">{t('game.timeline')}</h3>
      <ol className="space-y-1 text-xs">
        {entries.map((e, i) => (
          <li key={i} className="rounded-md border border-line bg-surface px-3 py-1.5">
            <span className="mr-2 text-fg-subtle">
              {e.turn === 0 ? t('game.tl.prep') : t('game.tl.turn', { turn: e.turn })}
            </span>
            <span className="text-fg">{entryText(t, e)}</span>
            {e.events && e.events.length > 0 && (
              <ul className="selectable mt-1 space-y-0.5 font-mono text-meta text-fg-muted">
                {e.events.map((ev, k) => (
                  <li key={k}>
                    {ev.deviceName}
                    {ev.eventId !== null ? ` · ${ev.eventId}` : ''} · {ev.text}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
