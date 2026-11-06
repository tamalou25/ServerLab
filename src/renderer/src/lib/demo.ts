/**
 * Démonstration : rejouer un rendu pas à pas (avancer, reculer, lecture à vitesse réglable) avec
 * le canvas, l'inspecteur et le panneau Simulation, et un mode projection (texte agrandi).
 * Les états viennent du rejeu du moteur ; l'affichage ne modifie rien (aucune commande).
 */
import { useEffect } from 'react'
import { replayFrames, type Subject, type Submission } from '@engine/index'
import { useDemoStore } from '../store/demo'
import { useLabStore } from '../store/lab'
import { useLabsStore } from '../store/labs'
import { useTeacherStore } from '../store/teacher'
import { useUiStore } from '../store/ui'
import { resetDocumentUi } from './document'

/** Affiche une image du rejeu (état en lecture seule : historique vidé, aucune tâche de fond). */
function show(index: number): void {
  const { frames, set } = useDemoStore.getState()
  const frame = frames[index]
  if (!frame) return
  set({ index })
  // Remplacement direct de l'état affiché : l'image vient déjà du moteur, rien n'est exécuté
  useLabStore.setState({ lab: frame.state })
}

export function startDemo(subject: Subject, submission: Submission): void {
  const frames = replayFrames(subject, submission)
  resetDocumentUi()
  useLabsStore.getState().setActive(null)
  useUiStore.getState().setMode('realtime')
  // Le rejeu se regarde sur le plan : espace Atelier (le retour à l'espace Enseignant se fait à la fermeture)
  useUiStore.getState().setWorkspace('atelier')
  useLabStore.getState().load(frames[0]!.state, { path: null, name: `${submission.student.name}.slab` })
  useDemoStore
    .getState()
    .set({ frames, index: 0, playing: false, title: `${submission.student.name} · ${subject.meta.title}` })
}

export const demoStep = (delta: number): void => {
  const { index, frames } = useDemoStore.getState()
  show(Math.max(0, Math.min(frames.length - 1, index + delta)))
}

export const demoGoto = (index: number): void => show(index)

export function setProjection(on: boolean): void {
  useDemoStore.getState().set({ projection: on })
  if (on) document.documentElement.setAttribute('data-projection', '')
  else document.documentElement.removeAttribute('data-projection')
}

export function closeDemo(): void {
  setProjection(false)
  useDemoStore.getState().set({ frames: [], playing: false, index: 0 })
  if (useTeacherStore.getState().enabled) useUiStore.getState().setWorkspace('teacher')
}

/** Lecture automatique à la vitesse choisie ; s'arrête à la dernière image. */
export function useDemoPlayback(): void {
  const playing = useDemoStore((s) => s.playing)
  const speed = useDemoStore((s) => s.speed)
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const { index, frames, set } = useDemoStore.getState()
      if (index >= frames.length - 1) return set({ playing: false })
      show(index + 1)
    }, 1000 / speed)
    return () => window.clearInterval(timer)
  }, [playing, speed])
}
