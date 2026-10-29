/**
 * Labs pare-feu 54 à 58 (v2.10, #248) : départ sain (les critères du sujet ne sont pas encore acquis), la
 * solution saisie avec les commandes `pf.*` valide 100 % des critères, une solution incomplète échoue.
 * Le lab 59 (dépannage) est couvert par `lab-59-depannage-pare-feu.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { command, type AnyCommand, type LabState } from '@engine/index'
import { run } from '../shell/helpers'
import { failing, loadTroubleshootingLab, play } from './depannage-helpers'

const idOf = (s: LabState, name: string): string =>
  Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

const lanNet = { type: 'interface', key: 'lan', what: 'net' } as const
const dmzNet = { type: 'interface', key: 'opt1', what: 'net' } as const
const tcp80 = { from: 80, to: 80 }

/** Solution du lab 54 : règles du LAN (HTTP vers WEB1, blocage de la DMZ avant la règle d'usine), règles de la DMZ. */
const regles = (fw: string, parts = 4): AnyCommand[] =>
  [
    command(
      'pf.addRule',
      fw,
      {
        iface: 'lan',
        action: 'pass',
        protocol: 'tcp',
        source: lanNet,
        destination: { type: 'address', address: '172.16.0.10' },
        destinationPort: tcp80,
        descr: 'LAN vers WEB1 en HTTP'
      },
      'pf-default-lan'
    ),
    command(
      'pf.addRule',
      fw,
      {
        iface: 'lan',
        action: 'block',
        source: lanNet,
        destination: { type: 'network', address: '172.16.0.0', prefixLength: 24 },
        descr: 'LAN vers DMZ bloqué'
      },
      'pf-default-lan'
    ),
    command('pf.addRule', fw, {
      iface: 'opt1',
      action: 'block',
      source: dmzNet,
      destination: lanNet,
      descr: 'DMZ vers LAN bloqué'
    }),
    command('pf.addRule', fw, {
      iface: 'opt1',
      action: 'pass',
      protocol: 'tcp',
      source: dmzNet,
      destination: { type: 'any' },
      destinationPort: tcp80,
      descr: 'Mises à jour HTTP'
    })
  ].slice(0, parts)

describe('lab 54 : règles LAN / DMZ', () => {
  const { lab, start } = loadTroubleshootingLab('lab-54-pfsense-regles-lan-dmz.json')
  const fw = idOf(start, 'FW1')

  it('au départ, les règles ne sont pas en place', () => {
    const open = failing(start, lab)
    expect(open).toEqual(expect.arrayContaining(['c2', 'c3', 'c5']))
    expect(open).not.toContain('c1')
  })

  it('la solution valide 100 % des critères', () => {
    expect(failing(play(start, regles(fw)), lab)).toEqual([])
  })

  it('sans blocage de la DMZ vers le LAN, la règle large laisse passer WEB1 vers FILES1', () => {
    const state = play(start, [regles(fw)[0]!, regles(fw)[1]!, regles(fw)[3]!])
    expect(failing(state, lab)).toEqual(['c6', 'c7'].filter((c) => c === 'c6'))
  })

  it('sans la règle de la DMZ vers Internet, les mises à jour échouent', () => {
    expect(failing(play(start, regles(fw, 3)), lab)).toEqual(['c5'])
  })

  it('la règle d’usine seule laisse le LAN tout faire', () => {
    expect(failing(play(start, regles(fw).slice(2)), lab)).toEqual(['c2', 'c3'])
  })
})

describe('lab 55 : serveur web publié', () => {
  const { lab, start } = loadTroubleshootingLab('lab-55-pfsense-dmz-web-publie.json')
  const fw = idOf(start, 'FW1')
  const publish = (): AnyCommand =>
    command('pf.addPortForward', fw, {
      protocol: 'tcp',
      destinationPort: tcp80,
      targetAddress: '172.16.0.10',
      descr: 'Site web'
    })

  it('au départ, le site n’est pas publié', () => {
    expect(failing(start, lab)).toEqual(['c1', 'c2', 'c3'])
  })

  it('la redirection du port 80 valide 100 % des critères', () => {
    expect(failing(play(start, [publish()]), lab)).toEqual([])
  })

  it('sans règle associée, le WAN refuse le flux', () => {
    const state = play(start, [
      command('pf.addPortForward', fw, {
        protocol: 'tcp',
        destinationPort: tcp80,
        targetAddress: '172.16.0.10',
        associatedRule: false
      })
    ])
    expect(failing(state, lab)).toEqual(['c2', 'c3'])
  })

  it('publier aussi SSH est détecté', () => {
    const state = play(start, [
      publish(),
      command('pf.addPortForward', fw, {
        protocol: 'tcp',
        destinationPort: { from: 22, to: 22 },
        targetAddress: '172.16.0.10'
      })
    ])
    expect(failing(state, lab)).toEqual(['c4'])
  })

  it('un serveur web arrêté ne répond plus', () => {
    const web = idOf(start, 'WEB1')
    const stopped = run(play(start, [publish()]), web, 'sudo systemctl stop apache2', { shell: 'cmd' }).state
    expect(failing(stopped, lab)).toEqual(['c3', 'c5'])
  })
})

describe('lab 56 : NAT sortant', () => {
  const { lab, start } = loadTroubleshootingLab('lab-56-pfsense-nat-sortant.json')
  const fw = idOf(start, 'FW1')
  const lanRule = (): AnyCommand =>
    command('pf.addOutboundNat', fw, {
      source: { type: 'network', address: '192.168.1.0', prefixLength: 24 }
    })
  const dmzRule = (): AnyCommand =>
    command('pf.addOutboundNat', fw, { source: { type: 'network', address: '172.16.0.0', prefixLength: 24 } })

  it('au départ, le NAT est désactivé : plus d’accès à Internet', () => {
    expect(failing(start, lab)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('mode manuel et une règle par réseau : 100 %', () => {
    const state = play(start, [command('pf.setNatMode', fw, 'manual'), lanRule(), dmzRule()])
    expect(failing(state, lab)).toEqual([])
  })

  it('mode manuel sans règle pour la DMZ : WEB1 reste isolé', () => {
    const state = play(start, [command('pf.setNatMode', fw, 'manual'), lanRule()])
    expect(failing(state, lab)).toEqual(['c3', 'c5'])
  })

  it('le mode automatique rétablit l’accès mais pas le mode demandé', () => {
    const state = play(start, [command('pf.setNatMode', fw, 'automatic')])
    expect(failing(state, lab)).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('lab 57 : DHCP et résolveur DNS', () => {
  const { lab, start } = loadTroubleshootingLab('lab-57-pfsense-dhcp-dns.json')
  const fw = idOf(start, 'FW1')
  const config = (): AnyCommand[] => [
    command('pf.setDhcp', fw, 'lan', { enabled: true, rangeFrom: '192.168.1.100', rangeTo: '192.168.1.150' }),
    command('pf.setGateway', fw, { name: 'WAN_GW', iface: 'wan', address: '45.10.0.2', isDefault: true }),
    command('pf.setHostOverride', fw, { host: 'intranet', domain: 'lab.local', address: '192.168.1.20' })
  ]
  const renew = (state: LabState, pc: string): LabState =>
    run(state, idOf(state, pc), 'ipconfig /renew', { shell: 'cmd' }).state

  it('au départ, rien n’est configuré', () => {
    expect(failing(start, lab)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
  })

  it('configuration et renouvellement des baux : 100 %', () => {
    const state = renew(renew(play(start, config()), 'PC1'), 'PC2')
    expect(failing(state, lab)).toEqual([])
  })

  it('sans renouvellement des baux, les postes n’ont pas d’adresse', () => {
    expect(failing(play(start, config()), lab)).toEqual(['c2', 'c3', 'c6', 'c7'])
  })

  it('sans le Host Override, le nom interne ne se résout pas', () => {
    const state = renew(renew(play(start, config().slice(0, 2)), 'PC1'), 'PC2')
    expect(failing(state, lab)).toEqual(['c5', 'c6'])
  })
})

describe('lab 58 : lab mixte Windows / Linux', () => {
  const { lab, start } = loadTroubleshootingLab('lab-58-pfsense-mixte-windows-linux.json')
  const fw = idOf(start, 'FW1')
  const solution = (): AnyCommand[] => [
    command('pf.setAlias', fw, {
      name: 'SRV_WEB',
      type: 'host',
      values: ['172.16.0.10'],
      descr: 'Serveur web'
    }),
    command('pf.addPortForward', fw, {
      protocol: 'tcp',
      destinationPort: tcp80,
      targetAddress: '172.16.0.10',
      descr: 'Site web'
    }),
    command(
      'pf.addRule',
      fw,
      {
        iface: 'lan',
        action: 'pass',
        protocol: 'tcp',
        source: lanNet,
        destination: { type: 'alias', name: 'SRV_WEB' },
        destinationPort: tcp80
      },
      'pf-default-lan'
    ),
    command(
      'pf.addRule',
      fw,
      {
        iface: 'lan',
        action: 'block',
        source: lanNet,
        destination: { type: 'network', address: '172.16.0.0', prefixLength: 24 }
      },
      'pf-default-lan'
    ),
    command('pf.addRule', fw, {
      iface: 'opt1',
      action: 'pass',
      protocol: 'udp',
      source: dmzNet,
      destination: { type: 'address', address: '192.168.1.20' },
      destinationPort: { from: 53, to: 53 },
      descr: 'DNS interne'
    }),
    command('pf.addRule', fw, { iface: 'opt1', action: 'block', source: dmzNet, destination: lanNet }),
    command('pf.addRule', fw, {
      iface: 'opt1',
      action: 'pass',
      protocol: 'tcp',
      source: dmzNet,
      destination: { type: 'any' },
      destinationPort: tcp80,
      descr: 'Mises à jour HTTP'
    })
  ]

  it('au départ, la politique n’est pas appliquée', () => {
    expect(failing(start, lab)).toEqual(expect.arrayContaining(['c1', 'c2', 'c3', 'c5', 'c7', 'c10']))
  })

  it('la politique complète valide 100 % des critères', () => {
    expect(failing(play(start, solution()), lab)).toEqual([])
  })

  it('sans la règle du DNS interne, la DMZ n’interroge plus WSRV1', () => {
    const partial = solution().filter((_, i) => i !== 4)
    expect(failing(play(start, partial), lab)).toEqual(['c7'])
  })

  it('en ouvrant tout le LAN à la DMZ, l’isolement est perdu', () => {
    const open = [...solution().slice(0, 4), command('pf.addRule', fw, { iface: 'opt1', action: 'pass' })]
    expect(failing(play(start, open), lab)).toEqual(['c8', 'c9'])
  })

  it('sans l’alias, le critère de l’alias échoue seul', () => {
    const partial = solution().filter((_, i) => i !== 0 && i !== 2)
    expect(failing(play(start, partial), lab)).toEqual(['c1', 'c4'])
  })
})
