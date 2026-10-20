/**
 * Commandes de fichiers de la console bash (v2.9) sur le système de fichiers Linux simulé :
 * ls, cat, touch, mkdir (partie locale), tee, sed, nano, chmod, chown. Les droits Unix sont appliqués
 * à chaque accès ; les messages sont ceux de coreutils 9.1 et de sed 4.9 (Debian 12, locale C).
 */
import { LAB_EPOCH_MS } from '../../core/clock'
import { resolveLink } from '../../services/linuxconfig'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { getopt, type ParsedOpts } from './getopt'
import {
  actor,
  baseOf,
  byteLength,
  canTraverse,
  childrenOf,
  cloneFiles,
  commitFiles,
  contentOf,
  hasPerm,
  identityOf,
  joinPath,
  linuxFiles,
  modeString,
  parentOf,
  readGroups,
  readPasswd,
  resolvePath,
  subtree,
  usageError,
  type LinuxFiles,
  type LinuxNode
} from './linuxfs'

// ---------------------------------------------------------------------------
// Accès communs
// ---------------------------------------------------------------------------

export type Errno = 'EACCES' | 'ENOENT' | 'EISDIR' | 'ENOTDIR' | 'EEXIST'
const ERRNO: Record<Errno, string> = {
  EACCES: 'Permission denied',
  ENOENT: 'No such file or directory',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EEXIST: 'File exists'
}
export const errnoText = (e: Errno) => ERRNO[e]

/** Chemin situé sous un partage monté (les fichiers y sont ceux du serveur, pas de l'arborescence locale). */
export function underMount(ctx: ExecContext, path: string): boolean {
  return ctx.host.host.mounts.some((m) => path === m.target || path.startsWith(`${m.target}/`))
}

/** Dossier de montage virtuel (/mnt/compta) : présent même hors de l'arborescence enregistrée. */
function mountDirNode(): LinuxNode {
  return { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 }
}

/** Nœud d'un chemin, y compris les points de montage. */
export function nodeAt(ctx: ExecContext, files: LinuxFiles, path: string): LinuxNode | undefined {
  return files[path] ?? (underMount(ctx, path) ? mountDirNode() : undefined)
}

/** Peut-on écrire ce fichier (ou le créer) ? Renvoie l'erreur errno, ou null. */
export function writeError(files: LinuxFiles, user: string, path: string): Errno | null {
  const node = files[path]
  if (node) {
    if (node.type === 'dir') return 'EISDIR'
    return canTraverse(files, user, path) && hasPerm(files, user, node, 2) ? null : 'EACCES'
  }
  const parent = files[parentOf(path)]
  if (!parent) return 'ENOENT'
  if (parent.type !== 'dir') return 'ENOTDIR'
  return canTraverse(files, user, path) && hasPerm(files, user, parent, 2) && hasPerm(files, user, parent, 1)
    ? null
    : 'EACCES'
}

/** Groupe principal d'un utilisateur (groupe des fichiers qu'il crée). */
export function primaryGroup(files: LinuxFiles, user: string): string {
  return identityOf(files, user)?.groups[0]?.name ?? user
}

/** Crée ou remplace le contenu d'un fichier (droits déjà vérifiés par l'appelant). */
export function putFile(
  files: LinuxFiles,
  path: string,
  text: string,
  ctx: ExecContext,
  opts: { user: string; clock: number; append?: boolean }
): void {
  let target = path
  // Écrire dans un lien symbolique écrit dans sa cible (contrairement à sed -i, qui remplace le lien)
  for (let i = 0; i < 8 && files[target]?.link !== undefined; i++)
    target = resolveLink(target, files[target]?.link as string)
  const node = files[target]
  if (node) {
    node.content = opts.append ? `${contentOf(ctx, target, node)}${text}` : text
    node.mtime = opts.clock
  } else {
    files[path] = {
      type: 'file',
      mode: 0o644,
      owner: opts.user,
      group: primaryGroup(files, opts.user),
      content: text,
      mtime: opts.clock
    }
  }
}

/** Texte de sortie (lignes) → contenu de fichier. */
export const linesToText = (lines: string[]): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)

const textToLines = (text: string): string[] => {
  const l = text.split('\n')
  if (l.at(-1) === '') l.pop()
  return l
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date de `ls -l` pour un fichier récent (« Jan  5 08:00 »). */
function lsDate(mtime: number): string {
  const d = new Date(LAB_EPOCH_MS + mtime)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

interface LsEntry {
  name: string
  node: LinuxNode
  path: string
}

const sizeOf = (ctx: ExecContext, e: LsEntry): number =>
  e.node.type === 'dir'
    ? 4096
    : e.node.link !== undefined
      ? byteLength(e.node.link)
      : byteLength(contentOf(ctx, e.path, e.node))
const blocksOf = (ctx: ExecContext, e: LsEntry): number =>
  e.node.type === 'dir' ? 4 : Math.ceil(sizeOf(ctx, e) / 4096) * 4

function longLines(ctx: ExecContext, files: LinuxFiles, entries: LsEntry[]): string[] {
  const rows = entries.map((e) => ({
    mode: `${e.node.type === 'dir' ? 'd' : e.node.link !== undefined ? 'l' : '-'}${modeString(e.node.mode)}`,
    links: String(
      e.node.type === 'dir' ? 2 + childrenOf(files, e.path).filter((c) => files[c]?.type === 'dir').length : 1
    ),
    owner: e.node.owner,
    group: e.node.group,
    size: String(sizeOf(ctx, e)),
    date: lsDate(e.node.mtime),
    name: e.node.link !== undefined ? `${e.name} -> ${e.node.link}` : e.name
  }))
  const w = (key: 'links' | 'owner' | 'group' | 'size') => Math.max(0, ...rows.map((r) => r[key].length))
  return rows.map(
    (r) =>
      `${r.mode} ${r.links.padStart(w('links'))} ${r.owner.padEnd(w('owner'))} ${r.group.padEnd(w('group'))} ${r.size.padStart(w('size'))} ${r.date} ${r.name}`
  )
}

/** ls sur l'arborescence locale : -l -a -A -d -1, plusieurs cibles, droits r/x vérifiés. */
export function lsLocal(ctx: ExecContext, args: string[]): void {
  const o = getopt('ls', args, {
    flags: 'laAd1',
    long: { all: 'a', 'almost-all': 'A', directory: 'd' },
    unsimulated: 'bBcCDfFgGhHiIklLmnNopqQrRsStTuUvwxXZ'
  })
  const files = linuxFiles(ctx)
  const user = actor(ctx)
  // ls trie aussi ses arguments (fichiers d'abord, puis dossiers)
  const targets = o.rest.length > 0 ? [...o.rest].sort((a, b) => a.localeCompare(b)) : ['.']
  const long = o.flags.has('l')
  const single: LsEntry[] = []
  const dirs: { arg: string; path: string }[] = []
  for (const arg of targets) {
    const path = resolvePath(ctx, arg)
    const node = nodeAt(ctx, files, path)
    const reachable = canTraverse(files, user, path)
    if (!reachable || !node) {
      ctx.write(`ls: cannot access '${arg}': ${reachable ? ERRNO.ENOENT : ERRNO.EACCES}`, 'error')
      continue
    }
    if (node.type === 'dir' && !o.flags.has('d')) dirs.push({ arg, path })
    else single.push({ name: arg, node, path })
  }
  const emit = (entries: LsEntry[]) => {
    if (long) ctx.writeLines(longLines(ctx, files, entries))
    else if (o.flags.has('1')) ctx.writeLines(entries.map((e) => e.name))
    else if (entries.length > 0) ctx.write(entries.map((e) => e.name).join('  '))
  }
  emit(single)
  dirs.forEach(({ arg, path }, i) => {
    if (targets.length > 1) {
      if (i > 0 || single.length > 0) ctx.write('')
      ctx.write(`${arg}:`)
    }
    const node = nodeAt(ctx, files, path) as LinuxNode
    if (!hasPerm(files, user, node, 4)) {
      ctx.write(`ls: cannot open directory '${arg}': ${ERRNO.EACCES}`, 'error')
      return
    }
    const names = new Set(childrenOf(files, path).map(baseOf))
    for (const m of ctx.host.host.mounts) {
      if (parentOf(m.target) === path) names.add(baseOf(m.target))
    }
    const all = o.flags.has('a')
    const shown = [...names]
      .filter((n) => all || o.flags.has('A') || !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b))
    const entries: LsEntry[] = shown.map((n) => {
      const p = joinPath(path, n)
      return { name: n, path: p, node: nodeAt(ctx, files, p) ?? mountDirNode() }
    })
    if (all)
      entries.unshift(
        { name: '.', path, node },
        { name: '..', path: parentOf(path), node: files[parentOf(path)] ?? node }
      )
    if (long) {
      ctx.write(`total ${entries.reduce((n, e) => n + blocksOf(ctx, e), 0)}`)
      ctx.writeLines(longLines(ctx, files, entries))
    } else emit(entries)
  })
}

// ---------------------------------------------------------------------------
// cat
// ---------------------------------------------------------------------------

/** Lit un fichier local pour cat : texte, ou null après avoir affiché l'erreur. */
export function readLocal(ctx: ExecContext, cmd: string, arg: string): string | null {
  const files = linuxFiles(ctx)
  const path = resolvePath(ctx, arg)
  const node = files[path]
  if (!node) {
    ctx.write(
      `${cmd}: ${arg}: ${canTraverse(files, actor(ctx), path) ? ERRNO.ENOENT : ERRNO.EACCES}`,
      'error'
    )
    return null
  }
  if (
    !canTraverse(files, actor(ctx), path) ||
    (node.type === 'file' && !hasPerm(files, actor(ctx), node, 4))
  ) {
    ctx.write(`${cmd}: ${arg}: ${ERRNO.EACCES}`, 'error')
    return null
  }
  if (node.type === 'dir') {
    ctx.write(`${cmd}: ${arg}: ${ERRNO.EISDIR}`, 'error')
    return null
  }
  return contentOf(ctx, path, node)
}

/** cat sur l'arborescence locale (le montage CIFS est traité par le rôle fichiers). */
export function catOutput(ctx: ExecContext, o: ParsedOpts, text: string): void {
  const rows = textToLines(text)
  ctx.writeLines(o.flags.has('n') ? rows.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`) : rows)
}

// ---------------------------------------------------------------------------
// touch, mkdir
// ---------------------------------------------------------------------------

export function touchLocal(ctx: ExecContext, arg: string): void {
  const files = linuxFiles(ctx)
  const user = actor(ctx)
  const path = resolvePath(ctx, arg)
  const err = (e: Errno) => new CommandFailure(`touch: cannot touch '${arg}': ${ERRNO[e]}`, 'AccessDenied')
  const node = files[path]
  if (node) {
    if (!canTraverse(files, user, path)) throw err('EACCES')
    // touch met la date à jour : droit d'écriture ou propriétaire
    if (!hasPerm(files, user, node, 2) && node.owner !== user && user !== 'root') throw err('EACCES')
    const next = cloneFiles(files)
    ;(next[path] as LinuxNode).mtime = ctx.state.clock
    commitFiles(ctx, next)
    return
  }
  const bad = writeError(files, user, path)
  if (bad) throw err(bad)
  const next = cloneFiles(files)
  putFile(next, path, '', ctx, { user, clock: ctx.state.clock })
  commitFiles(ctx, next)
}

export function mkdirLocal(ctx: ExecContext, arg: string, parents: boolean): void {
  const files = linuxFiles(ctx)
  const user = actor(ctx)
  const path = resolvePath(ctx, arg)
  const err = (e: Errno, at = arg) =>
    new CommandFailure(`mkdir: cannot create directory '${at}': ${ERRNO[e]}`, 'AccessDenied')
  const next = cloneFiles(files)
  const create = (p: string, e: Errno | null) => {
    if (e) throw err(e, p === path ? arg : p)
    next[p] = {
      type: 'dir',
      mode: 0o755,
      owner: user,
      group: primaryGroup(files, user),
      mtime: ctx.state.clock
    }
  }
  const existing = nodeAt(ctx, files, path)
  if (existing) {
    if (parents && existing.type === 'dir') return
    throw err('EEXIST')
  }
  if (parents) {
    // mkdir -p crée les dossiers manquants un par un, chacun soumis au droit d'écriture du parent
    const missing: string[] = []
    for (let p = path; p !== '/' && !next[p]; p = parentOf(p)) missing.unshift(p)
    for (const p of missing) create(p, writeError(next, user, p))
  } else create(path, writeError(files, user, path))
  commitFiles(ctx, next)
}

// ---------------------------------------------------------------------------
// tee, sed, nano
// ---------------------------------------------------------------------------

const teeTool: ToolDef = {
  name: 'tee',
  synopsis: 'Écrit l’entrée standard dans un fichier et à l’écran (echo texte | sudo tee -a fichier).',
  run(ctx, args) {
    const o = getopt('tee', args, { flags: 'a', long: { append: 'a' }, unsimulated: 'ip' })
    const input = ctx.stdin ?? []
    const user = actor(ctx)
    const files = linuxFiles(ctx)
    const next = cloneFiles(files)
    let changed = false
    for (const arg of o.rest) {
      const path = resolvePath(ctx, arg)
      if (underMount(ctx, path)) {
        ctx.write(`tee: ${arg}: écriture dans un partage monté non simulée dans ServerLab`, 'error')
        continue
      }
      const bad = writeError(next, user, path)
      if (bad) {
        ctx.write(`tee: ${arg}: ${ERRNO[bad]}`, 'error')
        continue
      }
      putFile(next, path, linesToText(input), ctx, { user, clock: ctx.state.clock, append: o.flags.has('a') })
      changed = true
    }
    // tee affiche toujours son entrée, même si l'écriture d'un fichier échoue
    ctx.writeLines(input)
    if (changed) commitFiles(ctx, next)
  }
}

/** Expression régulière de base (BRE) de sed → RegExp JavaScript. */
function breToJs(pattern: string, extended: boolean): string {
  if (extended) return pattern
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[++i] as string
      out += '(){}|+?'.includes(n) ? n : `\\${n}`
    } else if ('(){}|+?'.includes(c)) out += `\\${c}`
    else out += c
  }
  return out
}

interface SedCommand {
  re: RegExp
  replacement: string
  global: boolean
  nth: number
}

/** Analyse « s/motif/remplacement/drapeaux » (séparateurs ; ou saut de ligne entre commandes). */
function parseSed(script: string, extended: boolean): SedCommand[] {
  const err = (pos: number, text: string) =>
    new CommandFailure(`sed: -e expression #1, char ${pos}: ${text}`, 'InvalidArgument')
  const commands: SedCommand[] = []
  let i = 0
  const n = script.length
  while (i < n) {
    while (i < n && (script[i] === ';' || script[i] === ' ' || script[i] === '\n')) i++
    if (i >= n) break
    if (script[i] !== 's') throw err(i + 1, `unknown command: \`${script[i]}'`)
    i++
    const delim = script[i]
    if (delim === undefined || delim === '\n' || delim === '\\') throw err(n, "unterminated `s' command")
    i++
    const part = (): string | null => {
      let text = ''
      while (i < n) {
        const c = script[i] as string
        if (c === '\\' && i + 1 < n) {
          const next = script[i + 1] as string
          // \/ désigne le séparateur lui-même
          text += next === delim ? next : `\\${next}`
          i += 2
          continue
        }
        if (c === delim) {
          i++
          return text
        }
        text += c
        i++
      }
      return null
    }
    const pattern = part()
    const replacement = pattern === null ? null : part()
    if (pattern === null || replacement === null) throw err(n, "unterminated `s' command")
    let flags = ''
    while (i < n && script[i] !== ';' && script[i] !== '\n') {
      const f = script[i] as string
      if (!/[gIi0-9]/.test(f)) throw err(i + 1, "unknown option to `s'")
      flags += f
      i++
    }
    let re: RegExp
    try {
      re = new RegExp(breToJs(pattern, extended), flags.includes('I') || flags.includes('i') ? 'i' : '')
    } catch {
      throw err(n, 'Invalid preceding regular expression')
    }
    const nth = Number(/\d+/.exec(flags)?.[0] ?? '0')
    commands.push({ re, replacement, global: flags.includes('g'), nth })
  }
  return commands
}

function applySed(commands: SedCommand[], line: string): string {
  let out = line
  for (const c of commands) {
    const groupCount = (new RegExp(`${c.re.source}|`).exec('') ?? []).length - 1
    const re = new RegExp(c.re.source, `${c.re.flags.replace('g', '')}g`)
    let count = 0
    out = out.replace(re, (...m: unknown[]) => {
      count++
      const match = m.slice(0, 1 + groupCount) as (string | undefined)[]
      const whole = match[0] as string
      // s/a/b/ : première occurrence ; s/a/b/g : toutes ; s/a/b/N : la N-ième
      if (c.nth > 0 ? count !== c.nth : !c.global && count > 1) return whole
      return c.replacement.replace(
        /\\(\d)|\\n|\\(.)|&/g,
        (all, digit: string | undefined, literal: string | undefined) => {
          if (digit !== undefined) return match[Number(digit)] ?? ''
          if (all === '\\n') return '\n'
          return literal ?? whole
        }
      )
    })
  }
  return out
}

/** Suffixe « aléatoire » du fichier temporaire de sed -i, déterministe (horloge du lab). */
function tempName(clock: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let n = Math.abs(Math.floor(clock / 1000)) + 7919
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += alphabet[n % alphabet.length]
    n = Math.floor(n / 3) + 11
  }
  return `sed${s}`
}

const sedTool: ToolDef = {
  name: 'sed',
  synopsis: "Substitue du texte : sed [-i] [-E] 's/ancien/nouveau/[g]' fichier (sous-ensemble : commande s).",
  run(ctx, args) {
    // -i[SUFFIXE] : valeur facultative collée à l'option, hors de portée de getopt
    let inPlace = false
    const rest = args.filter((a) => {
      if ((a.startsWith('-i') && !a.startsWith('--')) || a === '--in-place') {
        inPlace = true
        return false
      }
      return true
    })
    const o = getopt('sed', rest, {
      flags: 'Er',
      args: 'e',
      long: { 'regexp-extended': 'E', expression: 'e' },
      unsimulated: 'nfbslzu',
      tryHelp: false
    })
    const scripts: string[] = []
    if (o.values['e'] !== undefined) {
      // -e peut être répété : getopt ne garde que la dernière valeur, relire la ligne
      for (let i = 0; i < rest.length; i++)
        if (rest[i] === '-e' && rest[i + 1] !== undefined) scripts.push(rest[++i] as string)
    }
    const positional = [...o.rest]
    if (scripts.length === 0) {
      const first = positional.shift()
      if (first === undefined)
        throw new CommandFailure(
          'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...',
          'Usage'
        )
      scripts.push(first)
    }
    const commands = parseSed(scripts.join('\n'), o.flags.has('E') || o.flags.has('r'))
    const files = linuxFiles(ctx)
    const user = actor(ctx)
    const transform = (text: string) => linesToText(textToLines(text).map((l) => applySed(commands, l)))
    if (positional.length === 0) {
      ctx.writeLines((ctx.stdin ?? []).map((l) => applySed(commands, l)))
      return
    }
    const next = cloneFiles(files)
    let changed = false
    for (const arg of positional) {
      const path = resolvePath(ctx, arg)
      const node = files[path]
      if (!node) {
        ctx.write(
          `sed: can't read ${arg}: ${canTraverse(files, user, path) ? ERRNO.ENOENT : ERRNO.EACCES}`,
          'error'
        )
        continue
      }
      if (!canTraverse(files, user, path) || (node.type === 'file' && !hasPerm(files, user, node, 4))) {
        ctx.write(`sed: can't read ${arg}: ${ERRNO.EACCES}`, 'error')
        continue
      }
      if (node.type === 'dir') {
        ctx.write(
          inPlace
            ? `sed: couldn't edit ${arg}: not a regular file`
            : `sed: read error on ${arg}: Is a directory`,
          'error'
        )
        continue
      }
      const out = transform(contentOf(ctx, path, node))
      if (!inPlace) {
        ctx.writeLines(textToLines(out))
        continue
      }
      // sed -i écrit un fichier temporaire dans le dossier, puis le renomme : droit w+x sur le dossier
      const dir = files[parentOf(path)]
      if (!dir || !hasPerm(files, user, dir, 2) || !hasPerm(files, user, dir, 1)) {
        const where = arg.includes('/') ? arg.slice(0, arg.lastIndexOf('/') + 1) : './'
        ctx.write(
          `sed: couldn't open temporary file ${where}${tempName(ctx.state.clock)}: ${ERRNO.EACCES}`,
          'error'
        )
        continue
      }
      // sed -i remplace le fichier (donc un lien symbolique devient un fichier ordinaire)
      // (le nouveau fichier reprend les droits de la cible, comme le fait GNU sed)
      const linkTarget = (next[path] as LinuxNode).link
      if (linkTarget !== undefined) {
        const source = next[resolveLink(path, linkTarget)]
        delete (next[path] as LinuxNode).link
        if (source) {
          ;(next[path] as LinuxNode).mode = source.mode
          ;(next[path] as LinuxNode).owner = source.owner
          ;(next[path] as LinuxNode).group = source.group
        }
      }
      ;(next[path] as LinuxNode).content = out
      ;(next[path] as LinuxNode).mtime = ctx.state.clock
      changed = true
    }
    if (changed) commitFiles(ctx, next)
  }
}

const nanoTool: ToolDef = {
  name: 'nano',
  synopsis: 'Éditeur de texte : non simulé (console en lignes) — utilisez echo, tee ou sed -i.',
  run() {
    throw new CommandFailure(
      "nano: éditeur plein écran non simulé dans ServerLab (la console ne gère que des lignes). Équivalents simulés : echo 'texte' >> fichier, echo 'texte' | sudo tee -a fichier, sed -i 's/ancien/nouveau/' fichier.",
      'NotSupported'
    )
  }
}

// ---------------------------------------------------------------------------
// chmod, chown
// ---------------------------------------------------------------------------

const WHO_MASK: Record<string, number> = { u: 0o4700, g: 0o2070, o: 0o1007 }
const UMASK = 0o022

/** Applique un mode octal ou symbolique ; null si la syntaxe est invalide. */
export function applyMode(spec: string, current: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8)
  let mode = current
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause)
    if (!m) return null
    const who = (m[1] as string) || 'a'
    const targets = who.includes('a') ? ['u', 'g', 'o'] : who.split('')
    for (const op of (m[2] as string).match(/[-+=][rwxXst]*/g) ?? []) {
      const sign = op[0]
      const letters = op.slice(1)
      let bits = 0
      for (const t of targets) {
        const shift = t === 'u' ? 6 : t === 'g' ? 3 : 0
        for (const l of letters) {
          if (l === 'r') bits |= 4 << shift
          else if (l === 'w') bits |= 2 << shift
          else if (l === 'x') bits |= 1 << shift
          else if (l === 'X' && (isDir || (current & 0o111) !== 0)) bits |= 1 << shift
          else if (l === 's' && t !== 'o') bits |= t === 'u' ? 0o4000 : 0o2000
          else if (l === 't') bits |= 0o1000
        }
      }
      // Sans « qui » explicite, le umask (022) protège les bits d'écriture de g et o
      if (!m[1]) bits &= ~UMASK
      const scope = targets.reduce((acc, t) => acc | (WHO_MASK[t] as number), 0) & ~(m[1] ? 0 : UMASK)
      if (sign === '+') mode |= bits
      else if (sign === '-') mode &= ~bits
      else mode = (mode & ~scope) | bits
    }
  }
  return mode & 0o7777
}

const MODE_ARG = /^-[rwxXstugoa+=,-]*$/

/** Cibles d'une commande récursive (-R) : le chemin et ses descendants. */
function targetsOf(files: LinuxFiles, path: string, recursive: boolean): string[] {
  return recursive ? subtree(files, path) : [path]
}

const chmodTool: ToolDef = {
  name: 'chmod',
  synopsis: 'Modifie les droits : chmod 640 fichier, chmod u+x,go-w fichier, chmod -R 755 dossier.',
  run(ctx, args) {
    // Un mode comme « -w » ressemble à une option : chmod le traite comme un mode (comme GNU chmod)
    let modeFirst: string | undefined
    const filtered = args.filter((a) => {
      if (modeFirst === undefined && a.length > 1 && MODE_ARG.test(a) && !/^-[Rcfv]+$/.test(a)) {
        modeFirst = a
        return false
      }
      return true
    })
    const o = getopt('chmod', filtered, { flags: 'R', long: { recursive: 'R' }, unsimulated: 'cfv' })
    const spec = modeFirst ?? o.rest.shift()
    if (spec === undefined) throw usageError('chmod', 'missing operand')
    if (o.rest.length === 0) throw usageError('chmod', `missing operand after '${spec}'`)
    const files = linuxFiles(ctx)
    const user = actor(ctx)
    const next = cloneFiles(files)
    // Syntaxe vérifiée avant tout accès, sur un mode quelconque
    if (applyMode(spec, 0o644, false) === null) throw usageError('chmod', `invalid mode: '${spec}'`)
    for (const arg of o.rest) {
      const path = resolvePath(ctx, arg)
      const node = files[path]
      if (!node) {
        ctx.write(
          `chmod: cannot access '${arg}': ${canTraverse(files, user, path) ? ERRNO.ENOENT : ERRNO.EACCES}`,
          'error'
        )
        continue
      }
      if (!canTraverse(files, user, path)) {
        ctx.write(`chmod: cannot access '${arg}': ${ERRNO.EACCES}`, 'error')
        continue
      }
      for (const p of targetsOf(files, path, o.flags.has('R'))) {
        const n = next[p] as LinuxNode
        if (user !== 'root' && n.owner !== user) {
          ctx.write(
            `chmod: changing permissions of '${p === path ? arg : p}': Operation not permitted`,
            'error'
          )
          continue
        }
        n.mode = applyMode(spec, n.mode, n.type === 'dir') as number
      }
    }
    commitFiles(ctx, next)
  }
}

const chownTool: ToolDef = {
  name: 'chown',
  synopsis: 'Change le propriétaire et le groupe : chown utilisateur:groupe fichier (sudo).',
  run(ctx, args) {
    const o = getopt('chown', args, { flags: 'R', long: { recursive: 'R' }, unsimulated: 'cfhHLPv' })
    const spec = o.rest.shift()
    if (spec === undefined) throw usageError('chown', 'missing operand')
    if (o.rest.length === 0) throw usageError('chown', `missing operand after '${spec}'`)
    const files = linuxFiles(ctx)
    const passwd = readPasswd(files)
    const groups = readGroups(files)
    const user = actor(ctx)
    const colon = spec.indexOf(':')
    const ownerPart = colon >= 0 ? spec.slice(0, colon) : spec
    const groupPart = colon >= 0 ? spec.slice(colon + 1) : ''
    let owner: string | null = null
    let group: string | null = null
    if (ownerPart !== '') {
      const entry = passwd.find((p) => p.name === ownerPart || String(p.uid) === ownerPart)
      if (!entry) throw new CommandFailure(`chown: invalid user: '${spec}'`, 'InvalidArgument')
      owner = entry.name
      // « utilisateur: » : le groupe devient le groupe de connexion de l'utilisateur
      if (colon >= 0 && groupPart === '') group = groups.find((g) => g.gid === entry.gid)?.name ?? null
    }
    if (groupPart !== '') {
      const g = groups.find((x) => x.name === groupPart || String(x.gid) === groupPart)
      if (!g) throw new CommandFailure(`chown: invalid group: '${spec}'`, 'InvalidArgument')
      group = g.name
    }
    const id = identityOf(files, user)
    const next = cloneFiles(files)
    for (const arg of o.rest) {
      const path = resolvePath(ctx, arg)
      const node = files[path]
      if (!node) {
        ctx.write(
          `chown: cannot access '${arg}': ${canTraverse(files, user, path) ? ERRNO.ENOENT : ERRNO.EACCES}`,
          'error'
        )
        continue
      }
      if (!canTraverse(files, user, path)) {
        ctx.write(`chown: cannot access '${arg}': ${ERRNO.EACCES}`, 'error')
        continue
      }
      for (const p of targetsOf(files, path, o.flags.has('R'))) {
        const n = next[p] as LinuxNode
        const label = p === path ? arg : p
        // root change tout ; le propriétaire ne peut changer que le groupe, vers l'un des siens
        const mayOwner = user === 'root' || owner === null || owner === n.owner
        const mayGroup =
          user === 'root' ||
          group === null ||
          group === n.group ||
          (n.owner === user && !!id?.groups.some((g) => g.name === group))
        if (!mayOwner || !mayGroup || (user !== 'root' && n.owner !== user)) {
          ctx.write(`chown: changing ownership of '${label}': Operation not permitted`, 'error')
          continue
        }
        if (owner !== null) n.owner = owner
        if (group !== null) n.group = group
      }
    }
    commitFiles(ctx, next)
  }
}

export const linuxFileTools: ToolDef[] = [teeTool, sedTool, nanoTool, chmodTool, chownTool]
