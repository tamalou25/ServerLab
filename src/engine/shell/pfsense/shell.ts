/**
 * Shell FreeBSD (tcsh) du pare-feu, ouvert par l'option 8 du menu (v2.10, #247). Périmètre limité :
 * `pfctl` (-sr, -ss, -si, -d, -e), `ifconfig`, `netstat -rn`, `cat` / `tail` / `clog` sur le journal du
 * filtre, `ping`, avec un tube vers `grep`, `head` ou `filterparser.php`. Toute autre commande réelle
 * donne le message honnête de `unsimulated.ts` ; une commande inconnue, « Command not found. ».
 */
import { isIpv4 } from '../../net/ipv4'
import type { PfDevice } from '../../net/pf'
import { splitBashArgs } from '../bash/interpreter'
import type { ExecContext } from '../context'
import {
  isUnsimulated,
  unsimulatedFileMessage,
  unsimulatedMessage,
  unsimulatedOptionMessage
} from '../unsimulated'
import { FILTER_LOG_PATH, filterLogLines, filterParserLines } from './filterlog'
import { menuScreen } from './menu'
import { bsdPing, fqdn, ifconfigLines, netstatRoutes, PFSENSE_RELEASE } from './nettools'
import { runPfctl } from './pfctl'
import type { PfTerm } from './term'

/** Invite de tcsh : `[version][utilisateur@hôte]répertoire: ` (docs/fidelite.md, P-57). */
export const shellPromptText = (device: PfDevice): string =>
  `[${PFSENSE_RELEASE}][root@${fqdn(device)}]/root: `

function firewall(ctx: ExecContext): PfDevice {
  return ctx.device as PfDevice
}

/** Lit un fichier du shell : seul le journal du filtre existe. */
function readFile(t: PfTerm, tool: string, file: string | undefined): string[] | null {
  if (file === undefined) {
    t.note(`${tool}: lecture de l’entrée standard non simulée`, 'warning')
    return null
  }
  if (file !== FILTER_LOG_PATH) {
    t.note(unsimulatedFileMessage(tool, file), 'warning')
    return null
  }
  return filterLogLines(firewall(t.ctx))
}

/** Une commande simple ; `stdin` : sortie de l'étage précédent du tube (null : aucune). */
function runSimple(ctx: ExecContext, t: PfTerm, args: string[], stdin: string[] | null): void {
  const [name = '', ...rest] = args
  const device = firewall(ctx)
  switch (name) {
    case 'exit':
    case 'logout':
      // tcsh se ferme : la console revient au menu numéroté
      ctx.session = { ...ctx.session, pfsense: { mode: 'menu' } }
      for (const line of menuScreen(device)) ctx.write(line)
      return
    case 'clear':
      ctx.clear = true
      return
    case 'pfctl':
      runPfctl(ctx, t, rest)
      return
    case 'ifconfig': {
      const names = rest.filter((a) => a !== '-a')
      if (names.some((n) => n.startsWith('-')))
        return t.note(unsimulatedOptionMessage('ifconfig', names.join(' ')))
      if (names.length > 1) return t.note(unsimulatedOptionMessage('ifconfig', names.join(' ')))
      const lines = ifconfigLines(ctx.state, device, names[0])
      if (!lines) return t.note(`ifconfig: interface ${names[0]} does not exist`, 'error')
      for (const l of lines) ctx.write(l)
      return
    }
    case 'netstat': {
      const flags = rest.join('')
      if (!/^-(rn|nr)$/.test(flags) && !(rest.length === 2 && rest.includes('-r') && rest.includes('-n')))
        return t.note(unsimulatedOptionMessage('netstat', rest.join(' ') || '(sans option)'))
      for (const l of netstatRoutes(device)) ctx.write(l)
      return
    }
    case 'cat': {
      if (rest.length !== 1 || rest[0]?.startsWith('-'))
        return t.note(unsimulatedOptionMessage('cat', rest.join(' ')))
      const lines = readFile(t, 'cat', rest[0])
      if (lines) for (const l of lines) ctx.write(l)
      return
    }
    case 'tail': {
      let count = 10
      let file: string | undefined
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string
        if (a === '-F' || a === '-f') continue
        if (a === '-n') count = Number(rest[++i])
        else if (/^-\d+$/.test(a)) count = Number(a.slice(1))
        else if (a.startsWith('-')) return t.note(unsimulatedOptionMessage('tail', a))
        else file = a
      }
      if (!Number.isFinite(count) || count < 0)
        return t.note('tail: illegal offset -- ' + String(count), 'error')
      const lines = file === undefined && stdin ? stdin : readFile(t, 'tail', file)
      if (lines) for (const l of count === 0 ? [] : lines.slice(-count)) ctx.write(l)
      if (rest.includes('-F') || rest.includes('-f'))
        t.note('(suivi en temps réel non simulé : dernières lignes de /var/log/filter.log)', 'warning')
      return
    }
    case 'clog':
      return t.note(
        'clog : les journaux de pfSense 2.5 et suivants sont des fichiers texte (docs.netgate.com, « Working with Log Files ») ; clog n’est pas simulé, utilisez cat ou tail /var/log/filter.log.',
        'warning'
      )
    case 'grep': {
      const [first, pattern, file] = rest
      const flags = first?.startsWith('-') ? first : ''
      const pat = flags ? pattern : first
      const src = flags ? file : rest[1]
      const lines = src === undefined && stdin ? stdin : readFile(t, 'grep', src)
      if (lines && pat !== undefined) for (const l of grepLines(lines, pat, flags)) ctx.write(l)
      return
    }
    case 'head': {
      let count = 10
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string
        if (a === '-n') count = Number(rest[++i])
        else if (/^-\d+$/.test(a)) count = Number(a.slice(1))
        else return t.note(unsimulatedOptionMessage('head', a))
      }
      for (const l of (stdin ?? []).slice(0, count)) ctx.write(l)
      return
    }
    case 'filterparser.php': {
      // Sortie simplifiée du journal (docs.netgate.com, « Viewing the Firewall Log »)
      const raw = filterLogLines(device)
      const parsed = filterParserLines(device)
      for (const line of stdin ?? raw) {
        const i = raw.indexOf(line)
        if (i >= 0) ctx.write(parsed[i] as string)
      }
      return
    }
    case 'ping': {
      let count = 3
      let host = ''
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i] as string
        if (a === '-c') count = Number(rest[++i])
        else if (a === '-n') continue
        else if (a.startsWith('-')) return t.note(unsimulatedOptionMessage('ping', a))
        else host = a
      }
      if (host === '')
        return t.note('usage: ping [-4AaDdfHnoQqRrSv] [-C pcp] [-c count] [-G sweepmaxsize] ...', 'error')
      if (!isIpv4(host)) return t.note(unsimulatedOptionMessage('ping', 'résolution de noms'))
      if (!Number.isInteger(count) || count < 1 || count > 20)
        return t.note(unsimulatedOptionMessage('ping', '-c (1 à 20)'))
      for (const l of bsdPing(ctx, host, count)) ctx.write(l)
      return
    }
    default:
      if (isUnsimulated('pfsense', name)) t.note(unsimulatedMessage('pfsense', name))
      else t.note(`${name}: Command not found.`, 'error')
  }
}

/** grep minimal : -i (casse) et -v (inverse) ; le motif est une expression régulière. */
function grepLines(lines: string[], pattern: string, flags: string): string[] {
  let re: RegExp
  try {
    re = new RegExp(pattern, flags.includes('i') ? 'i' : '')
  } catch {
    return []
  }
  return lines.filter((l) => re.test(l) !== flags.includes('v'))
}

/** Exécute une ligne du shell (commande simple ou tube). */
export function runShellLine(ctx: ExecContext, t: PfTerm, line: string): void {
  const stages = line.split('|').map((s) => s.trim())
  let stdin: string[] | null = null
  for (let i = 0; i < stages.length; i++) {
    const args = splitBashArgs(stages[i] as string)
    if (!args) return t.note("Unmatched '\"'.", 'error')
    if (args.length === 0) return
    const last = i === stages.length - 1
    const start = ctx.output.length
    runSimple(ctx, t, args, stdin)
    if (!last) {
      // La sortie standard alimente l'étage suivant ; les erreurs restent affichées
      const produced = ctx.output.splice(start)
      stdin = produced.filter((l) => l.kind === 'out').map((l) => l.text)
      ctx.output.push(...produced.filter((l) => l.kind !== 'out'))
    }
  }
}
