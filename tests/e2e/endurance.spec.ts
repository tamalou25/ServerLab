import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { clickMenu, launchApp } from './helpers'

/**
 * Endurance : 50 ouvertures de labs intégrés à la suite (chacune remplace la précédente), tas du
 * renderer mesuré au début, après 10 et après 50 ouvertures. Le ramasse-miettes est forcé avant
 * chaque mesure par le protocole DevTools (`HeapProfiler.collectGarbage`, deux passes).
 *
 * Seuil : la croissance du tas après GC entre la mesure « 10 » (caches chauds) et « 50 » ne doit pas
 * dépasser 1 Mo. Trois passages consécutifs ont mesuré +0,11 Mo, +0,11 Mo et +0,11 Mo (tas 11,35 → 11,46 ;
 * 11,34 → 11,45 ; 11,33 → 11,44 Mo), soit une variance quasi nulle ; 3 × le maximum donne 0,33 Mo, on
 * retient le plancher de 1 Mo pour absorber la variabilité de V8 et des runners. L'ancien seuil de 10 Mo
 * était 50 fois la mesure : une fuite de ~0,24 Mo par ouverture (+9,6 Mo mesurés avec une référence de
 * 12 500 objets conservée à chaque ouverture, simulation non commitée) passait encore, elle échoue
 * maintenant. Le nombre d'éléments DOM est aussi borné.
 */
const OPENINGS = 50
const MAX_HEAP_GROWTH_MB = 1
const MAX_DOM_GROWTH = 200

const labIds = readdirSync(resolve(__dirname, '../../labs'))
  .filter((f) => /^lab-.*\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

test(`endurance : ${OPENINGS} ouvertures de labs sans fuite mémoire`, async () => {
  test.setTimeout(10 * 60_000)
  expect(labIds.length).toBeGreaterThan(5)
  const { app, close, page, consoleErrors } = await launchApp()
  const cdp = await page.context().newCDPSession(page)
  try {
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const { usedSize } = await cdp.send('Runtime.getHeapUsage')
      const dom = await page.evaluate(() => document.getElementsByTagName('*').length)
      const rss = await app.evaluate(() => process.memoryUsage().rss)
      return { heapMb: usedSize / 1048576, dom, rssMb: rss / 1048576 }
    }
    const samples: Record<string, Awaited<ReturnType<typeof measure>>> = { début: await measure() }
    for (let i = 1; i <= OPENINGS; i++) {
      const id = labIds[i % labIds.length] ?? ''
      await clickMenu(app, ['Fichier', 'Ouvrir un lab…'])
      await page.getByTestId(`lab-open-${id}`).click()
      await expect(page.getByTestId('lab-title')).toBeVisible()
      await expect(page.locator('.react-flow__node').first()).toBeVisible()
      if (i === 10 || i === OPENINGS) samples[`après ${i}`] = await measure()
    }
    for (const [k, v] of Object.entries(samples))
      console.log(
        `[endurance] ${k} : tas ${v.heapMb.toFixed(2)} Mo · DOM ${v.dom} · RSS main ${v.rssMb.toFixed(0)} Mo`
      )
    const b = samples['après 10']
    const c = samples[`après ${OPENINGS}`]
    if (!b || !c) throw new Error('mesures manquantes')
    expect(c.heapMb - b.heapMb, `croissance du tas entre 10 et ${OPENINGS} ouvertures (Mo)`).toBeLessThan(
      MAX_HEAP_GROWTH_MB
    )
    expect(c.dom - b.dom, `croissance du DOM entre 10 et ${OPENINGS} ouvertures`).toBeLessThan(MAX_DOM_GROWTH)
    expect(consoleErrors).toEqual([])
  } finally {
    await close()
  }
})
