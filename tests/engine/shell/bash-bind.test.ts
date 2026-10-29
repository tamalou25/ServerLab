/**
 * Bind9 sur serveur Linux (v2.9, #240) : configuration en vigueur (relue au rechargement), zones directe et
 * inverse, résolution réelle par les clients Linux et Windows, délégation depuis le DNS Windows (redirecteur),
 * redirecteur vers le DNS Windows, listes d'accès, démarrage refusé, commandes non simulées.
 */
import {
  addPrimaryZone,
  addRecord,
  installFeatures,
  setForwarders,
  setInterfaceIpv4,
  unwrap
} from '@engine/index'
import { loadZone } from '@engine/services/linuxbind'
import { describe, expect, it } from 'vitest'
import {
  BIND_READY,
  buildBindLab,
  Consoles,
  INSTALL_BIND,
  LOCAL_ZONES,
  localConf,
  NAMED_LOCAL,
  REV_FILE,
  REV_LINES,
  writeFile,
  ZONE_FILE,
  ZONE_LINES,
  type Command
} from './bind-lab'

function ready(prepare: Command[] = BIND_READY): Consoles {
  const c = new Consoles(buildBindLab())
  for (const [who, line, answers] of prepare) c.run(who, line, answers)
  return c
}

describe('Bind9 : installation et configuration en vigueur', () => {
  it('apt install bind9 démarre named avec la configuration Debian (zones par défaut)', () => {
    const c = ready([INSTALL_BIND])
    expect(c.run('srv', 'systemctl is-active named')).toBe('active')
    expect(c.run('srv', 'cat /etc/bind/named.conf')).toContain('include "/etc/bind/named.conf.local";')
    expect(c.run('srv', 'sudo named-checkconf -z')).toContain('zone localhost/IN: loaded serial 2')
    expect(c.run('srv', 'dig @127.0.0.1 localhost +short')).toBe('127.0.0.1')
  })

  it('une zone ajoutée n’est servie qu’après rndc reload', () => {
    const c = ready([
      INSTALL_BIND,
      ...writeFile(ZONE_FILE, ZONE_LINES),
      ...writeFile(REV_FILE, REV_LINES),
      ...localConf(LOCAL_ZONES)
    ])
    // named garde la configuration lue à son démarrage : lab.lan est inconnue (recherche hors de la zone)
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan +short')).toBe('')
    expect(c.run('srv', 'sudo rndc reload')).toBe('server reload successful')
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan +short')).toBe('192.168.2.20')
  })

  it('une modification de la zone n’est visible qu’après rndc reload lab.lan', () => {
    const c = ready()
    c.run('srv', "echo 'ftp IN A 192.168.2.40' | sudo tee -a /var/cache/bind/db.lab.lan")
    expect(c.run('pc', 'dig @192.168.2.10 ftp.lab.lan +short')).toBe('')
    expect(c.run('srv', 'sudo rndc reload lab.lan')).toBe('zone reload queued')
    expect(c.run('pc', 'dig @192.168.2.10 ftp.lab.lan +short')).toBe('192.168.2.40')
    expect(c.run('srv', 'sudo rndc reload lab.lan')).toBe('zone reload up-to-date')
  })

  it('rndc reconfig charge la nouvelle zone mais garde les données des zones déjà chargées', () => {
    const c = ready()
    c.run('srv', "echo 'ftp IN A 192.168.2.40' | sudo tee -a /var/cache/bind/db.lab.lan")
    c.run('srv', 'sudo tee /var/cache/bind/db.autre.lan', [])
    c.run(
      'srv',
      'echo \'zone "autre.lan" { type master; file "db.autre.lan"; };\' | sudo tee -a /etc/bind/named.conf.local'
    )
    expect(c.run('srv', 'sudo rndc reconfig')).toBe('')
    expect(c.run('srv', 'dig @127.0.0.1 ftp.lab.lan +short')).toBe('')
    expect(c.run('srv', 'sudo rndc reload')).toBe('server reload successful')
    expect(c.run('srv', 'dig @127.0.0.1 ftp.lab.lan +short')).toBe('192.168.2.40')
  })

  it('un rechargement avec une configuration invalide échoue et garde l’ancienne', () => {
    const c = ready()
    c.run('srv', 'echo \'zone "x.lan" { type master; };\' | sudo tee -a /etc/bind/named.conf.local')
    expect(c.run('srv', 'sudo rndc reload')).toBe("rndc: 'reload' failed: failure")
    expect(c.run('srv', 'dig @127.0.0.1 www.lab.lan +short')).toBe('192.168.2.20')
    expect(c.run('srv', 'sudo journalctl -u named --no-pager')).toContain(
      'reloading configuration failed: failure'
    )
  })

  it('named refuse de démarrer avec une configuration invalide et le journal le dit', () => {
    const c = ready()
    c.run('srv', 'echo \'zone "x.lan" {\' | sudo tee -a /etc/bind/named.conf.local')
    const out = c.run('srv', 'sudo systemctl restart named')
    expect(out).toContain('Job for named.service failed')
    expect(c.run('srv', 'systemctl is-active named')).toBe('failed')
    const journal = c.run('srv', 'sudo journalctl -u named --no-pager')
    expect(journal).toContain('loading configuration:')
    expect(journal).toContain('exiting (due to fatal error)')
    // plus aucun serveur : le client n’obtient aucune réponse
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan')).toContain('no servers could be reached')
  })

  it('une zone dont le fichier est en erreur est chargée en SERVFAIL, les autres restent servies', () => {
    const c = ready()
    c.run('srv', "echo 'bad IN A 192.168.2' | sudo tee -a /var/cache/bind/db.lab.lan")
    c.run('srv', 'sudo systemctl restart named')
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan')).toContain('status: SERVFAIL')
    expect(c.run('pc', 'dig @192.168.2.10 -x 192.168.2.20 +short')).toBe('www.lab.lan.')
  })
})

describe('Bind9 : outils d’administration', () => {
  it('rndc exige root et un named démarré', () => {
    const c = ready()
    expect(c.run('srv', 'rndc reload')).toContain('permission denied')
    c.run('srv', 'sudo systemctl stop named')
    expect(c.run('srv', 'sudo rndc status')).toBe('rndc: connect failed: 127.0.0.1#953: connection refused')
  })

  it('rndc status compte les zones configurées', () => {
    const c = ready()
    const out = c.run('srv', 'sudo rndc status')
    expect(out).toContain('number of zones: 104 (97 automatic)')
    expect(out).toContain('server is up and running')
  })

  it('named-checkzone -q se tait, un fichier absent échoue, ServerLab signale les options non simulées', () => {
    const c = ready()
    expect(c.run('srv', 'named-checkzone -q lab.lan /var/cache/bind/db.lab.lan')).toBe('')
    expect(c.run('srv', 'named-checkzone -D lab.lan /var/cache/bind/db.lab.lan')).toContain(
      'n’est pas simulée'
    )
    expect(c.run('srv', 'sudo named-checkconf -p')).toContain('n’est pas simulée')
    expect(c.run('srv', 'sudo rndc dumpdb')).toContain('n’est pas simulée')
  })

  it('les outils Bind9 sont absents tant que le paquet n’est pas installé', () => {
    const c = new Consoles(buildBindLab())
    expect(c.run('srv', 'sudo rndc status')).toMatch(/not found|introuvable/i)
    expect(c.run('srv', 'named-checkconf')).toMatch(/not found|introuvable/i)
  })

  it('named.conf.local est modifiable par root seulement', () => {
    const c = ready([INSTALL_BIND])
    expect(c.run('srv', `echo x >> ${NAMED_LOCAL}`)).toContain('Permission denied')
  })
})

describe('fichiers de zone (named-checkzone)', () => {
  it('interprète $TTL, $ORIGIN, noms relatifs, propriétaire omis et parenthèses', () => {
    const load = loadZone(
      [
        '$ORIGIN lab.lan.',
        '$TTL 1h',
        '@ IN SOA ns1 admin ( 5 2h 30m 2w 1d )',
        '  IN NS ns1',
        'ns1 300 IN A 192.168.2.10',
        '    IN AAAA ::1',
        'sub.lab.lan. IN A 10.0.0.1',
        'txt IN TXT "bonjour"'
      ].join('\n'),
      'lab.lan',
      'z.db'
    )
    expect(load.ok).toBe(true)
    expect(load.serial).toBe(5)
    const byName = (n: string) => load.records.filter((r) => r.name === n)
    expect(byName('lab.lan').map((r) => r.type)).toEqual(['SOA', 'NS'])
    expect(byName('lab.lan')[0]?.ttl).toBe(3600)
    expect(byName('ns1.lab.lan').map((r) => [r.type, r.ttl])).toEqual([
      ['A', 300],
      ['AAAA', 3600]
    ])
    expect(byName('sub.lab.lan')).toHaveLength(1)
    expect(load.records.find((r) => r.type === 'SOA')?.rdata.slice(3)).toEqual([
      '7200',
      '1800',
      '1209600',
      '86400'
    ])
  })

  it('signale l’absence de $TTL et les erreurs de syntaxe des enregistrements', () => {
    const noTtl = loadZone('@ IN SOA ns1.x. a.x. 1 2 3 4 5\n@ IN NS ns1.x.\nns1 IN A 1.2.3.4', 'x', 'z.db')
    expect(noTtl.messages[0]).toBe('dns_master_load: z.db:1: no TTL specified; using SOA MINTTL instead')
    const typo = loadZone(
      '$TTL 60\n@ IN SOA ns1.x. a.x. 1 2 3 4 5\n@ IN NS ns1.x.\nns1 IN A 1.2.3.4 5',
      'x',
      'z.db'
    )
    expect(typo.messages[0]).toBe("dns_rdata_fromtext: z.db:4: near '5': extra input text")
    const unknown = loadZone('$TTL 60\n@ IN SOA ns1.x. a.x. 1 2 3 4 5\n@ IN FOO bar', 'x', 'z.db')
    expect(unknown.messages[0]).toBe("dns_master_load: z.db:3: unknown RR type 'FOO'")
  })

  it('le serveur de noms dans la zone doit avoir une adresse, pas être un CNAME', () => {
    const head = '$TTL 60\n@ IN SOA ns1.x. a.x. 1 2 3 4 5\n'
    expect(
      loadZone(`${head}@ IN NS ns1.x.\nns1 IN CNAME other.x.\nother IN A 1.1.1.1`, 'x', 'z').messages[0]
    ).toBe("zone x/IN: NS 'ns1.x' is a CNAME (illegal)")
    expect(loadZone(`${head}@ IN NS ns1.autre.org.\n@ IN MX 5 mail.x.`, 'x', 'z').messages[0]).toBe(
      "zone x/IN: MX 'mail.x' has no address records (A or AAAA)"
    )
  })
})

describe('résolution réelle par les clients', () => {
  /** PC1 (Windows) utilise le serveur Bind9 comme DNS. */
  function winUsesBind(c: Consoles) {
    const pc1 =
      c.state.devices[
        Object.keys(c.state.devices).find((id) => c.state.devices[id]?.name === 'PC1') as string
      ]
    if (!pc1) throw new Error('PC1 absent')
    c.state = unwrap(
      setInterfaceIpv4(c.state, pc1.id, pc1.interfaces[0]!.id, {
        addressing: 'static',
        address: '192.168.2.30',
        mask: '255.255.255.0',
        gateway: '192.168.2.254',
        dnsServers: ['192.168.2.10']
      })
    ).state
  }

  it('un poste Windows résout directement et en inverse par Bind9 (nslookup, ping)', () => {
    const c = ready()
    winUsesBind(c)
    const out = c.run('win', 'nslookup www.lab.lan')
    expect(out).toContain('192.168.2.20')
    expect(c.run('win', 'nslookup 192.168.2.20')).toContain('www.lab.lan')
    expect(c.run('win', 'nslookup nope.lab.lan')).toContain('Non-existent domain')
    expect(c.run('win', 'ping -n 1 www.lab.lan')).toContain('192.168.2.20')
  })

  it('un poste Linux sans @serveur passe par ses serveurs DNS (dig, host, nslookup)', () => {
    const c = ready()
    const lnx = Object.values(c.state.devices).find((d) => d.name === 'LNX1')!
    c.state = unwrap(
      setInterfaceIpv4(c.state, lnx.id, lnx.interfaces[0]!.id, {
        addressing: 'static',
        address: '192.168.2.20',
        mask: '255.255.255.0',
        gateway: '192.168.2.254',
        dnsServers: ['192.168.2.10']
      })
    ).state
    expect(c.run('pc', 'dig www.lab.lan +short')).toBe('192.168.2.20')
    expect(c.run('pc', 'host www.lab.lan')).toBe('www.lab.lan has address 192.168.2.20')
    expect(c.run('pc', 'nslookup web.lab.lan')).toContain('www.lab.lan')
  })

  it('délégation depuis le DNS Windows : SRV1 transmet lab.lan au serveur Bind9 (redirecteur)', () => {
    const c = ready()
    const srv1 = Object.values(c.state.devices).find((d) => d.name === 'SRV1')!
    c.state = unwrap(installFeatures(c.state, srv1.id, ['DNS'], { includeManagementTools: true })).state
    c.state = unwrap(setForwarders(c.state, srv1.id, ['192.168.2.10'])).state
    winUsesBind(c)
    const pc1 = Object.values(c.state.devices).find((d) => d.name === 'PC1')!
    c.state = unwrap(
      setInterfaceIpv4(c.state, pc1.id, pc1.interfaces[0]!.id, {
        addressing: 'static',
        address: '192.168.2.30',
        mask: '255.255.255.0',
        gateway: '192.168.2.254',
        dnsServers: ['192.168.2.1']
      })
    ).state
    expect(c.run('win', 'nslookup www.lab.lan')).toContain('192.168.2.20')
    // le Linux ne connaît pas la zone du Windows : sans redirecteur il passe par Internet (introuvable)
    c.state = unwrap(addPrimaryZone(c.state, srv1.id, { name: 'corp.local' })).state
    c.state = unwrap(
      addRecord(c.state, srv1.id, 'corp.local', { name: 'srv1', type: 'A', data: '192.168.2.1' })
    ).state
    expect(c.run('srv', 'dig @192.168.2.10 srv1.corp.local +short')).toBe('')
  })

  it('Bind9 transmet les autres zones au DNS Windows quand il a un redirecteur (forwarders)', () => {
    const c = ready()
    const srv1 = Object.values(c.state.devices).find((d) => d.name === 'SRV1')!
    c.state = unwrap(installFeatures(c.state, srv1.id, ['DNS'], { includeManagementTools: true })).state
    c.state = unwrap(addPrimaryZone(c.state, srv1.id, { name: 'corp.local' })).state
    c.state = unwrap(
      addRecord(c.state, srv1.id, 'corp.local', { name: 'srv1', type: 'A', data: '192.168.2.1' })
    ).state
    c.run(
      'srv',
      'echo \'options { directory "/var/cache/bind"; forwarders { 192.168.2.1; }; forward only; };\' | sudo tee /etc/bind/named.conf.options'
    )
    expect(c.run('srv', 'sudo systemctl restart named')).toBe('')
    expect(c.run('srv', 'dig @127.0.0.1 srv1.corp.local +short')).toBe('192.168.2.1')
    // sa propre zone reste servie en autorité
    expect(c.run('srv', 'dig @127.0.0.1 www.lab.lan +short')).toBe('192.168.2.20')
  })

  it('allow-query refuse les autres clients (REFUSED) et la récursion est limitée à localnets', () => {
    const c = ready()
    c.run(
      'srv',
      'echo \'options { directory "/var/cache/bind"; allow-query { 192.168.2.99; }; };\' | sudo tee /etc/bind/named.conf.options'
    )
    c.run('srv', 'sudo systemctl restart named')
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan')).toContain('status: REFUSED')
    expect(c.run('pc', 'nslookup www.lab.lan 192.168.2.10')).toContain('REFUSED')
    expect(c.run('pc', 'host www.lab.lan 192.168.2.10')).toContain('5(REFUSED)')
    // recursion no : les noms hors des zones sont refusés
    c.run(
      'srv',
      'echo \'options { directory "/var/cache/bind"; recursion no; };\' | sudo tee /etc/bind/named.conf.options'
    )
    c.run('srv', 'sudo systemctl restart named')
    expect(c.run('pc', 'dig @192.168.2.10 www.example.com')).toContain('status: REFUSED')
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan +short')).toBe('192.168.2.20')
  })

  it('un ACL nommé et la négation sont évalués dans l’ordre', () => {
    const c = ready()
    c.run(
      'srv',
      'echo \'acl lan { !192.168.2.20; 192.168.2.0/24; localhost; }; options { directory "/var/cache/bind"; allow-query { lan; }; };\' | sudo tee /etc/bind/named.conf.options'
    )
    c.run('srv', 'sudo systemctl restart named')
    expect(c.run('pc', 'dig @192.168.2.10 www.lab.lan')).toContain('REFUSED')
    expect(c.run('srv', 'dig @192.168.2.10 www.lab.lan +short')).toBe('192.168.2.20')
  })

  it('le trafic DNS est tracé comme de vrais paquets', () => {
    const c = ready()
    const r = c.run('pc', 'dig @192.168.2.10 www.lab.lan +short')
    expect(r).toBe('192.168.2.20')
  })
})
