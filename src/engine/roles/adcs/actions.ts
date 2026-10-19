/**
 * Services de certificats Active Directory : autorité racine d'entreprise, modèles publiés,
 * demande et émission de certificats, révocation ; côté client, distribution du certificat
 * racine et inscription automatique lors du traitement de la stratégie ordinateur.
 */
import type { Draft } from 'immer'
import { logEvent } from '../../core/eventlog'
import { raise, transact, type EngineResult } from '../../core/result'
import { nextSeq } from '../../model/factory'
import type { Certificate, Domain, HostDevice, LabState, ServerDevice } from '../../model/schema'
import { addCertificate, makeThumbprint } from '../../services/certificates'
import { requireDevice } from '../../topology/actions'
import { ensureRoleState } from '../state'
import type { AdcsServer } from './schema'
import { serviceRunning } from '../../services/servicestate'
import { ADCS_STATE, CERT_TEMPLATES, DEFAULT_TEMPLATES, enterpriseCas, templateName } from './state'

const YEAR_MS = 365 * 24 * 3600 * 1000

/** Motifs de révocation (certutil -revoke : code numérique). */
export const REVOCATION_REASONS = [
  'Unspecified',
  'KeyCompromise',
  'CACompromise',
  'AffiliationChanged',
  'Superseded',
  'CessationOfOperation'
] as const

export const REVOCATION_LABELS: Record<(typeof REVOCATION_REASONS)[number], string> = {
  Unspecified: 'Non spécifié',
  KeyCompromise: 'Compromission de clé',
  CACompromise: 'Compromission de l’autorité de certification',
  AffiliationChanged: 'Modification de l’affiliation',
  Superseded: 'Remplacé',
  CessationOfOperation: 'Cessation d’activité'
}

/**
 * Message d'une demande adressée à une autorité dont le service CertSvc est arrêté (v2.8, #222).
 * Code 1722 RPC_S_SERVER_UNAVAILABLE « The RPC server is unavailable. » :
 * https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1700-3999-
 * Que ce soit bien ce code que renvoie l'inscription réelle n'est pas sourcé (docs/fidelite.md,
 * « À vérifier (v2.8 — services) »).
 */
export function certSvcStoppedMessage(caName: string): string {
  return `Le serveur RPC n’est pas disponible (1722, RPC_S_SERVER_UNAVAILABLE) : le service Services de certificats Active Directory (CertSvc) est arrêté sur l’autorité ${caName}.`
}

export function requireAdcs(
  draft: Draft<LabState>,
  deviceId: string
): { server: Draft<ServerDevice>; ca: Draft<AdcsServer> } {
  const server = requireDevice(draft, deviceId)
  if (server.kind !== 'server' || !server.host.features.includes('ADCS-Cert-Authority'))
    raise('AdcsNotInstalled', 'Le rôle Autorité de certification n’est pas installé sur cet ordinateur.')
  return { server, ca: ensureRoleState(server, ADCS_STATE) }
}

function requireConfigured(draft: Draft<LabState>, deviceId: string) {
  const r = requireAdcs(draft, deviceId)
  if (!r.ca.configured)
    raise(
      'AdcsNotConfigured',
      'Les services de certificats Active Directory ne sont pas configurés : configurez l’autorité de certification.'
    )
  return r
}

/** Nom par défaut de l'autorité : « LAB-SRV1-CA ». */
export function defaultCaName(state: LabState, deviceId: string): string {
  const d = state.devices[deviceId]
  const domain = d && d.kind === 'server' && d.host.domain ? state.domains[d.host.domain] : undefined
  return `${domain?.netbios ?? 'CA'}-${d?.name ?? ''}-CA`
}

/** Configure l'autorité de certification racine d'entreprise (certificat auto-signé, 5 ans). */
export function installCertificationAuthority(
  state: LabState,
  deviceId: string,
  input: { caName?: string } = {}
): EngineResult<string> {
  const caName = input.caName?.trim() || defaultCaName(state, deviceId)
  return transact(state, (draft) => {
    const { server, ca } = requireAdcs(draft, deviceId)
    if (ca.configured) raise('AdcsConfigured', 'L’autorité de certification est déjà configurée.')
    if (!server.host.domain || !draft.domains[server.host.domain])
      raise(
        'NotDomainMember',
        'Une autorité de certification d’entreprise doit être membre d’un domaine Active Directory.'
      )
    if (!/^[^\\/:*?"<>|]{1,64}$/.test(caName)) raise('InvalidName', `Le nom « ${caName} » n’est pas valide.`)
    const thumbprint = makeThumbprint(nextSeq(draft), `${server.id}:ca`)
    const cert: Certificate = {
      thumbprint,
      subject: `CN=${caName}`,
      issuer: `CN=${caName}`,
      dnsNames: [],
      notBefore: draft.clock,
      notAfter: draft.clock + 5 * YEAR_MS,
      store: 'My',
      ca: true,
      issuerThumbprint: null
    }
    addCertificate(draft, server.id, cert)
    addCertificate(draft, server.id, { ...cert, store: 'Root' })
    ca.configured = true
    ca.caName = caName
    ca.caThumbprint = thumbprint
    ca.templates = [...DEFAULT_TEMPLATES]
    logEvent(draft, server.id, {
      level: 'information',
      source: 'CertificationAuthority',
      eventId: 26,
      log: 'Application',
      message: `Les services de certificats Active Directory ont démarré : ${caName}.`
    })
    return caName
  })
}

export function addCaTemplate(state: LabState, deviceId: string, name: string): EngineResult {
  return transact(state, (draft) => {
    const { ca } = requireConfigured(draft, deviceId)
    const short = templateName(name)
    if (!short) raise('TemplateNotFound', `Le modèle de certificat « ${name} » est introuvable.`)
    if (ca.templates.includes(short))
      raise('TemplateExists', `Le modèle « ${CERT_TEMPLATES[short]?.display} » est déjà publié.`)
    ca.templates.push(short)
    return undefined
  })
}

export function removeCaTemplate(state: LabState, deviceId: string, name: string): EngineResult {
  return transact(state, (draft) => {
    const { ca } = requireConfigured(draft, deviceId)
    const short = templateName(name)
    if (!short || !ca.templates.includes(short))
      raise('TemplateNotFound', `Le modèle de certificat « ${name} » n’est pas publié.`)
    ca.templates = ca.templates.filter((t) => t !== short)
    return undefined
  })
}

/**
 * Émet un certificat de l'autorité pour un ordinateur (dans un brouillon) et le place dans son
 * magasin Personnel. Renvoie l'empreinte.
 */
function issue(
  draft: Draft<LabState>,
  caServer: Draft<ServerDevice>,
  ca: Draft<AdcsServer>,
  requester: Draft<HostDevice>,
  template: string,
  dnsNames: string[]
): string {
  const seq = nextSeq(draft)
  const thumbprint = makeThumbprint(seq, `${requester.id}:${template}`)
  const serial = `61${seq.toString(16).toUpperCase().padStart(16, '0')}`
  const subject = `CN=${dnsNames[0] ?? requester.name}`
  addCertificate(draft, requester.id, {
    thumbprint,
    subject,
    issuer: `CN=${ca.caName}`,
    dnsNames,
    notBefore: draft.clock,
    notAfter: draft.clock + 2 * YEAR_MS,
    store: 'My',
    ca: false,
    issuerThumbprint: ca.caThumbprint
  })
  ca.issued.push({
    serial,
    thumbprint,
    subject,
    template,
    requester: requester.name,
    issuedAt: draft.clock,
    revoked: false,
    revokedAt: null,
    reason: null
  })
  logEvent(draft, caServer.id, {
    level: 'information',
    source: 'CertificationAuthority',
    eventId: 4887,
    log: 'Sécurité',
    message: `Les services de certificats ont approuvé une demande de certificat et ont délivré un certificat : ${subject} (modèle ${template}, demandeur ${requester.name}).`
  })
  return thumbprint
}

/**
 * Demande d'un certificat à l'autorité d'entreprise du domaine (Get-Certificate, « Créer un
 * certificat de domaine » du Gestionnaire IIS). Renvoie l'empreinte du certificat délivré.
 */
export function requestCertificate(
  state: LabState,
  requesterId: string,
  input: { template: string; dnsNames?: string[] }
): EngineResult<string> {
  return transact(state, (draft) => {
    const requester = requireDevice(draft, requesterId)
    if (requester.kind !== 'server' && requester.kind !== 'client')
      raise('NotSupported', 'Seul un ordinateur peut demander un certificat.')
    const domain = requester.host.domain ? draft.domains[requester.host.domain] : undefined
    if (!domain)
      raise(
        'NotDomainMember',
        'L’inscription auprès d’une autorité d’entreprise exige un ordinateur membre du domaine.'
      )
    const reachable = enterpriseCas(draft as LabState, domain.name).filter((c) => c.server.powered)
    // Une autorité allumée dont CertSvc est arrêté ne délivre plus rien (v2.8, #222)
    const found = reachable.find((c) => serviceRunning(c.server, 'CertSvc'))
    if (!found && reachable[0]) raise('CertSvcStopped', certSvcStoppedMessage(reachable[0].ca.caName))
    if (!found)
      raise(
        'CaUnavailable',
        'Le serveur RPC n’est pas disponible : aucune autorité de certification d’entreprise n’est joignable dans le domaine.'
      )
    const caServer = draft.devices[found.server.id] as Draft<ServerDevice>
    const ca = ensureRoleState(caServer, ADCS_STATE)
    const short = templateName(input.template)
    if (!short || !ca.templates.includes(short))
      raise(
        'TemplateNotFound',
        `Le modèle de certificat « ${input.template} » n’est pas publié par ${ca.caName}.`
      )
    const kind = CERT_TEMPLATES[short]?.kind
    if (kind === 'user' || kind === 'ca')
      raise(
        'TemplateNotSupported',
        `Le modèle « ${CERT_TEMPLATES[short]?.display} » ne s’applique pas à un ordinateur.`
      )
    const fqdn = `${requester.name}.${domain.name}`.toLowerCase()
    const names =
      kind === 'web' ? (input.dnsNames ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n) : [fqdn]
    if (names.length === 0)
      raise('InvalidArgument', 'Le modèle Serveur Web exige au moins un nom DNS (nom commun).')
    return issue(draft, caServer, ca, requester, short, names)
  })
}

/** Révoque un certificat délivré (numéro de série). */
export function revokeCertificate(
  state: LabState,
  deviceId: string,
  serial: string,
  reason: (typeof REVOCATION_REASONS)[number] = 'Unspecified'
): EngineResult {
  return transact(state, (draft) => {
    const { server, ca } = requireConfigured(draft, deviceId)
    if (!serviceRunning(server, 'CertSvc')) raise('CertSvcStopped', certSvcStoppedMessage(ca.caName))
    const cert = ca.issued.find((c) => c.serial.toLowerCase() === serial.trim().toLowerCase())
    if (!cert) raise('CertificateNotFound', `Aucun certificat délivré ne porte le numéro de série ${serial}.`)
    if (cert.revoked) raise('AlreadyRevoked', 'Ce certificat est déjà révoqué.')
    cert.revoked = true
    cert.revokedAt = draft.clock
    cert.reason = reason
    return undefined
  })
}

/** Le certificat a-t-il été révoqué par l'autorité qui l'a délivré (liste de révocation) ? */
export function isRevoked(state: LabState, cert: Certificate): boolean {
  if (!cert.issuerThumbprint) return false
  for (const d of Object.values(state.devices)) {
    if (d.kind !== 'server') continue
    const ca = d.roles['adcs'] as AdcsServer | undefined
    if (ca?.caThumbprint === cert.issuerThumbprint)
      return ca.issued.some((c) => c.thumbprint === cert.thumbprint && c.revoked)
  }
  return false
}

/**
 * Côté client (stratégie ordinateur d'un membre du domaine) : certificats des autorités
 * d'entreprise ajoutés aux autorités racines de confiance ; inscription automatique d'un
 * certificat Ordinateur si la stratégie l'active.
 */
export function applyCertificateServicesClient(
  draft: Draft<LabState>,
  deviceId: string,
  domain: Domain
): void {
  const host = draft.devices[deviceId]
  if (!host || (host.kind !== 'server' && host.kind !== 'client')) return
  for (const { server } of enterpriseCas(draft as LabState, domain.name)) {
    const caServer = draft.devices[server.id] as Draft<ServerDevice>
    const ca = ensureRoleState(caServer, ADCS_STATE)
    const root = caServer.host.certificates.find((c) => c.thumbprint === ca.caThumbprint && c.store === 'My')
    if (root && !host.host.certificates.some((c) => c.store === 'Root' && c.thumbprint === root.thumbprint))
      addCertificate(draft, host.id, { ...root, store: 'Root' })
    const auto = host.host.policy.computer?.settings.autoEnrollment === 'Enabled'
    const enrolled = ca.issued.some(
      (c) => c.requester === host.name && c.template === 'Machine' && !c.revoked
    )
    if (
      auto &&
      caServer.powered &&
      serviceRunning(caServer, 'CertSvc') &&
      ca.templates.includes('Machine') &&
      !enrolled
    )
      issue(draft, caServer, ca, host as Draft<HostDevice>, 'Machine', [
        `${host.name}.${domain.name}`.toLowerCase()
      ])
  }
}

/** certutil -pulse : déclenche l'inscription automatique (et la distribution du certificat racine). */
export function pulseAutoEnrollment(state: LabState, deviceId: string): EngineResult {
  return transact(state, (draft) => {
    const host = requireDevice(draft, deviceId)
    const domain =
      (host.kind === 'server' || host.kind === 'client') && host.host.domain
        ? draft.domains[host.host.domain]
        : undefined
    if (domain) applyCertificateServicesClient(draft, deviceId, domain as Domain)
    return undefined
  })
}
