/**
 * Cmdlets de base : aide, affichage, pipeline (Format-*, Select, Where, Sort, Measure), saisie.
 */
import { formatShortDate } from '../../../core/clock'
import { psError } from '../errors'
import { formatLabDate } from '../dateformat'
import { formatList, formatTable } from '../format'
import type { CmdContext } from '../interpreter'
import type { CmdletDef } from '../registry'
import {
  flatten,
  getProp,
  enumValue,
  isPsObject,
  isScript,
  psObject,
  psToString,
  wildcardToRegExp,
  type PsObject,
  type PsScriptBlock,
  type PsValue
} from '../values'
import { compare } from '../expression'

function asObjects(values: PsValue[]): PsObject[] {
  return flatten(values).map((v) => (isPsObject(v) ? v : psObject('System.String', { Value: v })))
}

/** Propriété demandée à Select-Object / Group-Object : nom ou expression calculée. */
interface SelectSpec {
  label: string
  expression?: PsScriptBlock
}

/** Clé d'une propriété calculée (Label / l / Name / n, Expression / e), insensible à la casse. */
function hashEntry(h: PsObject, names: string[]): PsValue | undefined {
  const key = Object.keys(h.props).find((k) => names.includes(k.toLowerCase()))
  return key === undefined ? undefined : (h.props[key] ?? null)
}

function selectSpecs(value: PsValue): SelectSpec[] | null {
  if (value === null) return null
  const items = Array.isArray(value) ? flatten(value) : [value]
  if (items.length === 1 && items[0] === '*') return null
  return items.map((v) => {
    if (isScript(v)) return { label: v.source, expression: v }
    if (isPsObject(v) && v.typeName === 'System.Collections.Hashtable') {
      const expression = hashEntry(v, ['expression', 'e'])
      const label = hashEntry(v, ['label', 'l', 'name', 'n'])
      if (isScript(expression ?? null))
        return {
          label: psToString(label ?? (expression as PsScriptBlock).source),
          expression: expression as PsScriptBlock
        }
      return { label: psToString(expression ?? label ?? '') }
    }
    return { label: psToString(v) }
  })
}

/** Sortie d'un bloc de script ramenée à une valeur (un seul objet ou un tableau). */
function collapse(values: PsValue[]): PsValue {
  return values.length === 1 ? (values[0] as PsValue) : values
}

/** Vrai si l'objet a la propriété (insensible à la casse ; Count / Length des collections). */
function hasProp(v: PsValue, name: string): boolean {
  if (isPsObject(v)) return Object.keys(v.props).some((k) => k.toLowerCase() === name.toLowerCase())
  return getProp(v, name) !== null
}

/** Cellule « Group » : au plus 4 éléments puis « ... » ($FormatEnumerationLimit). */
function enumerationCell(values: PsValue): string {
  const items = Array.isArray(values) ? flatten(values) : [values]
  const shown = items.slice(0, 4).map(psToString)
  return `{${shown.join(', ')}${items.length > 4 ? '...' : ''}}`
}

/**
 * Tableau de Group-Object : Count sur 5 caractères aligné à droite, Name sur 25 (exemple 2 de la
 * documentation : « Count Name                      Group »), Group en dernier.
 */
function renderGroups(objects: PsObject[]): string[] {
  const noElement = !objects.some((o) => 'Group' in o.props)
  const name = (o: PsObject) => {
    const text = psToString(o.props['Name'] ?? null)
    return text.length > 25 ? `${text.slice(0, 22)}...` : text
  }
  const lines = ['']
  if (noElement) {
    lines.push('Count Name', '----- ----')
    for (const o of objects)
      lines.push(`${psToString(o.props['Count'] ?? null).padStart(5)} ${name(o)}`.trimEnd())
  } else {
    lines.push(`Count ${'Name'.padEnd(25)} Group`, `----- ${'----'.padEnd(25)} -----`)
    for (const o of objects)
      lines.push(
        `${psToString(o.props['Count'] ?? null).padStart(5)} ${name(o).padEnd(25)} ${enumerationCell(o.props['Group'] ?? null)}`
      )
  }
  lines.push('')
  return lines
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
    // Select-Object (learn.microsoft.com/powershell/module/microsoft.powershell.utility/select-object) :
    // -Skip, -First / -Last, propriétés (noms, blocs de script, propriétés calculées
    // @{Label=…; Expression={…}}), -ExpandProperty, puis -Unique sur le résultat (exemple 5).
    name: 'Select-Object',
    aliases: ['select'],
    module: 'Core',
    synopsis: 'Sélectionne des propriétés ou des objets.',
    params: [
      { name: 'Property', type: 'any', position: 0 },
      { name: 'First', type: 'int' },
      { name: 'Last', type: 'int' },
      { name: 'Skip', type: 'int' },
      { name: 'Unique', type: 'switch' },
      { name: 'ExpandProperty', type: 'string' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx: CmdContext, args, input) {
      let items = flatten(input)
      if (typeof args['Skip'] === 'number') items = items.slice(args['Skip'])
      if (typeof args['First'] === 'number') items = items.slice(0, args['First'])
      if (typeof args['Last'] === 'number') items = items.slice(-args['Last'])
      let result: PsValue[]
      if (args['ExpandProperty']) {
        const name = psToString(args['ExpandProperty'])
        result = []
        for (const i of items) {
          if (!hasProp(i, name))
            throw psError(
              `La propriété « ${name} » est introuvable.`,
              'InvalidArgument',
              'ExpandPropertyNotFound,Microsoft.PowerShell.Commands.SelectObjectCommand',
              psToString(i)
            )
          result.push(...flatten([getProp(i, name)]))
        }
      } else {
        const specs = selectSpecs(args['Property'] ?? null)
        result =
          specs === null
            ? items
            : items.map((i) => {
                const selected: Record<string, PsValue> = {}
                for (const spec of specs) {
                  if (spec.expression) {
                    selected[spec.label] = collapse(ctx.invoke(spec.expression, i))
                    continue
                  }
                  const real = isPsObject(i)
                    ? (Object.keys(i.props).find((k) => k.toLowerCase() === spec.label.toLowerCase()) ??
                      spec.label)
                    : spec.label
                  selected[real] = getProp(i, spec.label)
                }
                return psObject('Selected', selected, {
                  kind: specs.length <= 4 ? 'table' : 'list',
                  props: Object.keys(selected)
                })
              })
      }
      if (args['Unique'] === true) {
        const seen = new Set<string>()
        result = result.filter((v) => {
          const key = isPsObject(v) ? JSON.stringify(v.props) : psToString(v)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      return result
    }
  },
  {
    // Group-Object (learn.microsoft.com/powershell/module/microsoft.powershell.utility/group-object) :
    // une ligne par valeur (Count, Name, Group), groupes dans l'ordre d'apparition (exemple 10),
    // propriété nommée ou bloc de script, -NoElement, insensible à la casse sauf -CaseSensitive.
    name: 'Group-Object',
    aliases: ['group'],
    module: 'Core',
    synopsis: 'Regroupe les objets qui ont la même valeur de propriété.',
    params: [
      { name: 'Property', type: 'any', position: 0 },
      { name: 'NoElement', type: 'switch' },
      { name: 'CaseSensitive', type: 'switch' },
      { name: 'InputObject', type: 'any', pipeline: true }
    ],
    run(ctx: CmdContext, args, input) {
      const specs = selectSpecs(args['Property'] ?? null)
      const caseSensitive = args['CaseSensitive'] === true
      const groups = new Map<string, { name: string; values: PsValue[]; group: PsValue[] }>()
      for (const item of flatten(input)) {
        const values = specs
          ? specs.map((spec) =>
              spec.expression ? collapse(ctx.invoke(spec.expression, item)) : getProp(item, spec.label)
            )
          : [item]
        const name = values.map((v) => psToString(v)).join(', ')
        const key = caseSensitive ? name : name.toLowerCase()
        const existing = groups.get(key)
        if (existing) existing.group.push(item)
        else groups.set(key, { name, values, group: [item] })
      }
      const noElement = args['NoElement'] === true
      return [...groups.values()].map((g) =>
        psObject(
          'GroupInfo',
          noElement
            ? { Count: g.group.length, Name: g.name }
            : { Count: g.group.length, Name: g.name, Group: g.group, Values: g.values },
          {
            kind: 'table',
            props: noElement ? ['Count', 'Name'] : ['Count', 'Name', 'Group'],
            render: renderGroups
          }
        )
      )
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
      // Énumération (Status d'un service) : tri sur la valeur entière (Learn, Get-Service)
      const text = (v: PsValue) => {
        const n = enumValue(v)
        return n === null ? psToString(v) : String(n).padStart(10, '0')
      }
      const key = (v: PsValue) => (props ? props.map((p) => text(getProp(v, p))).join('\u0000') : text(v))
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
    // Get-Date -Format : chaîne de format .NET (culture fr-FR), temps = horloge du lab
    name: 'Get-Date',
    module: 'Core',
    synopsis: 'Affiche la date et l’heure (horloge du lab).',
    params: [{ name: 'Format', type: 'string' }],
    run(ctx, args) {
      const format = args['Format']
      if (typeof format === 'string' && format !== '') return [formatLabDate(ctx.state.clock, format)]
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
