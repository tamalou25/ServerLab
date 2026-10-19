/**
 * Démarrage d'un dépannage : tire (ou prend) les pannes, les injecte dans l'état sain par
 * `dispatch` et renvoie l'état cassé comme NOUVEAU POINT DE DÉPART. Les commandes d'injection ne
 * sont pas rendues (aucune entrée de journal) : l'historique annuler / rétablir du renderer démarre
 * après l'injection, donc une panne ne se répare pas par « Annuler ».
 */
import { dispatch } from '../commands/dispatch'
import { fail, type EngineResult } from '../core/result'
import type { ActiveFault, LabState } from '../model/schema'
import { mulberry32, shuffle } from './prng'
import { FAULTS, getFault } from './registry'
import type { FaultDomain, FaultTargetParams } from './types'

export interface TroubleshootingSpec {
  /** Graine du tirage : même graine, mêmes pannes. */
  seed: number
  /** Pannes imposées (identifiant, cibles facultatives : tirées sinon). */
  faults?: { id: string; params?: FaultTargetParams }[]
  /** Filtres du tirage automatique. */
  domain?: FaultDomain
  /** Difficulté maximale des pannes tirées (1 à 3). */
  difficulty?: number
  /** Nombre de pannes tirées (1 par défaut). */
  count?: number
}

/** Injecte une panne : état cassé, ou null si une commande est refusée. */
function inject(
  state: LabState,
  id: string,
  params: FaultTargetParams
): { state: LabState } | { error: string } {
  const fault = getFault(id)
  if (!fault) return { error: `Panne inconnue : ${id}.` }
  let next = state
  for (const c of fault.inject(state, params)) {
    const r = dispatch(next, c)
    if (!r.ok) return { error: r.error.message }
    next = r.state
  }
  return next === state ? { error: 'L’injection n’a rien modifié.' } : { state: next }
}

/**
 * Cible agie d'une panne : équipement acteur et, s'il y en a un, objet précis (interface, port,
 * groupe, réseau). Les paramètres de sonde (`host`, `peer`…) ne comptent pas : ils ne sont pas modifiés.
 */
function actedOn(p: FaultTargetParams): { actor: string; detail: string } {
  const pick = (keys: string[]): string => {
    for (const k of keys) if (p[k] !== undefined) return String(p[k])
    return ''
  }
  return {
    actor: pick(['device', 'switch', 'router', 'aDevice']),
    detail: pick(['iface', 'portName', 'port', 'group', 'network', 'service'])
  }
}

/** Deux pannes agissent-elles sur la même cible ? (équipement entier si l'un des deux n'a pas de détail) */
function sameTarget(a: FaultTargetParams, b: FaultTargetParams): boolean {
  const x = actedOn(a)
  const y = actedOn(b)
  if (x.actor === '' || y.actor === '' || x.actor !== y.actor) return false
  return x.detail === '' || y.detail === '' || x.detail === y.detail
}

/**
 * Règle de compatibilité du tirage (déterministe) : une panne candidate est écartée si elle agit sur
 * la même cible qu'une panne déjà active, ou si son injection masque le symptôme d'une panne active.
 */
function compatible(candidate: FaultTargetParams, active: ActiveFault[], after: LabState): boolean {
  return active.every(
    (a) => !sameTarget(a.params, candidate) && (getFault(a.id)?.symptomVisible(after, a.params) ?? false)
  )
}

export function startTroubleshooting(
  healthy: LabState,
  spec: TroubleshootingSpec
): EngineResult<{ state: LabState; faults: ActiveFault[] }> {
  const rand = mulberry32(spec.seed)
  let state = healthy
  const active: ActiveFault[] = []

  // Pannes imposées : cibles données, ou tirées dans l'état sain
  for (const wanted of spec.faults ?? []) {
    const fault = getFault(wanted.id)
    if (!fault) return fail('UnknownFault', `Panne inconnue : ${wanted.id}.`)
    const params = wanted.params ?? fault.pick(healthy, rand)
    if (!params) return fail('FaultNotApplicable', `La panne « ${wanted.id} » ne s’applique pas à ce lab.`)
    const r = inject(state, wanted.id, params)
    if ('error' in r) return fail('InjectionFailed', `Injection de « ${wanted.id} » impossible : ${r.error}`)
    if (!fault.symptomVisible(r.state, params))
      return fail('SymptomNotVisible', `La panne « ${wanted.id} » ne produit aucun symptôme observable.`)
    state = r.state
    active.push({ id: wanted.id, params, hintsUsed: 0 })
  }

  // Pannes tirées : dans l'ordre mélangé du catalogue filtré, sans répéter une panne
  if (!spec.faults?.length) {
    const count = Math.max(1, Math.floor(spec.count ?? 1))
    const pool = shuffle(
      FAULTS.filter(
        (f) =>
          (spec.domain === undefined || f.domain === spec.domain) &&
          (spec.difficulty === undefined || f.difficulty <= spec.difficulty)
      ),
      rand
    )
    for (const fault of pool) {
      if (active.length >= count) break
      const params = fault.pick(healthy, rand)
      if (!params) continue
      const r = inject(state, fault.id, params)
      if ('error' in r || !fault.symptomVisible(r.state, params)) continue
      if (!compatible(params, active, r.state)) continue
      state = r.state
      active.push({ id: fault.id, params, hintsUsed: 0 })
    }
    if (active.length < count)
      return fail(
        'NoFaultAvailable',
        active.length === 0
          ? 'Aucune panne du catalogue ne s’applique à ce lab avec ces critères.'
          : `Impossible de tirer ${count} pannes compatibles sur ce lab avec ces critères : ${active.length} seulement ${active.length > 1 ? 'sont applicables' : 'est applicable'} sans se recouvrir. Réduisez le nombre de pannes ou élargissez les filtres.`
      )
  }

  const withMode: LabState = { ...state, troubleshooting: { seed: spec.seed, faults: active } }
  return { ok: true, state: withMode, value: { state: withMode, faults: active } }
}

/** Pannes actives du dépannage en cours (liste vide pour un lab ordinaire). */
export function activeFaults(state: LabState): ActiveFault[] {
  return state.troubleshooting?.faults ?? []
}

/** Toutes les pannes actives sont-elles réparées ? (faux sans dépannage ou panne inconnue) */
export function allRepaired(state: LabState, faultId?: string): boolean {
  const faults = activeFaults(state).filter((f) => faultId === undefined || f.id === faultId)
  return faults.length > 0 && faults.every((f) => getFault(f.id)?.healed(state, f.params) ?? false)
}
