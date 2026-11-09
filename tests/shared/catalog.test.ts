import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  durationBucket,
  EMPTY_FILTERS,
  filterCatalog,
  labMinutes,
  normalizeSearch,
  type CatalogEntry
} from '../../src/shared/catalog'

const LABS: CatalogEntry[] = [
  {
    id: 'lab-01-adressage',
    title: 'Adressage IP et routage',
    summary: 'Deux réseaux.',
    difficulty: 'Débutant',
    duration: '20 min'
  },
  {
    id: 'lab-02-dhcp',
    title: 'Distribuer les adresses',
    summary: 'Créer une étendue DHCP.',
    difficulty: 'Débutant',
    duration: '25 min'
  },
  {
    id: 'lab-05-ntfs',
    title: 'Partage et autorisations NTFS',
    summary: 'Droits par groupe.',
    difficulty: 'Avancé',
    duration: '40 min'
  },
  {
    id: 'lab-28-e6',
    title: 'Sujet E6',
    summary: 'Épreuve complète.',
    difficulty: 'Avancé',
    duration: '90 min'
  }
]
const context = {
  pathwayLabIds: new Set(['lab-01-adressage', 'lab-05-ntfs']),
  succeededLabIds: new Set(['lab-01-adressage'])
}
const ids = (filters: Partial<typeof EMPTY_FILTERS>) =>
  filterCatalog(LABS, { ...EMPTY_FILTERS, ...filters }, context).map((l) => l.id)

describe('catalogue des exercices', () => {
  it('lit la durée annoncée et la range par tranche', () => {
    expect(labMinutes('25 min')).toBe(25)
    expect(labMinutes('libre')).toBeNull()
    expect(durationBucket('25 min')).toBe('short')
    expect(durationBucket('30 min')).toBe('medium')
    expect(durationBucket('45 min')).toBe('long')
    expect(durationBucket('libre')).toBeNull()
  })

  it('cherche sans accents ni casse, tous les mots requis', () => {
    expect(normalizeSearch('  Étendue D’HCP ')).toBe("etendue d'hcp")
    expect(ids({ query: 'etendue' })).toEqual(['lab-02-dhcp'])
    expect(ids({ query: 'ADRESS routage' })).toEqual(['lab-01-adressage'])
    expect(ids({ query: 'adress' })).toEqual(['lab-01-adressage', 'lab-02-dhcp'])
    expect(ids({ query: 'ntfs dhcp' })).toEqual([])
  })

  it('sans filtre, conserve tout le catalogue dans son ordre', () => {
    expect(ids({})).toEqual(LABS.map((l) => l.id))
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
  })

  it('combine difficulté, durée, parcours et état', () => {
    expect(ids({ difficulty: 'Avancé' })).toEqual(['lab-05-ntfs', 'lab-28-e6'])
    expect(ids({ difficulty: 'Avancé', duration: 'long' })).toEqual(['lab-28-e6'])
    expect(ids({ pathwayOnly: true })).toEqual(['lab-01-adressage', 'lab-05-ntfs'])
    expect(ids({ pathwayOnly: true, status: 'todo' })).toEqual(['lab-05-ntfs'])
    expect(ids({ status: 'done' })).toEqual(['lab-01-adressage'])
    expect(activeFilterCount({ ...EMPTY_FILTERS, query: ' ', difficulty: 'Avancé', pathwayOnly: true })).toBe(
      2
    )
  })
})
