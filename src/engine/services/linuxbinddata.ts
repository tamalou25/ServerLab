/**
 * Fichiers fournis par le paquet Debian bind9 (v2.9, #240) : /etc/bind/named.conf et ses inclusions,
 * zones locales db.local, db.127, db.0, db.255. Textes reconstitués d'après le paquet bind9 1:9.18
 * (Debian bookworm) ; à comparer à une installation réelle (docs/fidelite.md, « À vérifier (v2.9 —
 * Linux) », L-90 à L-99).
 */

export const NAMED_CONF_DEFAULT = `// This is the primary configuration file for the BIND DNS server named.
//
// Please read /usr/share/doc/bind9/README.Debian.gz for information on the
// structure of BIND configuration files in Debian, *BEFORE* you customize
// this configuration file.
//
// If you are just adding zones, please do that in /etc/bind/named.conf.local

include "/etc/bind/named.conf.options";
include "/etc/bind/named.conf.local";
include "/etc/bind/named.conf.default-zones";
`

export const NAMED_CONF_OPTIONS_DEFAULT = `options {
\tdirectory "/var/cache/bind";

\t// If there is a firewall between you and nameservers you want
\t// to talk to, you may need to fix the firewall to allow multiple
\t// ports to talk.  See http://www.kb.cert.org/vuls/id/800113

\t// If your ISP provided one or more IP addresses for stable
\t// nameservers, you probably want to use them as forwarders.
\t// Uncomment the following block, and insert the addresses replacing
\t// the all-0's placeholder.

\t// forwarders {
\t// \t0.0.0.0;
\t// };

\t//========================================================================
\t// If BIND logs error messages about the root key being expired,
\t// you will need to update your keys.  See https://www.isc.org/bind-keys
\t//========================================================================
\tdnssec-validation auto;

\tlisten-on-v6 { any; };
};
`

export const NAMED_CONF_LOCAL_DEFAULT = `//
// Do any local configuration here
//

// Consider adding the 1918 zones here, if they are not used in your
// organization
//include "/etc/bind/zones.rfc1918";
`

export const NAMED_CONF_DEFAULT_ZONES = `// prime the server with knowledge of the root servers
zone "." {
\ttype hint;
\tfile "/usr/share/dns/root.hints";
};

// be authoritative for the localhost forward and reverse zones, and for
// broadcast zones as per RFC 1912

zone "localhost" {
\ttype master;
\tfile "/etc/bind/db.local";
};

zone "127.in-addr.arpa" {
\ttype master;
\tfile "/etc/bind/db.127";
};

zone "0.in-addr.arpa" {
\ttype master;
\tfile "/etc/bind/db.0";
};

zone "255.in-addr.arpa" {
\ttype master;
\tfile "/etc/bind/db.255";
};
`

export const DB_LOCAL = `;
; BIND data file for local loopback interface
;
$TTL\t604800
@\tIN\tSOA\tlocalhost. root.localhost. (
\t\t\t      2\t\t; Serial
\t\t\t 604800\t\t; Refresh
\t\t\t  86400\t\t; Retry
\t\t\t2419200\t\t; Expire
\t\t\t 604800 )\t; Negative Cache TTL
;
@\tIN\tNS\tlocalhost.
@\tIN\tA\t127.0.0.1
@\tIN\tAAAA\t::1
`

export const DB_127 = `;
; BIND reverse data file for local loopback interface
;
$TTL\t604800
@\tIN\tSOA\tlocalhost. root.localhost. (
\t\t\t      1\t\t; Serial
\t\t\t 604800\t\t; Refresh
\t\t\t  86400\t\t; Retry
\t\t\t2419200\t\t; Expire
\t\t\t 604800 )\t; Negative Cache TTL
;
@\tIN\tNS\tlocalhost.
1.0.0\tIN\tPTR\tlocalhost.
`

export const DB_EMPTY_ZONE = `;
; BIND reverse data file for broadcast zone
;
$TTL\t604800
@\tIN\tSOA\tlocalhost. root.localhost. (
\t\t\t      1\t\t; Serial
\t\t\t 604800\t\t; Refresh
\t\t\t  86400\t\t; Retry
\t\t\t2419200\t\t; Expire
\t\t\t 604800 )\t; Negative Cache TTL
;
@\tIN\tNS\tlocalhost.
`

/** Fichiers texte apportés par le paquet (chemin → contenu). */
export const BIND_PROVIDED: Record<string, string> = {
  '/etc/bind/named.conf': NAMED_CONF_DEFAULT,
  '/etc/bind/named.conf.options': NAMED_CONF_OPTIONS_DEFAULT,
  '/etc/bind/named.conf.local': NAMED_CONF_LOCAL_DEFAULT,
  '/etc/bind/named.conf.default-zones': NAMED_CONF_DEFAULT_ZONES,
  '/etc/bind/db.local': DB_LOCAL,
  '/etc/bind/db.127': DB_127,
  '/etc/bind/db.0': DB_EMPTY_ZONE,
  '/etc/bind/db.255': DB_EMPTY_ZONE,
  // Liste des serveurs racine (paquet dns-root-data) : non modélisée, la zone « . » n'est pas interrogée
  '/usr/share/dns/root.hints': '; Liste des serveurs racine (non modélisée par ServerLab)\n'
}

/** Options reconnues dans « options { } » (named.conf(5), BIND 9.18). */
export const OPTIONS_KNOWN = new Set(
  `acache-cleaning-interval acache-enable additional-from-auth additional-from-cache allow-new-zones allow-notify
allow-query allow-query-cache allow-query-cache-on allow-query-on allow-recursion allow-recursion-on
allow-transfer allow-update allow-update-forwarding also-notify alt-transfer-source alt-transfer-source-v6
answer-cookie auth-nxdomain automatic-interface-scan avoid-v4-udp-ports avoid-v6-udp-ports bindkeys-file
blackhole cache-file catalog-zones check-dup-records check-integrity check-mx check-mx-cname check-names
check-sibling check-spf check-srv-cname check-wildcard clients-per-query cookie-algorithm cookie-secret
coresize datasize deny-answer-addresses deny-answer-aliases dialup directory disable-algorithms
disable-ds-digests disable-empty-zone dns64 dns64-contact dns64-server dnskey-sig-validity dnsrps-enable
dnsrps-options dnssec-accept-expired dnssec-dnskey-kskonly dnssec-loadkeys-interval dnssec-must-be-secure
dnssec-policy dnssec-secure-to-insecure dnssec-update-mode dnssec-validation dnstap dnstap-identity
dnstap-output dnstap-version dscp dual-stack-servers edns-udp-size empty-contact empty-server empty-zones-enable
fetch-quota-params fetches-per-server fetches-per-zone files flush-zones-on-shutdown forward forwarders
fstrm-set-buffer-hint fstrm-set-flush-timeout fstrm-set-input-queue-size fstrm-set-output-notify-threshold
fstrm-set-output-queue-model fstrm-set-output-queue-size fstrm-set-reopen-interval geoip-directory glue-cache
heartbeat-interval hostname inline-signing interface-interval ixfr-from-differences keep-response-order
key-directory lame-ttl listen-on listen-on-v6 lmdb-mapsize mailbox-size managed-keys-directory masterfile-format
masterfile-style match-mapped-addresses max-cache-size max-cache-ttl max-clients-per-query max-journal-size
max-ncache-ttl max-records max-recursion-depth max-recursion-queries max-refresh-time max-retry-time
max-rsa-exponent-size max-stale-ttl max-transfer-idle-in max-transfer-idle-out max-transfer-time-in
max-transfer-time-out max-udp-size max-zone-ttl memstatistics memstatistics-file message-compression
min-cache-ttl min-ncache-ttl min-refresh-time min-retry-time minimal-any minimal-responses multi-master
new-zones-directory no-case-compress nocookie-udp-size notify notify-delay notify-rate notify-source
notify-source-v6 notify-to-soa nta-lifetime nta-recheck nxdomain-redirect parental-source parental-source-v6
pid-file plugin port preferred-glue prefetch provide-ixfr qname-minimization query-source query-source-v6
querylog queryport-pool-ports queryport-pool-updateinterval random-device rate-limit recursing-file recursion
recursive-clients request-expire request-ixfr request-nsid reserved-sockets resolver-nonbackoff-tries
resolver-query-timeout resolver-retry-interval response-padding response-policy reuseport root-delegation-only
root-key-sentinel rrset-order secroots-file send-cookie serial-query-rate serial-update-method server-id
servfail-ttl session-keyalg session-keyfile session-keyname sig-signing-nodes sig-signing-signatures
sig-signing-type sig-validity-interval sortlist stacksize stale-answer-client-timeout stale-answer-enable
stale-answer-ttl stale-cache-enable stale-refresh-time startup-notify-rate statistics-file synth-from-dnssec
tcp-advertised-timeout tcp-clients tcp-idle-timeout tcp-initial-timeout tcp-keepalive-timeout tcp-listen-queue
tkey-dhkey tkey-domain tkey-gssapi-credential tkey-gssapi-keytab transfer-format transfer-message-size
transfer-source transfer-source-v6 transfers-in transfers-out transfers-per-ns trust-anchor-telemetry
try-tcp-refresh update-check-ksk use-alt-transfer-source use-v4-udp-ports use-v6-udp-ports v6-bias validate-except
version zero-no-soa-ttl zero-no-soa-ttl-cache zone-statistics`.split(/\s+/)
)

/** Options reconnues dans « zone { } ». */
export const ZONE_OPTIONS_KNOWN = new Set(
  `type file masters primaries also-notify allow-notify allow-query allow-query-on allow-transfer allow-update
allow-update-forwarding auto-dnssec check-dup-records check-integrity check-mx check-mx-cname check-names
check-sibling check-spf check-srv-cname check-wildcard database delegation-only dialup dlz dnssec-dnskey-kskonly
dnssec-loadkeys-interval dnssec-policy dnssec-secure-to-insecure dnssec-update-mode forward forwarders in-view
inline-signing ixfr-from-differences journal key-directory max-journal-size max-records max-refresh-time
max-retry-time max-transfer-idle-in max-transfer-idle-out max-transfer-time-in max-transfer-time-out
max-zone-ttl min-refresh-time min-retry-time multi-master notify notify-delay notify-source notify-source-v6
notify-to-soa nsec3-test-zone parental-agents parental-source parental-source-v6 request-expire request-ixfr
serial-update-method server-addresses server-names sig-signing-nodes sig-signing-signatures sig-signing-type
sig-validity-interval transfer-source transfer-source-v6 try-tcp-refresh update-check-ksk update-policy
use-alt-transfer-source zero-no-soa-ttl zone-statistics`.split(/\s+/)
)

/** Instructions de premier niveau reconnues. */
export const TOP_LEVEL_KNOWN = new Set([
  'acl',
  'controls',
  'dlz',
  'dnssec-policy',
  'http',
  'include',
  'key',
  'logging',
  'managed-keys',
  'masters',
  'primaries',
  'options',
  'parental-agents',
  'plugin',
  'server',
  'statistics-channels',
  'tls',
  'trust-anchors',
  'trusted-keys',
  'view',
  'zone'
])
