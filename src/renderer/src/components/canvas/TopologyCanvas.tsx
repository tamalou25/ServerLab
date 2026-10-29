/**
 * Canvas de topologie (React Flow) : placement, déplacement, câblage, sélection.
 * Les nœuds et câbles sont dérivés de l'état du moteur à chaque rendu.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes
} from '@xyflow/react'
import { type DeviceKind, command } from '@engine/index'
import { isPaletteKind, paletteParams, type PaletteKind } from '../../lib/devices'
import { useLabStore } from '../../store/lab'
import { useUiStore } from '../../store/ui'
import { runCommand } from '../../lib/run'
import { sendSimplePdu } from '../../lib/network'
import { pickCablePort } from '../../lib/cabling'
import { ICON_CENTER, setFlowInstance } from '../../lib/flow'
import { DND_DEVICE_MIME } from '../Palette'
import { CableEdge, type CableFlowEdge } from './CableEdge'
import { CablePreview } from './CablePreview'
import { CanvasToolbar } from './CanvasToolbar'
import { PacketAnimation } from './PacketAnimation'
import { ProtocolLegend } from './ProtocolLegend'
import { PduList } from './PduList'
import { DeviceNode, type DeviceFlowNode } from './DeviceNode'
import { PortPicker, type PortPickerState } from './PortPicker'
import { ZoomControls } from './ZoomControls'
import { useT } from '../../lib/i18n'

const nodeTypes: NodeTypes = { device: DeviceNode }
const edgeTypes: EdgeTypes = { cable: CableEdge }

/** Couleurs de la minimap : tokens de catégorie (suivent le thème). */
const MINIMAP_COLORS: Record<DeviceKind, string> = {
  server: 'var(--sl-kind-server)',
  client: 'var(--sl-kind-client)',
  switch: 'var(--sl-kind-switch)',
  router: 'var(--sl-kind-router)',
  cloud: 'var(--sl-kind-cloud)',
  firewall: 'var(--sl-kind-firewall)'
}

export function TopologyCanvas() {
  const flow = useReactFlow<DeviceFlowNode, CableFlowEdge>()
  const devices = useLabStore((s) => s.lab.devices)
  const links = useLabStore((s) => s.lab.links)
  const revision = useLabStore((s) => s.revision)
  const viewport = useLabStore((s) => s.viewport)
  const selection = useUiStore((s) => s.selection)
  const tool = useUiStore((s) => s.tool)
  const { t } = useT()
  const armed = useUiStore((s) => s.armed)
  const cableStart = useUiStore((s) => s.cableStart)
  const pduSource = useUiStore((s) => s.pduSource)
  const theme = useUiStore((s) => s.theme)
  const showMinimap = useUiStore((s) => s.showMinimap)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [picker, setPicker] = useState<PortPickerState | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // Dimensions mesurées par React Flow : à réinjecter dans les nœuds dérivés,
  // sinon chaque nœud recréé est masqué le temps d'être remesuré.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})

  useEffect(() => {
    setFlowInstance(flow)
    return () => setFlowInstance(null)
  }, [flow])

  // Après chargement d'un document : restaure la vue enregistrée ou recadre
  useEffect(() => {
    if (revision === 0) return
    const id = requestAnimationFrame(() => {
      if (viewport) void flow.setViewport(viewport)
      else void flow.fitView({ padding: 0.3, maxZoom: 1.2 })
    })
    return () => cancelAnimationFrame(id)
  }, [revision, viewport, flow])

  // Nœuds dérivés incrémentalement : un nœud inchangé (position, sélection, taille) garde le même
  // objet, que React Flow et `memo` reconnaissent : seul le nœud déplacé est redessiné.
  const nodeCache = useRef(new Map<string, DeviceFlowNode>())
  const nodes = useMemo<DeviceFlowNode[]>(() => {
    const cache = nodeCache.current
    const next = new Map<string, DeviceFlowNode>()
    const list = Object.values(devices).map((d) => {
      const selected = selection.devices.includes(d.id)
      const measured = sizes[d.id]
      const prev = cache.get(d.id)
      const node: DeviceFlowNode =
        prev && prev.position === d.position && prev.selected === selected && prev.measured === measured
          ? prev
          : {
              id: d.id,
              type: 'device',
              position: d.position,
              data: prev?.data ?? { deviceId: d.id },
              selected,
              deletable: false,
              ...(measured ? { measured } : {})
            }
      next.set(d.id, node)
      return node
    })
    nodeCache.current = next
    return list
  }, [devices, selection.devices, sizes])

  const edges = useMemo<CableFlowEdge[]>(() => {
    // Décale les câbles parallèles entre deux mêmes équipements
    const pairCount = new Map<string, number>()
    return Object.values(links).map((l) => {
      const key = [l.a.deviceId, l.b.deviceId].sort().join('|')
      const index = pairCount.get(key) ?? 0
      pairCount.set(key, index + 1)
      const offset = index === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * 10
      return {
        id: l.id,
        type: 'cable',
        source: l.a.deviceId,
        target: l.b.deviceId,
        data: { linkId: l.id, offset },
        selected: selection.link === l.id,
        deletable: false
      }
    })
  }, [links, selection.link])

  const onNodesChange = useCallback((changes: NodeChange<DeviceFlowNode>[]) => {
    const ui = useUiStore.getState()
    let selected = ui.selection.devices
    let selectionChanged = false
    const measured: Record<string, { width: number; height: number }> = {}
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        measured[change.id] = change.dimensions
      } else if (change.type === 'position' && change.position) {
        const { id, position } = change
        // Déplacement transitoire : une seule entrée du journal à la fin du glisser
        useLabStore.getState().dispatch(command('topology.moveDevice', id, position))
      } else if (change.type === 'select') {
        selectionChanged = true
        selected = change.selected
          ? [...selected.filter((id) => id !== change.id), change.id]
          : selected.filter((id) => id !== change.id)
      }
    }
    if (selectionChanged)
      ui.select({ devices: selected, link: selected.length > 0 ? null : ui.selection.link })
    if (Object.keys(measured).length > 0) {
      setSizes((prev) => {
        const changed = Object.entries(measured).some(
          ([id, m]) => prev[id]?.width !== m.width || prev[id]?.height !== m.height
        )
        return changed ? { ...prev, ...measured } : prev
      })
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange<CableFlowEdge>[]) => {
    const ui = useUiStore.getState()
    for (const change of changes) {
      if (change.type === 'select') {
        if (change.selected) ui.select({ link: change.id, devices: [] })
        else if (ui.selection.link === change.id) ui.select({ link: null })
      }
    }
  }, [])

  const placeDevice = useCallback(
    (kind: PaletteKind, screen: { x: number; y: number }) => {
      const p = flow.screenToFlowPosition(screen)
      const id = runCommand(
        command('topology.addDevice', {
          ...paletteParams(kind),
          position: { x: Math.round(p.x - ICON_CENTER.x), y: Math.round(p.y - ICON_CENTER.y) }
        })
      )
      if (id) useUiStore.getState().select({ devices: [id], link: null })
    },
    [flow]
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData(DND_DEVICE_MIME)
      if (isPaletteKind(kind)) placeDevice(kind, { x: e.clientX, y: e.clientY })
    },
    [placeDevice]
  )

  const onPaneClick = useCallback(
    (e: MouseEvent) => {
      const ui = useUiStore.getState()
      if (ui.armed) {
        placeDevice(ui.armed, { x: e.clientX, y: e.clientY })
        ui.setArmed(null)
        return
      }
      if (ui.cableStart) ui.setCableStart(null)
      if (ui.pduSource) ui.setPduSource(null)
      setPicker(null)
      ui.clearSelection()
    },
    [placeDevice]
  )

  const openPicker = useCallback((deviceId: string, e: MouseEvent) => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    setPicker({
      deviceId,
      x: Math.min(e.clientX - rect.left + 8, rect.width - 236),
      y: Math.min(e.clientY - rect.top + 8, rect.height - 200)
    })
  }, [])

  const onNodeClick = useCallback(
    (e: MouseEvent, node: DeviceFlowNode) => {
      const ui = useUiStore.getState()
      if (ui.tool === 'cable') {
        if (ui.cableStart?.deviceId === node.id) return
        openPicker(node.id, e)
      } else if (ui.tool === 'pdu') {
        if (!ui.pduSource) ui.setPduSource(node.id)
        else if (ui.pduSource !== node.id) {
          const source = ui.pduSource
          ui.setPduSource(null)
          sendSimplePdu(source, node.id)
        }
      } else if (ui.tool === 'delete') {
        runCommand(command('topology.removeDevices', [node.id]))
        ui.closeWindow(node.id)
        ui.clearSelection()
      }
    },
    [openPicker]
  )

  const onPickPort = useCallback(
    (ifaceId: string) => {
      if (!picker) return
      setPicker(null)
      pickCablePort(picker.deviceId, ifaceId)
    },
    [picker]
  )

  const onEdgeClick = useCallback((_e: MouseEvent, edge: CableFlowEdge) => {
    if (useUiStore.getState().tool === 'delete') {
      runCommand(command('topology.disconnect', edge.id))
      useUiStore.getState().clearSelection()
    }
  }, [])

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const ui = useUiStore.getState()
      if (!ui.cableStart && !ui.pduSource) return
      setCursor(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    },
    [flow]
  )

  const isEmpty = nodes.length === 0
  const cursorClass =
    armed || tool === 'cable' || tool === 'pdu'
      ? 'cursor-crosshair'
      : tool === 'delete'
        ? 'cursor-not-allowed'
        : ''

  return (
    <div
      ref={wrapperRef}
      className={`relative h-full w-full ${cursorClass}`}
      data-testid="topology-canvas"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
      onMouseMove={onMouseMove}
    >
      <ReactFlow<DeviceFlowNode, CableFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={() => useLabStore.getState().beginTransaction()}
        onNodeDragStop={(_event, _node, nodes) =>
          useLabStore.getState().commitTransaction(
            command(
              'topology.moveDevices',
              nodes.map((n) => ({ id: n.id, position: n.position }))
            )
          )
        }
        onNodeClick={onNodeClick}
        onNodeDoubleClick={(_e, node) => useUiStore.getState().openWindow(node.id)}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={tool === 'select'}
        nodesConnectable={false}
        elementsSelectable={tool === 'select'}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={3}
        snapToGrid
        snapGrid={[10, 10]}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--sl-canvas-grid)" />
        {showMinimap && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="Minimap"
            className="!mr-3 !mb-12"
            style={{ width: 168, height: 104 }}
            nodeBorderRadius={3}
            nodeColor={(n) => {
              const d = useLabStore.getState().lab.devices[n.id]
              return d ? MINIMAP_COLORS[d.kind] : 'var(--sl-fg-subtle)'
            }}
          />
        )}
        <ZoomControls />
        <CablePreview cursor={cableStart || pduSource ? cursor : null} />
        <PacketAnimation />
        <ProtocolLegend />
      </ReactFlow>
      <CanvasToolbar />
      <PduList />
      {picker && <PortPicker picker={picker} onPick={onPickPort} onClose={() => setPicker(null)} />}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-line bg-panel/90 px-4 py-2 text-fg-muted shadow-sm">
            {t('canvas.empty')}
          </p>
        </div>
      )}
    </div>
  )
}
