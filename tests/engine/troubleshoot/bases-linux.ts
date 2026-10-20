/**
 * Base saine des tests des pannes Linux (v2.9, #241) : un serveur Debian LSRV1 (192.168.20.10/24) avec
 * SSH (root permis), fail2ban (prison sshd), Apache2 (site par défaut), Samba (partage public), Bind9
 * (zone lab.lan) et isc-dhcp-server configurés et actifs, un poste Ubuntu LNX1 et un poste Windows PC1.
 * Construite par le départ déclaratif d'un lab (mêmes `packages` et `bash` que les labs fournis).
 */
import { buildLabStart, LabDeclarativeStartSchema, type LabState } from '@engine/index'

const tee = (path: string, lines: string[]): string[] =>
  lines.map((l, i) => `echo '${l}' | sudo tee ${i === 0 ? '' : '-a '}${path}`)

export const LINUX_START = LabDeclarativeStartSchema.parse({
  devices: [
    { kind: 'switch', name: 'SW1', x: 330, y: 300 },
    {
      kind: 'server',
      os: 'linux',
      name: 'LSRV1',
      x: 330,
      y: 100,
      ip: '192.168.20.10/24',
      packages: ['apache2', 'samba', 'bind9', 'isc-dhcp-server', 'fail2ban'],
      bash: [
        "sudo sed -i 's/^#PermitRootLogin prohibit-password$/PermitRootLogin yes/' /etc/ssh/sshd_config",
        'sudo systemctl restart ssh',
        ...tee('/etc/fail2ban/jail.local', ['[sshd]', 'enabled = true', 'maxretry = 3']),
        'sudo systemctl restart fail2ban',
        'sudo useradd -m alice',
        { line: 'sudo smbpasswd -a alice', answers: ['Passw0rd', 'Passw0rd'] },
        'sudo mkdir -p /srv/samba/public',
        'sudo chown alice:alice /srv/samba/public',
        ...['[public]', '   path = /srv/samba/public', '   read only = no', '   valid users = alice'].map(
          (l) => `echo '${l}' | sudo tee -a /etc/samba/smb.conf`
        ),
        'sudo systemctl restart smbd',
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
          'www IN A 192.168.20.20'
        ]),
        ...tee('/etc/bind/named.conf.local', [
          'zone "lab.lan" {',
          '    type master;',
          '    file "db.lab.lan";',
          '};'
        ]),
        'sudo systemctl restart named',
        ...tee('/etc/default/isc-dhcp-server', ['INTERFACESv4="eth0"']),
        ...tee('/etc/dhcp/dhcpd.conf', [
          'default-lease-time 600;',
          'authoritative;',
          'subnet 192.168.20.0 netmask 255.255.255.0 {',
          '  range 192.168.20.100 192.168.20.110;',
          '  option routers 192.168.20.254;',
          '  option domain-name-servers 192.168.20.10;',
          '}'
        ]),
        'sudo systemctl restart isc-dhcp-server'
      ]
    },
    {
      kind: 'client',
      os: 'linux',
      name: 'LNX1',
      x: 130,
      y: 470,
      ip: '192.168.20.20/24',
      dns: ['192.168.20.10']
    },
    { kind: 'client', name: 'PC1', x: 530, y: 470, ip: '192.168.20.30/24', dns: ['192.168.20.10'] }
  ],
  links: [
    ['LSRV1:eth0', 'SW1:Fa0/1'],
    ['LNX1:eth0', 'SW1:Fa0/2'],
    ['PC1:Ethernet0', 'SW1:Fa0/3']
  ]
})

export const buildLinuxHealthy = (): LabState => buildLabStart(LINUX_START)
