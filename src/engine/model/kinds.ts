/**
 * Types d'équipements disponibles dans la palette.
 */
export const DEVICE_KINDS = ['server', 'client', 'switch', 'router', 'cloud', 'firewall'] as const

export type DeviceKind = (typeof DEVICE_KINDS)[number]

export interface DeviceKindInfo {
  /** Libellé affiché dans la palette. */
  label: string
  /** Préfixe du nom d'hôte généré automatiquement (SRV1, PC1…). */
  namePrefix: string
  /** Description courte (infobulle). */
  description: string
}

export const DEVICE_KIND_INFO: Record<DeviceKind, DeviceKindInfo> = {
  server: {
    label: 'Serveur',
    namePrefix: 'SRV',
    description: 'Serveur avec rôles (AD DS, DNS, DHCP, fichiers)'
  },
  client: { label: 'Poste client', namePrefix: 'PC', description: 'Poste de travail utilisateur' },
  switch: { label: 'Switch', namePrefix: 'SW', description: 'Commutateur de niveau 2 (16 ports)' },
  router: { label: 'Routeur', namePrefix: 'R', description: 'Routeur avec routage statique (4 interfaces)' },
  firewall: {
    label: 'Pare-feu',
    namePrefix: 'FW',
    description: 'Pare-feu pfSense CE 2.7 (WAN, LAN, DMZ)'
  },
  cloud: { label: 'Internet', namePrefix: 'INTERNET', description: 'Nuage Internet (hôtes publics simulés)' }
}
