/**
 * Aide « commande /? » de l'Invite de commandes.
 *
 * Le texte réel affiché par `/?` n'est pas publié sur Microsoft Learn : ServerLab ne l'invente pas.
 * Il affiche un message honnête, la syntaxe telle que la donne la page Microsoft Learn de la
 * commande (rubrique « Syntax », recopiée telle quelle) et le lien vers cette page.
 * Les outils qui ont leur propre aide (`handlesHelp`) la gardent.
 */
import type { ExecContext } from '../context'

export const LEARN_CMD = 'https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/'

export interface HelpEntry {
  /** Lignes « Syntax » de la page Microsoft Learn. */
  syntax: string[]
  url: string
}

/** Syntaxes recopiées des pages Microsoft Learn (rubrique Syntax). */
export const CMD_SYNTAX: Record<string, HelpEntry> = {
  cd: { syntax: ['cd [/d] [<drive>:][<path>]', 'cd [..]'], url: `${LEARN_CMD}cd` },
  chdir: { syntax: ['chdir [/d] [<drive>:][<path>]', 'chdir [..]'], url: `${LEARN_CMD}cd` },
  set: {
    syntax: [
      'set [<variable>=[<string>]]',
      'set [/p] <variable>=[<promptString>]',
      'set /a <variable>=<expression>'
    ],
    url: `${LEARN_CMD}set_1`
  },
  type: { syntax: ['type [<drive>:][<path>]<filename>'], url: `${LEARN_CMD}type` },
  copy: {
    syntax: [
      'copy [/d] [/v] [/n] [/y | /-y] [/z] [/a | /b] <source> [/a | /b] [+<source> [/a | /b] [+ ...]] [<destination> [/a | /b]]'
    ],
    url: `${LEARN_CMD}copy`
  },
  move: { syntax: ['move [{/y|-y}] [<source>] [<target>]'], url: `${LEARN_CMD}move` },
  ren: { syntax: ['ren [<drive>:][<path>]<filename1> <filename2>'], url: `${LEARN_CMD}ren` },
  rename: { syntax: ['ren [<drive>:][<path>]<filename1> <filename2>'], url: `${LEARN_CMD}ren` }
}

/** Écrit l'aide honnête de `name /?`. */
export function writeCmdHelp(ctx: ExecContext, name: string, own?: HelpEntry): void {
  const entry = own ?? CMD_SYNTAX[name.toLowerCase()]
  const lines = [
    `L’aide intégrée de « ${name} /? » n’est pas reproduite par ServerLab (texte réel non publié sur Microsoft Learn).`
  ]
  if (entry)
    lines.push(
      '',
      'Syntaxe (Microsoft Learn) :',
      ...entry.syntax.map((s) => `  ${s}`),
      '',
      `Référence : ${entry.url}`
    )
  else lines.push(`Référence : ${LEARN_CMD}${name.toLowerCase()}`)
  ctx.writeLines([...lines, ''])
}
