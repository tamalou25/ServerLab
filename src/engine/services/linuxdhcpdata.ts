/**
 * Fichiers fournis par le paquet Debian isc-dhcp-server 4.4.3-P1 (v2.9, #240) : /etc/dhcp/dhcpd.conf,
 * /etc/default/isc-dhcp-server et base des baux. Textes reconstitués d'après le paquet (dhcpd.conf
 * abrégé : les sous-réseaux d'exemple commentés ne sont pas recopiés) ; à comparer à une installation
 * réelle (docs/fidelite.md, « À vérifier (v2.9 — Linux) », L-90 à L-99).
 */

export const DHCPD_CONF_DEFAULT = `# dhcpd.conf
#
# Sample configuration file for ISC dhcpd
#

# option definitions common to all supported networks...
option domain-name "example.org";
option domain-name-servers ns1.example.org, ns2.example.org;

default-lease-time 600;
max-lease-time 7200;

# The ddns-updates-style parameter controls whether or not the server will
# attempt to do a DNS update when a lease is confirmed. We default to the
# behavior of the version 2 packages ('none', since DHCP v2 didn't
# have support for DDNS.)
ddns-update-style none;

# If this DHCP server is the official DHCP server for the local
# network, the authoritative directive should be uncommented.
#authoritative;

# Use this to send dhcp log messages to a different log file (you also
# have to hack syslog.conf to complete the redirection).
#log-facility local7;

# No service will be given on this subnet, but declaring it helps the
# DHCP server to understand the network topology.

#subnet 10.152.187.0 netmask 255.255.255.0 {
#}

# This is a very basic subnet declaration.

#subnet 10.254.239.0 netmask 255.255.255.224 {
#  range 10.254.239.10 10.254.239.20;
#  option routers rtr-239-0-1.example.org, rtr-239-0-2.example.org;
#}
`

export const DEFAULT_ISC_DHCP_SERVER = `# Defaults for isc-dhcp-server (sourced by /etc/init.d/isc-dhcp-server)

# Path to dhcpd's config file (default: /etc/dhcp/dhcpd.conf).
#DHCPDv4_CONF=/etc/dhcp/dhcpd.conf
#DHCPDv6_CONF=/etc/dhcp/dhcpd6.conf

# Path to dhcpd's PID file (default: /var/run/dhcpd.pid).
#DHCPDv4_PID=/var/run/dhcpd.pid
#DHCPDv6_PID=/var/run/dhcpd6.pid

# Additional options to start dhcpd with.
#\tDon't use options -cf or -pf here; use DHCPD_CONF/ DHCPD_PID instead
#OPTIONS=""

# On what interfaces should the DHCP server (dhcpd) serve DHCP requests?
#\tSeparate multiple interfaces with spaces, e.g. "eth0 eth1".
INTERFACESv4=""
INTERFACESv6=""
`

/** En-tête de la base des baux écrite par dhcpd (la version est celle du paquet). */
export const leasesHeader = (version: string) =>
  `# The format of this file is documented in the dhcpd.leases(5) manual page.\n# This lease file was written by isc-dhcp-${version}\n\n`
