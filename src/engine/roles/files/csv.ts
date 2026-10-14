/**
 * Import-Csv / Export-Csv (Windows PowerShell 5.1, celui de Windows Server 2022) sur le système de
 * fichiers simulé. Comportement d'après Microsoft Learn :
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/export-csv?view=powershell-5.1
 *   « By default the first string contains the #TYPE information header followed by the object
 *   type's fully qualified name » ; -NoTypeInformation retire cet en-tête (devenu le défaut en
 *   PowerShell 6.0 seulement) ; colonnes = propriétés du premier objet ; valeurs entre guillemets
 *   (exemple 5) ; délimiteur par défaut « , » ; encodage par défaut ASCII ; -Append n'écrit pas
 *   d'en-tête (exemple 6).
 * - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/import-csv?view=powershell-5.1
 *   Première ligne = en-têtes (sauf -Header) ; valeurs supplémentaires ignorées ; en-tête vide → H1,
 *   H2… ; objets PSCustomObject dont les propriétés sont des chaînes.
 */
import { writeFileContent } from './actions'
import { accessPermsAt, applyFs, denied, notFound, target } from './cmdlets'
import { nodeAt, shellToken } from '../../shell/filesystem'
import { psError } from '../../shell/ps/errors'
import type { CmdletDef } from '../../shell/ps/registry'
import { flatten, isPsObject, psObject, psToString, type PsObject, type PsValue } from '../../shell/ps/values'
import { unsimulatedParameterMessage } from '../../shell/unsimulated'
import type { FileEncoding } from './encoding'

const str = (v: PsValue | undefined): string => psToString(v)
const CUSTOM = 'System.Management.Automation.PSCustomObject'

/** Valeur entre guillemets, guillemets internes doublés. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Délimiteur : premier caractère de l'argument (paramètre de type Char). */
function delimiterOf(v: PsValue | undefined): string {
  const d = v === undefined ? ',' : str(v)
  if (d.length !== 1)
    throw psError(
      `Impossible de convertir la valeur « ${d} » en type « System.Char ». Erreur : « La chaîne doit avoir une longueur d’un et un seul caractère. »`,
      'InvalidArgument',
      'ParameterArgumentTransformationError'
    )
  return d
}

/** Nom de type complet écrit après #TYPE (à vérifier pour les objets propres au simulateur). */
function fullTypeName(o: PsObject): string {
  return o.typeName === 'Selected' || o.typeName === CUSTOM || o.typeName.startsWith('CSV:')
    ? CUSTOM
    : o.typeName
}

/** Lignes CSV des objets (en-tête de type et de colonnes compris, sauf ajout). */
export function toCsv(objects: PsValue[], delimiter: string, typeInfo: boolean, header: boolean): string[] {
  const items = flatten(objects)
  const first = items[0]
  if (first === undefined) return []
  const props = isPsObject(first) ? Object.keys(first.props) : ['Length']
  const lines: string[] = []
  if (header) {
    if (typeInfo) lines.push(`#TYPE ${isPsObject(first) ? fullTypeName(first) : 'System.String'}`)
    lines.push(props.map(quote).join(delimiter))
  }
  for (const item of items) {
    const values = props.map((p) => {
      if (!isPsObject(item)) return quote(p === 'Length' ? String(str(item).length) : '')
      const key = Object.keys(item.props).find((k) => k.toLowerCase() === p.toLowerCase())
      const v = key === undefined ? null : (item.props[key] ?? null)
      // Propriété absente : valeur nulle, représentée par deux délimiteurs consécutifs
      return key === undefined || v === null ? '' : quote(str(v))
    })
    lines.push(values.join(delimiter))
  }
  return lines
}

/** Découpe un texte CSV en enregistrements (guillemets, délimiteurs et sauts de ligne protégés). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRecord = () => {
    record.push(field)
    records.push(record)
    record = []
    field = ''
  }
  while (i < text.length) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      if (c === '"') quoted = false
      else field += c
      i++
      continue
    }
    if (c === '"') quoted = true
    else if (c === delimiter) {
      record.push(field)
      field = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      endRecord()
      i++
    } else if (c === '\n') endRecord()
    else field += c
    i++
  }
  if (field !== '' || record.length > 0) endRecord()
  // Lignes vides ignorées
  return records.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Objets PSCustomObject d'un texte CSV (en-têtes du fichier ou de -Header). */
export function fromCsv(text: string, delimiter: string, header?: string[]): PsObject[] {
  let records = parseCsv(text, delimiter)
  // En-tête #TYPE d'un fichier produit par Export-Csv sans -NoTypeInformation
  if (records[0]?.[0]?.startsWith('#TYPE')) records = records.slice(1)
  const names = header ?? records.shift() ?? []
  let n = 0
  const props = names.map((h) => (h === '' ? `H${++n}` : h))
  return records.map((r) => {
    const values: Record<string, PsValue> = {}
    props.forEach((p, i) => (values[p] = r[i] ?? null))
    return psObject(CUSTOM, values)
  })
}

const reject = (command: string, args: Record<string, PsValue>, names: string[]) => {
  for (const name of names)
    if (args[name] !== undefined)
      throw psError(unsimulatedParameterMessage(command, name), 'NotImplemented', 'UnsimulatedParameter')
}

const CSV_ENCODINGS = ['ASCII', 'BigEndianUnicode', 'Default', 'OEM', 'Unicode', 'UTF7', 'UTF8', 'UTF32']

export const csvCmdlets: CmdletDef[] = [
  {
    name: 'Export-Csv',
    aliases: ['epcsv'],
    module: 'Utility',
    synopsis: 'Convertit des objets en chaînes CSV et les enregistre dans un fichier.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Delimiter', type: 'string', position: 1 },
      { name: 'NoTypeInformation', type: 'switch', aliases: ['NTI'] },
      { name: 'Encoding', type: 'string', validateSet: CSV_ENCODINGS },
      { name: 'Append', type: 'switch' },
      { name: 'Force', type: 'switch' },
      { name: 'NoClobber', type: 'switch', aliases: ['NoOverwrite'] },
      { name: 'InputObject', type: 'any', pipeline: true, mandatory: true },
      { name: 'UseCulture', type: 'switch' },
      { name: 'LiteralPath', type: 'any' }
    ],
    run(ctx, args, input) {
      reject('Export-Csv', args, ['UseCulture', 'LiteralPath'])
      const t = target(ctx, str(args['Path']))
      const existing = nodeAt(t)
      if (args['NoClobber'] === true && args['Append'] !== true && existing !== undefined)
        // Libellé à vérifier (aucune sortie française de référence sur Learn)
        throw psError(`Le fichier « ${t.display} » existe déjà.`, 'ResourceExists', 'NoClobber', t.display)
      const values = args['InputObject'] !== undefined ? [args['InputObject']] : input
      const append = args['Append'] === true && existing !== undefined && existing !== null
      const lines = toCsv(values, delimiterOf(args['Delimiter']), args['NoTypeInformation'] !== true, !append)
      const text = lines.map((l) => `${l}\r\n`).join('')
      const encoding = (str(args['Encoding']) || 'ASCII') as FileEncoding
      applyFs(ctx, t.display, () =>
        writeFileContent(ctx.state, t.server.id, t.localPath, text, shellToken(ctx), {
          append,
          encoding,
          ...(t.share ? { share: t.share.name } : {})
        })
      )
      return []
    }
  },
  {
    name: 'Import-Csv',
    aliases: ['ipcsv'],
    module: 'Utility',
    synopsis: 'Crée des objets à partir des lignes d’un fichier CSV.',
    params: [
      { name: 'Path', type: 'string', position: 0, mandatory: true },
      { name: 'Delimiter', type: 'string', position: 1 },
      { name: 'Header', type: 'string[]' },
      { name: 'Encoding', type: 'string', validateSet: CSV_ENCODINGS },
      { name: 'UseCulture', type: 'switch' },
      { name: 'LiteralPath', type: 'any' }
    ],
    run(ctx, args) {
      reject('Import-Csv', args, ['UseCulture', 'LiteralPath'])
      const t = target(ctx, str(args['Path']))
      const node = nodeAt(t)
      if (node === undefined || node === null || node.kind === 'folder') throw notFound(t.display)
      if (!accessPermsAt(t, node, shellToken(ctx)).has('read')) throw denied(t.display)
      const header = args['Header'] !== undefined ? flatten([args['Header']]).map(psToString) : undefined
      return fromCsv(node.content ?? '', delimiterOf(args['Delimiter']), header)
    }
  }
]
