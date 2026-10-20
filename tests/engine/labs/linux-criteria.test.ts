/**
 * Critères Linux des labs (v2.9, #241) et champs `packages` / `bash` du départ déclaratif.
 */
import { describe, expect, it } from 'vitest'
import { buildLabStart, evaluateCheck, LabDeclarativeStartSchema, type Check } from '@engine/index'

const start = (bash: (string | { line: string; answers: string[] })[] = []) =>
  LabDeclarativeStartSchema.parse({
    devices: [
      { kind: 'switch', name: 'SW1', x: 0, y: 0 },
      {
        kind: 'server',
        os: 'linux',
        name: 'LSRV1',
        x: 0,
        y: 0,
        ip: '10.0.0.1/24',
        packages: ['apache2'],
        bash
      },
      { kind: 'server', name: 'SRV1', x: 0, y: 0, ip: '10.0.0.2/24' }
    ],
    links: [
      ['LSRV1:eth0', 'SW1:Fa0/1'],
      ['SRV1:Ethernet0', 'SW1:Fa0/2']
    ]
  })

const ok = (s: ReturnType<typeof buildLabStart>, check: Check) => evaluateCheck(s, check)

describe('départ déclaratif Linux', () => {
  it('packages : le paquet est installé et son service démarré', () => {
    const s = buildLabStart(start())
    expect(ok(s, { type: 'linuxPackageInstalled', device: 'LSRV1', package: 'apache2' })).toBe(true)
    expect(ok(s, { type: 'linuxPackageInstalled', device: 'LSRV1', package: 'samba' })).toBe(false)
    expect(ok(s, { type: 'linuxServiceActive', device: 'LSRV1', unit: 'apache2', enabled: true })).toBe(true)
  })

  it('bash : les lignes sont rejouées, une ligne en erreur interrompt la construction', () => {
    const s = buildLabStart(start(["echo 'bonjour' | sudo tee /srv/note.txt", 'sudo systemctl stop apache2']))
    expect(
      ok(s, { type: 'linuxFileContains', device: 'LSRV1', path: '/srv/note.txt', text: 'bonjour' })
    ).toBe(true)
    expect(ok(s, { type: 'linuxServiceActive', device: 'LSRV1', unit: 'apache2', active: false })).toBe(true)
    expect(() => buildLabStart(start(['cat /fichier/absent']))).toThrow(/a échoué/)
    expect(() => buildLabStart(start(['sudo smbpasswd -a alice']))).toThrow()
  })
})

describe('critères Linux', () => {
  const s = buildLabStart(start(['sudo chmod 750 /var/www/html']))

  it('linuxFileContains : texte, expression, absence, fichier absent', () => {
    const base = { type: 'linuxFileContains', device: 'LSRV1', path: '/etc/apache2/ports.conf' }
    expect(ok(s, { ...base, text: 'Listen 80' })).toBe(true)
    expect(ok(s, { ...base, text: '^Listen\\s+80$', regex: true })).toBe(true)
    expect(ok(s, { ...base, text: 'Listen 8080', present: false })).toBe(true)
    expect(ok(s, { ...base, text: 'Listen 80', present: false })).toBe(false)
    expect(ok(s, { ...base, text: '(', regex: true })).toBe(false)
    expect(ok(s, { ...base, path: '/inexistant', text: 'x' })).toBe(false)
    expect(ok(s, { ...base, path: '/inexistant', text: 'x', present: false })).toBe(true)
    // Un poste Windows n'a pas de fichiers Linux
    expect(ok(s, { ...base, device: 'SRV1', text: 'Listen 80' })).toBe(false)
  })

  it('linuxFileMode : droits octaux, propriétaire et groupe', () => {
    const base = { type: 'linuxFileMode', device: 'LSRV1', path: '/var/www/html' }
    expect(ok(s, { ...base, mode: '750' })).toBe(true)
    expect(ok(s, { ...base, mode: '0750', owner: 'root', group: 'root' })).toBe(true)
    expect(ok(s, { ...base, mode: '755' })).toBe(false)
    expect(ok(s, { ...base, mode: '750', owner: 'alice' })).toBe(false)
  })

  it('linuxPortListening et linuxServiceActive', () => {
    expect(ok(s, { type: 'linuxPortListening', device: 'LSRV1', port: 80 })).toBe(true)
    expect(ok(s, { type: 'linuxPortListening', device: 'LSRV1', port: 22 })).toBe(true)
    expect(ok(s, { type: 'linuxPortListening', device: 'LSRV1', port: 8080, listening: false })).toBe(true)
    expect(ok(s, { type: 'linuxServiceActive', device: 'LSRV1', unit: 'samba-inconnu' })).toBe(false)
    expect(ok(s, { type: 'linuxServiceActive', device: 'LSRV1', unit: 'named' })).toBe(false)
    expect(ok(s, { type: 'linuxServiceActive', device: 'SRV1', unit: 'apache2' })).toBe(false)
  })
})
