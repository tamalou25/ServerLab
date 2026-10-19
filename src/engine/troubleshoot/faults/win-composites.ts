/**
 * Pannes composées Windows (chantier D, #230) : deux causes, la première masque la seconde. Chaque
 * partie est une panne simple du catalogue, éventuellement restreinte à un service (les sondes de
 * `service-probes.ts`) pour que le masque soit réel. Voir `composite.ts` pour le mécanisme.
 */
import { defineComposite } from '../composite'
import type { FaultDef } from '../types'
import { accountLocked } from './win-account'
import { clockSkew } from './win-clock'
import { dhcpScopeDisabled, dhcpScopeExhausted } from './win-dhcp'
import { dnsWrongA } from './win-dns-record'
import { serviceFault } from './service-fault'
import { stoppedSpec } from './service-stopped'
import { dependencySpec, failedSpec } from './win-services'
import { gpoUnlinked } from './win-gpo'
import { ntfsRights } from './win-share'

const stoppedOf = (service: string) => serviceFault({ ...stoppedSpec, only: [service] })
const failedOf = (service: string) => serviceFault({ ...failedSpec, only: [service] })

export const WINDOWS_COMPOSITES: readonly FaultDef[] = [
  // DNS arrêté : le nom ne se résout plus, on ne voit pas qu'il pointerait au mauvais endroit
  defineComposite({
    id: 'win.combo.dns-stopped-wrong-a',
    title: 'DNS arrêté qui masque un enregistrement A erroné',
    difficulty: 3,
    masker: stoppedOf('DNS'),
    masked: dnsWrongA
  }),
  // Horloge décalée : Kerberos refuse la session avant même de regarder l'état du compte
  defineComposite({
    id: 'win.combo.clock-account-locked',
    title: 'Horloge décalée qui masque un compte verrouillé',
    difficulty: 3,
    masker: clockSkew,
    masked: accountLocked
  }),
  // Service DHCP arrêté : on ne voit pas que l'étendue est aussi désactivée
  defineComposite({
    id: 'win.combo.dhcp-stopped-scope-disabled',
    title: 'Service DHCP arrêté qui masque une étendue désactivée',
    difficulty: 3,
    masker: stoppedOf('DHCPServer'),
    masked: dhcpScopeDisabled
  }),
  // Service DHCP en échec : une fois relancé, l'étendue se révèle épuisée
  defineComposite({
    id: 'win.combo.dhcp-failed-scope-exhausted',
    title: 'Service DHCP en échec qui masque une étendue épuisée',
    difficulty: 3,
    masker: failedOf('DHCPServer'),
    masked: dhcpScopeExhausted
  }),
  // Netlogon tombé avec sa dépendance : sans contrôleur joignable, on ne voit pas la GPO non liée
  defineComposite({
    id: 'win.combo.dc-dependency-gpo-unlinked',
    title: 'Contrôleur injoignable qui masque une GPO non liée',
    difficulty: 3,
    masker: serviceFault({ ...dependencySpec, only: ['Netlogon'] }),
    masked: gpoUnlinked
  }),
  // Service Serveur arrêté : erreur 53 avant tout contrôle de droits
  defineComposite({
    id: 'win.combo.lanman-stopped-ntfs-rights',
    title: 'Service Serveur arrêté qui masque des droits NTFS incohérents',
    difficulty: 3,
    masker: stoppedOf('LanmanServer'),
    masked: ntfsRights
  })
]
