/**
 * Navigation autorisée dans la fenêtre de l'application : la page elle-même uniquement.
 */
import { describe, expect, it } from 'vitest'
import { isAppNavigation } from '../../src/shared/navigation'

const APP = 'file:///opt/ServerLab/resources/app.asar/out/renderer/index.html'

describe('navigation de la fenêtre principale', () => {
  it('autorise la page de l’application, avec ancre ou paramètres', () => {
    expect(isAppNavigation(APP, APP)).toBe(true)
    expect(isAppNavigation(`${APP}#/lab`, APP)).toBe(true)
    expect(isAppNavigation(`${APP}?x=1`, APP)).toBe(true)
  })

  it('refuse tout autre fichier local (fichier glissé dans la fenêtre)', () => {
    expect(isAppNavigation('file:///home/eleve/Téléchargements/piege.html', APP)).toBe(false)
    expect(isAppNavigation('file:///home/eleve/lab.slab', APP)).toBe(false)
    expect(isAppNavigation('file:///opt/ServerLab/resources/app.asar/out/renderer/autre.html', APP)).toBe(
      false
    )
    expect(isAppNavigation('file://serveur/partage/index.html', APP)).toBe(false)
  })

  it('refuse le web et les schémas exotiques', () => {
    for (const url of ['https://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'pas une url']) {
      expect(isAppNavigation(url, APP)).toBe(false)
    }
  })

  it('en développement : même origine que le serveur Vite seulement', () => {
    const dev = 'http://localhost:5173'
    expect(isAppNavigation('http://localhost:5173/', APP, dev)).toBe(true)
    expect(isAppNavigation('http://localhost:5173/src/main.tsx', APP, dev)).toBe(true)
    expect(isAppNavigation('http://localhost:5173@evil.example/', APP, dev)).toBe(false)
    expect(isAppNavigation('http://localhost:5174/', APP, dev)).toBe(false)
    expect(isAppNavigation('file:///tmp/piege.html', APP, dev)).toBe(false)
  })
})
