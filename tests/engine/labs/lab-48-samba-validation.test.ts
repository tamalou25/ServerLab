/**
 * Lab 48 (Samba) : la validation suit le fonctionnement réel du partage, pas le seul contenu des fichiers.
 * Reproduction du défaut signalé (v2.11) : groupe, compte Unix, droits et smb.conf préparés, mais ni compte
 * Samba ni redémarrage de smbd ; depuis LNX1, smbclient échouait (NT_STATUS_BAD_NETWORK_NAME) alors que
 * 6 critères sur 6 étaient validés. Désormais : configuration enregistrée ≠ configuration appliquée ≠
 * fonctionnement depuis le poste ; les accès interdits (bob, invité) sont vérifiés ; une solution
 * alternative valable (writable = yes, +compta) est acceptée.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLabState,
  checkLab,
  parseLabText,
  smbProbe,
  type HostDevice,
  type LabState,
  type ShellSession
} from '@engine/index'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../shell/helpers'

const parsed = parseLabText(readFileSync(join(__dirname, '../../../labs/lab-48-linux-samba.json'), 'utf8'))
if (!parsed.ok) throw new Error(parsed.message)
const lab = parsed.lab
const start = buildLabState(lab)

type Step = [string, string, string[]?]

const deviceId = (state: LabState, name: string) =>
  Object.values(state.devices).find((d) => d.name === name)?.id ?? ''

function play(from: LabState, steps: Step[]): { state: LabState; last: string } {
  let state = from
  let last = ''
  const sessions = new Map<string, ShellSession>()
  for (const [name, line, answers] of steps) {
    const session = sessions.get(name)
    const r = run(state, deviceId(state, name), line, {
      shell: 'cmd',
      answers: answers ?? [],
      ...(session ? { session } : {})
    })
    state = r.state
    last = `${r.text}\n${r.errors}`
    sessions.set(name, r.session)
  }
  return { state, last }
}

const failing = (state: LabState) =>
  checkLab(state, lab)
    .results.filter((r) => !r.ok)
    .map((r) => r.id)

const section = (lines: string[]): Step[] =>
  lines.map((l): Step => ['LSRV1', `echo '${l}' | sudo tee -a /etc/samba/smb.conf`])

const UNIX: Step[] = [
  ['LSRV1', 'sudo groupadd compta'],
  ['LSRV1', 'sudo useradd -m alice'],
  ['LSRV1', 'sudo usermod -aG compta alice'],
  ['LSRV1', 'sudo mkdir -p /srv/compta'],
  ['LSRV1', 'sudo chown root:compta /srv/compta'],
  ['LSRV1', 'sudo chmod 770 /srv/compta']
]
const CONF = section(['[compta]', '   path = /srv/compta', '   read only = no', '   valid users = @compta'])
const SMBPASSWD: Step = ['LSRV1', 'sudo smbpasswd -a alice', ['Passw0rd', 'Passw0rd']]
const RESTART: Step = ['LSRV1', 'sudo systemctl restart smbd']
const ALICE: Step = ['LNX1', 'smbclient //192.168.20.10/compta -U alice%Passw0rd -c ls']
const BOB: Step = ['LNX1', 'smbclient //192.168.20.10/compta -U bob%Passw0rd -c ls']

describe('lab 48 : configuration enregistrée, appliquée, fonctionnement depuis le poste', () => {
  it('au départ : bob a un compte Samba, le partage compta n’existe pas, 5 critères restent à faire', () => {
    expect(smbProbe(start, deviceId(start, 'LNX1'), 'LSRV1', 'public', { user: 'bob' }).status).toBe(
      'bad-network-name'
    )
    expect(failing(start)).toEqual(['groupe', 'dossier', 'partage', 'valid', 'alice'])
  })

  it('défaut reproduit : sans compte Samba ni redémarrage, smbclient échoue et le lab n’est PAS validé', () => {
    const { state, last } = play(start, [...UNIX, ...CONF, ALICE])
    expect(last).toContain('tree connect failed: NT_STATUS_BAD_NETWORK_NAME')
    expect(failing(state)).toEqual(['applique', 'alice'])
    expect(smbProbe(state, deviceId(state, 'LNX1'), 'LSRV1', 'compta', { user: 'alice' }).status).toBe(
      'bad-network-name'
    )
  })

  it('smbd redémarré mais compte Samba absent : alice est traitée en invitée (map to guest = bad user) et refusée', () => {
    const { state, last } = play(start, [...UNIX, ...CONF, RESTART, ALICE])
    expect(last).toContain('tree connect failed: NT_STATUS_ACCESS_DENIED')
    expect(failing(state)).toEqual(['alice'])
    expect(smbProbe(state, deviceId(state, 'LNX1'), 'LSRV1', 'compta', { user: 'alice' }).status).toBe(
      'access-denied'
    )
  })

  it('compte Samba désactivé (smbpasswd -d) : ouverture de session refusée', () => {
    const { state, last } = play(start, [
      ...UNIX,
      ...CONF,
      SMBPASSWD,
      ['LSRV1', 'sudo smbpasswd -d alice'],
      RESTART,
      ALICE
    ])
    expect(last).toContain('session setup failed: NT_STATUS_ACCOUNT_DISABLED')
    expect(failing(state)).toEqual(['alice'])
    expect(smbProbe(state, deviceId(state, 'LNX1'), 'LSRV1', 'compta', { user: 'alice' }).status).toBe(
      'logon-failure'
    )
  })

  it('solution complète : 100 % des critères, alice écrit, bob et l’invité sont refusés', () => {
    const { state, last } = play(start, [...UNIX, ...CONF, SMBPASSWD, RESTART, ALICE])
    expect(last).toContain('blocks of size')
    expect(failing(state)).toEqual([])
    const lnx = deviceId(state, 'LNX1')
    expect(smbProbe(state, lnx, 'LSRV1', 'compta', { user: 'alice', write: true })).toMatchObject({
      ok: true,
      unixUser: 'alice',
      writable: true
    })
    expect(smbProbe(state, lnx, 'LSRV1', 'compta', { user: 'bob', password: 'Passw0rd' }).status).toBe(
      'access-denied'
    )
    expect(smbProbe(state, lnx, 'LSRV1', 'compta').status).toBe('access-denied')
    expect(play(state, [BOB]).last).toContain('tree connect failed: NT_STATUS_ACCESS_DENIED')
    // La sonde n'a rien écrit dans le partage
    const srv = state.devices[deviceId(state, 'LSRV1')] as HostDevice
    expect(Object.keys(srv.host.linux?.files ?? {})).not.toContain('/srv/compta/sonde-serverlab.txt')
  })

  it('solution alternative valable (writable = yes, +compta, reload) : acceptée', () => {
    const alt = section([
      '[compta]',
      '   path = /srv/compta',
      '   writable = yes',
      '   valid users = +compta'
    ])
    const { state } = play(start, [...UNIX, ...alt, SMBPASSWD, ['LSRV1', 'sudo systemctl reload smbd']])
    expect(failing(state)).toEqual([])
  })

  it('partage en lecture seule : alice lit mais n’écrit pas, le critère alice échoue', () => {
    const ro = section(['[compta]', '   path = /srv/compta', '   valid users = @compta'])
    const { state } = play(start, [...UNIX, ...ro, SMBPASSWD, RESTART])
    expect(failing(state)).toEqual(['alice'])
    expect(
      smbProbe(state, deviceId(state, 'LNX1'), 'LSRV1', 'compta', { user: 'alice', write: true })
    ).toMatchObject({ ok: false, status: 'write-denied', writable: false })
  })

  it('partage ouvert à tous (guest ok, pas de valid users, 777) : les accès interdits font échouer le lab', () => {
    const open = section(['[compta]', '   path = /srv/compta', '   read only = no', '   guest ok = yes'])
    const { state } = play(start, [
      ...UNIX,
      ['LSRV1', 'sudo chmod 777 /srv/compta'],
      ...open,
      SMBPASSWD,
      RESTART
    ])
    expect(failing(state)).toEqual(['dossier', 'valid', 'bob', 'invite'])
  })

  it('bob ajouté par erreur au groupe compta : son accès est détecté', () => {
    const { state } = play(start, [
      ...UNIX,
      ['LSRV1', 'sudo usermod -aG compta bob'],
      ...CONF,
      SMBPASSWD,
      RESTART
    ])
    expect(failing(state)).toEqual(['bob'])
  })

  it('smbd arrêté après la configuration : la connexion est refusée, le service et le port manquent', () => {
    const { state } = play(start, [
      ...UNIX,
      ...CONF,
      SMBPASSWD,
      RESTART,
      ['LSRV1', 'sudo systemctl stop smbd']
    ])
    expect(failing(state)).toEqual(['alice', 'smbd', 'port'])
    expect(smbProbe(state, deviceId(state, 'LNX1'), 'LSRV1', 'compta', { user: 'alice' }).status).toBe(
      'refused'
    )
  })

  it('poste débranché : le serveur est injoignable (critères fonctionnels en échec)', () => {
    const { state } = play(start, [...UNIX, ...CONF, SMBPASSWD, RESTART])
    const lnx = state.devices[deviceId(state, 'LNX1')]!
    const unplugged: LabState = {
      ...state,
      devices: {
        ...state.devices,
        [lnx.id]: { ...lnx, interfaces: lnx.interfaces.map((i) => ({ ...i, enabled: false })) }
      }
    } as LabState
    expect(smbProbe(unplugged, lnx.id, 'LSRV1', 'compta', { user: 'alice' }).status).toBe('unreachable')
    expect(failing(unplugged)).toContain('alice')
  })

  it('déterminisme : deux évaluations du même état donnent le même résultat', () => {
    const { state } = play(start, [...UNIX, ...CONF, SMBPASSWD, RESTART])
    expect(checkLab(state, lab)).toEqual(checkLab(state, lab))
  })
})
