/**
 * Onglet Bibliothèque du sélecteur de labs : labs partagés par la communauté (index du dépôt
 * public), téléchargés et vérifiés avant ouverture.
 */
import { useEffect, useState } from 'react'
import { CloudDownload, RefreshCw, ShieldCheck } from 'lucide-react'
import type { LibraryEntry, LibraryIndex } from '@engine/index'
import { loadLibraryIndex, openLibraryLab } from '../../lib/library'
import { Button } from '../common/ui'
import { DifficultyBadge } from './DifficultyBadge'
import { t } from '../../lib/i18n'

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; index: LibraryIndex }

export function LibraryList() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setState({ kind: 'loading' })
    void loadLibraryIndex().then((r) =>
      setState(r.ok ? { kind: 'ready', index: r.index } : { kind: 'error', message: r.message })
    )
  }
  useEffect(load, [])
  const open = async (entry: LibraryEntry) => {
    setBusy(entry.id)
    setError(null)
    const message = await openLibraryLab(entry)
    setBusy(null)
    if (message) setError(message)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="library">
      <p className="flex items-start gap-1.5 px-5 pt-3 text-dense text-fg-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-ok-text" />
        {t('lab.libraryHelp')}
      </p>
      {error && (
        <p
          className="mx-5 mt-2 rounded-md bg-danger-soft px-3 py-2 text-dense text-danger-text"
          data-testid="library-error"
        >
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {state.kind === 'loading' ? (
          <p className="text-ui text-fg-muted" data-testid="library-loading">
            {t('lab.chargementDeLaBibliotheque')}
          </p>
        ) : state.kind === 'error' ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-ui text-danger-text" data-testid="library-index-error">
              {state.message}
            </p>
            <Button onClick={load} data-testid="library-retry">
              <RefreshCw size={14} /> Réessayer
            </Button>
          </div>
        ) : state.index.labs.length === 0 ? (
          <p className="text-ui text-fg-muted">{t('lab.laBibliothequeNeContient')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.index.labs.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-3 rounded-md border border-line bg-surface p-3"
                data-testid={`library-entry-${entry.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-semibold text-fg">{entry.title}</span>
                    <DifficultyBadge difficulty={entry.difficulty} />
                    <span className="font-mono text-meta text-fg-subtle">v{entry.version}</span>
                  </div>
                  <p className="mt-0.5 text-meta text-fg-subtle">par {entry.author}</p>
                  {entry.summary && <p className="mt-1 text-dense text-fg-muted">{entry.summary}</p>}
                </div>
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void open(entry)}
                  data-testid={`library-open-${entry.id}`}
                >
                  <CloudDownload size={14} /> {busy === entry.id ? t('lab.verifying') : t('lab.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
