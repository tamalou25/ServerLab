/**
 * Terminal simulé : sortie défilante + ligne de saisie avec historique (↑↓) et complétion (Tab).
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { complete, IOS_CTRL_Z, iosComplete, iosHelp, type ShellKind } from '@engine/index'
import { terminalKey, useConsoleStore, type TermLine } from '../../store/console'
import { useLabStore } from '../../store/lab'
import { cancelConsoleInput, ensureTerminal, promptOf, submitConsoleInput } from '../../lib/console'
import { redo, undo } from '../../lib/editing'
import { t } from '../../lib/i18n'
import { countRender } from '../../lib/perf'

interface TerminalProps {
  deviceId: string
  kind: ShellKind
  /** Donne le focus à l'ouverture. */
  autoFocus?: boolean
}

const THEMES: Record<
  ShellKind,
  { root: string; text: string; error: string; warning: string; verbose: string }
> = {
  powershell: {
    root: 'bg-[#012456]',
    text: 'text-slate-100',
    error: 'text-red-300',
    warning: 'text-yellow-300',
    verbose: 'text-cyan-300'
  },
  cmd: {
    root: 'bg-black',
    text: 'text-neutral-300',
    error: 'text-red-400',
    warning: 'text-yellow-300',
    verbose: 'text-cyan-300'
  },
  // Émulateur de terminal sur le port console d'un équipement Cisco
  ios: {
    root: 'bg-black',
    text: 'text-neutral-200',
    error: 'text-neutral-200',
    warning: 'text-neutral-200',
    verbose: 'text-neutral-200'
  },
  // Console série du pare-feu pfSense
  pfsense: {
    root: 'bg-black',
    text: 'text-neutral-200',
    error: 'text-red-400',
    warning: 'text-yellow-300',
    verbose: 'text-cyan-300'
  },
  // Terminal d'Ubuntu (profil par défaut)
  bash: {
    root: 'bg-[#300a24]',
    text: 'text-neutral-100',
    error: 'text-neutral-100',
    warning: 'text-yellow-300',
    verbose: 'text-cyan-300'
  }
}

/** État de la complétion Tab en cours (pour parcourir les propositions). */
interface CompletionCycle {
  base: string
  start: number
  end: number
  candidates: string[]
  index: number
}

type TerminalTheme = (typeof THEMES)[ShellKind]

/**
 * Lignes de sortie (jusqu'à 2000). Mémoïsé : la saisie (état du Terminal) ne les redessine pas,
 * seul un changement de `lines` (nouveau tableau) ou de thème le fait.
 */
const Lines = memo(function Lines({
  lines,
  theme,
  probeKey
}: {
  lines: TermLine[]
  theme: TerminalTheme
  probeKey: string
}) {
  countRender(`console-lines:${probeKey}`) // mesure (tests/e2e/console-perf.spec.ts)
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.id}
          className={`min-h-[1.35em] break-all whitespace-pre-wrap ${
            l.kind === 'error'
              ? theme.error
              : l.kind === 'warning'
                ? theme.warning
                : l.kind === 'verbose'
                  ? theme.verbose
                  : ''
          }`}
        >
          {l.text}
        </div>
      ))}
    </>
  )
})

export function Terminal({ deviceId, kind, autoFocus }: TerminalProps) {
  const key = terminalKey(deviceId, kind)
  const term = useConsoleStore((s) => s.terminals[key])
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const cycle = useRef<CompletionCycle | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Création de la console hors du rendu (mise à jour du store)
  // Recréée aussi après une réinitialisation (changement de session, redémarrage)
  const exists = !!term
  useEffect(() => {
    if (!exists) ensureTerminal(deviceId, kind)
  }, [deviceId, kind, exists])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus, term?.busy])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [term?.lines.length, term?.pending])

  if (!term) return null
  const theme = THEMES[term.session ? (term.session.stack[term.session.stack.length - 1] ?? kind) : kind]
  const promptText = term.pending ? term.pending.prompt.message : promptOf(term.session)
  const secure = term.pending?.prompt.secure ?? false

  const ios = kind === 'ios'

  /** Console IOS : « ? » (aide immédiate), Tab (mot unique) et Ctrl+Z (fin de la configuration). */
  const onIosKey = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!term.session || term.pending) return false
    const lab = useLabStore.getState().lab
    if (e.key === '?') {
      e.preventDefault()
      useConsoleStore
        .getState()
        .append(key, [
          { text: `${promptText}${input}?`, kind: 'input' },
          ...iosHelp(lab, term.session, input).map((text) => ({ text, kind: 'out' as const }))
        ])
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const result = iosComplete(lab, term.session, input)
      if (result) setInput(input.slice(0, result.start) + result.word)
      return true
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      setInput('')
      setHistoryIndex(null)
      submitConsoleInput(key, IOS_CTRL_Z)
      return true
    }
    return false
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (ios && onIosKey(e)) return
    if (e.key !== 'Tab') cycle.current = null
    if (e.key === 'Enter') {
      e.preventDefault()
      const value = input
      setInput('')
      setHistoryIndex(null)
      submitConsoleInput(key, value)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (term.pending || !term.session) return
      let c = cycle.current
      if (!c) {
        const cursor = e.currentTarget.selectionStart ?? input.length
        const result = complete(useLabStore.getState().lab, term.session, input, cursor)
        if (result.candidates.length === 0) return
        c = {
          base: input,
          start: result.start,
          end: result.end,
          candidates: result.candidates,
          index: e.shiftKey ? result.candidates.length - 1 : 0
        }
      } else {
        c = { ...c, index: (c.index + (e.shiftKey ? -1 : 1) + c.candidates.length) % c.candidates.length }
      }
      cycle.current = c
      const candidate = c.candidates[c.index] ?? ''
      const next = c.base.slice(0, c.start) + candidate + c.base.slice(c.end)
      setInput(next)
      requestAnimationFrame(() => {
        const pos = c.start + candidate.length
        inputRef.current?.setSelectionRange(pos, pos)
      })
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (term.pending) return
      e.preventDefault()
      const h = term.history
      if (h.length === 0) return
      let idx = historyIndex ?? h.length
      idx = e.key === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(h.length, idx + 1)
      setHistoryIndex(idx)
      setInput(idx === h.length ? '' : (h[idx] ?? ''))
    } else if ((e.ctrlKey || e.metaKey) && !term.pending && input === '' && /^[zy]$/i.test(e.key)) {
      // Ligne vide : Ctrl+Z / Ctrl+Y (ou Maj+Ctrl+Z) annulent ou rétablissent la dernière commande du lab
      e.preventDefault()
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo('lab')
      else undo('lab')
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      cancelConsoleInput(key, secure ? '' : input)
      setInput('')
    } else if (e.key === 'Escape') {
      setInput('')
    }
  }

  return (
    <div
      ref={scrollRef}
      className={`selectable h-full overflow-y-auto p-2 font-mono text-ui leading-[1.35] ${theme.root} ${theme.text}`}
      onMouseUp={() => {
        // Clic dans la console : focus sur la saisie (sauf sélection de texte en cours)
        if (!window.getSelection()?.toString()) inputRef.current?.focus()
      }}
      data-testid={`terminal-${kind}`}
    >
      <Lines lines={term.lines} theme={theme} probeKey={key} />
      {term.busy ? (
        <div className="text-cyan-300">{t('console.simulationEnCoursPanneau')}</div>
      ) : (
        <div className="flex">
          <span className="whitespace-pre">{promptText}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              cycle.current = null
            }}
            onKeyDown={onKeyDown}
            type={secure ? 'password' : 'text'}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-ui text-inherit caret-current outline-none focus-visible:ring-1 focus-visible:ring-accent"
            data-testid="terminal-input"
          />
        </div>
      )}
    </div>
  )
}
