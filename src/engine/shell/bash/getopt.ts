/**
 * Analyse des options façon getopt (v2.9) : options courtes groupées (`-aG sudo`, `-lh`), valeur
 * collée ou séparée, `--` pour finir les options, quelques options longues. Messages d'origine de
 * getopt (glibc) : « invalid option -- 'z' », « option requires an argument -- 'G' »,
 * « unrecognized option '--foo' ».
 */
import { CommandFailure } from '../context'
import { unsimulatedOptionMessage } from '../unsimulated'

export interface OptSpec {
  /** Options courtes sans valeur. */
  flags: string
  /** Options courtes avec valeur. */
  args?: string
  /** Options longues → lettre courte correspondante. */
  long?: Record<string, string>
  /** Options courtes réelles de l'outil, acceptées par le vrai système mais non simulées. */
  unsimulated?: string
  /** Texte de l'erreur « Try … » (aucun : l'outil affiche son propre usage). */
  tryHelp?: boolean
  /** Première ligne d'usage affichée après l'erreur à la place de « Try … » (shadow-utils, sudo). */
  usage?: string
}

export interface ParsedOpts {
  flags: Set<string>
  values: Record<string, string>
  rest: string[]
}

export function getopt(cmd: string, argv: string[], spec: OptSpec): ParsedOpts {
  const out: ParsedOpts = { flags: new Set(), values: {}, rest: [] }
  const fail = (message: string) =>
    new CommandFailure(
      spec.usage !== undefined
        ? `${cmd}: ${message}\n${spec.usage}`
        : spec.tryHelp === false
          ? `${cmd}: ${message}`
          : `${cmd}: ${message}\nTry '${cmd} --help' for more information.`,
      'Usage'
    )
  const takeShort = (letter: string, attached: string | null, next: () => string | undefined): boolean => {
    // Renvoie vrai si la valeur attachée a été consommée
    if (spec.flags.includes(letter)) {
      out.flags.add(letter)
      return false
    }
    if ((spec.args ?? '').includes(letter)) {
      const value = attached !== null && attached !== '' ? attached : next()
      if (value === undefined) throw fail(`option requires an argument -- '${letter}'`)
      out.values[letter] = value
      out.flags.add(letter)
      return true
    }
    if ((spec.unsimulated ?? '').includes(letter))
      throw new CommandFailure(unsimulatedOptionMessage(cmd, `-${letter}`), 'NotSupported')
    throw fail(`invalid option -- '${letter}'`)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      out.rest.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [name = '', value] = a.slice(2).split('=')
      const short = spec.long?.[name]
      if (!short) throw fail(`unrecognized option '${a}'`)
      takeShort(short, value ?? null, () => argv[++i])
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const consumed = takeShort(a[j] as string, a.slice(j + 1), () => argv[++i])
        if (consumed || (spec.args ?? '').includes(a[j] as string)) break
      }
      continue
    }
    out.rest.push(a)
  }
  return out
}
