/**
 * Cmdlets de base : aide, affichage, pipeline (Format-*, Select, Where, Sort, Measure), saisie.
 */
import { formatShortDate } from '../../../core/clock'
import { psError } from '../errors'
import { formatList, formatTable } from '../format'
import type { CmdContext } from '../interpreter'
import type { CmdletDef } from '../registry'
import {
  flatten,
  getProp,
  isPsObject,
  isScript,
  psObject,
  psToString,
  wildcardToRegExp,
  type PsObject,
  type PsValue
} from '../values'
import { compare } from '../expression'

function asObjects(values: PsValue[]): PsObject[] {
  return flatten(values).map((v) => (isPsObject(v) ? v : psObject('System.String', { Value: v })))
}

function propsArg(value: PsValue | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined
  return (Array.isArray(value) ? flatten(value) : [value]).map(psToString)
}

export const coreCmdlets: CmdletDef[] = [
  {
    name: 'Get-Command',
    aliases: ['gcm'],
    module: 'Core',
    synopsis: 'Liste les commandes disponibles.',
    params: [
      { name: 'Name', type: 'string', position: 0 },
      { name: 'Module', type: 'string' }
    ],
    run(ctx, args) {
      const pattern = args['Name'] ? wildcardToRegExp(psToString(args['Name'])) : null
      const module = args['Module'] ? psToString(args['Module']).toLowerCase() : null
      const cmds = ctx.catalog.cmdlets
        .filter((c) => c.available?.(ctx) ?? true)
        .filter((c) => !pattern || pattern.test(c.name))
        .filter((c) => !module || c.module.toLowerCase() === module)
        .sort((a, b) => a.name.localeCompare(b.name))
      if (pattern && cmds.length === 0) {
        throw psError(
          `Le terme «${psToString(args['Name'])}» n'est pas reconnu comme nom d'applet de commande, fonction, fichier de script ou programme exécutable.`,
          'ObjectNotFound',
          'CommandNotFoundException',
          psToString(args['Name'])
        )
      }
      return cmds.map((c) =>
        psObject(
          'CmdletInfo',
          { CommandType: 'Cmdlet', Name: c.name, Version: '1.0.0.0', Source: c.module },
          {
            kind: 'table',
            props: ['CommandType', 'Name', 'Version', 'Source']
          }
        )
      )
    }
  },
  {
    name: 'Get-Help',
    aliases: ['help', 'man'],
    module: 'Core',
    synopsis: 'Affiche l’aide d’une commande.',
    params: [{ name: 'Name', type: 'string', position: 0 }],
    run(ctx, args) {
      if (!args['Name']) {
        ctx.writeLines([
          '',
          'RUBRIQUE',
          '    Aide du PowerShell simulé',
          '',
          'DESCRIPTION',
          '    Get-Command          liste les commandes disponibles sur cet ordinateur.',
          '    Get-Help <commande>  affiche la syntaxe d’une commande.',
          '    Tab                  complète les noms de commandes et de paramètres.',
          '    ↑ / ↓                rappellent les commandes précédentes.',
          ''
        ])
        return
      }
      const name = psToString(args['Name'])
      const def = ctx.catalog.cmdlets.find(
        (c) =>
          c.name.toLowerCase() === name.toLowerCase() ||
          (c.aliases ?? []).some((a) => a.toLowerCase() === name.toLowerCase())
      )
      if (!def)
        throw psError(
          `Get-Help n’a trouvé aucune rubrique d’aide pour « ${name} ».`,
          'ResourceUnavailable',
          'HelpNotFound',
          name
        )
      const syntax = def.params
        .map((p) => {
          const t = p.type === 'switch' ? '' : ` <${p.type}>`
          const core = p.position !== undefined ? `[-${p.name}]${t}` : `-${p.name}${t}`
          return p.mandatory ? core : `[${core}]`
        })
        .join(' ')
      ctx.writeLines([
        '',
        'NOM',
        `    ${def.name}`,
        '',
        'RÉSUMÉ',
        `    ${def.synopsis}`,
        '',
        'SYNTAXE',
        `    ${def.name} ${syntax}`,
        ''
      ])
      if (def.aliases?.length) ctx.writeLines(['ALIAS', `    ${def.aliases.join(', ')}`, ''])
    }
  },
  {
    name: 'Write-Host',
    module: 'Core',
    synopsis: 'Écrit du texte à l’écran.',
    params: [
      { name: 'Object', type: 'any', position: 0 },
      { name: 'ForegroundColor', type: 'string' },
      { name: 'NoNewline', type: 'switch' }
    ],
    run(ctx, args) {
      const v = args['Object']
      ctx.write(Array.isArray(v) ? flatten(v).map(psToString).join(' ') : psToString(v ?? ''))
    }
  },
  {
    name: 'Write-Output',
    aliases: ['echo', 'write'],
    module: 'Core',
    synopsis: 'Envoie des objets dans le pipeline.',
    params: [{ name: 'InputObject', type: 'any', position: 0, pipeline: true }],
    run(_ctx, args, input) {
      const v = args['InputObject']
      return v !== undefined ? [v] : input
    }
  },
  {
    name: 'Clear-Host',
    aliases: ['cls', 'clear'],
    module: 'Core',
    synopsis: 'Efface l’écran.',
    params: [],
    run(ctx) {
      ctx.clear = true
    }
  },
  {
    name: 'Out-Null',
    module: 'Core',
    synopsis: 'Supprime la sortie.',
    params: [{ name: 'InputObject', type: 'any', pipeline: true }],
    run() {
      return []
    }
  },
  {
    name: 'Format-Table',
    aliases: ['ft'],
    module: 'Core',
    synopsis: 'Met en forme la sortie sous forme de tableau.',
    params: [
      { name: 'Property', type: 'string[]', position: 0 },
      { name: 'AutoSize', type: 'switch' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(_ctx, args, input) {
      const objects = asObjects(input)
      return formatTable(objects, propsArg(args['Property']))
    }
  },
  {
    name: 'Format-List',
    aliases: ['fl'],
    module: 'Core',
    synopsis: 'Met en forme la sortie sous forme de liste.',
    params: [
      { name: 'Property', type: 'string[]', position: 0 },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(_ctx, args, input) {
      const props = propsArg(args['Property'])
      return formatList(asObjects(input), props && props.length === 1 && props[0] === '*' ? '*' : props)
    }
  },
  {
    name: 'Select-Object',
    aliases: ['select'],
    module: 'Core',
    synopsis: 'Sélectionne des propriétés ou des objets.',
    params: [
      { name: 'Property', type: 'string[]', position: 0 },
      { name: 'First', type: 'int' },
      { name: 'Last', type: 'int' },
      { name: 'ExpandProperty', type: 'string' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(_ctx, args, input) {
      let items = flatten(input)
      if (typeof args['First'] === 'number') items = items.slice(0, args['First'])
      if (typeof args['Last'] === 'number') items = items.slice(-args['Last'])
      if (args['ExpandProperty']) {
        const name = psToString(args['ExpandProperty'])
        return flatten(items.map((i) => getProp(i, name)))
      }
      const props = propsArg(args['Property'])
      if (!props || (props.length === 1 && props[0] === '*')) return items
      return items.map((i) => {
        const selected: Record<string, PsValue> = {}
        for (const p of props) {
          const real = isPsObject(i)
            ? (Object.keys(i.props).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p)
            : p
          selected[real] = getProp(i, p)
        }
        return psObject('Selected', selected, {
          kind: props.length <= 4 ? 'table' : 'list',
          props: Object.keys(selected)
        })
      })
    }
  },
  {
    name: 'Where-Object',
    aliases: ['where', '?'],
    module: 'Core',
    synopsis: 'Filtre les objets du pipeline.',
    params: [
      { name: 'FilterScript', type: 'any', position: 0 },
      { name: 'Value', type: 'any', position: 1 },
      ...['EQ', 'NE', 'Like', 'NotLike', 'Match', 'NotMatch', 'GT', 'GE', 'LT', 'LE', 'Contains', 'In'].map(
        (n) => ({
          name: n,
          type: 'switch' as const
        })
      ),
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx: CmdContext, args, input) {
      const filter = args['FilterScript'] ?? null
      const items = flatten(input)
      if (isScript(filter)) return items.filter((i) => ctx.test(filter, i))
      const property = psToString(filter ?? '')
      const op = [
        'EQ',
        'NE',
        'Like',
        'NotLike',
        'Match',
        'NotMatch',
        'GT',
        'GE',
        'LT',
        'LE',
        'Contains',
        'In'
      ].find((o) => args[o] === true)
      if (!op) return items.filter((i) => !!getProp(i, property) && getProp(i, property) !== false)
      return items.filter((i) => compare(op.toLowerCase(), getProp(i, property), args['Value'] ?? null))
    }
  },
  {
    // ForEach-Object (learn.microsoft.com/powershell/module/microsoft.powershell.core/foreach-object) :
    // bloc -Process exécuté pour chaque objet ($_), -Begin / -End une fois ; un nom (-MemberName)
    // renvoie la propriété de chaque objet.
    name: 'ForEach-Object',
    aliases: ['foreach', '%'],
    module: 'Core',
    synopsis: 'Exécute une opération sur chaque objet du pipeline.',
    params: [
      { name: 'Process', type: 'any', position: 0, aliases: ['MemberName'] },
      { name: 'Begin', type: 'script' },
      { name: 'End', type: 'script' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx: CmdContext, args, input) {
      const out: PsValue[] = []
      const begin = args['Begin'] ?? null
      if (isScript(begin)) out.push(...ctx.invoke(begin, null))
      const process = args['Process'] ?? null
      for (const item of flatten(input)) {
        if (isScript(process)) out.push(...ctx.invoke(process, item))
        else if (process !== null) out.push(getProp(item, psToString(process)))
      }
      const end = args['End'] ?? null
      if (isScript(end)) out.push(...ctx.invoke(end, null))
      return out
    }
  },
  {
    name: 'Sort-Object',
    aliases: ['sort'],
    module: 'Core',
    synopsis: 'Trie les objets.',
    params: [
      { name: 'Property', type: 'string[]', position: 0 },
      { name: 'Descending', type: 'switch' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(_ctx, args, input) {
      const props = propsArg(args['Property'])
      const key = (v: PsValue) =>
        props ? props.map((p) => psToString(getProp(v, p))).join('\u0000') : psToString(v)
      const sorted = [...flatten(input)].sort((a, b) => key(a).localeCompare(key(b), 'fr', { numeric: true }))
      return args['Descending'] === true ? sorted.reverse() : sorted
    }
  },
  {
    name: 'Measure-Object',
    aliases: ['measure'],
    module: 'Core',
    synopsis: 'Compte les objets.',
    params: [
      { name: 'Property', type: 'string', position: 0 },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(_ctx, args, input) {
      const items = flatten(input)
      return [
        psObject(
          'GenericMeasureInfo',
          {
            Count: items.length,
            Average: null,
            Sum: null,
            Maximum: null,
            Minimum: null,
            Property: args['Property'] ?? null
          },
          { kind: 'list', props: ['Count', 'Average', 'Sum', 'Maximum', 'Minimum', 'Property'] }
        )
      ]
    }
  },
  {
    name: 'ConvertTo-SecureString',
    module: 'Security',
    synopsis: 'Convertit un texte en chaîne sécurisée.',
    params: [
      { name: 'String', type: 'string', position: 0, mandatory: true, pipeline: true },
      { name: 'AsPlainText', type: 'switch' },
      { name: 'Force', type: 'switch' }
    ],
    run(_ctx, args) {
      if (args['AsPlainText'] !== true)
        throw psError(
          'Impossible de convertir la chaîne : utilisez -AsPlainText -Force pour convertir un texte en clair.',
          'InvalidArgument',
          'ImportSecureString'
        )
      if (args['Force'] !== true)
        throw psError(
          'Le paramètre « AsPlainText » nécessite le paramètre « Force » pour confirmer que vous comprenez les risques liés à cette opération.',
          'InvalidArgument',
          'ConvertToSecureString'
        )
      return [{ kind: 'secure', value: psToString(args['String'] ?? '') }]
    }
  },
  {
    name: 'Read-Host',
    module: 'Core',
    synopsis: 'Lit une saisie au clavier.',
    params: [
      { name: 'Prompt', type: 'string', position: 0 },
      { name: 'AsSecureString', type: 'switch' }
    ],
    run(ctx, args) {
      const secure = args['AsSecureString'] === true
      const answer = ctx.ask(`${psToString(args['Prompt'])}: `, secure)
      return [secure ? { kind: 'secure', value: answer } : answer]
    }
  },
  {
    name: 'Get-Credential',
    module: 'Security',
    synopsis: 'Demande un nom d’utilisateur et un mot de passe.',
    params: [
      { name: 'UserName', type: 'string', position: 0, aliases: ['Credential'] },
      { name: 'Message', type: 'string' }
    ],
    run(ctx, args) {
      ctx.writeLines([
        '',
        'Demande d’informations d’identification',
        psToString(args['Message'] ?? 'Entrez vos informations d’identification.')
      ])
      const user = args['UserName'] ? psToString(args['UserName']) : ctx.ask('Utilisateur : ')
      const password = ctx.ask(`Mot de passe pour l’utilisateur ${user} : `, true)
      return [{ kind: 'credential', user, password }]
    }
  },
  {
    name: 'Get-Date',
    module: 'Core',
    synopsis: 'Affiche la date et l’heure (horloge du lab).',
    params: [],
    run(ctx) {
      return [formatShortDate(ctx.state.clock)]
    }
  },
  {
    name: 'Get-Location',
    aliases: ['pwd', 'gl'],
    module: 'Core',
    synopsis: 'Affiche le dossier courant.',
    params: [],
    run(ctx) {
      return [psObject('PathInfo', { Path: ctx.session.cwd }, { kind: 'table', props: ['Path'] })]
    }
  }
]
