/**
 * Exécution des opérations réseau selon le mode (Temps réel ou Simulation).
 */
import { effectiveIpv4, isApipa, ping, type PacketTrace } from '@engine/index'
import { useLabStore } from '../store/lab'
import { useSimStore } from '../store/sim'
import { useUiStore } from '../store/ui'
import { observeTrace } from './tutorial'
import { t } from './i18n'

/**
 * Lance une opération réseau : immédiate en Temps réel, rejouée pas à pas en Simulation.
 * `onComplete` applique le résultat (état, sortie console…) à la fin.
 */
export function runNetworkOperation(trace: PacketTrace, onComplete: () => void): void {
  const ui = useUiStore.getState()
  if (ui.mode === 'realtime' || trace.events.length === 0) {
    onComplete()
    return
  }
  // Le panneau Simulation (en bas) est toujours visible en mode Simulation
  useSimStore.getState().enqueue({ trace, onComplete })
}

/** Première adresse IP exploitable d'un équipement (cible d'un PDU simple). */
export function primaryAddress(deviceId: string): string | null {
  const device = useLabStore.getState().lab.devices[deviceId]
  if (!device) return null
  for (const iface of device.interfaces) {
    const eff = effectiveIpv4(iface)
    if (eff && !isApipa(eff.address)) return eff.address
  }
  for (const iface of device.interfaces) {
    const eff = effectiveIpv4(iface)
    if (eff) return eff.address
  }
  return null
}

/** PDU simple : un écho ICMP de la source vers la destination (comme l'enveloppe des simulateurs). */
export function sendSimplePdu(sourceId: string, targetId: string): void {
  const ui = useUiStore.getState()
  const { lab } = useLabStore.getState()
  const src = lab.devices[sourceId]
  const dst = lab.devices[targetId]
  if (!src || !dst) return
  if (src.kind === 'switch' || dst.kind === 'switch') {
    ui.notify('error', t('pdu.switchNoIp'))
    return
  }
  const target = primaryAddress(targetId)
  if (!target) {
    ui.notify('error', t('pdu.noIp', { name: dst.name }))
    return
  }
  const result = ping(lab, sourceId, target, { count: 1 })
  if (!result.ok) {
    ui.notify('error', result.error.message)
    return
  }
  const { value } = result
  runNetworkOperation(value.trace, () => {
    observeTrace(value.trace)
    ui.addPduResult({ source: src.name, target: `${dst.name} (${target})`, success: value.success })
    ui.notify(
      value.success ? 'success' : 'error',
      t(value.success ? 'pdu.result.success' : 'pdu.result.failure', {
        source: src.name,
        target: dst.name,
        detail: value.lines[1] ?? ''
      })
    )
  })
}
