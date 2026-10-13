/// <reference types="vite/client" />
/**
 * Mesures de performance sur la topologie de 100 équipements : `npm run perf:measure`.
 * Écrit aussi `out/lab-100.slab`, à ouvrir dans l'application pour un essai manuel.
 * Ignoré par `npm test` (s'exécute seulement en mode « perf ») ; résultats reportés dans
 * docs/performance.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import {
  canvasStatus,
  command,
  dispatch,
  parseSlab,
  runBackgroundTasks,
  serializeSlab,
  type BackgroundMemo,
  type LabState
} from '@engine/index'
import { buildLargeLab } from '../../support/large-lab'

/** Médiane de durées (ms). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now()
  const value = fn()
  return { ms: performance.now() - start, value }
}

/** Ce que l'interface calcule pour dessiner le canvas : état et IP de chaque nœud, voyants des câbles. */
function canvasFrame(lab: LabState): void {
  canvasStatus(lab)
}

/** Tâches de fond après un changement, comme le store en mode Temps réel (mémo conservé). */
let memo: BackgroundMemo = {}
function settle(lab: LabState): LabState {
  const r = runBackgroundTasks(lab, memo)
  memo = r.memo
  return r.state
}

describe.runIf(import.meta.env.MODE === 'perf')('mesures — topologie de 100 équipements', () => {
  it('ouverture, glisser, tâches de fond', () => {
    const { state, ids } = buildLargeLab()
    const text = serializeSlab(state, { savedAt: '2026-10-05T10:00:00.000Z', appVersion: 'perf' })
    const rows: [string, number][] = []

    // Ouverture : lecture du fichier, tâches de fond, premier dessin du canvas
    const opens: number[] = []
    for (let i = 0; i < 5; i++) {
      opens.push(
        time(() => {
          memo = {}
          const parsed = parseSlab(text)
          if (!parsed.ok) throw new Error(parsed.message)
          canvasFrame(settle(parsed.doc.lab))
        }).ms
      )
    }
    rows.push(['Ouverture (lecture + tâches de fond + canvas)', median(opens)])

    // Glisser : 30 mouvements d'un poste, chacun suivi des tâches de fond et du canvas
    const pc = ids['PC1'] ?? ''
    let lab = settle(state)
    const moves: number[] = []
    const background: number[] = []
    const frames: number[] = []
    for (let i = 1; i <= 30; i++) {
      const moved = dispatch(lab, command('topology.moveDevice', pc, { x: 20 + i * 7, y: 420 + i * 3 }))
      if (!moved.ok) throw new Error(moved.error.message)
      const bg = time(() => settle(moved.state))
      const frame = time(() => canvasFrame(bg.value))
      lab = bg.value
      background.push(bg.ms)
      frames.push(frame.ms)
      moves.push(bg.ms + frame.ms)
    }
    rows.push(['Glisser : par mouvement (tâches de fond + canvas)', median(moves)])
    rows.push(['  dont tâches de fond', median(background)])
    rows.push(['  dont calcul du canvas (100 nœuds, câbles)', median(frames)])

    // Modification réseau (adresse IP d'un poste statique) : le canvas est recalculé (audit P-01)
    const host = ids['PC8'] ?? ''
    const nicId = lab.devices[host]?.interfaces[0]?.id ?? ''
    const edits: number[] = []
    const editFrames: number[] = []
    for (let i = 1; i <= 10; i++) {
      const changed = dispatch(
        lab,
        command('net.setInterfaceIpv4', host, nicId, {
          addressing: 'static',
          address: `10.0.0.${100 + i}`,
          mask: '22',
          gateway: '10.0.0.254',
          dnsServers: ['10.0.0.1']
        })
      )
      if (!changed.ok) throw new Error(changed.error.message)
      const bg = time(() => settle(changed.state))
      const frame = time(() => canvasFrame(bg.value))
      lab = bg.value
      edits.push(bg.ms + frame.ms)
      editFrames.push(frame.ms)
    }
    rows.push(['Modification réseau : IP d’un poste (tâches + canvas)', median(edits)])
    rows.push(['  dont calcul du canvas', median(editFrames)])

    console.log(
      `\n${'Mesure'.padEnd(52)} médiane (ms)\n${rows.map(([k, v]) => `${k.padEnd(52)} ${v.toFixed(2)}`).join('\n')}\n`
    )
  })

  it('écrit out/lab-100.slab (essai manuel : Fichier > Ouvrir…)', () => {
    const { state } = buildLargeLab()
    mkdirSync(new URL('../../../out/', import.meta.url), { recursive: true })
    writeFileSync(
      new URL('../../../out/lab-100.slab', import.meta.url),
      serializeSlab(state, { savedAt: '2026-10-05T10:00:00.000Z', appVersion: 'perf', viewport: null })
    )
  })
})
