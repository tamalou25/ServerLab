/**
 * Données lues par le process principal (settings.json, recent.json, messages IPC) : un contenu
 * invalide donne les valeurs par défaut, jamais d'exception.
 */
import { describe, expect, it } from 'vitest'
import { MAX_SLAB_LENGTH } from '@engine/index'
import { MAX_SLAB_BYTES } from '../../src/shared/ipc'
import {
  DEFAULT_SETTINGS,
  DocStateSchema,
  MAX_MENU_LABEL,
  MAX_RECENT,
  MAX_RECENT_BYTES,
  MAX_SETTINGS_BYTES,
  MenuStateSchema,
  MAX_PROGRESS_BYTES,
  parseAttempt,
  parseProgressFile,
  parseRecentFiles,
  parseSettings
} from '../../src/shared/persisted'

const recent = (n: number) => ({
  path: `C:\\Labs\\lab${n}.slab`,
  name: `lab${n}.slab`,
  openedAt: '2026-10-05T10:00:00Z'
})

describe('settings.json', () => {
  it('lit un thème valide et ignore les champs inconnus', () => {
    expect(parseSettings('{"theme":"light","fenetre":{"x":1}}')).toEqual({
      theme: 'light',
      language: 'system',
      showHomeOnStartup: true,
      showTutorialOnStartup: true,
      teacherMode: false
    })
  })

  it('thème « Système » par défaut ; un choix explicite déjà enregistré est conservé', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(parseSettings('{}').theme).toBe('system')
    expect(parseSettings('{"theme":"system"}').theme).toBe('system')
    expect(parseSettings('{"theme":"dark"}').theme).toBe('dark')
  })

  it('langue : celle du système par défaut, choix enregistré conservé, valeur invalide ignorée', () => {
    expect(DEFAULT_SETTINGS.language).toBe('system')
    // Fichier d'une version précédente (sans langue) : langue du système, thème conservé
    expect(parseSettings('{"theme":"dark"}')).toMatchObject({ theme: 'dark', language: 'system' })
    expect(parseSettings('{"language":"en"}').language).toBe('en')
    expect(parseSettings('{"language":"fr"}').language).toBe('fr')
    expect(parseSettings('{"theme":"light","language":"de"}')).toMatchObject({
      theme: 'light',
      language: 'system'
    })
  })

  it('accueil au démarrage : affiché par défaut, choix enregistré conservé', () => {
    expect(DEFAULT_SETTINGS.showHomeOnStartup).toBe(true)
    // Fichier d'une version précédente (thème seul) : accueil affiché, thème conservé
    expect(parseSettings('{"theme":"dark"}')).toMatchObject({ theme: 'dark', showHomeOnStartup: true })
    expect(parseSettings('{"showHomeOnStartup":false}')).toMatchObject({
      theme: 'system',
      showHomeOnStartup: false
    })
    // Valeur invalide : défaut, sans perdre le thème
    expect(parseSettings('{"theme":"light","showHomeOnStartup":"non"}')).toMatchObject({
      theme: 'light',
      showHomeOnStartup: true
    })
  })

  it('tutoriel au démarrage : proposé par défaut, choix enregistré conservé', () => {
    expect(DEFAULT_SETTINGS.showTutorialOnStartup).toBe(true)
    // Fichier d'une version précédente : tutoriel proposé, autres préférences conservées
    expect(parseSettings('{"theme":"dark","showHomeOnStartup":false}')).toEqual({
      theme: 'dark',
      language: 'system',
      showHomeOnStartup: false,
      showTutorialOnStartup: true,
      teacherMode: false
    })
    expect(parseSettings('{"showTutorialOnStartup":false}').showTutorialOnStartup).toBe(false)
    expect(parseSettings('{"showTutorialOnStartup":0}').showTutorialOnStartup).toBe(true)
  })

  it('corrompu, tronqué, trop gros ou de mauvais type : préférences par défaut', () => {
    const cases = [
      '',
      '{"theme":"light"',
      'null',
      '[]',
      '"light"',
      '{"theme":42}',
      '{"theme":"rose"}',
      `{"theme":"light","x":"${'a'.repeat(MAX_SETTINGS_BYTES)}"}`
    ]
    for (const text of cases) expect(parseSettings(text), text.slice(0, 30)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('recent.json', () => {
  it('garde les entrées valides, écarte les autres une à une', () => {
    const text = JSON.stringify([recent(1), { path: 42 }, null, recent(2), { ...recent(3), path: '' }, 'x'])
    expect(parseRecentFiles(text)).toEqual([recent(1), recent(2)])
  })

  it('retire les champs inconnus et limite le nombre d’entrées', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...recent(i), pinned: true }))
    const files = parseRecentFiles(JSON.stringify(many))
    expect(files).toHaveLength(MAX_RECENT)
    expect(files.every((f) => !('pinned' in f))).toBe(true)
  })

  it('corrompu, tronqué, trop gros ou pas une liste : liste vide', () => {
    const big = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => recent(i)))
    expect(big.length).toBeGreaterThan(MAX_RECENT_BYTES)
    for (const text of ['', '[{"path":', '{}', 'null', '"x"', big]) expect(parseRecentFiles(text)).toEqual([])
  })
})

describe('messages IPC', () => {
  it('état du menu : forme exacte exigée', () => {
    const ok = {
      mode: 'realtime',
      showPortLabels: false,
      showProperties: true,
      showMinimap: true,
      undoLabel: 'Annuler : Ajouter SRV1',
      redoLabel: null
    }
    expect(MenuStateSchema.safeParse(ok).success).toBe(true)
    expect(MenuStateSchema.safeParse({ ...ok, mode: 'turbo' }).success).toBe(false)
    expect(MenuStateSchema.safeParse({ ...ok, showMinimap: 'oui' }).success).toBe(false)
    expect(MenuStateSchema.safeParse(null).success).toBe(false)
  })

  it('état du menu : libellés Annuler / Rétablir texte court ou null', () => {
    const base = { mode: 'simulation', showPortLabels: true, showProperties: false, showMinimap: false }
    expect(MenuStateSchema.safeParse({ ...base, undoLabel: null, redoLabel: null }).success).toBe(true)
    expect(MenuStateSchema.safeParse({ ...base, undoLabel: null }).success).toBe(false)
    expect(MenuStateSchema.safeParse({ ...base, undoLabel: 42, redoLabel: null }).success).toBe(false)
    expect(
      MenuStateSchema.safeParse({ ...base, undoLabel: 'x'.repeat(MAX_MENU_LABEL + 1), redoLabel: null })
        .success
    ).toBe(false)
  })

  it('état du document : nom limité à 200 caractères', () => {
    expect(DocStateSchema.safeParse({ name: 'Lab 1', dirty: true }).success).toBe(true)
    expect(DocStateSchema.safeParse({ name: 'x'.repeat(201), dirty: true }).success).toBe(false)
    expect(DocStateSchema.safeParse({ name: 'Lab 1' }).success).toBe(false)
  })
})

it('la limite de taille des .slab est la même dans le moteur et le process principal', () => {
  expect(MAX_SLAB_LENGTH).toBe(MAX_SLAB_BYTES)
})

describe('progress.json (progression du parcours)', () => {
  const attempt = {
    id: 'lab-01-adressage-1',
    labId: 'lab-01-adressage',
    mode: 'lab',
    finishedAt: '2026-11-02T09:00:00.000Z',
    passed: 7,
    total: 7,
    success: true
  }

  it('lit les tentatives valides, écarte les autres, remplit les défauts', () => {
    const text = JSON.stringify({ formatVersion: 1, attempts: [attempt, { id: 'x' }, 42] })
    const parsed = parseProgressFile(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ ...attempt, hintsUsed: 0, gaveUp: false, competences: [] })
  })

  it('fichier absent, corrompu, trop gros ou d’un autre format : progression vide', () => {
    expect(parseProgressFile('')).toEqual([])
    expect(parseProgressFile('{"formatVersion":1,"attempts":[')).toEqual([])
    expect(parseProgressFile('{"formatVersion":9,"attempts":[]}')).toEqual([])
    expect(parseProgressFile('[]')).toEqual([])
    expect(
      parseProgressFile(`{"formatVersion":1,"attempts":[${'0,'.repeat(MAX_PROGRESS_BYTES / 2)}0]}`)
    ).toEqual([])
  })

  it('tentative IPC : validée par le schéma du moteur, refusée sinon', () => {
    expect(parseAttempt(attempt)).toMatchObject({ labId: 'lab-01-adressage', success: true })
    expect(parseAttempt({ ...attempt, passed: 'sept' })).toBeNull()
    expect(parseAttempt({ ...attempt, mode: 'triche' })).toBeNull()
    expect(parseAttempt(null)).toBeNull()
    expect(parseAttempt({ ...attempt, id: 'x'.repeat(200) })).toBeNull()
  })
})
