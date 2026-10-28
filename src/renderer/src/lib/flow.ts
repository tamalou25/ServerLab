/**
 * Accès à l'instance React Flow hors des composants (zoom, viewport pour l'enregistrement).
 */
import type { ReactFlowInstance } from '@xyflow/react'
import type { CableFlowEdge } from '../components/canvas/CableEdge'
import type { DeviceFlowNode } from '../components/canvas/DeviceNode'

/** Sous-ensemble de l'instance React Flow utilisé hors du canvas. */
export type FlowApi = Pick<
  ReactFlowInstance<DeviceFlowNode, CableFlowEdge>,
  | 'getViewport'
  | 'setViewport'
  | 'fitView'
  | 'zoomIn'
  | 'zoomOut'
  | 'screenToFlowPosition'
  | 'flowToScreenPosition'
>

let instance: FlowApi | null = null

export function setFlowInstance(next: FlowApi | null): void {
  instance = next
}

export function getFlowInstance(): FlowApi | null {
  return instance
}

/** Dimensions d'un nœud équipement (carte de 64 px, voir DeviceNode). */
export const NODE_SIZE = 64
/** Centre de la carte relativement au coin supérieur gauche du nœud. */
export const ICON_CENTER = { x: NODE_SIZE / 2, y: NODE_SIZE / 2 }
