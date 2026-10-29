/**
 * Labs Linux 46 à 52 (v2.9, #241) : départ sain (aucun critère validé sauf ceux du sujet déjà acquis),
 * la solution saisie dans les consoles bash et cmd valide 100 % des critères, cas partiels.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLabState,
  checkLab,
  parseLabText,
  type LabDefinition,
  type LabState,
  type ShellSession
} from '@engine/index'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../shell/helpers'
import { failing } from './depannage-helpers'

function load(file: string): { lab: LabDefinition; start: LabState } {
  const parsed = parseLabText(readFileSync(join(__dirname, '../../../labs', file), 'utf8'))
  if (!parsed.ok) throw new Error(parsed.message)
  return { lab: parsed.lab, start: buildLabState(parsed.lab) }
}

const DIAGNOSTIC = /apache2ctl|testparm|dhcpd -t|named-checkconf|fail2ban-client|smbclient|dig |curl|nslookup/

/** [machine, ligne, réponses aux invites] */
type Step = [string, string, string[]?]

/** Rejoue les lignes sur les consoles du lab (une session par machine) ; toute erreur fait échouer le test. */
function play(start: LabState, steps: Step[], allowErrors = false): LabState {
  let state = start
  const sessions = new Map<string, ShellSession>()
  for (const [name, line, answers] of steps) {
    const id = Object.values(state.devices).find((d) => d.name === name)?.id ?? ''
    const session = sessions.get(name)
    const r = run(state, id, line, { shell: 'cmd', answers: answers ?? [], ...(session ? { session } : {}) })
    // Les outils de contrôle écrivent leurs avertissements sur la sortie d'erreur : seule une vraie erreur échoue
    if (!allowErrors && !DIAGNOSTIC.test(line)) expect(r.errors, `${name} : ${line}`).toBe('')
    state = r.state
    sessions.set(name, r.session)
  }
  return state
}

const tee = (path: string, lines: string[]): Step[] =>
  lines.map((l, i) => ['LSRV1', `echo '${l}' | sudo tee ${i === 0 ? '' : '-a '}${path}`])

const SOLUTIONS: Record<string, Step[]> = {
  'lab-46-linux-ssh-fail2ban.json': [
    ['LSRV1', "sudo sed -i 's/^#Port 22$/Port 2222/' /etc/ssh/sshd_config"],
    [
      'LSRV1',
      "sudo sed -i 's/^#PermitRootLogin prohibit-password$/PermitRootLogin no/' /etc/ssh/sshd_config"
    ],
    ['LSRV1', 'sudo systemctl restart ssh'],
    ...tee('/etc/fail2ban/jail.local', [
      '[sshd]',
      'enabled = true',
      'port = 2222',
      'maxretry = 3',
      'bantime = 10m'
    ]),
    ['LSRV1', 'sudo systemctl restart fail2ban'],
    ['LSRV1', 'sudo fail2ban-client status sshd']
  ],
  'lab-47-linux-apache2.json': [
    ['LSRV1', 'sudo mkdir -p /var/www/site1 /var/www/site2'],
    ['LSRV1', "echo '<h1>Site 1</h1>' | sudo tee /var/www/site1/index.html"],
    ['LSRV1', "echo '<h1>Site 2</h1>' | sudo tee /var/www/site2/index.html"],
    ...['site1', 'site2'].flatMap((s) =>
      tee(`/etc/apache2/sites-available/${s}.conf`, [
        '<VirtualHost *:80>',
        `    ServerName ${s}.lab.local`,
        `    DocumentRoot /var/www/${s}`,
        '</VirtualHost>'
      ])
    ),
    ['LSRV1', 'sudo a2ensite site1'],
    ['LSRV1', 'sudo a2ensite site2'],
    ['LSRV1', 'sudo a2dissite 000-default'],
    ['LSRV1', 'sudo apache2ctl configtest'],
    ['LSRV1', 'sudo systemctl reload apache2'],
    ['LNX1', 'curl -s -H "Host: site2.lab.local" http://192.168.20.10/']
  ],
  'lab-48-linux-samba.json': [
    ['LSRV1', 'sudo groupadd compta'],
    ['LSRV1', 'sudo useradd -m alice'],
    ['LSRV1', 'sudo usermod -aG compta alice'],
    ['LSRV1', 'sudo mkdir -p /srv/compta'],
    ['LSRV1', 'sudo chown root:compta /srv/compta'],
    ['LSRV1', 'sudo chmod 770 /srv/compta'],
    ...['[compta]', '   path = /srv/compta', '   read only = no', '   valid users = @compta'].map(
      (l): Step => ['LSRV1', `echo '${l}' | sudo tee -a /etc/samba/smb.conf`]
    ),
    ['LSRV1', 'sudo testparm -s'],
    ['LSRV1', 'sudo smbpasswd -a alice', ['Passw0rd', 'Passw0rd']],
    ['LSRV1', 'sudo systemctl restart smbd'],
    ['LNX1', 'smbclient //192.168.20.10/compta -U alice%Passw0rd -c ls']
  ],
  'lab-49-linux-bind9.json': [
    ...tee('/var/cache/bind/db.lab.lan', [
      '$TTL 604800',
      '@ IN SOA ns1.lab.lan. admin.lab.lan. (',
      '        2         ; Serial',
      '        604800    ; Refresh',
      '        86400     ; Retry',
      '        2419200   ; Expire',
      '        604800 )  ; Negative Cache TTL',
      '@ IN NS ns1.lab.lan.',
      'ns1 IN A 192.168.20.10',
      'www IN A 192.168.20.20',
      'web IN CNAME www'
    ]),
    ...tee('/etc/bind/named.conf.local', [
      'zone "lab.lan" {',
      '    type master;',
      '    file "db.lab.lan";',
      '};'
    ]),
    ['LSRV1', 'sudo named-checkconf'],
    ['LSRV1', 'sudo rndc reload'],
    ['LNX1', 'dig @192.168.20.10 www.lab.lan +short']
  ],
  'lab-50-linux-dhcp.json': [
    ...tee('/etc/default/isc-dhcp-server', ['INTERFACESv4="eth0"']),
    ...tee('/etc/dhcp/dhcpd.conf', [
      'default-lease-time 600;',
      'max-lease-time 7200;',
      'authoritative;',
      'subnet 192.168.20.0 netmask 255.255.255.0 {',
      '  range 192.168.20.100 192.168.20.110;',
      '  option routers 192.168.20.254;',
      '  option domain-name-servers 192.168.20.10;',
      '  option domain-name "lab.lan";',
      '}'
    ]),
    ['LSRV1', 'sudo dhcpd -t'],
    ['LSRV1', 'sudo systemctl restart isc-dhcp-server'],
    ['PC1', 'ipconfig /renew']
  ],
  'lab-51-mixte-samba-windows.json': [
    ['PC1', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd'],
    ['PC1', 'mkdir Z:\\dossier'],
    ...['[lecture]', '   path = /srv/samba/lecture', '   guest ok = yes'].map((l): Step => [
      'LSRV1',
      `echo '${l}' | sudo tee -a /etc/samba/smb.conf`
    ]),
    ['LSRV1', 'sudo systemctl restart smbd'],
    ['LNX1', 'smbclient //192.168.20.10/public -U alice%Passw0rd -c ls']
  ],
  'lab-52-mixte-dns-dhcp.json': [
    ...tee('/etc/default/isc-dhcp-server', ['INTERFACESv4="eth0"']),
    ...tee('/etc/dhcp/dhcpd.conf', [
      'default-lease-time 600;',
      'authoritative;',
      'subnet 192.168.20.0 netmask 255.255.255.0 {',
      '  range 192.168.20.100 192.168.20.110;',
      '  option routers 192.168.20.254;',
      '  option domain-name-servers 192.168.20.10;',
      '  option domain-name "lab.lan";',
      '}'
    ]),
    ['LSRV1', 'sudo dhcpd -t'],
    ['LSRV1', 'sudo systemctl restart isc-dhcp-server'],
    ['PC1', 'ipconfig /renew'],
    ['PC1', 'nslookup www.lab.lan']
  ]
}

/** Étape décisive dont l'absence laisse au moins un critère en échec. */
const OMIT: Record<string, RegExp> = {
  'lab-46-linux-ssh-fail2ban.json': /restart ssh/,
  'lab-47-linux-apache2.json': /a2dissite/,
  'lab-48-linux-samba.json': /chmod 770/,
  'lab-49-linux-bind9.json': /rndc reload/,
  'lab-50-linux-dhcp.json': /restart isc-dhcp-server/,
  'lab-51-mixte-samba-windows.json': /net use/,
  'lab-52-mixte-dns-dhcp.json': /restart isc-dhcp-server/
}

describe.each(Object.entries(SOLUTIONS))('%s', (file, steps) => {
  const { lab, start } = load(file)

  it('le départ se construit ; il reste du travail à faire', () => {
    expect(failing(start, lab).length).toBeGreaterThan(0)
    expect(failing(start, lab)).not.toEqual([])
  })

  it('la solution saisie dans les consoles valide 100 % des critères', () => {
    const fixed = play(start, steps)
    expect(failing(fixed, lab)).toEqual([])
    expect(checkLab(fixed, lab).passed).toBe(lab.criteria.length)
  })

  it('une solution incomplète ne valide pas tout (étape décisive omise)', () => {
    const partial = play(
      start,
      steps.filter(([, line]) => !OMIT[file]!.test(line)),
      true
    )
    expect(failing(partial, lab).length).toBeGreaterThan(0)
    expect(failing(partial, lab).length).toBeLessThan(lab.criteria.length)
  })
})
