/**
 * Accès à l'interface web d'administration (webConfigurator) d'un pare-feu pfSense simulé (v2.10, #246).
 *
 * - Un poste joint le pare-feu comme n'importe quel serveur : résolution du nom, puis échange TCP routé
 *   et tracé qui traverse le filtre du pare-feu. Depuis le LAN, la règle d'anti-verrouillage (443, 80, 22)
 *   autorise l'accès ; depuis le WAN ou la DMZ, les règles de l'utilisateur décident (refus par défaut).
 * - L'échange alimente le journal et la table d'états du pare-feu (effets durables de la trace).
 * - L'authentification (page de connexion) est un contrôle pur : le compte d'usine est admin / pfsense.
 *
 * Voir docs/fidelite.md (P-40 et suivants) pour les points à vérifier.
 */
import { produce } from 'immer'
import { fail, type EngineResult } from '../../core/result'
import type { LabState } from '../../model/schema'
import { PF_IFACE_KEYS, type PfIfaceKey } from '../../model/firewall'
import { firstAddress, resolveName } from '../dns/resolver'
import { CONNECT_FAILED, parseHttpUrl } from './http'
import { serverExchange } from '../adds/locator'
import { concatTraces, type PacketTrace } from '../../sim/trace'
import { effectiveIpv4 } from '../../net/addressing'
import { applyPfEffects, nicOf, type PfDevice } from '../../net/pf'

/** Compte d'usine du webConfigurator (docs Netgate, _Initial Configuration_ ; P-40). */
export const PF_ADMIN_USER = 'admin'
export const PF_DEFAULT_PASSWORD = 'pfsense'

/** Message affiché par la page de connexion après un échec (P-41). */
export const PF_LOGIN_ERROR = 'Username or Password incorrect'

/** Avertissement du navigateur : le certificat du webConfigurator est auto-signé (P-43). */
export const PF_CERT_WARNING =
  'Le certificat de sécurité présenté par ce site n’a pas été émis par une autorité de certification approuvée.'

/** Ports sur lesquels le webConfigurator écoute : HTTPS, et HTTP qui redirige vers HTTPS (P-42). */
export const PF_WEB_PORTS = [443, 80] as const

export type PfWebResult =
  /** L'adresse ne désigne pas un pare-feu pfSense : le navigateur poursuit avec le client HTTP ordinaire. */
  | { kind: 'not-firewall' }
  | { kind: 'failure'; message: string; url: string; trace: PacketTrace | null }
  | {
      kind: 'response'
      firewallId: string
      /** Adresse affichée (après redirection HTTP → HTTPS). */
      url: string
      /** Une redirection HTTP → HTTPS a eu lieu. */
      redirected: boolean
      certificateWarning: string | null
      /** Interface du pare-feu qui a reçu la connexion (WAN, LAN, OPTx). */
      via: PfIfaceKey | null
      trace: PacketTrace
    }

/** Pare-feu sous tension dont une interface porte cette adresse. */
function firewallAt(state: LabState, ip: string): PfDevice | null {
  for (const d of Object.values(state.devices))
    if (d.kind === 'firewall' && d.powered && d.interfaces.some((i) => effectiveIpv4(i)?.address === ip))
      return d
  return null
}

/**
 * Requête GET d'un poste vers le webConfigurator. Les effets durables (journal, états) sont appliqués à
 * l'état renvoyé ; l'état est inchangé si l'adresse ne désigne pas un pare-feu.
 */
export function pfWebRequest(state: LabState, clientId: string, urlText: string): EngineResult<PfWebResult> {
  const client = state.devices[clientId]
  const url = parseHttpUrl(urlText)
  if (!client || (client.kind !== 'server' && client.kind !== 'client') || !url)
    return { ok: true, state, value: { kind: 'not-firewall' } }

  let ip: string | null
  let resolution: PacketTrace | null = null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.host)) ip = url.host
  else {
    const r = resolveName(state, clientId, url.host)
    ip = firstAddress(r)
    resolution = r.trace
  }
  const firewall = ip ? firewallAt(state, ip) : null
  if (!ip || !firewall) return { ok: true, state, value: { kind: 'not-firewall' } }

  const https = url.protocol === 'https'
  const display = `${url.protocol}://${url.host}${url.port === (https ? 443 : 80) ? '' : `:${url.port}`}/${url.path}`
  const exchange = serverExchange(state, clientId, ip, {
    protocol: 'HTTP',
    port: url.port,
    request: https ? `TLS ClientHello (${url.host})` : `GET /${url.path} HTTP/1.1`,
    reply: https ? 'TLS ServerHello, Certificate' : 'HTTP/1.1 302 Found (https)',
    fields: [['Hôte', url.host]]
  })
  const trace = resolution ? concatTraces(`HTTP ${url.host}`, [resolution, exchange.trace]) : exchange.trace
  // Les paquets refusés ou autorisés par le filtre sont journalisés, que la page s'affiche ou non
  const next = produce(state, (draft) => applyPfEffects(draft, trace.effects ?? []))
  const listening = (PF_WEB_PORTS as readonly number[]).includes(url.port)
  if (!exchange.ok || !listening)
    return { ok: true, state: next, value: { kind: 'failure', message: CONNECT_FAILED, url: display, trace } }

  const via = PF_IFACE_KEYS.find((k) => {
    const nic = nicOf(firewall, k)
    return nic ? effectiveIpv4(nic)?.address === ip : false
  })
  return {
    ok: true,
    state: next,
    value: {
      kind: 'response',
      firewallId: firewall.id,
      url: `https://${url.host}${url.port === 443 || url.port === 80 ? '' : `:${url.port}`}/${url.path}`,
      redirected: !https,
      certificateWarning: PF_CERT_WARNING,
      via: via ?? null,
      trace
    }
  }
}

/** Contrôle l'identifiant et le mot de passe saisis sur la page de connexion (aucune modification d'état). */
export function pfAuthenticate(
  state: LabState,
  firewallId: string,
  user: string,
  password: string
): EngineResult<undefined> {
  const device = state.devices[firewallId]
  if (!device || device.kind !== 'firewall')
    return fail('NotAFirewall', 'Cet équipement n’est pas un pare-feu pfSense.')
  if (user.trim().toLowerCase() !== PF_ADMIN_USER || password !== PF_DEFAULT_PASSWORD)
    return fail('BadCredentials', PF_LOGIN_ERROR)
  return { ok: true, state, value: undefined }
}
