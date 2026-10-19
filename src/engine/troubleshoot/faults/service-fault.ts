/**
 * Fabrique des pannes de service : la cible (serveur, service, client qui observe) et le symptôme
 * viennent de la table `PROBES` ; chaque panne ne change que la manière de casser et de réparer.
 */
import { command } from '../../commands/catalog'
import type { AnyCommand } from '../../commands/define'
import type { LabState } from '../../model/schema'
import { runningDependents } from '../../services/hostservices'
import { serviceState } from '../../services/servicestate'
import type { FaultDef, FaultTargetParams } from '../types'
import { nameOf, PROBES, probeOf, running } from './service-probes'
import { firstViable } from './viable'

export interface ServiceFaultSpec {
  id: string
  title: string
  difficulty: 1 | 2 | 3
  /** Services pris en compte (par défaut : tous ceux de `PROBES`). */
  only?: readonly string[]
  /** Variantes d'une cible (cause d'échec, dépendance visée…) ; par défaut la cible telle quelle. */
  expand?(state: LabState, p: FaultTargetParams): FaultTargetParams[]
  /** Commandes qui cassent le service (après les commandes `before` de la sonde). */
  break(state: LabState, p: FaultTargetParams): AnyCommand[]
  /** Commandes qui réparent le service (avant les commandes `after` de la sonde). */
  fix(state: LabState, p: FaultTargetParams): AnyCommand[]
  /** Le service lui-même est-il dans l'état sain (démarrable) ? */
  serviceOk?(state: LabState, p: FaultTargetParams): boolean
  /** Indice de piste propre à la panne (remplace celui de la sonde). */
  trackHint?(state: LabState, p: FaultTargetParams): string
  cause(state: LabState, p: FaultTargetParams): string
}

/** Cibles par défaut : un service qui tourne et dont l'effet est observable. */
export function liveCandidates(state: LabState, only?: readonly string[]): FaultTargetParams[] {
  return PROBES.filter((probe) => !only || only.includes(probe.service)).flatMap((probe) =>
    probe.candidates(state).filter((p) => running(state, p) && probe.works(state, p))
  )
}

/** Services dépendants en cours d'exécution, enregistrés dans les cibles (arrêtés avec le service). */
const withDependents = (state: LabState, p: FaultTargetParams): FaultTargetParams => ({
  ...p,
  dependents: runningDependents(state, String(p['device']), String(p['service']))
    .map((s) => s.name)
    .join(',')
})

const dependentsOf = (p: FaultTargetParams): string[] =>
  String(p['dependents'] ?? '')
    .split(',')
    .filter((n) => n !== '')

export function serviceFault(spec: ServiceFaultSpec): FaultDef {
  const def: FaultDef = {
    id: spec.id,
    domain: 'windows',
    difficulty: spec.difficulty,
    title: spec.title,

    pick: (state, rand) =>
      firstViable(
        state,
        rand,
        liveCandidates(state, spec.only)
          .flatMap((p) => (spec.expand ? spec.expand(state, p) : [p]))
          .map((p) => withDependents(state, p)),
        def
      ),

    inject: (state, p) => [...(probeOf(p)?.before?.(state, p) ?? []), ...spec.break(state, p)],

    // Le service ne tourne plus ET son effet a disparu (le symptôme n'existe que service coupé)
    symptomVisible: (state, p) => !running(state, p) && !(probeOf(p)?.works(state, p) ?? true),

    ticket: (state, p) => probeOf(p)?.ticket(state, p) ?? 'Un service ne répond plus.',

    hints(state, p) {
      const [symptom, zone, track] = probeOf(p)?.hints(state, p) ?? [
        'Un service ne répond plus.',
        'Cherchez sur un serveur.',
        'Un service est en cause.'
      ]
      return [symptom, zone, spec.trackHint?.(state, p) ?? track]
    },

    cause: (state, p) =>
      `${spec.cause(state, p)} (serveur ${nameOf(state, p['device'])}, service ${String(p['service'])})`,

    // Les dépendants arrêtés avec le service sont redémarrés après lui
    repair: (state, p) => [
      ...spec.fix(state, p),
      ...dependentsOf(p).map((n) => command('service.start', String(p['device']), n)),
      ...(probeOf(p)?.after?.(state, p) ?? [])
    ],

    healed: (state, p) =>
      running(state, p) &&
      dependentsOf(p).every((n) => running(state, p, n)) &&
      (spec.serviceOk?.(state, p) ?? true) &&
      (probeOf(p)?.works(state, p) ?? false)
  }
  return def
}

/** Le service ciblé est-il démarrable : ni désactivé ni en échec ? */
export function startable(state: LabState, p: FaultTargetParams, name = String(p['service'])): boolean {
  const device = state.devices[String(p['device'])]
  if (!device || (device.kind !== 'server' && device.kind !== 'client')) return false
  const s = serviceState(device, name)
  return s.startType !== 'Disabled' && s.failure === undefined
}

export const startCommand = (p: FaultTargetParams, name = String(p['service'])): AnyCommand =>
  command('service.start', String(p['device']), name)
