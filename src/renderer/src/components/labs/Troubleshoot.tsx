/**
 * Dépannage (mode panne) : boîte de lancement (difficulté, domaine, graine, nombre de pannes,
 * mode chronométré), panneau du ticket (indices, « J'ai réparé », abandon, journal) et bilan.
 * Aucune logique métier ici : pannes, indices et bilan viennent du moteur (lib/troubleshoot.ts).
 */
import { useEffect, useState } from 'react'
import { Dices, Flag, Lightbulb, ListOrdered, CircleCheck, CircleX, Ticket, Wrench, X } from 'lucide-react'
import {
  faultTickets,
  formatDuration,
  hintsUsedTotal,
  HINTS_PER_FAULT,
  revealedHints,
  nextHintFaultId
} from '@engine/index'
import { useDialog } from '../../hooks/useDialog'
import {
  askGiveUp,
  claimRepaired,
  closeSummary,
  closeTroubleshootDialog,
  DOMAIN_LABELS,
  drawSeed,
  launchTroubleshoot,
  requestHint,
  type TroubleshootOptions
} from '../../lib/troubleshoot'
import { useExamStore } from '../../store/exam'
import { useLabStore } from '../../store/lab'
import { useTroubleshootStore } from '../../store/troubleshoot'
import { Button, Field, inputClass } from '../common/ui'
import { ExamBanner } from './Exam'

const DIFFICULTY_LABELS = { 1: 'Débutant', 2: 'Intermédiaire', 3: 'Avancé' } as const

/** Boîte « Lancer un dépannage » : le lab de base est le document ouvert (état sain courant). */
export function TroubleshootDialog() {
  const open = useTroubleshootStore((s) => s.dialogOpen)
  const { ref, titleId } = useDialog(open, closeTroubleshootDialog)
  const [difficulty, setDifficulty] = useState<TroubleshootOptions['difficulty']>(1)
  const [domain, setDomain] = useState<TroubleshootOptions['domain']>('aleatoire')
  const [count, setCount] = useState<TroubleshootOptions['count']>(1)
  const [seed, setSeed] = useState(() => String(drawSeed()))
  const [exam, setExam] = useState(false)
  const [minutes, setMinutes] = useState('20')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const seedValue = Number(seed)
  const valid = seed.trim() !== '' && Number.isInteger(seedValue) && seedValue >= 0
  const launch = async () => {
    setBusy(true)
    const message = await launchTroubleshoot({
      difficulty,
      domain,
      count,
      seed: seedValue,
      exam,
      minutes: Number(minutes) || 20
    })
    setBusy(false)
    if (message === null) setSeed(String(drawSeed()))
    setError(message === '' ? null : message)
  }
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-scrim outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="flex max-h-[85vh] w-[480px] flex-col rounded-md border border-line bg-overlay shadow-lg"
        data-testid="tshoot-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Wrench size={18} className="text-accent" />
          <h2 id={titleId} className="text-title font-semibold text-fg">
            Lancer un dépannage
          </h2>
          <button
            type="button"
            onClick={closeTroubleshootDialog}
            className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            aria-label="Fermer"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <p className="text-ui text-fg-muted">
            Une ou plusieurs pannes sont injectées dans le lab ouvert (il doit fonctionner). Vous recevez le
            ticket d’un utilisateur : à vous de diagnostiquer et de réparer.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Difficulté maximale">
              <select
                className={inputClass}
                value={difficulty}
                onChange={(e) => setDifficulty(Number(e.target.value) as TroubleshootOptions['difficulty'])}
                data-testid="tshoot-difficulty"
              >
                {([1, 2, 3] as const).map((d) => (
                  <option key={d} value={d}>
                    {d} — {DIFFICULTY_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Domaine">
              <select
                className={inputClass}
                value={domain}
                onChange={(e) => setDomain(e.target.value as TroubleshootOptions['domain'])}
                data-testid="tshoot-domain"
              >
                {(['aleatoire', 'reseau', 'windows'] as const).map((d) => (
                  <option key={d} value={d}>
                    {DOMAIN_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nombre de pannes">
              <select
                className={inputClass}
                value={count}
                onChange={(e) => setCount(Number(e.target.value) as TroubleshootOptions['count'])}
                data-testid="tshoot-count"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </Field>
            <Field label="Graine (pour rejouer)">
              <span className="flex gap-1">
                <input
                  className={`${inputClass} font-mono`}
                  inputMode="numeric"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
                  data-testid="tshoot-seed"
                />
                <Button
                  onClick={() => setSeed(String(drawSeed()))}
                  title="Tirer une autre graine"
                  aria-label="Tirer une autre graine"
                >
                  <Dices size={14} />
                </Button>
              </span>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-ui text-fg">
            <input
              type="checkbox"
              checked={exam}
              onChange={(e) => setExam(e.target.checked)}
              data-testid="tshoot-exam"
            />
            Dépannage chronométré (mode examen : indices désactivés, vérification unique)
          </label>
          {exam && (
            <Field label="Durée imposée (minutes)">
              <input
                className={`${inputClass} w-24`}
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))}
                data-testid="tshoot-minutes"
              />
            </Field>
          )}
          {error && (
            <p
              className="rounded-md bg-danger-soft px-3 py-2 text-ui text-danger-text"
              data-testid="tshoot-error"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button onClick={closeTroubleshootDialog}>Annuler</Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void launch()}
            data-testid="tshoot-launch"
          >
            <Wrench size={14} /> Lancer
          </Button>
        </div>
      </div>
    </div>
  )
}

/** « 03:25 » */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Panneau du dépannage en cours : ticket, indices, compteurs, boutons, journal. */
export function TroubleshootPanel() {
  const session = useTroubleshootStore((s) => s.session)
  const lab = useLabStore((s) => s.lab)
  const past = useLabStore((s) => s.history.past)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (!session) return null
  const tickets = faultTickets(session.start)
  const hints = revealedHints(session.start, lab)
  const total = (session.start.troubleshooting?.faults.length ?? 1) * HINTS_PER_FAULT
  const journal = past.filter((e) => e.type !== 'troubleshoot.useHint')
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tshoot-panel">
      {session.exam && <ExamBanner />}
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Wrench size={15} className="text-accent" />
          <h2 className="text-ui font-semibold text-fg">Dépannage</h2>
          <span className="ml-auto font-mono text-meta text-fg-subtle" data-testid="tshoot-seed-shown">
            graine {session.seed}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h3 className="mb-2 flex items-center gap-1 text-meta font-semibold tracking-wider text-fg-subtle uppercase">
          <Ticket size={12} /> {tickets.length > 1 ? 'Tickets' : 'Ticket'}
        </h3>
        <ul className="flex flex-col gap-2" data-testid="tshoot-tickets">
          {tickets.map((text, i) => (
            <li key={i} className="rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg">
              {tickets.length > 1 && <span className="font-semibold">Ticket {i + 1} — </span>}
              {text}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-dense text-fg-muted">
          Reproduisez le symptôme avec les consoles et l’interface, trouvez la cause puis réparez.
        </p>
        {hints.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-dense text-warn-text" data-testid="tshoot-hints">
            {hints.map((h) => (
              <li key={`${h.fault}-${h.level}`}>
                Indice {h.level}
                {tickets.length > 1 ? ` (ticket ${h.fault + 1})` : ''} : {h.text}
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-dense">
          <dt className="text-fg-subtle">Commandes jouées</dt>
          <dd className="font-mono text-fg" data-testid="tshoot-played">
            {session.played}
          </dd>
          <dt className="text-fg-subtle">Indices utilisés</dt>
          <dd className="font-mono text-fg" data-testid="tshoot-hints-count">
            {session.exam ? 'désactivés' : `${Math.max(session.peakHints, hintsUsedTotal(lab))} / ${total}`}
          </dd>
          <dt className="text-fg-subtle">Durée</dt>
          <dd className="font-mono text-fg">{clock(now - session.startedAt)}</dd>
        </dl>
        <details className="mt-3">
          <summary className="flex cursor-pointer items-center gap-1 text-dense text-fg-muted">
            <ListOrdered size={12} /> Journal des commandes ({journal.length})
          </summary>
          <ol
            className="mt-1 list-decimal pl-5 font-mono text-meta text-fg-muted"
            data-testid="tshoot-journal"
          >
            {journal.slice(-50).map((e, i) => (
              <li key={i}>{e.label}</li>
            ))}
          </ol>
        </details>
      </div>
      <div className="border-t border-line px-4 py-3">
        {session.failedChecks > 0 && !session.exam && (
          <p
            className="mb-2 flex items-center gap-1 text-dense font-semibold text-danger-text"
            data-testid="tshoot-persists"
          >
            <CircleX size={13} /> Le problème persiste.
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" onClick={claimRepaired} data-testid="tshoot-repaired">
            <Flag size={14} /> {session.exam ? 'Terminer l’épreuve' : 'J’ai réparé'}
          </Button>
          {!session.exam && (
            <Button
              onClick={requestHint}
              disabled={nextHintFaultId(lab) === null}
              data-testid="tshoot-hint"
              title="Indice suivant : compté dans le résultat"
            >
              <Lightbulb size={14} /> Indice
            </Button>
          )}
          <Button variant="ghostDanger" onClick={askGiveUp} data-testid="tshoot-giveup">
            Abandonner
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Bilan : cause, symptôme, correction officielle, chemin le plus court, indices, durée. */
export function TroubleshootSummaryPanel() {
  const summary = useTroubleshootStore((s) => s.summary)
  const exam = useExamStore((s) => s.result)
  if (!summary) return null
  const scoreClass = summary.score >= 50 ? 'text-ok-text' : 'text-danger-text'
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tshoot-summary">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            Bilan du dépannage
          </div>
          <h2
            className={`flex items-center gap-1 text-ui font-semibold ${summary.repaired ? 'text-ok-text' : 'text-danger-text'}`}
            data-testid="tshoot-outcome"
          >
            {summary.repaired ? <CircleCheck size={15} /> : <CircleX size={15} />}
            {summary.repaired ? 'Problème résolu' : summary.gaveUp ? 'Dépannage abandonné' : 'Non résolu'}
          </h2>
        </div>
        <button
          type="button"
          onClick={closeSummary}
          className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label="Fermer le bilan"
          data-testid="tshoot-summary-close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className={`text-2xl font-semibold ${scoreClass}`} data-testid="tshoot-score">
          {summary.score}
          <span className="text-ui text-fg-subtle"> / 100</span>
        </div>
        <p className="mt-1 text-ui text-fg" data-testid="tshoot-verdict">
          {summary.verdict}
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-dense">
          <dt className="text-fg-subtle">Chemin le plus court</dt>
          <dd className="text-fg" data-testid="tshoot-official">
            {summary.officialCommands} commande(s)
          </dd>
          <dt className="text-fg-subtle">Votre démarche</dt>
          <dd className="text-fg" data-testid="tshoot-playedcount">
            {summary.playedCommands} commande(s)
          </dd>
          <dt className="text-fg-subtle">Indices utilisés</dt>
          <dd className="text-fg">{summary.hintsUsed}</dd>
          <dt className="text-fg-subtle">Durée</dt>
          <dd className="text-fg">{formatDuration(summary.elapsedMs)}</dd>
          {exam && (
            <>
              <dt className="text-fg-subtle">Note d’examen</dt>
              <dd className="text-fg" data-testid="tshoot-exam-grade">
                {String(exam.grade).replace('.', ',')} / 20 ({exam.passed} / {exam.total})
              </dd>
            </>
          )}
        </dl>
        {summary.faults.map((f, i) => (
          <section key={i} className="mt-4 rounded-md border border-line bg-surface px-3 py-2">
            <h3 className="text-ui font-semibold text-fg">{f.title}</h3>
            <p className="mt-1 text-dense text-fg-muted">
              <span className="font-semibold text-fg">Symptôme : </span>
              {f.symptom}
            </p>
            <p className="mt-1 text-dense text-fg-muted" data-testid="tshoot-cause">
              <span className="font-semibold text-fg">Cause : </span>
              {f.cause}
            </p>
            <div className="mt-1 text-dense text-fg-muted">
              <span className="font-semibold text-fg">Correction officielle :</span>
              <ol className="list-decimal pl-5" data-testid="tshoot-repair-steps">
                {f.repairSteps.map((step, k) => (
                  <li key={k}>{step}</li>
                ))}
              </ol>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
