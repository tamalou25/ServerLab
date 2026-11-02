/** Fichiers de référence du mode enseignant : un par type et par version de format, jamais modifiés. */
import { readFileSync } from 'node:fs'
import type { TeacherFileKind } from '@engine/index'

export const fixtureUrl = (kind: TeacherFileKind, version: number): URL =>
  new URL(`./fixtures/${kind}-v${version}.json`, import.meta.url)

export const readFixture = (kind: TeacherFileKind, version: number): string =>
  readFileSync(fixtureUrl(kind, version), 'utf8')
