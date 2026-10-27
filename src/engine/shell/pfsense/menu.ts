/**
 * Menu numéroté de la console pfSense (v2.10, #247), transcrit des scripts de pfSense CE 2.7.2
 * (src/etc/rc.initial, rc.banner, rc.initial.setports, config.console.inc, rc.initial.setlanip,
 * rc.initial.password, rc.initial.defaults, rc.initial.reboot, rc.initial.ping). Les textes sont ceux des
 * scripts, en anglais comme sur l'équipement. Chaque option appelle l'action pure du moteur
 * (`net/pf-console.ts`, commandes nommées `pf.*`) : la console ne contient aucune logique métier.
 */
import { broadcastInt, inNetwork, isIpv4, networkAddress, parseIpv4 } from '../../net/ipv4'
import {
  assignPfInterfaces,
  factoryResetPf,
  rebootPf,
  resetPfAdminPassword,
  setPfInterfaceFromConsole
} from '../../net/pf-console'
import { effectiveIpv4 } from '../../net/addressing'
import { assignmentOfNic, nicOf, type PfDevice } from '../../net/pf'
import { PF_DEFAULT_ADMIN_PASSWORD, type PfIfaceKey } from '../../model/firewall'
import { CommandFailure, type ExecContext } from '../context'
import { unsimulatedOptionMessage } from '../unsimulated'
import { filterLogLines } from './filterlog'
import { bsdMac, bsdPing, EM_DRIVER_DESCRIPTION, hasCarrier, PFSENSE_RELEASE } from './nettools'
import { padEnd, type PfTerm } from './term'

const PRODUCT = 'pfSense'

/** Suffixe de l'invite du menu (rc.initial : `read -p "Enter an option: "`). */
export const MENU_PROMPT = 'Enter an option: '

function firewall(ctx: ExecContext): PfDevice {
  const d = ctx.device
  if (d.kind !== 'firewall') throw new CommandFailure('Console indisponible sur cet équipement.', 'NotSupported')
  return d
}

// --- Bannière et menu (rc.banner puis rc.initial) -----------------------------------------------

/** Bannière : une ligne par interface affectée (rc.banner, sans la ligne « Netgate Device ID »). */
export function bannerLines(device: PfDevice): string[] {
  const lines = [`*** Welcome to ${PRODUCT} ${PFSENSE_RELEASE} (amd64) on ${device.pf.hostname} ***`]
  // Une ligne vide après l'en-tête (le « \n » qui précède la première interface), puis une ligne par interface
  device.pf.assignments.forEach((a) => {
    const nic = nicOf(device, a.key)
    if (!nic) return
    if (lines.length === 1) lines.push('')
    const eff = effectiveIpv4(nic)
    lines.push(
      ` ${padEnd(`${a.descr} (${a.key})`, 15)} -> ${padEnd(nic.name, 10)} -> ${eff ? `v4: ${eff.address}/${eff.prefixLength}` : ''}`
    )
  })
  return lines
}

/** Bannière puis menu, tels qu'affichés avant l'invite « Enter an option: ». */
export function menuScreen(device: PfDevice): string[] {
  return [
    ...bannerLines(device),
    '',
    ' 0) Logout (SSH only)                  9) pfTop',
    ' 1) Assign Interfaces                 10) Filter Logs',
    ' 2) Set interface(s) IP address       11) Restart webConfigurator',
    ` 3) Reset webConfigurator password    12) PHP shell + ${PRODUCT} tools`,
    ' 4) Reset to factory defaults         13) Update from console',
    ' 5) Reboot system                     14) Enable Secure Shell (sshd)',
    ' 6) Halt system                       15) Restore recent configuration',
    ' 7) Ping host                         16) Restart PHP-FPM',
    ' 8) Shell',
    ''
  ]
}

// --- Saisies communes ----------------------------------------------------------------------------

/** `console_prompt_for_yn` de rc.initial.setlanip : redemande tant que la réponse n'est pas y/yes/n/no. */
function askYesNo(t: PfTerm, text: string): boolean {
  for (;;) {
    t.echo(`\n${text} (y/n) `)
    const answer = t.read().trim().toLowerCase()
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
  }
}

const refuse = (t: PfTerm, tool: string, what: string): void => {
  t.note(unsimulatedOptionMessage(tool, what), 'warning')
}

// --- 1) Assign Interfaces -------------------------------------------------------------------------

function assignInterfaces(ctx: ExecContext, t: PfTerm): void {
  const device = firewall(ctx)
  const names = device.interfaces.map((n) => n.name)
  t.echo('\nValid interfaces are:\n\n')
  for (const nic of device.interfaces) {
    const assigned = !!assignmentOfNic(device.pf, nic.id)
    const status = assigned && hasCarrier(ctx.state, device, nic) ? '  (up)' : '(down)'
    t.echo(`${padEnd(nic.name, 7)} ${bsdMac(nic)} ${status} ${EM_DRIVER_DESCRIPTION.slice(0, 46)}\n`)
  }
  t.echo(
    '\nDo VLANs need to be set up first?' +
      '\nIf VLANs will not be used, or only for optional interfaces, it is typical to\n' +
      'say no here and use the webConfigurator to configure VLANs later, if required.' +
      '\n\nShould VLANs be set up now [y|n]? '
  )
  if (/^[yY]$/.test(t.read())) return refuse(t, 'Assign Interfaces', 'VLAN')
  t.echo(
    "\nIf the names of the interfaces are not known, auto-detection can\n" +
      'be used instead. To use auto-detection, please disconnect all\n' +
      "interfaces before pressing 'a' to begin the process.\n"
  )

  let list = [...names]
  let wan = ''
  while (!wan) {
    t.echo("\nEnter the WAN interface name or 'a' for auto-detection ")
    t.echo(`\n(${list.join(' ')} or a): `)
    const answer = t.read()
    if (answer === '') return
    if (answer === 'a') return refuse(t, 'Assign Interfaces', 'a (auto-détection)')
    if (!names.includes(answer)) {
      t.echo(`\nInvalid interface name '${answer}'\n`)
      continue
    }
    wan = answer
    list = list.filter((n) => n !== wan)
  }

  let lan = ''
  while (!lan) {
    t.echo(
      `\nEnter the LAN interface name or 'a' for auto-detection \nNOTE: this enables full Firewalling/NAT mode.\n(${list.join(' ')} a or nothing if finished): `
    )
    const answer = t.read()
    if (answer === 'exit') return
    if (answer === '') break
    if (answer === 'a') return refuse(t, 'Assign Interfaces', 'a (auto-détection)')
    if (!names.includes(answer)) {
      t.echo(`\nInvalid interface name '${answer}'\n`)
      continue
    }
    lan = answer
    list = list.filter((n) => n !== lan)
  }

  const optional: string[] = []
  if (lan !== '') {
    while (list.length > 0) {
      const io = optional.length + 1
      const descr = io === 1 ? device.pf.assignments.find((a) => a.key === 'opt1')?.descr : undefined
      if (descr) t.echo(`\nOptional interface ${io} description found: ${descr}`)
      t.echo(
        `\nEnter the Optional ${io} interface name or 'a' for auto-detection\n(${list.join(' ')} a or nothing if finished): `
      )
      const answer = t.read()
      if (answer === '') break
      if (answer === 'a') return refuse(t, 'Assign Interfaces', 'a (auto-détection)')
      if (!names.includes(answer)) {
        t.echo(`\nInvalid interface name '${answer}'\n`)
        continue
      }
      optional.push(answer)
      list = list.filter((n) => n !== answer)
      if (optional.length === 1 && list.length > 0)
        return refuse(t, 'Assign Interfaces', 'OPT2 et suivantes (un seul réseau optionnel, OPT1)')
    }
  }

  const all = [lan, wan, ...optional]
  if (all.some((n, i) => all.indexOf(n) !== i)) {
    t.echo('\nError: The same interface name cannot be assigned twice!\n')
    return
  }
  t.echo('\nThe interfaces will be assigned as follows:\n\n')
  t.echo(`WAN  -> ${wan}\n`)
  if (lan !== '') t.echo(`LAN  -> ${lan}\n`)
  optional.forEach((n, i) => t.echo(`OPT${i + 1} -> ${n}\n`))
  t.echo('\nDo you want to proceed [y|n]? ')
  if (!/^[yY]$/.test(t.read())) return
  if (lan === '') {
    t.echo('\nYou have chosen to remove the LAN interface.\n')
    t.echo('\nWould you like to remove the LAN IP address and \nunload the interface now [y|n]? ')
    t.read()
  }
  ctx.apply(assignPfInterfaces(ctx.state, ctx.deviceId, { wan, lan: lan || null, opt1: optional[0] ?? null }))
  t.echo('\nWriting configuration...')
  t.echo('done.\n')
  t.echo('One moment while the settings are reloading...')
  t.echo(' done!\n')
}

// --- 2) Set interface(s) IP address -------------------------------------------------------------

function setInterfaceIp(ctx: ExecContext, t: PfTerm): void {
  const device = firewall(ctx)
  const listed = device.pf.assignments.filter((a) => nicOf(device, a.key))
  let key: PfIfaceKey
  if (listed.length > 1) {
    t.echo('Available interfaces:\n\n')
    listed.forEach((a, i) => {
      const nic = nicOf(device, a.key)
      const eff = nic ? effectiveIpv4(nic) : null
      t.echo(`${i + 1} - ${a.descr} (${nic?.name ?? ''}${eff ? ' - static' : ''})\n`)
    })
    t.echo('\nEnter the number of the interface you wish to configure: ')
    const n = Number(t.read())
    if (!(n >= 1) || n > listed.length) return
    const chosen = listed[Math.floor(n) - 1]
    if (!chosen) return
    key = chosen.key
  } else {
    const only = listed[0]
    if (!only) return
    key = only.key
  }
  const assignment = device.pf.assignments.find((a) => a.key === key)
  const nic = nicOf(device, key)
  if (!assignment || !nic) return
  const upper = key.toUpperCase()

  // IPv4 : DHCP (non simulé) ou adresse statique
  let restartDhcpd = false
  const dhcpWasEnabled = !!device.pf.dhcp[key]?.enabled
  if (askYesNo(t, `Configure IPv4 address ${upper} interface via DHCP?`))
    return refuse(t, 'Set interface(s) IP address', 'client DHCP')
  let ip = ''
  let bits = 0
  let gateway = ''
  let gatewayIsDefault = false
  for (;;) {
    let accepted = false
    do {
      t.echo(`\nEnter the new ${upper} IPv4 address.  Press <ENTER> for none:\n> `)
      const typed = t.read().trim()
      const [address = '', suffix] = typed.split('/')
      ip = address
      bits = 0
      if (suffix !== undefined && /^\d+$/.test(suffix) && Number(suffix) >= 1 && Number(suffix) <= 32)
        bits = Number(suffix)
      // Adresse déjà portée par une autre interface du pare-feu
      const conflict =
        isIpv4(ip) &&
        device.interfaces.some((o) => o.id !== nic.id && effectiveIpv4(o)?.address === ip)
      if (conflict) t.echo('This IP address conflicts with another interface or a VIP\n')
      accepted = !conflict && (isIpv4(ip) || ip === '')
    } while (!accepted)
    if (ip === '') break
    if (bits === 0) {
      t.echo('\nSubnet masks are entered as bit counts (as in CIDR notation) in pfSense.\n')
      t.echo('e.g. 255.255.255.0 = 24\n     255.255.0.0   = 16\n     255.0.0.0     = 8\n')
    }
    let restart = false
    while (bits === 0) {
      t.echo(`\nEnter the new ${upper} IPv4 subnet bit count (1 to 32):\n> `)
      const typed = t.read().trim()
      const n = /^\d+$/.test(typed) ? Number(typed) : 0
      if (n >= 1 && n <= 32) bits = n
      restartDhcpd = true
      restart = false
      if (bits > 0 && bits < 32) {
        if (ip === networkAddress(ip, bits)) {
          t.echo('You cannot set network address to an interface')
          bits = -1
        } else if (parseIpv4(ip) === broadcastInt(parseIpv4(ip) ?? 0, bits)) {
          t.echo('You cannot set broadcast address to an interface')
          bits = -1
        }
        if (bits === -1) {
          restart = true
          break
        }
      }
    }
    if (restart) {
      bits = 0
      continue
    }
    let again = false
    do {
      t.echo(
        `\nFor a WAN, enter the new ${upper} IPv4 upstream gateway address.\nFor a LAN, press <ENTER> for none:\n> `
      )
      gateway = t.read().trim()
      again = false
      if (gateway !== '') {
        if (!isIpv4(gateway)) {
          t.echo('not an IPv4 IP address!\n')
          again = true
        } else if (!inNetwork(gateway, networkAddress(ip, bits), bits)) {
          t.echo('Non-local gateway detected.')
        }
      }
    } while (again)
    if (gateway !== '') gatewayIsDefault = askYesNo(t, 'Should this gateway be set as the default gateway?')
    break
  }

  // IPv6 : non simulé (le pare-feu n'a pas de pile IPv6)
  if (askYesNo(t, `Configure IPv6 address ${upper} interface via DHCP6?`))
    return refuse(t, 'Set interface(s) IP address', 'client DHCP6')
  t.echo(`\nEnter the new ${upper} IPv6 address.  Press <ENTER> for none:\n> `)
  if (t.read().trim() !== '') return refuse(t, 'Set interface(s) IP address', 'adresse IPv6')

  // Serveur DHCP de l'interface
  let dhcp: { enabled: boolean; from?: string; to?: string } = { enabled: false }
  if (ip !== '' && askYesNo(t, `Do you want to enable the DHCP server on ${upper}?`)) {
    const first = parseIpv4(networkAddress(ip, bits)) ?? 0
    const last = broadcastInt(parseIpv4(ip) ?? 0, bits)
    const inRange = (a: string): boolean => {
      const n = parseIpv4(a)
      return n !== null && n >= first && n <= last
    }
    let from = ''
    let to = ''
    do {
      do {
        t.echo('Enter the start address of the IPv4 client address range: ')
        from = t.read().trim()
        if (from === '') return
        if (!inRange(from)) t.echo("This IP address must be in the interface's subnet\n")
      } while (!inRange(from))
      do {
        t.echo('Enter the end address of the IPv4 client address range: ')
        to = t.read().trim()
        if (to === '') return
        if (!inRange(to)) t.echo("This IP address must be in the interface's subnet\n")
        if ((parseIpv4(to) ?? 0) < (parseIpv4(from) ?? 0))
          t.echo('The end address of the DHCP range must be >= the start address\n')
      } while (!inRange(to))
    } while ((parseIpv4(to) ?? 0) < (parseIpv4(from) ?? 0))
    restartDhcpd = true
    dhcp = { enabled: true, from, to }
  } else {
    if (dhcpWasEnabled) restartDhcpd = true
    if (restartDhcpd) t.echo('Disabling IPv4 DHCPD...\n')
  }
  if (restartDhcpd) t.echo('Disabling IPv6 DHCPD...\n')

  // Protocole du webConfigurator (https par défaut)
  let revertToHttp = false
  let restartWebgui = false
  if ((device.pf.webProtocol ?? 'https') === 'https') {
    revertToHttp = askYesNo(t, 'Do you want to revert to HTTP as the webConfigurator protocol?')
    restartWebgui = revertToHttp
  }

  t.echo(`\nPlease wait while the changes are saved to ${upper}...`)
  ctx.apply(
    setPfInterfaceFromConsole(ctx.state, ctx.deviceId, {
      key,
      address: ip === '' ? null : ip,
      prefixLength: ip === '' ? null : bits,
      gateway: gateway === '' ? null : gateway,
      gatewayIsDefault,
      dhcp,
      revertToHttp
    })
  )
  t.echo('\n Reloading filter...')
  t.echo('\n Reloading routing configuration...')
  if (restartDhcpd) t.echo('\n DHCPD...')
  if (restartWebgui) t.echo('\n Restarting webConfigurator... ')

  const after = firewall(ctx)
  if (ip !== '') t.echo(`\n\nThe IPv4 ${upper} address has been set to ${ip}/${bits}\n`)
  if (ip !== '') {
    if (listed.length === 1 || gateway === '') {
      t.echo('You can now access the webConfigurator by opening the following URL in your web browser:\n')
      t.echo(`\t\t${after.pf.webProtocol ?? 'https'}://${ip}/\n`)
    }
  }
  t.echo('\nPress <ENTER> to continue.')
  t.read()
}

// --- 3) Reset webConfigurator password ------------------------------------------------------------

function resetPassword(ctx: ExecContext, t: PfTerm): void {
  t.echo(
    `\n\nThe webConfigurator admin password and privileges will be reset to the default (which is "${PF_DEFAULT_ADMIN_PASSWORD}").\nDo you want to proceed [y|n]? `
  )
  if (!/^[yY]$/.test(t.read())) return
  ctx.apply(resetPfAdminPassword(ctx.state, ctx.deviceId))
  t.echo(
    '\n\nThe password for the webConfigurator has been reset and\nthe default username has been set to "admin".\n' +
      '\nRemember to set the password to something else than\nthe default as soon as you have logged into the webConfigurator.\nPress ENTER to continue.'
  )
  t.read()
}

// --- 4) Reset to factory defaults ------------------------------------------------------------------

function factoryDefaults(ctx: ExecContext, t: PfTerm): void {
  t.echo(
    '\nYou are about to reset the firewall to factory defaults.\nThe firewall will reboot after resetting the configuration.\nAll additional packages installed will be removed.\nDo you want to proceed [y|n]? '
  )
  if (!/^[yY]$/.test(t.read())) return
  ctx.apply(factoryResetPf(ctx.state, ctx.deviceId))
  t.echo(`\n${PRODUCT} is rebooting now.\n`)
  ctx.exit = true
}

// --- 5) Reboot system -------------------------------------------------------------------------------

function reboot(ctx: ExecContext, t: PfTerm): void {
  // Installation sur ZFS (défaut de pfSense CE 2.7) : pas de vérification du système de fichiers (docs/fidelite.md, P-56)
  t.echo(
    `\n${PRODUCT} will reboot. This may take a few minutes, depending on your hardware.\nDo you want to proceed?\n\n` +
      '    Y/y: Reboot normally\n' +
      '    R/r: Reroot (Stop processes, remount disks, re-run startup sequence)\n' +
      '    S: Reboot into Single User Mode (requires console access!)\n' +
      'Enter an option: '
  )
  const answer = t.read()
  if (answer === 'Y' || answer === 'y' || answer === 'R' || answer === 'r') {
    t.echo(`\n${PRODUCT} is ${answer.toLowerCase() === 'r' ? 'rerooting' : 'rebooting'} now.\n`)
    ctx.apply(rebootPf(ctx.state, ctx.deviceId))
    ctx.exit = true
    return
  }
  if (answer === 'S') {
    t.echo('\n')
    refuse(t, 'Reboot system', 'S (mode mono-utilisateur)')
    return
  }
  t.echo('\n')
}

// --- 7) Ping host -------------------------------------------------------------------------------------

function pingHost(ctx: ExecContext, t: PfTerm): void {
  t.echo('\nEnter a host name or IP address: ')
  const host = t.read().trim()
  if (isIpv4(host)) {
    t.echo('\n')
    t.echo(`${bsdPing(ctx, host, 3).join('\n')}\n`)
    t.echo('\nPress ENTER to continue.\n')
    t.read()
  } else if (host.includes(':')) {
    refuse(t, 'ping6', 'IPv6')
  } else if (/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    refuse(t, 'ping', 'résolution de noms')
  }
}

// --- 10) Filter Logs ----------------------------------------------------------------------------------

function filterLogs(ctx: ExecContext, t: PfTerm): void {
  const lines = filterLogLines(firewall(ctx))
  for (const line of lines.slice(-10)) t.ctx.write(line)
  t.note('(suivi en temps réel non simulé : dernières lignes de /var/log/filter.log)', 'warning')
}

// --- Dispatch -----------------------------------------------------------------------------------------

/** Options réelles du menu sans effet dans ServerLab. */
const UNSIMULATED: Record<string, string> = {
  '6': '6) Halt system',
  '9': '9) pfTop',
  '11': '11) Restart webConfigurator',
  '12': '12) PHP shell + pfSense tools',
  '13': '13) Update from console',
  '14': '14) Enable Secure Shell (sshd)',
  '15': '15) Restore recent configuration',
  '16': '16) Restart PHP-FPM'
}

/** Exécute l'option saisie au menu (rc.initial : `case ${opmode}`), puis réaffiche le menu. */
export function runMenuOption(ctx: ExecContext, t: PfTerm, option: string): void {
  // `echo` qui suit la lecture de l'option
  t.echo('\n')
  switch (option) {
    case '':
    case '0':
      ctx.exit = true
      return
    case '1':
      assignInterfaces(ctx, t)
      break
    case '2':
      setInterfaceIp(ctx, t)
      break
    case '3':
      resetPassword(ctx, t)
      break
    case '4':
      factoryDefaults(ctx, t)
      break
    case '5':
      reboot(ctx, t)
      break
    case '7':
      pingHost(ctx, t)
      break
    case '8':
      ctx.session = { ...ctx.session, pfsense: { mode: 'shell' } }
      return
    case '10':
      filterLogs(ctx, t)
      break
    default:
      if (UNSIMULATED[option]) t.note(`« ${UNSIMULATED[option]} » existe réellement sur pfSense mais n’est pas simulé dans ServerLab.`)
  }
  t.flush()
  if (!ctx.exit) for (const line of menuScreen(firewall(ctx))) ctx.write(line)
}

