import { expect, test } from '@playwright/test'
import { buildLargeLab } from '../support/large-lab'
import { openLab } from './fixtures'
import { launchApp } from './helpers'

/**
 * Seuils fixés après la première mesure (docs/performance.md). Mesures d'origine : ouverture
 * 205–308 ms, glisser 22–46 ms par mouvement (piloté par Playwright, dépend de la machine), image
 * p95 16,7–33 ms, 0 rendu des autres nœuds et câbles. Avant optimisation : 6 047 rendus des autres
 * nœuds. Les rendus sont le contrôle strict ; les durées, avec une marge large (runners variables),
 * détectent une régression grossière.
 */
const THRESHOLDS = {
  openMs: 2000,
  dragMsPerMove: 80,
  frameP95Ms: 70,
  otherNodeRenders: 0,
  otherEdgeRenders: 0
}

for (const mixed of [false, true]) {
  test(`topologie de 100 équipements${mixed ? ' mixte (Cisco, pare-feu, Linux, Windows)' : ''} : ouverture et glisser fluides`, async () => {
    const { app, close, page, consoleErrors } = await launchApp()
    try {
      const { state } = buildLargeLab({ mixed })
      const devices = Object.keys(state.devices).length
      expect(devices).toBe(100)

      // Ouverture : du menu Fichier > Ouvrir… jusqu'aux 100 nœuds affichés
      const openStart = Date.now()
      await openLab(app, page, state)
      const openMs = Date.now() - openStart

      // Laisse le canvas terminer ses mesures de taille avant de compter les rendus
      await page.waitForTimeout(500)

      // Glisser un poste : 30 mouvements, durée des images mesurée dans la page
      const node = page.getByTestId('device-PC1')
      const box = await node.boundingBox()
      if (!box) throw new Error('nœud PC1 introuvable')
      await page.evaluate(() => {
        const w = window as unknown as { serverlabFrames: number[]; serverlabFrameStop: boolean }
        w.serverlabFrames = []
        w.serverlabFrameStop = false
        let last = performance.now()
        const tick = (now: number) => {
          w.serverlabFrames.push(now - last)
          last = now
          if (!w.serverlabFrameStop) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await node.hover()
      // Fin des effets de survol précédents (panneau de ports masqué après un délai)
      await page.waitForTimeout(300)
      await page.evaluate(() => {
        ;(window as unknown as { serverlabPerf: { renders: Record<string, number> } }).serverlabPerf = {
          renders: {}
        }
      })
      await page.mouse.down()
      const dragStart = Date.now()
      for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 20 + i * 8, box.y + 20 + i * 4)
      const dragMs = (Date.now() - dragStart) / 30
      await page.mouse.up()
      const frames = await page.evaluate(() => {
        const w = window as unknown as { serverlabFrames: number[]; serverlabFrameStop: boolean }
        w.serverlabFrameStop = true
        return w.serverlabFrames.slice(1)
      })
      // Rendus des autres nœuds et des câbles non raccordés au poste déplacé
      const pcId = Object.values(state.devices).find((d) => d.name === 'PC1')?.id ?? ''
      const pcLinks = new Set(
        Object.values(state.links)
          .filter((l) => l.a.deviceId === pcId || l.b.deviceId === pcId)
          .map((l) => l.id)
      )
      const renders = await page.evaluate(
        () =>
          (window as unknown as { serverlabPerf: { renders: Record<string, number> } }).serverlabPerf.renders
      )
      const otherNodeRenders = Object.entries(renders)
        .filter(([k]) => k.startsWith('node:') && k !== `node:${pcId}`)
        .reduce((sum, [, n]) => sum + n, 0)
      const otherEdgeRenders = Object.entries(renders)
        .filter(([k]) => k.startsWith('edge:') && !pcLinks.has(k.slice(5)))
        .reduce((sum, [, n]) => sum + n, 0)
      const sorted = [...frames].sort((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
      await expect.poll(async () => (await node.boundingBox())?.x).toBeGreaterThan(box.x + 100)

      const heapMb = await page.evaluate(
        () =>
          ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) /
          1048576
      )
      const rssMb = await app.evaluate(() => process.memoryUsage().rss / 1048576)
      console.log(
        `[perf${mixed ? ' mixte' : ''}] tas renderer ${heapMb.toFixed(0)} Mo · RSS main ${rssMb.toFixed(0)} Mo · ouverture ${openMs} ms · glisser ${dragMs.toFixed(1)} ms/mouvement · image p95 ${p95.toFixed(1)} ms · max ${Math.max(...frames).toFixed(1)} ms · rendus des autres nœuds ${otherNodeRenders} · des autres câbles ${otherEdgeRenders}`
      )
      expect(otherNodeRenders, 'glisser un nœud ne redessine pas les autres').toBeLessThanOrEqual(
        THRESHOLDS.otherNodeRenders
      )
      expect(otherEdgeRenders, 'ni les câbles qui ne lui sont pas raccordés').toBeLessThanOrEqual(
        THRESHOLDS.otherEdgeRenders
      )
      expect(openMs, 'ouverture du lab de 100 équipements').toBeLessThan(THRESHOLDS.openMs)
      expect(dragMs, 'glisser : durée par mouvement').toBeLessThan(THRESHOLDS.dragMsPerMove)
      expect(p95, 'glisser : image p95').toBeLessThan(THRESHOLDS.frameP95Ms)
      expect(consoleErrors).toEqual([])
    } finally {
      await close()
    }
  })
}
