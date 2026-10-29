/**
 * Générateur d'une grande topologie (100 équipements par défaut) pour les mesures de performance.
 * Construite avec les actions du moteur, comme dans l'interface, puis « vécue » : les postes en
 * DHCP ont déjà leur bail, comme dans un lab enregistré après usage.
 *
 * SW1 (cœur) : SRV1 (DHCP, DNS), SRV2 (fichiers), R1, et 6 switchs d'accès de 14 postes ;
 * 100 équipements au total.
 * SW7 n'est pas raccordé au cœur : ses postes en DHCP restent sans bail (APIPA), cas où les
 * tâches de fond pourraient retenter un DORA à chaque modification.
 *
 * Option `mixed` (OUTIL DE TEST SEULEMENT, jamais embarqué) : même nombre d'équipements (100) mais
 * hétérogènes : cœur Catalyst 9200, switchs d'accès Catalyst 2960, routeur Cisco 1921, pare-feu FW1,
 * serveur Linux SRV3, postes alternativement Windows et Linux.
 */
import {
  addDevice,
  addScope,
  connect,
  createLab,
  installFeatures,
  runBackgroundTasks,
  setDhcpOptions,
  setInterfaceIpv4,
  unwrap,
  type DeviceKind,
  type LabState
} from '../../src/engine/index'

export interface LargeLab {
  state: LabState
  /** Identifiants par nom (SRV1, SW3, PC42…). */
  ids: Record<string, string>
}

const ACCESS_SWITCHES = 6
const PER_SWITCH = 14

export function buildLargeLab(options: { mixed?: boolean } = {}): LargeLab {
  const mixed = options.mixed === true
  let s = createLab()
  const ids: Record<string, string> = {}
  const add = (
    kind: DeviceKind,
    name: string,
    x: number,
    y: number,
    extra: { os?: 'windows' | 'linux'; model?: 'c1921' | 'c2960' | 'c9200' } = {}
  ) => {
    const r = unwrap(addDevice(s, { kind, position: { x, y }, name, ...extra }))
    s = r.state
    ids[name] = r.value
    return r.value
  }
  const port = (id: string, i: number) => ({ deviceId: id, ifaceId: s.devices[id]?.interfaces[i]?.id ?? '' })
  const cable = (a: string, ia: number, b: string, ib: number) => {
    s = unwrap(connect(s, port(a, ia), port(b, ib))).state
  }
  const ip = (id: string, address: string, gateway: string | null, dns: string[]) => {
    s = unwrap(
      setInterfaceIpv4(s, id, port(id, 0).ifaceId, {
        addressing: 'static',
        address,
        mask: '22',
        gateway,
        dnsServers: dns
      })
    ).state
  }

  const core = add('switch', 'SW1', 900, 80, mixed ? { model: 'c9200' } : {})
  const srv1 = add('server', 'SRV1', 600, 0)
  const srv2 = add('server', 'SRV2', 750, 0)
  const r1 = add('router', 'R1', 1200, 0, mixed ? { model: 'c1921' } : {})
  if (mixed) {
    // Pare-feu et serveur Linux au cœur, remplacent deux postes de SW8
    const fw = add('firewall', 'FW1', 1350, 0)
    const srv3 = add('server', 'SRV3', 450, 0, { os: 'linux' })
    cable(fw, 0, r1, 1)
    cable(srv3, 0, core, 20)
  }
  cable(srv1, 0, core, 0)
  cable(srv2, 0, core, 1)
  cable(r1, 0, core, 2)
  ip(srv1, '10.0.0.1', '10.0.0.254', ['127.0.0.1'])
  ip(srv2, '10.0.0.2', '10.0.0.254', ['10.0.0.1'])
  ip(r1, '10.0.0.254', null, [])
  s = unwrap(installFeatures(s, srv1, ['DHCP', 'DNS'], { includeManagementTools: true })).state
  s = unwrap(installFeatures(s, srv2, ['FS-FileServer'])).state
  s = unwrap(
    addScope(s, srv1, { name: 'LAN', start: '10.0.1.1', end: '10.0.3.200', mask: '255.255.252.0' })
  ).state
  s = unwrap(setDhcpOptions(s, srv1, '10.0.0.0', { router: ['10.0.0.254'], dnsServers: ['10.0.0.1'] })).state

  let pc = 0
  for (let a = 0; a <= ACCESS_SWITCHES; a++) {
    const x = 100 + a * 260
    const sw = add('switch', `SW${a + 2}`, x, 300, mixed ? { model: 'c2960' } : {})
    // Le dernier switch d'accès reste isolé (postes sans serveur DHCP joignable)
    if (a < ACCESS_SWITCHES) cable(sw, PER_SWITCH, core, 3 + a)
    const count = a < ACCESS_SWITCHES ? PER_SWITCH : mixed ? 3 : 5
    for (let i = 0; i < count; i++) {
      pc++
      const host = add(
        'client',
        `PC${pc}`,
        x - 80 + (i % 3) * 80,
        420 + Math.floor(i / 3) * 110,
        mixed && pc % 2 === 0 ? { os: 'linux' } : {}
      )
      cable(host, 0, sw, i)
      // Un poste sur huit en adressage statique, les autres en DHCP (par défaut)
      if (pc % 8 === 0) ip(host, `10.0.0.${10 + pc}`, '10.0.0.254', ['10.0.0.1'])
    }
  }
  // Lab « vécu » : baux obtenus et journaux remplis avant l'enregistrement
  s = runBackgroundTasks(s).state
  return { state: s, ids }
}
