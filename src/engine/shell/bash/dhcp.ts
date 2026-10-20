/**
 * isc-dhcp-server d'une console bash (v2.9, #240) : `dhcpd -t` (contrôle de la syntaxe de dhcpd.conf),
 * d'après dhcpd(8) et les sources d'isc-dhcp 4.4.3-P1 (server/dhcpd.c, server/confpars.c, common/parse.c).
 * Le démarrage du service (systemctl), les baux (dhcpd.leases) et la distribution aux clients sont dans
 * services/linuxdhcp.ts et roles/dhcp/client.ts. Mêmes messages que l'outil réel
 * (docs/captures/bash/dhcpd-*.txt, docs/fidelite.md L-90 à L-99).
 */
import { DHCP_DEFAULT, DHCPD_CONF, DHCPD_LEASES, fileText } from '../../services/linuxconfig'
import { dhcpVersion, errorLines, readDhcpd } from '../../services/linuxdhcp'
import { isInstalled, linuxRelease } from '../../services/linuxpackages'
import { CommandFailure } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { resolvePath } from './interpreter'

const dhcpdTool: ToolDef = {
  name: 'dhcpd',
  synopsis: 'Contrôle dhcpd.conf (dhcpd -t [-cf fichier]) ; le démarrage passe par systemctl.',
  switches: ['-t', '-cf', '-4'],
  available: (ctx) => isInstalled(ctx.host, 'isc-dhcp-server'),
  run(ctx, args) {
    let test = false
    let path = DHCPD_CONF
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-t') test = true
      else if (a === '-4') continue
      else if (a === '-cf') path = resolvePath(ctx, args[++i] ?? '')
      else throw new CommandFailure(unsimulatedOptionMessage('dhcpd', a), 'NotSupported')
    }
    if (!test)
      throw new CommandFailure(
        'dhcpd lancé à la main n’est pas simulé dans ServerLab : utilisez systemctl start / restart isc-dhcp-server (et dhcpd -t pour contrôler la configuration).',
        'NotSupported'
      )
    const release = linuxRelease(ctx.host)
    const version = dhcpVersion(release)
    ctx.writeLines(
      [
        `Internet Systems Consortium DHCP Server ${version}`,
        `Copyright 2004-${version.startsWith('4.4.1') ? '2018' : '2022'} Internet Systems Consortium.`,
        'All rights reserved.',
        'For info, please visit https://www.isc.org/software/dhcp/',
        `Config file: ${path}`,
        `Database file: ${DHCPD_LEASES}`,
        'PID file: /var/run/dhcpd.pid'
      ],
      'error'
    )
    const text = fileText(ctx.host.host.linux?.files, path)
    if (text === null) {
      ctx.write(`Can't open ${path}: No such file or directory`, 'error')
      return
    }
    const running = readDhcpd(ctx.host, text, fileText(ctx.host.host.linux?.files, DHCP_DEFAULT))
    if (running.parse.errors.length === 0) return
    ctx.writeLines(
      [
        ...running.parse.errors.flatMap((e) => errorLines(path, e)),
        'Configuration file errors encountered -- exiting'
      ],
      'error'
    )
  }
}

export const dhcpBashTools: ToolDef[] = [dhcpdTool]
