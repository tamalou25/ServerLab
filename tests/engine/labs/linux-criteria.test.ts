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

  it('linuxConfigApplied : vrai tant que les fichiers n’ont pas changé, faux après une modification, vrai après reload', () => {
    const check = { type: 'linuxConfigApplied', device: 'LSRV1', unit: 'apache2' }
    expect(ok(s, check)).toBe(true)
    const edited = buildLabStart(start(["echo 'Listen 8080' | sudo tee -a /etc/apache2/ports.conf"]))
    expect(ok(edited, check)).toBe(false)
    const reloaded = buildLabStart(
      start(["echo 'Listen 8080' | sudo tee -a /etc/apache2/ports.conf", 'sudo systemctl reload apache2'])
    )
    expect(ok(reloaded, check)).toBe(true)
    // Unité inconnue, non installée ou sans configuration modélisée : non validé
    expect(ok(s, { ...check, unit: 'smbd' })).toBe(false)
    expect(ok(s, { ...check, unit: 'inconnue' })).toBe(false)
    expect(ok(s, { ...check, device: 'SRV1' })).toBe(false)
  })
})

describe('critère smbAccess (accès à un partage Samba depuis un poste)', () => {
  const samba = (bash: string[]) =>
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
          packages: ['samba'],
          bash: [
            'sudo useradd -m alice',
            { line: 'sudo smbpasswd -a alice', answers: ['Secret1', 'Secret1'] },
            'sudo useradd -m bob',
            'sudo mkdir -p /srv/docs',
            'sudo chown alice:alice /srv/docs',
            ...bash
          ]
        },
        { kind: 'client', os: 'linux', name: 'LNX1', x: 0, y: 0, ip: '10.0.0.20/24' },
        { kind: 'client', name: 'PC1', x: 0, y: 0, ip: '10.0.0.30/24' },
        { kind: 'client', name: 'PC2', x: 0, y: 0, ip: '10.0.1.40/24' }
      ],
      links: [
        ['LSRV1:eth0', 'SW1:Fa0/1'],
        ['LNX1:eth0', 'SW1:Fa0/2'],
        ['PC1:Ethernet0', 'SW1:Fa0/3'],
        ['PC2:Ethernet0', 'SW1:Fa0/4']
      ]
    })
  const conf = ['[docs]', '   path = /srv/docs', '   read only = no', '   valid users = alice'].map(
    (l) => `echo '${l}' | sudo tee -a /etc/samba/smb.conf`
  )
  const base = { type: 'smbAccess', from: 'LNX1', server: 'LSRV1', share: 'docs' }

  it('réussite : compte autorisé (mot de passe de la base ou donné), lecture et écriture ; serveur par adresse', () => {
    const s = buildLabStart(samba([...conf, 'sudo systemctl restart smbd']))
    expect(ok(s, { ...base, user: 'alice' })).toBe(true)
    expect(ok(s, { ...base, user: 'alice', password: 'Secret1', write: true })).toBe(true)
    expect(ok(s, { ...base, user: 'alice', server: '10.0.0.1' })).toBe(true)
    expect(ok(s, { ...base, user: 'alice', from: 'PC1' })).toBe(true)
    // Mauvais mot de passe, compte sans compte Samba, invité : refusés (et success: false les valide)
    expect(ok(s, { ...base, user: 'alice', password: 'faux' })).toBe(false)
    expect(ok(s, { ...base, user: 'bob', password: 'x' })).toBe(false)
    expect(ok(s, { ...base, user: 'bob', password: 'x', success: false })).toBe(true)
    expect(ok(s, { ...base })).toBe(false)
    expect(ok(s, { ...base, success: false })).toBe(true)
    // Poste d'un autre réseau sans passerelle : injoignable
    expect(ok(s, { ...base, user: 'alice', from: 'PC2' })).toBe(false)
    // Partage ou serveur inconnus
    expect(ok(s, { ...base, user: 'alice', share: 'autre' })).toBe(false)
    expect(ok(s, { ...base, user: 'alice', server: 'SRV9' })).toBe(false)
  })

  it('configuration non relue : le fichier déclare le partage mais smbd ne le sert pas', () => {
    const s = buildLabStart(samba(conf))
    expect(ok(s, { ...base, user: 'alice' })).toBe(false)
    expect(ok(s, { type: 'linuxConfigApplied', device: 'LSRV1', unit: 'smbd' })).toBe(false)
    expect(
      ok(s, { type: 'linuxFileContains', device: 'LSRV1', path: '/etc/samba/smb.conf', text: '[docs]' })
    ).toBe(true)
  })

  it('lecture seule et droits Unix : l’écriture est jugée, pas seulement la connexion', () => {
    const ro = buildLabStart(
      samba([
        ...conf,
        "sudo sed -i 's/read only = no/read only = yes/' /etc/samba/smb.conf",
        'sudo systemctl restart smbd'
      ])
    )
    expect(ok(ro, { ...base, user: 'alice' })).toBe(true)
    expect(ok(ro, { ...base, user: 'alice', write: true })).toBe(false)
    expect(ok(ro, { ...base, user: 'alice', write: true, success: false })).toBe(true)
    const locked = buildLabStart(samba([...conf, 'sudo chmod 000 /srv/docs', 'sudo systemctl restart smbd']))
    expect(ok(locked, { ...base, user: 'alice' })).toBe(false)
  })

  it('service arrêté : aucun accès', () => {
    const s = buildLabStart(samba([...conf, 'sudo systemctl restart smbd', 'sudo systemctl stop smbd']))
    expect(ok(s, { ...base, user: 'alice' })).toBe(false)
  })

  it('la sonde ne modifie pas l’état (aucun fichier créé par le test d’écriture)', () => {
    const s = buildLabStart(samba([...conf, 'sudo systemctl restart smbd']))
    const before = JSON.stringify(s)
    ok(s, { ...base, user: 'alice', write: true })
    expect(JSON.stringify(s)).toBe(before)
  })
})
