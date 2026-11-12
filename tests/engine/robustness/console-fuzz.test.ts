/**
 * Fuzzing des consoles (CMD, PowerShell, bash, IOS, pare-feu) : lignes aléatoires ou mal formées.
 * Attendu : aucune exception, sortie toujours définie, état toujours valide pour le schéma zod.
 */
import { describe, expect, it } from 'vitest'
import {
  createShellSession,
  executeLine,
  isIosDevice,
  isLinuxDeviceId,
  LabStateSchema,
  type LabState,
  type ShellKind,
  type ShellSession
} from '@engine/index'
import { isPfsenseDevice } from '@engine/shell/pfsense'
import { loadAllLabs, prng, type Rng } from './prng'

type Console = 'cmd' | 'powershell' | 'bash' | 'ios' | 'pfsense'

const SPECIAL = [
  '"',
  "'",
  '`',
  '|',
  '||',
  '&',
  '&&',
  ';',
  '>',
  '>>',
  '<',
  '2>&1',
  '$(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '*',
  '?',
  '%',
  '$',
  '\\',
  '/',
  '..',
  '~',
  '^',
  '@',
  '#',
  '!',
  ' ',
  '\t',
  '=',
  '-',
  ',',
  ':'
]
const UNICODE = ['é', 'ß', 'ñ', '漢字', '😀', '\u0000', '\u202e', '\ufeff', 'İ', '\r', '\n', '\u00a0', 'Ω']
const WORDS: Record<Console, string[]> = {
  cmd: [
    'dir',
    'cd',
    'echo',
    'set',
    'ipconfig /all',
    'ping',
    'net user',
    'type',
    'copy',
    'del',
    'mkdir',
    'nslookup',
    'tracert',
    'for',
    'if',
    'goto',
    'help',
    'cls',
    'whoami',
    'tasklist',
    'sc query',
    'netsh',
    'gpupdate',
    'C:\\',
    'exit'
  ],
  powershell: [
    'Get-ChildItem',
    'Get-Process',
    'Get-ADUser',
    'New-ADUser',
    'Set-Location',
    '$x =',
    '$_',
    'foreach',
    'if',
    'Where-Object',
    'Select-Object',
    'Format-Table',
    '-Filter',
    '-Name',
    '@{',
    '@(',
    'Write-Host',
    'Get-Service',
    'Get-DnsServerZone',
    'Add-DhcpServerv4Scope',
    '1..5',
    '-eq',
    '-match',
    'function f {',
    'ForEach-Object',
    '$null',
    'exit'
  ],
  bash: [
    'ls -la',
    'cd',
    'cat',
    'echo',
    'grep',
    'sudo',
    'apt',
    'systemctl status',
    'ip a',
    'ping -c 1',
    'useradd',
    'chmod',
    'sed',
    'awk',
    'for i in',
    'do',
    'done',
    'if [',
    'export',
    '$HOME',
    '$?',
    'cat <<EOF',
    'tail -f',
    'ssh',
    'smbpasswd',
    'named-checkconf',
    'exit'
  ],
  ios: [
    'enable',
    'configure terminal',
    'interface',
    'show running-config',
    'show ip route',
    'ip address',
    'no',
    'vlan',
    'switchport mode',
    'router ospf 1',
    'network',
    'access-list',
    'end',
    'exit',
    '?',
    'show',
    '| include',
    '| begin',
    'copy running-config startup-config',
    'ping',
    'shutdown',
    'hostname',
    'do',
    'GigabitEthernet0/0',
    'Vlan1'
  ],
  pfsense: [
    '1',
    '2',
    '8',
    '11',
    'pfctl -sr',
    'pfctl -s',
    'ifconfig',
    'ping',
    'netstat -rn',
    'exit',
    'ls',
    'cat /etc/rc.conf',
    'clog',
    'tcpdump',
    'pfctl -F',
    'easyrule',
    'help'
  ]
}

/** Ligne aléatoire : mélange de mots du vocabulaire, de caractères spéciaux, d'Unicode et de bruit. */
function randomLine(rng: Rng, kind: Console): string {
  const parts = rng.int(8)
  let line = ''
  for (let i = 0; i < parts; i++) {
    const r = rng.int(10)
    if (r < 4) line += rng.pick(WORDS[kind]) + ' '
    else if (r < 7) line += rng.pick(SPECIAL)
    else if (r < 8) line += rng.pick(UNICODE)
    else if (r < 9) line += String.fromCharCode(32 + rng.int(95))
    else line += String.fromCharCode(rng.int(0xd7ff))
  }
  const mode = rng.int(40)
  if (mode === 0) line = line.repeat(1 + rng.int(300)) // très longue ligne
  if (mode === 1) line = '"' + line // guillemet non fermé
  if (mode === 2) line = line + ' |'.repeat(1 + rng.int(50))
  if (mode === 3) line = '('.repeat(rng.int(400)) + line // imbrication profonde
  if (mode === 4) line = line + ' >'.repeat(1 + rng.int(5)) + ' '
  if (mode === 5) line = ' '.repeat(rng.int(5000)) + line
  return line
}

function findDevice(kind: Console): { state: LabState; deviceId: string; shell: ShellKind } | undefined {
  for (const lab of loadAllLabs()) {
    const s = lab.state
    for (const d of Object.values(s.devices)) {
      if (!d.powered) continue
      if (kind === 'ios' && isIosDevice(s, d.id)) return { state: s, deviceId: d.id, shell: 'ios' }
      if (kind === 'pfsense' && isPfsenseDevice(s, d.id)) return { state: s, deviceId: d.id, shell: 'cmd' }
      if (d.kind !== 'server' && d.kind !== 'client') continue
      if (isPfsenseDevice(s, d.id) || isIosDevice(s, d.id)) continue
      if (kind === 'bash' && isLinuxDeviceId(s, d.id)) return { state: s, deviceId: d.id, shell: 'bash' }
      if ((kind === 'cmd' || kind === 'powershell') && !isLinuxDeviceId(s, d.id) && d.kind === 'server')
        return { state: s, deviceId: d.id, shell: kind }
    }
  }
  return undefined
}

const COUNT: Record<Console, number> = { cmd: 1500, powershell: 1500, bash: 1500, ios: 2000, pfsense: 1200 }

describe.each(['cmd', 'powershell', 'bash', 'ios', 'pfsense'] as Console[])(
  'fuzzing de la console %s',
  (kind) => {
    it('lignes aléatoires : aucune exception, sortie définie, état valide', { timeout: 30000 }, () => {
      const found = findDevice(kind)
      expect(found, `aucun équipement ${kind} dans les labs`).toBeDefined()
      let state = found!.state
      const initialSession = createShellSession(state, found!.deviceId, found!.shell)
      let session: ShellSession = initialSession
      const rng = prng(0x5eed + kind.length * 7919)
      for (let i = 0; i < COUNT[kind]; i++) {
        const line = randomLine(rng, kind)
        let result: ReturnType<typeof executeLine> | undefined
        try {
          result = executeLine(state, session, line)
        } catch (e) {
          throw new Error(
            `Exception sur la ligne n°${i} ${JSON.stringify(line.slice(0, 200))} : ${String(e)}`,
            { cause: e }
          )
        }
        expect(Array.isArray(result.output)).toBe(true)
        for (const o of result.output) expect(typeof o.text).toBe('string')
        expect(result.state).toBeDefined()
        expect(result.session).toBeDefined()
        state = result.state
        session = result.exit ? initialSession : result.session
        if (i % 100 === 99) {
          expect(LabStateSchema.safeParse(state).success, `état invalide après la ligne n°${i}`).toBe(true)
        }
      }
      expect(LabStateSchema.safeParse(state).success).toBe(true)
    })
  }
)
