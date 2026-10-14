/**
 * Éditeur de labs : catalogue des types de critères (champs déduits des schémas zod, libellés
 * français), suggestions tirées du lab courant, construction et validation d'un critère, puis
 * d'une définition de lab complète dont le départ est un instantané du lab de l'auteur.
 */
import type { z } from 'zod'
import type { LabState } from '../model/schema'
import { createSlabDocument } from '../serialization/slab'
import { CheckSchema, criterionTypes, evaluateCheck, type Check } from './criteria'
import { LAB_FORMAT_VERSION, LabDefinitionSchema, type LabDefinition } from './lab'

export type FieldKind = 'text' | 'number' | 'boolean' | 'enum' | 'list' | 'enumList'

/** Liste de noms du lab courant proposée pour un champ. */
export type ReferenceKind = 'device' | 'account' | 'group' | 'domain' | 'gpo' | 'site'

export interface CriterionField {
  key: string
  label: string
  kind: FieldKind
  optional: boolean
  /** Valeur appliquée si le champ est laissé vide. */
  defaultValue?: unknown
  /** Valeurs possibles (énumérations). */
  options?: string[]
  reference?: ReferenceKind
}

export interface CriterionTypeInfo {
  type: string
  label: string
  fields: CriterionField[]
}

/** Libellés des champs, communs à tous les types (même clé = même sens). */
const FIELD_LABELS: Record<string, string> = {
  min: 'Score minimal',
  line: 'Ligne de configuration',
  present: 'Présente',
  state: 'État',
  network: 'Réseau',
  source: 'Origine',
  via: 'Prochain saut',
  violated: 'Violation constatée',
  match: 'Comparaison de la ligne (exacte ou début de ligne)',
  minNeighbors: 'Voisins OSPF (minimum)',
  minTranslations: 'Traductions NAT (minimum)',
  minBindings: 'Baux (minimum)',
  rule: 'Règle',
  scenario: 'Scénario (identifiant)',
  after: 'Scénarios joués avant (identifiants)',
  passed: 'Respectée',
  device: 'Équipement',
  interface: 'Carte',
  address: 'Adresse',
  prefixLength: 'Longueur du préfixe',
  gateway: 'Passerelle',
  from: 'Depuis',
  to: 'Vers (nom ou adresse)',
  success: 'Réussi',
  port: 'Port',
  mode: 'Mode',
  vlan: 'VLAN',
  profile: 'Profil',
  enabled: 'Activé',
  displayName: 'Nom affiché',
  direction: 'Sens',
  action: 'Action',
  protocol: 'Protocole',
  feature: 'Fonctionnalité',
  server: 'Serveur',
  zone: 'Zone',
  name: 'Nom',
  recordType: 'Type d’enregistrement',
  data: 'Données',
  client: 'Client',
  start: 'Début',
  end: 'Fin',
  router: 'Routeur',
  dnsServer: 'Serveur DNS',
  kind: 'Type d’objet',
  parent: 'Conteneur parent',
  memberOf: 'Membre de',
  contains: 'Doit contenir',
  domain: 'Domaine',
  site: 'Site',
  subnet: 'Sous-réseau',
  sites: 'Sites',
  maxInterval: 'Intervalle maximal (min)',
  role: 'Rôle',
  gpo: 'GPO',
  target: 'Cible',
  enforced: 'Appliquée',
  setting: 'Paramètre',
  value: 'Valeur',
  part: 'Partie',
  account: 'Compte',
  path: 'Chemin',
  share: 'Partage',
  allow: 'Autorisations accordées',
  deny: 'Autorisations refusées',
  letter: 'Lettre',
  update: 'Mise à jour',
  group: 'Groupe',
  computer: 'Ordinateur',
  received: 'Reçue',
  started: 'Démarré',
  host: 'Hôte',
  url: 'Adresse (URL)',
  status: 'Code HTTP',
  trusted: 'Approuvé',
  app: 'Application RemoteApp',
  opened: 'Ouverte',
  switchType: 'Type de commutateur',
  running: 'En cours d’exécution',
  switch: 'Commutateur',
  template: 'Modèle',
  published: 'Publié',
  dnsName: 'Nom DNS',
  fromCa: 'Émis par l’autorité',
  trustedBy: 'Approuvé par',
  revoked: 'Révoqué',
  folder: 'Dossier',
  targets: 'Nombre de cibles',
  item: 'Élément',
  systemState: 'État du système',
  access: 'Accès',
  user: 'Utilisateur',
  granted: 'Accordé'
}

/** Champs dont la valeur désigne un objet du lab : suggestions proposées. */
const FIELD_REFERENCES: Record<string, ReferenceKind> = {
  device: 'device',
  from: 'device',
  to: 'device',
  client: 'device',
  server: 'device',
  computer: 'device',
  host: 'device',
  trustedBy: 'device',
  account: 'account',
  user: 'account',
  memberOf: 'group',
  group: 'group',
  domain: 'domain',
  gpo: 'gpo',
  site: 'site',
  sites: 'site'
}

interface ZodDef {
  type: string
  innerType?: z.ZodType
  defaultValue?: unknown
  element?: z.ZodType
  entries?: Record<string, string>
}

const defOf = (schema: z.ZodType): ZodDef => (schema as unknown as { _zod: { def: ZodDef } })._zod.def

/** Description d'un champ d'après son schéma (facultatif, valeur par défaut, énumération, liste). */
function describeField(key: string, schema: z.ZodType): CriterionField {
  let current = schema
  let optional = false
  let defaultValue: unknown
  for (;;) {
    const def = defOf(current)
    if (def.type === 'optional' && def.innerType) {
      optional = true
      current = def.innerType
    } else if (def.type === 'default' && def.innerType) {
      optional = true
      defaultValue = def.defaultValue
      current = def.innerType
    } else break
  }
  const def = defOf(current)
  const field: CriterionField = { key, label: FIELD_LABELS[key] ?? key, kind: 'text', optional }
  if (defaultValue !== undefined) field.defaultValue = defaultValue
  const reference = FIELD_REFERENCES[key]
  if (reference) field.reference = reference
  if (def.type === 'number') field.kind = 'number'
  else if (def.type === 'boolean') field.kind = 'boolean'
  else if (def.type === 'enum' && def.entries) {
    field.kind = 'enum'
    field.options = Object.values(def.entries)
  } else if (def.type === 'array' && def.element) {
    const element = defOf(def.element)
    if (element.type === 'enum' && element.entries) {
      field.kind = 'enumList'
      field.options = Object.values(element.entries)
    } else field.kind = 'list'
  }
  return field
}

let catalog: CriterionTypeInfo[] | null = null

/** Types de critères proposés par l'éditeur, triés par libellé. */
export function criterionCatalog(): CriterionTypeInfo[] {
  return (catalog ??= [...criterionTypes().values()]
    .map((t) => ({
      type: t.type,
      label: t.label,
      fields: Object.entries(t.schema.shape)
        .filter(([key]) => key !== 'type')
        .map(([key, schema]) => describeField(key, schema as z.ZodType))
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr')))
}

export function criterionTypeInfo(type: string): CriterionTypeInfo | undefined {
  return criterionCatalog().find((t) => t.type === type)
}

/** Noms du lab courant proposés pour chaque type de référence. */
export function labReferences(state: LabState): Record<ReferenceKind, string[]> {
  const domains = Object.values(state.domains)
  const sorted = (names: Iterable<string>) => [...new Set(names)].sort((a, b) => a.localeCompare(b, 'fr'))
  return {
    device: sorted(Object.values(state.devices).map((d) => d.name)),
    account: sorted(domains.flatMap((d) => [...d.users.map((u) => u.sam), ...d.groups.map((g) => g.name)])),
    group: sorted(domains.flatMap((d) => d.groups.map((g) => g.name))),
    domain: sorted(domains.map((d) => d.name)),
    gpo: sorted(domains.flatMap((d) => d.gpos.map((g) => g.name))),
    site: sorted(domains.flatMap((d) => d.sites.map((s) => s.name)))
  }
}

/** Valeurs saisies dans le formulaire (texte brut, cases à cocher, listes). */
export type FieldValues = Record<string, string | boolean | string[] | undefined>

export type BuildCheckResult = { ok: true; check: Check } | { ok: false; message: string }

/**
 * Construit et valide une vérification à partir des valeurs du formulaire : champs vides
 * ignorés (valeur par défaut du type), nombres convertis, listes nettoyées.
 */
export function buildCheck(type: string, values: FieldValues): BuildCheckResult {
  const info = criterionTypeInfo(type)
  if (!info) return { ok: false, message: `Type de critère inconnu : ${type}.` }
  const raw: Record<string, unknown> = { type }
  for (const field of info.fields) {
    const value = values[field.key]
    if (value === undefined || value === '') continue
    if (field.kind === 'boolean') raw[field.key] = value === true || value === 'true'
    else if (field.kind === 'number') {
      const n = Number(value)
      if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(n))
        return { ok: false, message: `« ${field.label} » doit être un nombre.` }
      raw[field.key] = n
    } else if (field.kind === 'list' || field.kind === 'enumList') {
      const items = (Array.isArray(value) ? value : String(value).split(','))
        .map((v) => v.trim())
        .filter((v) => v !== '')
      raw[field.key] = items
    } else raw[field.key] = typeof value === 'string' ? value.trim() : value
  }
  const missing = info.fields.find((f) => !f.optional && raw[f.key] === undefined)
  if (missing) return { ok: false, message: `Le champ « ${missing.label} » est obligatoire.` }
  const parsed = CheckSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const key = issue?.path[0]
    const label = typeof key === 'string' ? (FIELD_LABELS[key] ?? key) : 'critère'
    return { ok: false, message: `Valeur invalide pour « ${label} ».` }
  }
  return { ok: true, check: parsed.data }
}

/** Valeurs du formulaire correspondant à une vérification existante (édition d'un critère). */
export function checkValues(check: Check): FieldValues {
  const values: FieldValues = {}
  for (const [key, value] of Object.entries(check)) {
    if (key === 'type' || value === undefined || value === null) continue
    values[key] = Array.isArray(value)
      ? value.map(String)
      : typeof value === 'boolean'
        ? value
        : String(value)
  }
  return values
}

/** Teste une vérification sur le lab courant. */
export function testCheck(state: LabState, check: Check): boolean {
  return evaluateCheck(state, check)
}

/** Brouillon de l'éditeur : métadonnées, énoncé, critères (avec niveaux d'indice). */
export interface LabDraft {
  title: string
  difficulty: LabDefinition['difficulty']
  duration: string
  summary: string
  statement: string
  criteria: { label: string; hints: string[]; check: Check }[]
}

/** Identifiant de lab tiré du titre (« Mon lab DHCP » → custom-mon-lab-dhcp). */
export function labIdFromTitle(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  return `custom-${slug || 'lab'}`
}

export type LabDefinitionResult = { ok: true; lab: LabDefinition } | { ok: false; message: string }

/**
 * Définition de lab complète : départ = instantané du lab donné, critères numérotés, premier
 * niveau d'indice obligatoire. Validée par le même schéma que l'import.
 */
export function createLabDefinition(
  draft: LabDraft,
  start: LabState,
  options: { appVersion: string; savedAt: string }
): LabDefinitionResult {
  if (draft.title.trim() === '') return { ok: false, message: 'Donnez un titre au lab.' }
  if (draft.statement.trim() === '') return { ok: false, message: 'Rédigez l’énoncé du lab.' }
  if (draft.criteria.length === 0) return { ok: false, message: 'Ajoutez au moins un critère.' }
  for (const [i, c] of draft.criteria.entries()) {
    if (c.label.trim() === '')
      return { ok: false, message: `Critère ${i + 1} : décrivez ce qui est attendu.` }
    if ((c.hints[0] ?? '').trim() === '')
      return { ok: false, message: `Critère ${i + 1} : rédigez au moins un indice.` }
  }
  const snapshot = createSlabDocument(start, { savedAt: options.savedAt, appVersion: options.appVersion })
  const parsed = LabDefinitionSchema.safeParse({
    formatVersion: LAB_FORMAT_VERSION,
    id: labIdFromTitle(draft.title),
    title: draft.title.trim(),
    difficulty: draft.difficulty,
    duration: draft.duration.trim() || '30 min',
    summary: draft.summary.trim(),
    statement: draft.statement,
    start: { snapshot },
    criteria: draft.criteria.map((c, i) => {
      const hints = c.hints.map((h) => h.trim()).filter((h) => h !== '')
      return {
        id: `c${i + 1}`,
        label: c.label.trim(),
        hint: hints[0] ?? '',
        hints: hints.slice(1),
        check: c.check
      }
    })
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `Lab invalide : ${issue?.message ?? 'structure inattendue'}.` }
  }
  return { ok: true, lab: parsed.data }
}

/** Brouillon d'éditeur correspondant à un lab importé (pour le modifier). */
export function draftFromLab(lab: LabDefinition): LabDraft {
  return {
    title: lab.title,
    difficulty: lab.difficulty,
    duration: lab.duration,
    summary: lab.summary,
    statement: lab.statement,
    criteria: lab.criteria.map((c) => ({ label: c.label, hints: [c.hint, ...c.hints], check: c.check }))
  }
}

/** Texte JSON d'un lab exporté. */
export function serializeLab(lab: LabDefinition): string {
  return `${JSON.stringify(lab, null, 2)}\n`
}
