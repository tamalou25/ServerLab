/**
 * netsh, contexte advfirewall : état des profils et règles du pare-feu.
 */
import type { FirewallProfileName, FirewallRule } from '../../model/schema'
import { FIREWALL_PROFILES } from '../../model/schema'
import {
  activeProfile,
  effectiveRules,
  newFirewallRule,
  PROFILE_LABELS,
  profileEnabled,
  removeFirewallRule,
  setFirewallProfile,
  setFirewallRuleEnabled,
  type RuleSelector
} from '../../services/firewall'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from './types'
import { netshInterface } from './netsh-interface'

const SEPARATOR = '-'.repeat(70)

/** Ligne « libellé    valeur » des sorties de netsh. */
const row = (label: string, value: string) => `${label.padEnd(38)}${value}`

/** Options « clé=valeur » d'une commande netsh (clés en minuscules). */
function options(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of args) {
    const at = a.indexOf('=')
    if (at > 0) out[a.slice(0, at).toLowerCase()] = a.slice(at + 1)
  }
  return out
}

/** Profils désignés : allprofiles, currentprofile, domainprofile, privateprofile, publicprofile. */
function profilesOf(ctx: ExecContext, word: string): FirewallProfileName[] | null {
  switch (word.toLowerCase()) {
    case 'allprofiles':
      return [...FIREWALL_PROFILES]
    case 'currentprofile':
      return [activeProfile(ctx.host)]
    case 'domainprofile':
      return ['Domain']
    case 'privateprofile':
      return ['Private']
    case 'publicprofile':
      return ['Public']
    default:
      return null
  }
}

function fail(ctx: ExecContext, message: string): void {
  ctx.write(message, 'error')
}

function showProfiles(ctx: ExecContext, profiles: FirewallProfileName[]): void {
  for (const p of profiles) {
    const settings = ctx.host.host.firewall.profiles[p]
    ctx.writeLines([
      `Paramètres Profil ${PROFILE_LABELS[p].toLowerCase()} :`,
      SEPARATOR,
      row('État', profileEnabled(ctx.host, p) ? 'ACTIF' : 'INACTIF'),
      row('Stratégie de pare-feu', `${settings.defaultInbound}Inbound,${settings.defaultOutbound}Outbound`),
      ''
    ])
  }
  ctx.write('Ok.')
}

const YES_NO = (v: boolean) => (v ? 'Oui' : 'Non')

function showRule(ctx: ExecContext, rule: FirewallRule): void {
  const profiles =
    rule.profiles.length === 0
      ? 'Domaine,Privé,Public'
      : rule.profiles.map((p) => PROFILE_LABELS[p]).join(',')
  ctx.writeLines([
    '',
    row('Nom de la règle :', rule.displayName),
    SEPARATOR,
    row('Activé :', YES_NO(rule.enabled)),
    row('Direction :', rule.direction === 'Inbound' ? 'Entrée' : 'Sortie'),
    row('Profils :', profiles),
    row('Groupement :', rule.group),
    row('LocalIP :', 'Tout'),
    row('RemoteIP :', rule.remoteAddresses.join(',') || 'Tout'),
    row('Protocole :', rule.protocol === 'Any' ? 'Tout' : rule.protocol),
    ...(rule.protocol === 'TCP' || rule.protocol === 'UDP'
      ? [row('LocalPort :', rule.localPorts.join(',') || 'Tout'), row('RemotePort :', 'Tout')]
      : []),
    row('Action :', rule.action === 'Allow' ? 'Autoriser' : 'Bloquer')
  ])
}

/** Sélecteur name= ou group= d'une commande « firewall … rule ». */
function selectorOf(opts: Record<string, string>): RuleSelector | null {
  if (opts['name'] && opts['name'].toLowerCase() !== 'all') return { displayName: opts['name'] }
  if (opts['group']) return { group: opts['group'] }
  return null
}

const NO_MATCH = 'Aucune règle ne correspond aux critères spécifiés.'

function firewallContext(ctx: ExecContext, args: string[]): void {
  const [verb = '', noun = ''] = args.map((a) => a.toLowerCase())
  const opts = options(args.slice(2))
  if (noun !== 'rule') {
    fail(ctx, `La commande suivante est introuvable : advfirewall firewall ${args.join(' ')}.`)
    return
  }
  if (verb === 'show') {
    const all = (opts['name'] ?? '').toLowerCase() === 'all'
    const selector = selectorOf(opts)
    const rules = effectiveRules(ctx.host).filter(
      (r) =>
        all ||
        (selector?.displayName && r.displayName.toLowerCase() === selector.displayName.toLowerCase()) ||
        (selector?.group && r.group.toLowerCase() === selector.group.toLowerCase())
    )
    if (rules.length === 0) {
      fail(ctx, NO_MATCH)
      return
    }
    for (const r of rules) showRule(ctx, r)
    ctx.write('Ok.')
    return
  }
  if (verb === 'add') {
    const dir = (opts['dir'] ?? '').toLowerCase()
    const action = (opts['action'] ?? '').toLowerCase()
    if (!opts['name'] || (dir !== 'in' && dir !== 'out') || !['allow', 'block'].includes(action)) {
      fail(
        ctx,
        'Les paramètres name, dir (in|out) et action (allow|block) sont obligatoires.\nUtilisation : add rule name=<chaîne> dir=in|out action=allow|block [protocol=TCP|UDP|ICMPv4|any] [localport=<port>] [remoteip=<adresse>] [profile=public|private|domain|any]'
      )
      return
    }
    const protocol = ({ tcp: 'TCP', udp: 'UDP', icmpv4: 'ICMPv4', any: 'Any' } as const)[
      (opts['protocol'] ?? 'any').toLowerCase() as 'tcp'
    ]
    if (!protocol) {
      fail(ctx, `Une valeur spécifiée n’est pas valide : protocol=${opts['protocol']}.`)
      return
    }
    const ports = (opts['localport'] ?? '')
      .split(',')
      .filter((p) => p && p.toLowerCase() !== 'any')
      .map(Number)
    const profiles = (opts['profile'] ?? 'any')
      .split(',')
      .map((p) => FIREWALL_PROFILES.find((x) => x.toLowerCase() === p.trim().toLowerCase()))
      .filter((p): p is FirewallProfileName => !!p)
    try {
      ctx.apply(
        newFirewallRule(ctx.state, ctx.deviceId, {
          displayName: opts['name'],
          direction: dir === 'in' ? 'Inbound' : 'Outbound',
          action: action === 'allow' ? 'Allow' : 'Block',
          protocol,
          localPorts: ports,
          remoteAddresses: (opts['remoteip'] ?? '').split(',').filter((a) => a && a.toLowerCase() !== 'any'),
          profiles,
          enabled: (opts['enable'] ?? 'yes').toLowerCase() !== 'no'
        })
      )
    } catch (e) {
      if (e instanceof CommandFailure) {
        fail(ctx, e.message)
        return
      }
      throw e
    }
    ctx.write('Ok.')
    return
  }
  const selector = selectorOf(opts)
  if (!selector) {
    fail(ctx, 'Indiquez la règle : name=<chaîne> ou group=<chaîne>.')
    return
  }
  try {
    if (verb === 'delete') {
      const count = ctx.apply(removeFirewallRule(ctx.state, ctx.deviceId, selector))
      ctx.writeLines(['', `${count} règle(s) supprimée(s).`, 'Ok.'])
      return
    }
    if (verb === 'set') {
      const enable = (
        options(args.slice(args.findIndex((a) => a.toLowerCase() === 'new') + 1))['enable'] ?? ''
      ).toLowerCase()
      if (enable !== 'yes' && enable !== 'no') {
        fail(ctx, 'Utilisation : set rule name=<chaîne>|group=<chaîne> new enable=yes|no')
        return
      }
      const count = ctx.apply(setFirewallRuleEnabled(ctx.state, ctx.deviceId, selector, enable === 'yes'))
      ctx.writeLines(['', `${count} règle(s) mise(s) à jour.`, 'Ok.'])
      return
    }
  } catch (e) {
    if (e instanceof CommandFailure) {
      fail(ctx, e.code === 'RuleNotFound' ? NO_MATCH : e.message)
      return
    }
    throw e
  }
  fail(ctx, `La commande suivante est introuvable : advfirewall firewall ${args.join(' ')}.`)
}

export const netshTool: ToolDef = {
  name: 'netsh',
  synopsis: 'Configure le pare-feu (advfirewall) et l’adressage IPv4 (interface ipv4).',
  switches: ['advfirewall', 'interface', 'ipv4', 'ip'],
  run(ctx, args) {
    const [context = '', verb = '', target = '', ...rest] = args
    if (context.toLowerCase() === 'interface' || context.toLowerCase() === 'int') {
      netshInterface(ctx, args.slice(1))
      return
    }
    if (context.toLowerCase() !== 'advfirewall') {
      fail(
        ctx,
        `La commande suivante est introuvable : ${args.join(' ')}.\nLe simulateur ne prend en charge que les contextes « netsh advfirewall » et « netsh interface ipv4 ».`
      )
      return
    }
    if (verb.toLowerCase() === 'firewall') {
      firewallContext(ctx, args.slice(2))
      return
    }
    const profiles = profilesOf(ctx, target)
    if (verb.toLowerCase() === 'show' && profiles) {
      showProfiles(ctx, profiles)
      return
    }
    if (verb.toLowerCase() === 'set' && profiles) {
      const [setting = '', value = ''] = rest.map((r) => r.toLowerCase())
      if (setting === 'state' && (value === 'on' || value === 'off')) {
        ctx.apply(setFirewallProfile(ctx.state, ctx.deviceId, profiles, { enabled: value === 'on' }))
        ctx.write('Ok.')
        return
      }
      const policy = /^(block|allow)inbound,(block|allow)outbound$/.exec(value)
      if (setting === 'firewallpolicy' && policy) {
        const cap = (v: string) => (v === 'block' ? 'Block' : 'Allow')
        ctx.apply(
          setFirewallProfile(ctx.state, ctx.deviceId, profiles, {
            defaultInbound: cap(policy[1] ?? ''),
            defaultOutbound: cap(policy[2] ?? '')
          })
        )
        ctx.write('Ok.')
        return
      }
    }
    fail(ctx, `La commande suivante est introuvable : advfirewall ${args.slice(1).join(' ')}.`)
  }
}
