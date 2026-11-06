/**
 * Interface du mode panne : accesseurs purs (tickets, indices révélés) et BILAN d'un dépannage.
 *
 * Le bilan (v2.12) évalue le résultat de l'intervention, pas la ressemblance de la démarche avec la
 * correction de référence. Règles explicites (`SCORE_WEIGHTS`, testées) :
 *
 * - **Résultat sur 100** = rétablissement (pannes réparées) × 60 + usage attendu (objectifs
 *   fonctionnels du lab validés) × 25 + contraintes préservées (critères déjà vrais au départ qui
 *   doivent le rester : sécurité, autres usages) × 15. Une catégorie absente du lab redistribue son
 *   poids aux autres ; les objectifs partiellement atteints comptent au prorata.
 * - **Autonomie**, à part : indices demandés sur indices disponibles (entraînement) ; en examen les
 *   indices sont désactivés et l'autonomie n'est pas évaluée. Un indice n'enlève aucun point au résultat.
 * - **Descriptif**, sans effet sur le résultat : durée, commandes jouées, commandes de diagnostic
 *   reconnues, changements effectués (journal fourni par l'interface), nombre de commandes de la
 *   correction de référence. La correction de référence est UNE réparation qui fonctionne, pas le
 *   chemin le plus court : rien ne démontre son optimalité.
 *
 * Le moteur ne mesure ni la compréhension ni la qualité d'un compte rendu : ces limites sont
 * écrites dans le bilan (`limits`). Durée et commandes sont fournies par l'appelant : le moteur
 * ne lit jamais l'horloge.
 */
import { commandLabel, dispatch } from '../commands/dispatch'
import { evaluateCriteria } from '../labs/criteria'
import type { LabDefinition } from '../labs/lab'
import type { LabState } from '../model/schema'
import { compositeParts } from './composite'
import { HINTS_PER_FAULT } from './hints'
import { getFault } from './registry'
import type { FaultDef, FaultDomain, FaultTargetParams } from './types'

/** Poids (points sur 100) de chaque catégorie d'objectifs du résultat. */
export const SCORE_WEIGHTS = { repair: 60, function: 25, constraint: 15 } as const

export type ObjectiveKind = keyof typeof SCORE_WEIGHTS

export type TroubleshootMode = 'training' | 'exam'

/** Objectif du lab évalué sur l'état final (un critère), classé par son rôle dans le bilan. */
export interface ObjectiveOutcome {
  id: string
  label: string
  /** repair : panne réparée · function : usage attendu rétabli · constraint : déjà vrai au départ, à préserver. */
  kind: ObjectiveKind
  ok: boolean
}

export interface FaultSummary {
  title: string
  domain: FaultDomain
  difficulty: 1 | 2 | 3
  /** Symptôme tel que l'utilisateur l'a signalé (le ticket). */
  symptom: string
  cause: string
  /** Chaîne des causes : une entrée par cause, dans l'ordre où elles se révèlent (panne composée : la masquante puis la masquée). */
  chain: string[]
  /** Libellés lisibles de la correction de référence (une commande nommée par ligne). */
  repairSteps: string[]
  /** Pourquoi cette correction répare la panne (cause → action). */
  referenceExplanation: string
  /** Piste de révision : la zone de la configuration à retravailler (dérivée des indices de la panne). */
  review: string
  /** Panne guérie sur l'état final (null : état final non fourni). */
  healed: boolean | null
}

/** Mesures de la session, fournies par l'interface. */
export interface TroubleshootStats {
  /** Commandes nommées jouées depuis le départ (hors demandes d'indice, annulations comprises). */
  commandsPlayed: number
  hintsUsed: number
  elapsedMs: number
  /** Toutes les pannes sont réparées à la fin. */
  repaired: boolean
  /** Dépannage abandonné (cause révélée sans réparation). */
  gaveUp: boolean
  /** Entraînement (par défaut) ou examen (indices désactivés). */
  mode?: TroubleshootMode
  /** Libellés des commandes jouées, dans l'ordre (journal de l'interface) ; facultatif. */
  journal?: string[]
}

/** État final et lab, pour évaluer les objectifs et la guérison de chaque panne (facultatif). */
export interface TroubleshootContext {
  current?: LabState
  lab?: LabDefinition
  /** Objectifs déjà évalués (à la place de `lab` + `current`). */
  objectives?: ObjectiveOutcome[]
}

export type TroubleshootOutcome =
  /** Pannes réparées, usage attendu rétabli, contraintes préservées. */
  | 'resolu'
  /** Pannes réparées mais une contrainte dégradée (sécurité, autre usage) ou un usage non rétabli. */
  | 'resolu-avec-reserves'
  /** Une partie seulement des objectifs est atteinte. */
  | 'partiel'
  | 'non-resolu'
  /** Cause révélée à la demande de l'élève. */
  | 'abandonne'

export type AutonomyLevel = 'autonome' | 'guide' | 'assiste' | 'non-evaluee'

export interface ScoreBreakdown {
  kind: ObjectiveKind
  /** Poids effectif (après redistribution des catégories absentes). */
  weight: number
  met: number
  total: number
  points: number
}

export interface TroubleshootSummary {
  mode: TroubleshootMode
  faults: FaultSummary[]
  repaired: boolean
  gaveUp: boolean
  outcome: TroubleshootOutcome
  /** Résultat sur 100 (rétablissement, usage, contraintes). */
  score: number
  breakdown: ScoreBreakdown[]
  objectives: ObjectiveOutcome[]
  /** Autonomie, séparée du résultat. */
  autonomy: { hintsUsed: number; hintsAvailable: number; level: AutonomyLevel }
  /** Informations descriptives, sans effet sur le résultat. */
  officialCommands: number
  playedCommands: number
  /** Commandes de diagnostic reconnues dans le journal (ping, nslookup, show, dig…). */
  diagnosticCommands: number
  /** Changements effectués (journal sans les commandes de diagnostic ni les indices). */
  changes: string[]
  elapsedMs: number
  hintsUsed: number
  verdict: string
  /** Ce que le moteur ne sait pas évaluer. */
  limits: string[]
}

/** Tickets des pannes actives (sans la cause), dans l'ordre d'injection. `start` : état cassé de départ. */
export function faultTickets(start: LabState): string[] {
  return (start.troubleshooting?.faults ?? []).flatMap((f) => {
    const def = getFault(f.id)
    return def ? [def.ticket(start, f.params)] : []
  })
}

/** Indice révélé (niveau 1 à 3) d'une panne. */
export interface RevealedHint {
  /** Rang de la panne (0 pour la première). */
  fault: number
  level: number
  text: string
}

/** Indices déjà demandés (état courant), avec leur texte tiré de l'état de départ. */
export function revealedHints(start: LabState, current: LabState): RevealedHint[] {
  const out: RevealedHint[] = []
  ;(start.troubleshooting?.faults ?? []).forEach((f, i) => {
    const used = current.troubleshooting?.faults.find((x) => x.id === f.id)?.hintsUsed ?? 0
    const texts = getFault(f.id)?.hints(start, f.params) ?? []
    for (let level = 1; level <= Math.min(used, texts.length); level++)
      out.push({ fault: i, level, text: texts[level - 1] ?? '' })
  })
  return out
}

/** Panne dont le prochain indice peut être demandé (la première non épuisée et non réparée), ou null. */
export function nextHintFaultId(current: LabState): string | null {
  const faults = current.troubleshooting?.faults ?? []
  const open = faults.find(
    (f) => f.hintsUsed < HINTS_PER_FAULT && !(getFault(f.id)?.healed(current, f.params) ?? false)
  )
  return open?.id ?? null
}

/** Total des indices demandés sur l'état donné. */
export function hintsUsedTotal(state: LabState): number {
  return (state.troubleshooting?.faults ?? []).reduce((n, f) => n + f.hintsUsed, 0)
}

/** Libellés de la correction de référence d'une panne, évalués au fil des commandes. */
function repairSteps(start: LabState, id: string, params: FaultTargetParams): string[] {
  const def = getFault(id)
  if (!def) return []
  const steps: string[] = []
  let state = start
  for (const c of def.repair(start, params)) {
    steps.push(commandLabel(state, c))
    const r = dispatch(state, c)
    if (r.ok) state = r.state
  }
  return steps
}

/** Chaîne des causes d'une panne : simple (une cause) ou composée (masquante puis masquée). */
function causeChain(def: FaultDef, start: LabState, params: FaultTargetParams): string[] {
  const parts = compositeParts(def)
  if (!parts) return [def.cause(start, params)]
  return [
    `Cause visible en premier : ${parts.masker.cause(start, parts.pa(params))}`,
    `Cause masquée par la première (visible seulement après sa correction) : ${parts.masked.cause(start, parts.pb(params))}`
  ]
}

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one)

// ---------------------------------------------------------------------------------------------
// Objectifs du lab (critères) : rétablissement, usage attendu, contraintes
// ---------------------------------------------------------------------------------------------

/**
 * Classe et évalue les critères d'un lab sur l'état final : `faultRepaired` → rétablissement ; critère
 * déjà validé au départ (état cassé) → contrainte à préserver ; sinon → usage attendu à rétablir.
 */
export function criteriaOutcomes(start: LabState, current: LabState, lab: LabDefinition): ObjectiveOutcome[] {
  const atStart = evaluateCriteria(start, lab.criteria)
  const atEnd = evaluateCriteria(current, lab.criteria)
  return lab.criteria.map((c, i) => ({
    id: c.id,
    label: c.label,
    kind: c.check.type === 'faultRepaired' ? 'repair' : atStart[i]?.ok ? 'constraint' : 'function',
    ok: atEnd[i]?.ok ?? false
  }))
}

/**
 * Résultat sur 100 : chaque catégorie présente vaut son poids × (objectifs validés / objectifs) ;
 * le poids des catégories absentes est redistribué au prorata des catégories présentes.
 */
export function troubleshootScoreOf(objectives: ObjectiveOutcome[]): { score: number; breakdown: ScoreBreakdown[] } {
  const kinds = Object.keys(SCORE_WEIGHTS) as ObjectiveKind[]
  const present = kinds.filter((k) => objectives.some((o) => o.kind === k))
  if (present.length === 0) return { score: 0, breakdown: [] }
  const presentWeight = present.reduce((n, k) => n + SCORE_WEIGHTS[k], 0)
  const breakdown = present.map((kind) => {
    const of = objectives.filter((o) => o.kind === kind)
    const met = of.filter((o) => o.ok).length
    const weight = Math.round((100 * SCORE_WEIGHTS[kind]) / presentWeight)
    return { kind, weight, met, total: of.length, points: (weight * met) / of.length }
  })
  // Les arrondis des poids peuvent laisser 1 point : le dernier poids absorbe l'écart
  const drift = 100 - breakdown.reduce((n, b) => n + b.weight, 0)
  const last = breakdown[breakdown.length - 1]
  if (last && drift !== 0) {
    last.weight += drift
    last.points = (last.weight * last.met) / last.total
  }
  const score = Math.round(breakdown.reduce((n, b) => n + b.points, 0))
  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: breakdown.map((b) => ({ ...b, points: Math.round(b.points) }))
  }
}

/** Commandes de diagnostic reconnues dans le journal (lecture d'état, aucune modification). */
const DIAGNOSTIC_RE =
  /^(ping|tracert|traceroute|nslookup|ipconfig(?! \/(renew|release|flushdns))|arp |route print|netstat|ss |ip (a|addr|r|route|link)|dig|host |curl|wget|whoami|id |getent|klist|gpresult|w32tm \/query|nltest|Test-|Get-|Resolve-|Measure-|sc query|sc qc|sc qfailure|tasklist|net view|net share$|net user\b(?! .* \/add)|show |ls |ll |cat |less|tail|head|grep|journalctl|systemctl (status|is-active|is-enabled|list-units)|testparm|smbclient|smbstatus|pdbedit -L|apache2ctl (configtest|-t|-S)|named-checkconf|named-checkzone|dhcpd -t|fail2ban-client status|dir\b|type |findstr|more |echo [^|>]*$|pfctl -s|ifconfig$|Set-Location|cd |pwd|cls|clear)/i

export const isDiagnosticLabel = (label: string): boolean => DIAGNOSTIC_RE.test(label.trim())

// ---------------------------------------------------------------------------------------------
// Bilan
// ---------------------------------------------------------------------------------------------

function autonomyLevel(mode: TroubleshootMode, used: number, faults: number): AutonomyLevel {
  if (mode === 'exam') return 'non-evaluee'
  if (used === 0) return 'autonome'
  return used <= Math.max(1, faults) ? 'guide' : 'assiste'
}

function outcomeOf(gaveUp: boolean, objectives: ObjectiveOutcome[], repaired: boolean): TroubleshootOutcome {
  if (gaveUp) return 'abandonne'
  const of = (kind: ObjectiveKind) => objectives.filter((o) => o.kind === kind)
  const allOk = (kind: ObjectiveKind) => of(kind).every((o) => o.ok)
  const repairOk = of('repair').length > 0 ? allOk('repair') : repaired
  if (repairOk && allOk('function') && allOk('constraint')) return 'resolu'
  if (repairOk) return 'resolu-avec-reserves'
  return objectives.some((o) => o.ok && o.kind !== 'constraint') ? 'partiel' : 'non-resolu'
}

function verdictOf(s: {
  outcome: TroubleshootOutcome
  objectives: ObjectiveOutcome[]
  autonomy: TroubleshootSummary['autonomy']
}): string {
  const degraded = s.objectives.filter((o) => o.kind === 'constraint' && !o.ok)
  const missing = s.objectives.filter((o) => o.kind === 'function' && !o.ok)
  const hints =
    s.autonomy.level === 'autonome'
      ? 'sans indice'
      : s.autonomy.level === 'non-evaluee'
        ? 'en conditions d’examen'
        : `avec ${s.autonomy.hintsUsed} indice${plural(s.autonomy.hintsUsed, '', 's')}`
  switch (s.outcome) {
    case 'resolu':
      return `Service rétabli, usage attendu vérifié et contraintes préservées, ${hints}.`
    case 'resolu-avec-reserves': {
      const parts = [
        ...(missing.length
          ? [
              `${missing.length} usage${plural(missing.length, '', 's')} non rétabli${plural(missing.length, '', 's')}`
            ]
          : []),
        ...(degraded.length
          ? [
              `${degraded.length} contrainte${plural(degraded.length, '', 's')} dégradée${plural(degraded.length, '', 's')}`
            ]
          : [])
      ]
      return `Pannes réparées, mais ${parts.join(' et ')} : relisez les objectifs en échec avant de clore l’intervention.`
    }
    case 'partiel':
      return 'Une partie des objectifs est atteinte : le symptôme signalé n’est pas entièrement levé.'
    case 'non-resolu':
      return 'Panne non réparée : le symptôme signalé persiste.'
    case 'abandonne':
      return 'Dépannage abandonné : la cause et la correction de référence sont affichées.'
  }
}

/**
 * Bilan d'un dépannage. `start` : état cassé de départ (après injection). `context` : état final et
 * lab (objectifs fonctionnels et contraintes) ; sans lui, seul le rétablissement des pannes compte.
 */
export function summarizeTroubleshooting(
  start: LabState,
  stats: TroubleshootStats,
  context: TroubleshootContext = {}
): TroubleshootSummary {
  const mode: TroubleshootMode = stats.mode ?? 'training'
  const active = start.troubleshooting?.faults ?? []
  const faults: FaultSummary[] = []
  for (const f of active) {
    const def = getFault(f.id)
    if (!def) continue
    const steps = repairSteps(start, f.id, f.params)
    const hints = def.hints(start, f.params)
    faults.push({
      title: def.title,
      domain: def.domain,
      difficulty: def.difficulty,
      symptom: def.ticket(start, f.params),
      cause: def.cause(start, f.params),
      chain: causeChain(def, start, f.params),
      repairSteps: steps,
      referenceExplanation: `${def.cause(start, f.params)} La correction de référence rétablit la configuration d’origine en ${steps.length} commande${plural(steps.length, '', 's')} : c’est une réparation qui fonctionne, d’autres peuvent l’être aussi.`,
      review: `${def.title} (domaine ${def.domain}) — où regarder : ${hints[1]}`,
      healed: context.current ? def.healed(context.current, f.params) : null
    })
  }

  // Objectifs : ceux fournis, sinon ceux du lab sur l'état final, sinon la seule guérison des pannes
  let objectives: ObjectiveOutcome[]
  const limits: string[] = []
  if (context.objectives) objectives = context.objectives
  else if (context.lab && context.current) objectives = criteriaOutcomes(start, context.current, context.lab)
  else {
    objectives = faults.map((f, i) => ({
      id: `panne-${i + 1}`,
      label: `${f.title} : panne réparée`,
      kind: 'repair' as const,
      ok: f.healed ?? (stats.repaired && !stats.gaveUp)
    }))
    limits.push(
      'Aucun objectif fonctionnel ni contrainte fourni par ce lab : le résultat repose sur la seule réparation des pannes.'
    )
  }
  if (!objectives.some((o) => o.kind === 'function'))
    limits.push(
      'Ce lab ne décrit aucun usage attendu à vérifier depuis un poste : le rétablissement n’est jugé que par la guérison des pannes.'
    )
  if (!objectives.some((o) => o.kind === 'constraint'))
    limits.push(
      'Ce lab ne déclare aucune contrainte à préserver (sécurité, autres usages) : rien ne détecte un effet de bord.'
    )

  const { score, breakdown } = troubleshootScoreOf(objectives)
  const repaired = stats.repaired && !stats.gaveUp
  const outcome = outcomeOf(stats.gaveUp, objectives, repaired)
  const hintsUsed = Math.max(0, Math.floor(stats.hintsUsed))
  const autonomy = {
    hintsUsed,
    hintsAvailable: mode === 'exam' ? 0 : active.length * HINTS_PER_FAULT,
    level: autonomyLevel(mode, hintsUsed, active.length)
  }
  const journal = stats.journal ?? []
  const diagnosticCommands = journal.filter(isDiagnosticLabel).length
  const changes = journal.filter((l) => !isDiagnosticLabel(l))
  if (!stats.journal)
    limits.push('Journal des commandes non fourni : changements et vérifications ne sont pas détaillés.')
  else if (diagnosticCommands === 0)
    limits.push(
      'Aucune commande de diagnostic reconnue dans le journal : le symptôme n’a pas été reproduit depuis une console (ou l’a été par l’interface graphique, non comptée).'
    )
  limits.push(
    'Durée et nombre de commandes sont descriptifs : le bilan ne mesure ni la compréhension ni la qualité du compte rendu, qui restent à évaluer par le formateur.'
  )

  return {
    mode,
    faults,
    repaired,
    gaveUp: stats.gaveUp,
    outcome,
    score,
    breakdown,
    objectives,
    autonomy,
    officialCommands: faults.reduce((n, f) => n + f.repairSteps.length, 0),
    playedCommands: Math.max(0, Math.floor(stats.commandsPlayed)),
    diagnosticCommands,
    changes,
    elapsedMs: Math.max(0, stats.elapsedMs),
    hintsUsed,
    verdict: verdictOf({ outcome, objectives, autonomy }),
    limits
  }
}

const OUTCOME_LABELS: Record<TroubleshootOutcome, string> = {
  resolu: 'Problème résolu',
  'resolu-avec-reserves': 'Résolu avec réserves',
  partiel: 'Partiellement résolu',
  'non-resolu': 'Non résolu',
  abandonne: 'Dépannage abandonné'
}
export const outcomeLabel = (o: TroubleshootOutcome): string => OUTCOME_LABELS[o]

const KIND_LABELS: Record<ObjectiveKind, string> = {
  repair: 'Rétablissement',
  function: 'Usage attendu',
  constraint: 'Contraintes préservées'
}
export const objectiveKindLabel = (k: ObjectiveKind): string => KIND_LABELS[k]

const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  autonome: 'autonome (aucun indice)',
  guide: 'guidé (au plus un indice par panne)',
  assiste: 'assisté (plusieurs indices par panne)',
  'non-evaluee': 'non évaluée (examen, indices désactivés)'
}
export const autonomyLabel = (a: AutonomyLevel): string => AUTONOMY_LABELS[a]

/** « 12 min 05 s » (identique à `formatDuration` du mode examen, sans en dépendre). */
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

/** Compte rendu d'intervention (texte exportable) : symptôme, causes, changements, vérifications, référence, révision. */
export function troubleshootSummaryText(summary: TroubleshootSummary, title = 'Bilan du dépannage'): string {
  const lines: string[] = [
    `${title} — ${summary.mode === 'exam' ? 'examen' : 'entraînement'}`,
    '',
    `Issue : ${outcomeLabel(summary.outcome)}`,
    `Résultat : ${summary.score} / 100`,
    ...summary.breakdown.map(
      (b) => `  ${objectiveKindLabel(b.kind)} : ${b.met} / ${b.total} (${b.points} / ${b.weight} pts)`
    ),
    `Autonomie : ${autonomyLabel(summary.autonomy.level)}${summary.mode === 'exam' ? '' : ` — ${summary.autonomy.hintsUsed} / ${summary.autonomy.hintsAvailable} indices`}`,
    `Durée : ${duration(summary.elapsedMs)} · commandes jouées : ${summary.playedCommands} (dont ${summary.diagnosticCommands} de diagnostic) · correction de référence : ${summary.officialCommands} commande(s)`,
    summary.verdict,
    ''
  ]
  summary.faults.forEach((f, i) => {
    lines.push(
      `Panne ${i + 1} : ${f.title}${f.healed === null ? '' : f.healed ? ' — réparée' : ' — NON réparée'}`
    )
    lines.push(`  Symptôme signalé : ${f.symptom}`)
    f.chain.forEach((c, k) =>
      lines.push(`  Cause ${f.chain.length > 1 ? k + 1 : ''}: ${c}`.replace(' :', ' :'))
    )
    lines.push('  Correction de référence :')
    f.repairSteps.forEach((s, k) => lines.push(`    ${k + 1}. ${s}`))
    lines.push(`  Pourquoi : ${f.referenceExplanation}`)
    lines.push(`  À revoir : ${f.review}`)
    lines.push('')
  })
  lines.push('Objectifs :')
  for (const o of summary.objectives)
    lines.push(`  [${o.ok ? 'OK' : 'KO'}] (${objectiveKindLabel(o.kind)}) ${o.label}`)
  lines.push('')
  lines.push(
    summary.changes.length === 0 ? 'Changements effectués : aucun relevé.' : 'Changements effectués :'
  )
  summary.changes.forEach((c, k) => lines.push(`  ${k + 1}. ${c}`))
  lines.push('')
  lines.push('Limites du bilan :')
  for (const l of summary.limits) lines.push(`  - ${l}`)
  lines.push('')
  return lines.join('\n')
}
