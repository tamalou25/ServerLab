/**
 * Chaîne de mise à jour automatique : une version installée détecte la suivante si le tag est de la
 * forme vX.Y.Z, si release.yml publie installeurs et latest.yml dans la release du tag marquée
 * « latest », et si electron-builder publie dans le dépôt lu par electron-updater.
 * Ces invariants, répartis entre trois fichiers, sont figés ici (lecture du texte, sans dépendance).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUG_REPORT_URL } from '../../src/shared/bugReport'

const ROOT = join(__dirname, '../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const builder = read('electron-builder.yml')
const release = read('.github/workflows/release.yml')
const pkg = JSON.parse(read('package.json')) as { homepage: string }

describe('chaîne de mise à jour automatique', () => {
  it('electron-builder publie dans le dépôt du projet (GitHub)', () => {
    const publish = builder.slice(builder.indexOf('\npublish:'))
    expect(publish).toMatch(/provider: github/)
    const owner = /owner: (\S+)/.exec(publish)?.[1]
    const repo = /repo: (\S+)/.exec(publish)?.[1]
    expect(`https://github.com/${owner}/${repo}`).toBe(pkg.homepage)
    expect(BUG_REPORT_URL.startsWith(`${pkg.homepage}/`)).toBe(true)
  })

  it('les installeurs portent la version (référencés par latest.yml / latest-linux.yml)', () => {
    const names = [...builder.matchAll(/artifactName: (.+)/g)].map((m) => m[1])
    expect(names).toHaveLength(2)
    for (const name of names) expect(name).toContain('${version}')
  })

  it('release.yml : tag vX.Y.Z seulement, version alignée sur le tag, publication « latest »', () => {
    expect(release).toMatch(/tags: \['v\*'\]/)
    // Un tag hors format (V2, v2) fait échouer le workflow au lieu de publier une release incomplète
    expect(release).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$')
    expect(release).toContain('npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version')
    expect(release).toContain('--publish always')
    expect(release).toMatch(/kind=--latest/)
  })
})

describe('fuses Electron de l’application empaquetée (audit S-02)', () => {
  it('pas d’interpréteur Node ni de NODE_OPTIONS, asar seul et vérifié', () => {
    const fuses = builder.slice(builder.indexOf('\nelectronFuses:'))
    expect(fuses).toMatch(/\n {2}runAsNode: false/)
    expect(fuses).toMatch(/\n {2}enableNodeOptionsEnvironmentVariable: false/)
    expect(fuses).toMatch(/\n {2}enableEmbeddedAsarIntegrityValidation: true/)
    expect(fuses).toMatch(/\n {2}onlyLoadAppFromAsar: true/)
  })
})
