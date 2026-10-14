/**
 * netsh interface ipv4 (alias ip) : set address, set dnsservers (set dns), show config.
 *
 * Syntaxe d'après Microsoft Learn (netsh interface) :
 * https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/netsh-interface
 *   netsh interface ipv4 set address [name=]<string> [source=]dhcp|static [address=]<IPv4 address>[/<integer>]
 *                                    [mask=]<IPv4 mask> [gateway=]<IPv4 address>|none …
 *   netsh interface ipv4 set dnsservers [name=]<string> [source=]dhcp|static [address=]<IP address>|none …
 *   netsh interface ipv4 show config [name=]<string>
 * Paramètres nommés (name=…) ou positionnels, dans l'ordre de la syntaxe. L'alias « ip » et
 * l'abréviation « dns » ne figurent pas sur la page : à vérifier. Mise en page de show config :
 * à vérifier. Modifications par l'action de la commande nommée `net.setInterfaceIpv4`.
 */
import { effectiveIpv4 } from '../../net/addressing'
import { setInterfaceIpv4 } from '../../net/config'
import { networkAddress, prefixToMask } from '../../net/ipv4'
import type { NetInterface } from '../../model/schema'
import type { ExecContext } from '../context'

/** Valeurs nommées ou positionnelles selon l'ordre de la syntaxe Learn. */
function bind(args: string[], order: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  let position = 0
  for (const a of args) {
    const eq = a.indexOf('=')
    if (eq > 0) out[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1)
    else {
      while (position < order.length && out[order[position] as string] !== undefined) position++
      const key = order[position++]
      if (key) out[key] = a
    }
  }
  return out
}

function findInterface(ctx: ExecContext, name: string | undefined): NetInterface | null {
  if (!name) {
    ctx.write('Le paramètre name (nom ou index de l’interface) est obligatoire.', 'error')
    return null
  }
  const host = ctx.host
  const iface = host.interfaces.find(
    (i, index) => i.name.toLowerCase() === name.toLowerCase() || String(4 + index * 2) === name
  )
  if (!iface) ctx.write(`L’interface « ${name} » est introuvable.`, 'error')
  return iface ?? null
}

function apply(ctx: ExecContext, iface: NetInterface, input: Parameters<typeof setInterfaceIpv4>[3]): void {
  const r = setInterfaceIpv4(ctx.state, ctx.deviceId, iface.id, input)
  if (!r.ok) {
    ctx.write(r.error.message, 'error')
    return
  }
  ctx.state = r.state
  for (const w of r.value.warnings) ctx.warn(w)
}

function setAddress(ctx: ExecContext, args: string[]): void {
  const p = bind(args, ['name', 'source', 'address', 'mask', 'gateway', 'gwmetric'])
  const iface = findInterface(ctx, p['name'])
  if (!iface) return
  const source = (p['source'] ?? (p['address'] ? 'static' : '')).toLowerCase()
  if (source === 'dhcp') {
    apply(ctx, iface, { addressing: 'dhcp' })
    return
  }
  if (source !== 'static') {
    ctx.write('Le paramètre source doit valoir dhcp ou static.', 'error')
    return
  }
  let address = p['address'] ?? ''
  let mask = p['mask'] ?? ''
  const slash = address.indexOf('/')
  if (slash > 0) {
    mask = address.slice(slash + 1)
    address = address.slice(0, slash)
  }
  const gateway = (p['gateway'] ?? 'none').toLowerCase() === 'none' ? null : (p['gateway'] ?? null)
  apply(ctx, iface, {
    addressing: 'static',
    address,
    mask,
    gateway,
    dnsServers: iface.dnsMode === 'static' ? iface.dnsServers : []
  })
}

function setDns(ctx: ExecContext, args: string[]): void {
  const p = bind(args, ['name', 'source', 'address', 'register', 'validate'])
  const iface = findInterface(ctx, p['name'])
  if (!iface) return
  const source = (p['source'] ?? '').toLowerCase()
  const keep = {
    addressing: iface.addressing,
    address: iface.address,
    mask: iface.prefixLength === null ? null : String(iface.prefixLength),
    gateway: iface.gateway
  }
  if (source === 'dhcp') {
    if (iface.addressing === 'static') {
      ctx.write(
        'Une carte à adresse statique utilise des serveurs DNS statiques (source=dhcp impossible).',
        'error'
      )
      return
    }
    apply(ctx, iface, { ...keep, dnsMode: 'dhcp' })
    return
  }
  if (source !== 'static') {
    ctx.write('Le paramètre source doit valoir dhcp ou static.', 'error')
    return
  }
  const address = p['address'] ?? ''
  if (address === '') {
    ctx.write('Le paramètre address (adresse IP ou none) est obligatoire.', 'error')
    return
  }
  apply(ctx, iface, {
    ...keep,
    dnsMode: 'static',
    dnsServers: address.toLowerCase() === 'none' ? [] : [address]
  })
}

function showConfig(ctx: ExecContext, args: string[]): void {
  const p = bind(args, ['name'])
  const host = ctx.host
  const list = p['name'] ? [findInterface(ctx, p['name'])] : host.interfaces
  const row = (label: string, value: string) => `    ${label.padEnd(42)}${value}`
  const lines: string[] = []
  for (const iface of list) {
    if (!iface) return
    const eff = effectiveIpv4(iface)
    lines.push('', `Configuration pour l’interface « ${iface.name} »`)
    lines.push(row('DHCP activé :', iface.addressing === 'dhcp' ? 'Oui' : 'Non'))
    if (eff) {
      lines.push(row('Adresse IP :', eff.address))
      lines.push(
        row(
          'Préfixe de sous-réseau :',
          `${networkAddress(eff.address, eff.prefixLength)}/${eff.prefixLength} (masque ${prefixToMask(eff.prefixLength)})`
        )
      )
      if (eff.gateway) lines.push(row('Passerelle par défaut :', eff.gateway))
    }
    const dns = eff?.dnsServers ?? iface.dnsServers
    const label =
      iface.dnsMode === 'static'
        ? 'Serveurs DNS configurés statiquement :'
        : 'Serveurs DNS configurés via DHCP :'
    lines.push(row(label, dns[0] ?? 'Aucun'))
    for (const extra of dns.slice(1)) lines.push(`    ${' '.repeat(42)}${extra}`)
  }
  ctx.writeLines([...lines, ''])
}

/** netsh interface … ; renvoie false si le contexte n'est pas pris en charge. */
export function netshInterface(ctx: ExecContext, args: string[]): void {
  const [family = '', verb = '', noun = '', ...rest] = args
  const fam = family.toLowerCase()
  if (fam !== 'ipv4' && fam !== 'ip') {
    ctx.write(
      `Le contexte « netsh interface ${family} » n’est pas simulé dans ServerLab (interface ipv4 seulement).`,
      'error'
    )
    return
  }
  const v = verb.toLowerCase()
  const n = noun.toLowerCase()
  if (v === 'set' && n === 'address') return setAddress(ctx, rest)
  if (v === 'set' && (n === 'dnsservers' || n === 'dnsserver' || n === 'dns')) return setDns(ctx, rest)
  if (v === 'show' && n === 'config') return showConfig(ctx, rest)
  ctx.write(
    `La commande « netsh interface ${family} ${verb} ${noun} » n’est pas simulée dans ServerLab (set address, set dnsservers, show config).`,
    'error'
  )
}
