/**
 * Paramètres de stratégie fondés sur le registre (Set-GPRegistryValue / Get-GPRegistryValue,
 * v2.7 Lot 2b).
 *
 * Sourcé Microsoft Learn (module GroupPolicy) :
 * - Set-GPRegistryValue : « configures a registry-based policy setting under either Computer
 *   Configuration or User Configuration » ; -Key, -ValueName, -Value, -Type ; -Disable supprime la
 *   valeur sur le client ; plusieurs valeurs : types String et ExpandString seulement.
 * - Get-GPRegistryValue : objets KeyPath, FullKeyPath, Hive, PolicyState (Set / Delete), Value,
 *   Type, ValueName, HasValue ; -Key renvoie aussi les sous-clés.
 *
 * Valeurs reliées aux paramètres simulés (l'effet sur les clients en découle) : NoRun et
 * NoControlPanel (HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer), DisableCMD
 * (HKCU\Software\Policies\Microsoft\Windows\System). Les autres valeurs sont conservées dans la GPO
 * et restituées, sans effet simulé sur les clients. Correspondances : docs/fidelite.md, « À vérifier (Lot 2) ».
 */
import { raise, type EngineResult } from '../../core/result'
import type { Gpo, GpoUserSettings, GpRegistryValue, LabState, PolicyState } from '../../model/schema'
import { GP_REGISTRY_TYPES } from '../../model/schema'
import { transact } from '../../core/result'
import { requireDomain } from '../adds/objects'

export type GpHive = GpRegistryValue['hive']

/** Valeur reliée à un paramètre simulé de la Configuration utilisateur. */
interface MappedValue {
  hive: GpHive
  key: string
  valueName: string
  setting: 'noRun' | 'noControlPanel' | 'noCmd'
}

const MAPPED: MappedValue[] = [
  {
    hive: 'HKCU',
    key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
    valueName: 'NoRun',
    setting: 'noRun'
  },
  {
    hive: 'HKCU',
    key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
    valueName: 'NoControlPanel',
    setting: 'noControlPanel'
  },
  {
    hive: 'HKCU',
    key: 'Software\\Policies\\Microsoft\\Windows\\System',
    valueName: 'DisableCMD',
    setting: 'noCmd'
  }
]

const HIVES: Record<string, GpHive> = {
  hklm: 'HKLM',
  hkey_local_machine: 'HKLM',
  hkcu: 'HKCU',
  hkey_current_user: 'HKCU'
}

/** « HKLM\Software\… » → ruche et chemin relatif ; seules HKLM et HKCU sont admises. */
export function parseGpKey(key: string): { hive: GpHive; key: string } {
  const [root = '', ...rest] = key.trim().replace(/\\+$/, '').split('\\')
  const hive = HIVES[root.replace(/:$/, '').toLowerCase()]
  if (!hive)
    raise(
      'InvalidRegistryKey',
      `La clé « ${key} » n’est pas valide : elle doit commencer par HKLM (Configuration ordinateur) ou HKCU (Configuration utilisateur).`
    )
  return { hive, key: rest.join('\\') }
}

export function parseGpType(type: string): GpRegistryValue['type'] {
  const found = GP_REGISTRY_TYPES.find((t) => t.toLowerCase() === type.trim().toLowerCase())
  if (!found)
    raise(
      'InvalidRegistryType',
      `Le type « ${type} » n’est pas valide : String, ExpandString, Binary, DWord, MultiString ou QWord.`
    )
  return found
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Valeurs de registre d'une GPO : paramètres simulés reliés, puis valeurs conservées. */
export function gpoRegistryValues(gpo: Gpo): GpRegistryValue[] {
  const mapped = MAPPED.flatMap((m): GpRegistryValue[] => {
    const state = gpo.user[m.setting]
    if (state === 'NotConfigured') return []
    return [
      state === 'Enabled'
        ? { hive: m.hive, key: m.key, valueName: m.valueName, type: 'DWord', value: 1, state: 'Set' }
        : { hive: m.hive, key: m.key, valueName: m.valueName, type: 'DWord', value: '', state: 'Delete' }
    ]
  })
  return [...mapped, ...gpo.registry]
}

export interface GpRegistryInput {
  key: string
  valueNames: string[]
  values: (string | number)[]
  type?: string
  disable?: boolean
}

/** Configure (ou désactive avec -Disable) des valeurs de registre d'une GPO. */
export function setGpRegistryValue(
  state: LabState,
  domainName: string,
  gpoId: string,
  input: GpRegistryInput
): EngineResult {
  return transact(state, (draft) => {
    const domain = requireDomain(draft, domainName)
    const gpo = domain.gpos.find((g) => g.id === gpoId)
    if (!gpo) raise('GpoNotFound', `L’objet de stratégie de groupe ${gpoId} est introuvable.`)
    const { hive, key } = parseGpKey(input.key)
    const disable = !!input.disable
    if (!disable && input.type === undefined)
      raise('MissingType', 'Le paramètre -Type est obligatoire pour configurer une valeur.')
    const type = input.type === undefined ? 'String' : parseGpType(input.type)
    if (input.valueNames.length === 0 && !disable)
      raise('MissingValueName', 'Le paramètre -ValueName est obligatoire pour configurer une valeur.')
    if (!disable && input.valueNames.length > 1 && type !== 'String' && type !== 'ExpandString')
      raise(
        'InvalidRegistryType',
        'Plusieurs valeurs de registre ne peuvent être configurées qu’avec les types String et ExpandString.'
      )
    if (!disable && input.values.length !== input.valueNames.length)
      raise('ValueCountMismatch', 'Indiquez autant de valeurs (-Value) que de noms (-ValueName).')
    // -Disable sans -ValueName : toutes les valeurs de la clé
    const names =
      input.valueNames.length > 0
        ? input.valueNames
        : gpoRegistryValues(gpo as Gpo)
            .filter((v) => v.hive === hive && same(v.key, key))
            .map((v) => v.valueName)
    names.forEach((valueName, i) => {
      const raw = input.values[i] ?? ''
      let value: string | number = raw
      if (!disable && (type === 'DWord' || type === 'QWord')) {
        const n = typeof raw === 'number' ? raw : Number(raw)
        if (!Number.isInteger(n) || n < 0)
          raise('InvalidRegistryValue', `La valeur « ${raw} » n’est pas valide pour le type ${type}.`)
        value = n
      }
      const mapped = MAPPED.find((m) => m.hive === hive && same(m.key, key) && same(m.valueName, valueName))
      if (mapped) {
        const policy: PolicyState = disable || value === 0 ? 'Disabled' : 'Enabled'
        ;(gpo.user as GpoUserSettings)[mapped.setting] = policy
        return
      }
      const existing = gpo.registry.find(
        (v) => v.hive === hive && same(v.key, key) && same(v.valueName, valueName)
      )
      const entry: GpRegistryValue = disable
        ? { hive, key, valueName, type: existing?.type ?? type, value: '', state: 'Delete' }
        : { hive, key, valueName, type, value, state: 'Set' }
      if (existing) Object.assign(existing, entry)
      else gpo.registry.push(entry)
    })
    if (hive === 'HKLM') gpo.computerVersion += 1
    else gpo.userVersion += 1
    gpo.modifiedAt = draft.clock
    return undefined
  })
}

/** Valeurs sous une clé (et ses sous-clés), filtrées par nom. */
export function findGpRegistryValues(gpo: Gpo, key: string, valueName?: string): GpRegistryValue[] {
  const parsed = parseGpKey(key)
  const prefix = parsed.key.toLowerCase()
  return gpoRegistryValues(gpo).filter(
    (v) =>
      v.hive === parsed.hive &&
      (v.key.toLowerCase() === prefix || v.key.toLowerCase().startsWith(`${prefix}\\`)) &&
      (valueName === undefined || same(v.valueName, valueName))
  )
}
