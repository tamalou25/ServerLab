/**
 * Bibliothèque communautaire de labs : téléchargement de l'index et des labs depuis le dépôt
 * public (adresses construites ici, chemins sur liste blanche, taille et délai bornés). Le
 * contenu est vérifié ensuite par le moteur (empreinte SHA-256, schéma des labs).
 */
import { app, net } from 'electron'
import type { FileResult } from '../shared/ipc'
import { t } from './i18n'
import {
  libraryBaseUrl,
  libraryFileUrl,
  MAX_LIBRARY_INDEX_BYTES,
  MAX_LIBRARY_LAB_BYTES
} from '../shared/library'

const TIMEOUT_MS = 15_000

/** Corps de la réponse, ou null s'il dépasse `maxBytes` (lecture interrompue). */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function download(url: string, maxBytes: number): Promise<FileResult<string>> {
  let res: Response
  try {
    res = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  } catch {
    return { ok: false, error: t('library.error.unreachable') }
  }
  if (!res.ok)
    return {
      ok: false,
      error:
        res.status === 404 ? t('library.error.notFound') : t('library.error.http', { status: res.status })
    }
  const length = Number(res.headers.get('content-length') ?? '0')
  if (length > maxBytes) return { ok: false, error: t('library.error.tooLarge') }
  // Lecture par morceaux : le téléchargement s'arrête dès que la taille maximale est dépassée
  // (en-tête absent ou mensonger)
  let body: Uint8Array | null
  try {
    body = await readBounded(res, maxBytes)
  } catch {
    // Connexion coupée ou délai dépassé pendant la lecture
    return { ok: false, error: t('library.error.unreachable') }
  }
  if (!body) return { ok: false, error: t('library.error.tooLarge') }
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(body) }
  } catch {
    return { ok: false, error: t('library.error.encoding') }
  }
}

// Bibliothèque locale des tests E2E : ignorée par l'application empaquetée
const base = () => libraryBaseUrl(app.isPackaged ? undefined : process.env['SERVERLAB_LIBRARY_URL'])

export function fetchLibraryIndex(): Promise<FileResult<string>> {
  return download(`${base()}index.json`, MAX_LIBRARY_INDEX_BYTES)
}

export async function fetchLibraryLab(file: unknown): Promise<FileResult<string>> {
  const url = file === 'index.json' ? null : libraryFileUrl(base(), file)
  if (!url) return { ok: false, error: t('library.error.path') }
  return download(url, MAX_LIBRARY_LAB_BYTES)
}
