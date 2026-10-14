/**
 * Outils réseau : ipconfig, ping, tracert.
 */
import { formatLongDate } from '../../core/clock'
import { effectiveIpv4 } from '../../net/addressing'
import { ping, tracert } from '../../net/diagnostics'
import { ipConflicts } from '../../net/conflicts'
import { prefixToMask } from '../../net/ipv4'
import { carrierUp } from '../../net/segment'
import type { NetInterface } from '../../model/schema'
import { dhcpRelease, dhcpRenew } from '../../roles/dhcp/client'
import { firstAddress, resolveName } from '../../roles/dns/resolver'
import { registerDnsAction } from '../../roles/adds/registration'
import { currentUserGroups } from '../../roles/adds/cmdlets'
import type { ExecContext } from '../context'
import type { ToolDef } from './types'

/** Ligne « libellé . . . : valeur » au format d'ipconfig. */
function field(label: string, value: string): string {
  const dots =
    label.length >= 38
      ? ' '
      : ` ${'. '.repeat(Math.max(0, Math.floor((38 - label.length) / 2)))}`.slice(0, 39 - label.length)
  return `   ${label}${dots}: ${value}`
}

function connectionSuffix(ctx: ExecContext, iface: NetInterface): string {
  if (iface.addressing === 'dhcp' && iface.dhcpLease?.dnsSuffix) return iface.dhcpLease.dnsSuffix
  void ctx
  return ''
}

/** Résout la cible d'un ping/tracert : adresse IP ou nom (requête DNS tracée). */
export function resolveForTool(ctx: ExecContext, target: string): { ip: string; display: string } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return { ip: target, display: target }
  const resolution = resolveName(ctx.state, ctx.deviceId, target)
  ctx.addTrace(resolution.trace)
  const ip = firstAddress(resolution)
  return ip ? { ip, display: `${resolution.fqdn} [${ip}]` } : null
}

function ipconfigAdapter(ctx: ExecContext, iface: NetInterface, all: boolean): string[] {
  const device = ctx.host
  const lines = ['', `Carte Ethernet ${iface.name} :`, '']
  const connected = iface.enabled && carrierUp(ctx.state, { deviceId: device.id, ifaceId: iface.id })
  if (!connected) {
    lines.push(field('Statut du média', 'Média déconnecté'))
    lines.push(field('Suffixe DNS propre à la connexion', ''))
    if (all) {
      lines.push(field('Description', 'Carte réseau Ethernet virtuelle'))
      lines.push(field('Adresse physique', iface.mac))
      lines.push(field('DHCP activé', iface.addressing === 'dhcp' ? 'Oui' : 'Non'))
      lines.push(field('Configuration automatique activée', 'Oui'))
    }
    return lines
  }
  const eff = effectiveIpv4(iface)
  const conflict = ipConflicts(ctx.state).has(`${device.id}/${iface.id}`)
  lines.push(field('Suffixe DNS propre à la connexion', connectionSuffix(ctx, iface)))
  if (all) {
    lines.push(field('Description', 'Carte réseau Ethernet virtuelle'))
    lines.push(field('Adresse physique', iface.mac))
    lines.push(field('DHCP activé', iface.addressing === 'dhcp' ? 'Oui' : 'Non'))
    lines.push(field('Configuration automatique activée', 'Oui'))
  }
  if (eff) {
    const state = conflict ? '(Dupliqué)' : all ? '(préféré)' : ''
    const label = eff.source === 'apipa' ? 'Adresse d’autoconfiguration IPv4' : 'Adresse IPv4'
    lines.push(field(label, `${eff.address}${state}`))
    lines.push(field('Masque de sous-réseau', prefixToMask(eff.prefixLength)))
    if (all && eff.source === 'dhcp' && iface.dhcpLease) {
      lines.push(field('Bail obtenu', formatLongDate(iface.dhcpLease.obtainedAt)))
      lines.push(field('Bail expirant', formatLongDate(iface.dhcpLease.expiresAt)))
    }
    lines.push(field('Passerelle par défaut', eff.gateway ?? ''))
    if (all) {
      if (eff.source === 'dhcp' && iface.dhcpLease)
        lines.push(field('Serveur DHCP', iface.dhcpLease.serverId))
      const dns = eff.dnsServers
      lines.push(field('Serveurs DNS', dns[0] ?? ''))
      for (const extra of dns.slice(1)) lines.push(`${' '.repeat(44)}${extra}`)
      lines.push(field('NetBIOS sur Tcpip', 'Activé'))
    }
  } else {
    lines.push(field('Passerelle par défaut', ''))
  }
  return lines
}

const IPCONFIG_HELP = [
  '',
  'UTILISATION :',
  '    ipconfig [/allcompartments] [/? | /all |',
  '                                 /renew [carte] | /release [carte] |',
  '                                 /flushdns | /displaydns | /registerdns]',
  '',
  'Options :',
  '    /?               Afficher ce message d’aide',
  '    /all             Afficher toutes les informations de configuration.',
  '    /release         Libérer l’adresse IPv4 de la carte spécifiée.',
  '    /renew           Renouveler l’adresse IPv4 de la carte spécifiée.',
  '    /flushdns        Vider le cache de résolution DNS.',
  '    /registerdns     Actualiser tous les baux DHCP et réinscrire les noms DNS',
  ''
]

export const ipconfigTool: ToolDef = {
  name: 'ipconfig',
  handlesHelp: true,
  synopsis: 'Affiche la configuration IP et gère les baux DHCP.',
  switches: ['/all', '/release', '/renew', '/flushdns', '/registerdns', '/?'],
  run(ctx, args) {
    const opt = (args[0] ?? '').toLowerCase().replace(/^-/, '/')
    const device = ctx.host
    const adapters = device.interfaces.filter((i) => i.l3)
    if (opt === '/?') {
      ctx.writeLines(IPCONFIG_HELP)
      return
    }
    if (opt === '' || opt === '/all') {
      const lines = ['', 'Configuration IP', '']
      if (opt === '/all') {
        const suffix = device.host.domain ?? ''
        lines.push(`   Nom de l’hôte . . . . . . . . . . : ${device.name}`)
        lines.push(`   Suffixe DNS principal . . . . . . : ${suffix}`)
        lines.push('   Type de noeud. . . . . . . . . .  : Hybride')
        lines.push('   Routage IP activé . . . . . . . . : Non')
        lines.push('   Proxy WINS activé . . . . . . . . : Non')
        if (suffix) lines.push(`   Liste de recherche du suffixe DNS.: ${suffix}`)
      }
      for (const iface of adapters) lines.push(...ipconfigAdapter(ctx, iface, opt === '/all'))
      ctx.writeLines(lines)
      return
    }
    if (opt === '/release' || opt === '/renew') {
      const filter = args[1]?.toLowerCase()
      const targets = adapters.filter((i) => !filter || i.name.toLowerCase() === filter.replace(/"/g, ''))
      if (filter && targets.length === 0) {
        ctx.write(
          `L’opération n’a pas pu être effectuée : aucune carte ne correspond au nom « ${args[1]} ».`,
          'error'
        )
        return
      }
      ctx.write('')
      ctx.write('Configuration IP')
      ctx.write('')
      for (const iface of targets) {
        const connected = iface.enabled && carrierUp(ctx.state, { deviceId: device.id, ifaceId: iface.id })
        if (!connected) {
          ctx.write(
            `Aucune opération ne peut être effectuée sur ${iface.name} lorsque son média est déconnecté.`
          )
          continue
        }
        if (iface.addressing !== 'dhcp') {
          ctx.write(`L’adaptateur ${iface.name} n’est pas activé pour DHCP.`)
          continue
        }
        if (opt === '/release') {
          const op = dhcpRelease(ctx.state, device.id, iface.id)
          ctx.state = op.state
          ctx.addTrace(op.trace)
        } else {
          const op = dhcpRenew(ctx.state, device.id, iface.id)
          ctx.state = op.state
          ctx.addTrace(op.trace)
          if (op.outcome === 'failed')
            ctx.write(
              `Une erreur s’est produite lors du renouvellement de l’interface ${iface.name} : ${op.message.charAt(0).toLowerCase()}${op.message.slice(1)}`,
              'error'
            )
        }
      }
      // Affiche la configuration résultante
      for (const iface of ctx.host.interfaces.filter((i) => i.l3))
        ctx.writeLines(ipconfigAdapter(ctx, iface, false))
      return
    }
    if (opt === '/flushdns') {
      ctx.writeLines(['', 'Configuration IP', '', 'Cache de résolution DNS vidé.'])
      return
    }
    if (opt === '/registerdns') {
      ctx.apply(registerDnsAction(ctx.state, device.id))
      ctx.writeLines([
        '',
        'Configuration IP',
        '',
        'L’inscription des enregistrements de ressources DNS pour toutes les cartes de cet ordinateur a été initiée. Les erreurs éventuelles seront signalées dans l’Observateur d’événements dans 15 minutes.'
      ])
      return
    }
    ctx.write(`Erreur : option « ${args[0]} » non reconnue.`, 'error')
    ctx.writeLines(IPCONFIG_HELP)
  }
}

export const pingTool: ToolDef = {
  name: 'ping',
  handlesHelp: true,
  synopsis: 'Teste la connectivité avec un hôte (requêtes d’écho ICMP).',
  switches: ['-n', '-l', '-i', '-t', '/?'],
  run(ctx, args) {
    let count = 4
    let size = 32
    let ttl: number | undefined
    let target: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = (args[i] as string).toLowerCase()
      if (a === '-n' || a === '/n') count = Number(args[++i])
      else if (a === '-l' || a === '/l') size = Number(args[++i])
      else if (a === '-i' || a === '/i') ttl = Number(args[++i])
      else if (a === '-t' || a === '/t') count = 4
      else if (a === '/?' || a === '-?') {
        ctx.writeLines([
          '',
          'Utilisation : ping [-t] [-n nombre] [-l taille] [-i TTL] nom_cible',
          '',
          'Options :',
          '    -t             Envoie des requêtes Ping jusqu’à interruption (limité à 4 dans le simulateur).',
          '    -n nombre      Nombre de demandes d’écho à envoyer.',
          '    -l taille      Taille du tampon d’envoi.',
          '    -i TTL         Durée de vie.',
          ''
        ])
        return
      } else target = args[i] as string
    }
    if (!target) {
      ctx.write('Le nom de la cible doit être indiqué.', 'error')
      return
    }
    if (!Number.isInteger(count) || count < 1) {
      ctx.write(`Valeur incorrecte pour l’option -n, plage valide comprise entre 1 et 4294967295.`, 'error')
      return
    }
    const resolved = resolveForTool(ctx, target)
    if (!resolved) {
      ctx.write(`La requête Ping n’a pas pu trouver l’hôte ${target}. Vérifiez le nom et essayez à nouveau.`)
      return
    }
    const result = ping(ctx.state, ctx.deviceId, resolved.ip, {
      count: Math.min(count, 20),
      size,
      ...(ttl ? { ttl } : {})
    })
    if (!result.ok) {
      ctx.write(result.error.message)
      return
    }
    const lines = [...result.value.lines]
    if (resolved.display !== resolved.ip)
      lines[0] = `Envoi d’une requête 'ping' sur ${resolved.display} avec ${size} octets de données :`
    ctx.write('')
    ctx.writeLines(lines)
    ctx.addTrace(result.value.trace)
  }
}

export const tracertTool: ToolDef = {
  name: 'tracert',
  synopsis: 'Détermine l’itinéraire vers une destination.',
  switches: ['-d', '-h', '/?'],
  run(ctx, args) {
    let maxHops = 30
    let target: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = (args[i] as string).toLowerCase()
      if (a === '-d' || a === '/d') continue
      if (a === '-h' || a === '/h') maxHops = Number(args[++i]) || 30
      else target = args[i] as string
    }
    if (!target) {
      ctx.writeLines(['', 'Utilisation : tracert [-d] [-h nombre_maximal_de_sauts] nom_cible', ''])
      return
    }
    const resolved = resolveForTool(ctx, target)
    if (!resolved) {
      ctx.write(`Impossible de résoudre le nom système cible ${target}.`)
      return
    }
    const result = tracert(ctx.state, ctx.deviceId, resolved.ip, maxHops)
    if (!result.ok) {
      ctx.write(result.error.message)
      return
    }
    const lines = [...result.value.lines]
    if (resolved.display !== resolved.ip)
      lines[0] = `Détermination de l’itinéraire vers ${resolved.display} avec un maximum de ${maxHops} sauts.`
    ctx.write('')
    ctx.writeLines(lines)
    ctx.addTrace(result.value.trace)
  }
}

export const hostnameTool: ToolDef = {
  name: 'hostname',
  synopsis: 'Affiche le nom de l’ordinateur.',
  run(ctx) {
    ctx.write(ctx.host.name)
  }
}

export const whoamiTool: ToolDef = {
  name: 'whoami',
  synopsis: 'Affiche l’utilisateur connecté.',
  switches: ['/groups', '/upn', '/?'],
  run(ctx, args) {
    const user = ctx.user
    const prefix = (user.domain ?? ctx.host.name).toLowerCase()
    const opt = (args[0] ?? '').toLowerCase()
    if (opt === '/groups') {
      const groups = currentUserGroups(ctx)
      ctx.writeLines([
        '',
        'INFORMATIONS DE GROUPE',
        '----------------------',
        '',
        `${'Nom du groupe'.padEnd(52)}Type`,
        `${'='.repeat(51)} ==============`
      ])
      for (const g of groups) ctx.write(`${g.padEnd(52)}Groupe`)
      if (groups.length === 0) ctx.write(`${'Tout le monde'.padEnd(52)}Groupe bien connu`)
      ctx.write('')
      return
    }
    if (opt === '/upn') {
      if (!user.domain || !ctx.host.host.domain) {
        ctx.write(
          'ERREUR : impossible d’obtenir le nom d’utilisateur principal (UPN) car l’utilisateur actuel n’est pas un utilisateur de domaine.',
          'error'
        )
        return
      }
      ctx.write(`${user.name.toLowerCase()}@${ctx.host.host.domain}`)
      return
    }
    ctx.write(`${prefix}\\${user.name.toLowerCase()}`)
  }
}
