/**
 * Dépannage (mode panne) côté interface : lancement sur le lab ouvert, indices, vérification,
 * abandon, bilan. Pannes, indices et bilan sont calculés par le moteur ; ce module orchestre les
 * stores. Le mode chronométré réutilise la session et le résultat du mode examen (lib/exam.ts).
 */
import { useEffect } from 'react'
import {
  allRepaired,
  command,
  faultTickets,
  getFault,
  hintsUsedTotal,
  LAB_FORMAT_VERSION,
  nextHintFaultId,
  serializeSlab,
  startExam,
  startTroubleshooting,
  summarizeTroubleshooting,
  troubleshootSummaryText,
  type FaultDomain,
  type LabDefinition,
  type LabState
} from '@engine/index'
import { useExamStore } from '../store/exam'
import { useLabStore } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useTroubleshootStore } from '../store/troubleshoot'
import { useUiStore } from '../store/ui'
import { confirmDiscard, resetDocumentUi } from './document'
import { askFinishExam, endExam } from './exam'
import { attemptFromSummary, recordAttempt } from './progress'

export interface TroubleshootOptions {
  /** Difficulté maximale des pannes tirées (1 à 3). */
  difficulty: 1 | 2 | 3
  /** Domaine des pannes ; `aleatoire` : tout le catalogue. */
  domain: FaultDomain | 'aleatoire'
  count: 1 | 2
  seed: number
  /** Dépannage chronométré (indices désactivés). */
  exam: boolean
  /** Durée imposée du dépannage chronométré (minutes). */
  minutes: number
}

export const DOMAIN_LABELS: Record<TroubleshootOptions['domain'], string> = {
  reseau: 'Réseau',
  windows: 'Windows',
  linux: 'Linux',
  'pare-feu': 'Pare-feu',
  aleatoire: 'Aléatoire'
}

/** Graine tirée pour un nouveau dépannage (affichée pour pouvoir le rejouer). */
export function drawSeed(): number {
  return Math.floor(Math.random() * 1_000_000)
}

export function openTroubleshootDialog(): void {
  useLabsStore.getState().setPickerOpen(false)
  useTroubleshootStore.getState().set({ dialogOpen: true })
}

export function closeTroubleshootDialog(): void {
  useTroubleshootStore.getState().set({ dialogOpen: false })
}

/** Commandes déjà comptées (entrées du journal d'historique) : annuler puis rétablir ne recompte pas. */
let seen = new WeakSet<object>()

const DIFFICULTIES: LabDefinition['difficulty'][] = ['Débutant', 'Intermédiaire', 'Avancé']

/** Lab de dépannage : ticket(s) en énoncé, un critère « panne réparée » par panne, départ cassé. */
function troubleshootLab(start: LabState, seed: number, minutes: number): LabDefinition {
  const faults = start.troubleshooting?.faults ?? []
  const level = Math.max(1, ...faults.map((f) => getFault(f.id)?.difficulty ?? 1))
  const tickets = faultTickets(start)
  return {
    formatVersion: LAB_FORMAT_VERSION,
    id: `depannage-${seed}`,
    title: `Dépannage (graine ${seed})`,
    difficulty: DIFFICULTIES[level - 1] ?? 'Débutant',
    duration: `${minutes} min`,
    summary: 'Dépannage généré à partir du lab ouvert.',
    statement: tickets.map((t, i) => `**Ticket ${i + 1}**\n\n> ${t}`).join('\n\n'),
    start: {
      snapshot: JSON.parse(serializeSlab(start, { savedAt: new Date().toISOString(), appVersion: '' }))
    },
    criteria: faults.map((f, i) => ({
      id: `panne-${i + 1}`,
      label: `Le problème n° ${i + 1} est résolu`,
      hint: 'Relisez le ticket, reproduisez le symptôme puis cherchez où la configuration diffère de ce qui est attendu.',
      hints: [],
      check: { type: 'faultRepaired', faultId: f.id }
    }))
  }
}

/**
 * Lance un dépannage sur le document ouvert (supposé sain). Renvoie un message d'erreur en
 * français (erreur du moteur, ou lab déjà en dépannage), une chaîne vide si l'utilisateur annule,
 * null en cas de succès.
 */
export async function launchTroubleshoot(o: TroubleshootOptions): Promise<string | null> {
  const base = useLabStore.getState().lab
  if (base.troubleshooting)
    return 'Ce lab est déjà un dépannage en cours : ouvrez ou réparez un lab sain avant d’en lancer un autre.'
  const r = startTroubleshooting(base, {
    seed: o.seed,
    count: o.count,
    difficulty: o.difficulty,
    ...(o.domain === 'aleatoire' ? {} : { domain: o.domain })
  })
  if (!r.ok) return r.error.message
  if (!(await confirmDiscard())) return ''
  const minutes = Math.max(1, Math.floor(o.minutes))
  const lab = troubleshootLab(r.state, o.seed, minutes)
  // Le départ du dépannage devient le document : l'historique repart vide, annuler ne revient
  // donc jamais avant l'injection de la panne
  useExamStore.getState().set({ result: null })
  resetDocumentUi()
  useLabStore.getState().load(r.state, { path: null, name: `${lab.id}.slab` })
  useLabsStore.getState().setActive(lab)
  useUiStore.getState().openMission('troubleshoot')
  beginTroubleshootSession(lab.id, o.seed, { exam: o.exam, generated: true })
  if (o.exam)
    useExamStore.getState().set({
      session: startExam(lab, Date.now(), minutes),
      lab,
      revision: useLabStore.getState().revision,
      result: null
    })
  return null
}

/**
 * Ouvre une session de dépannage sur le document qui vient d'être chargé (état cassé = départ) : tickets,
 * indices, « J'ai réparé », bilan. `generated` : dépannage tiré depuis un lab ouvert (onglet Lab masqué) ;
 * faux pour un lab de dépannage fourni, dont l'énoncé reste dans l'onglet Lab.
 */
export function beginTroubleshootSession(
  labId: string,
  seed: number,
  opts: { exam: boolean; generated: boolean }
): void {
  seen = new WeakSet()
  const labState = useLabStore.getState()
  useTroubleshootStore.getState().set({
    dialogOpen: false,
    summary: null,
    session: {
      labId,
      start: labState.loadedLab,
      seed,
      startedAt: Date.now(),
      exam: opts.exam,
      generated: opts.generated,
      revision: labState.revision,
      played: 0,
      peakHints: 0,
      failedChecks: 0
    }
  })
}

/** Demande l'indice suivant (commande nommée `troubleshoot.useHint`) ; faux si aucun n'est disponible. */
export function requestHint(): boolean {
  const { session } = useTroubleshootStore.getState()
  if (!session || session.exam) return false
  const faultId = nextHintFaultId(useLabStore.getState().lab)
  if (!faultId) return false
  return useLabStore.getState().dispatch(command('troubleshoot.useHint', faultId)).ok
}

/** Calcule le bilan (moteur) et le publie ; `elapsedMs` : durée imposée par le mode examen, sinon horloge réelle. */
function conclude(gaveUp: boolean, elapsedMs?: number): void {
  const store = useTroubleshootStore.getState()
  const { session } = store
  if (!session || store.summary) return
  const labState = useLabStore.getState()
  const lab = labState.lab
  const active = useLabsStore.getState().active
  const summary = summarizeTroubleshooting(
    session.start,
    {
      commandsPlayed: session.played,
      hintsUsed: Math.max(session.peakHints, hintsUsedTotal(lab)),
      elapsedMs: elapsedMs ?? Date.now() - session.startedAt,
      repaired: allRepaired(lab),
      gaveUp,
      mode: session.exam ? 'exam' : 'training',
      // Journal des commandes jouées (annuler retire une entrée : descriptif seulement)
      journal: labState.history.past.filter((e) => e.type !== 'troubleshoot.useHint').map((e) => e.label)
    },
    // État final et lab : objectifs fonctionnels et contraintes du lab de dépannage
    { current: lab, ...(active && active.id === session.labId ? { lab: active } : {}) }
  )
  store.set({ summary })
  // Progression : un lab de dépannage fourni (lab 44, 45, 60…) compte comme tentative, pas un dépannage généré
  if (active && active.id === session.labId && !session.generated)
    void recordAttempt(attemptFromSummary(active, summary, session.startedAt, lab.troubleshooting?.seed))
}

/** « J'ai réparé » : le bilan si toutes les pannes sont guéries, sinon un message qui ne dit pas quoi. */
export function claimRepaired(): void {
  const { session } = useTroubleshootStore.getState()
  if (!session) return
  if (session.exam) {
    askFinishExam()
    return
  }
  if (allRepaired(useLabStore.getState().lab)) conclude(false)
  else useTroubleshootStore.getState().patchSession({ failedChecks: session.failedChecks + 1 })
}

/** Abandon : la cause et la correction officielle sont révélées dans le bilan. */
export function askGiveUp(): void {
  useUiStore.getState().showModal({
    title: 'Abandonner le dépannage',
    message: 'La cause de la panne et la correction officielle seront affichées. Le dépannage sera noté 0.',
    confirmLabel: 'Abandonner',
    onConfirm: () => {
      const { session } = useTroubleshootStore.getState()
      if (session?.exam) endExam('abandon')
      else conclude(true)
    }
  })
}

/** Exporte le bilan en texte (compte rendu d'intervention), par le dialogue d'export du mode examen. */
export async function exportTroubleshootSummary(): Promise<void> {
  const { summary, session } = useTroubleshootStore.getState()
  if (!summary) return
  const name = `bilan-${session?.labId ?? 'depannage'}.txt`
  const res = await window.serverlab.exportExamResult(troubleshootSummaryText(summary), name)
  const ui = useUiStore.getState()
  if (res.ok) ui.notify('success', `Bilan enregistré : ${res.value}`)
  else if (!res.canceled)
    ui.showModal({ title: 'Export impossible', message: res.error ?? 'Erreur inconnue.' })
}

/** Ferme le bilan (et le résultat d'examen associé) ; le lab reste ouvert. */
export function closeSummary(): void {
  useTroubleshootStore.getState().set({ session: null, summary: null })
  useExamStore.getState().set({ result: null })
}

/**
 * Suivi du dépannage (monté une fois) : commandes jouées depuis le départ, indices demandés, fin de
 * session si un autre document est ouvert, bilan à la fin d'un dépannage chronométré.
 */
export function useTroubleshootTracking(): void {
  useEffect(() => {
    const unsubLab = useLabStore.subscribe((s) => {
      const store = useTroubleshootStore.getState()
      const { session } = store
      if (!session || store.summary) return
      // Autre document chargé : fin de session (le mode examen note l'abandon de son côté)
      if (s.revision !== session.revision) {
        if (!session.exam) store.set({ session: null })
        return
      }
      let played = session.played
      for (const entry of s.history.past) {
        if (seen.has(entry)) continue
        seen.add(entry)
        if (entry.type !== 'troubleshoot.useHint') played++
      }
      const peakHints = Math.max(session.peakHints, hintsUsedTotal(s.lab))
      if (played !== session.played || peakHints !== session.peakHints)
        store.patchSession({ played, peakHints })
    })
    const unsubLabs = useLabsStore.subscribe((s) => {
      const { session } = useTroubleshootStore.getState()
      if (session && !session.exam && s.active?.id !== session.labId)
        useTroubleshootStore.getState().set({ session: null, summary: null })
    })
    const unsubExam = useExamStore.subscribe((s) => {
      const store = useTroubleshootStore.getState()
      if (store.session?.exam && s.result && !store.summary)
        conclude(s.result.ending === 'abandon', s.result.elapsedMs)
    })
    return () => {
      unsubLab()
      unsubLabs()
      unsubExam()
    }
  }, [])
}
