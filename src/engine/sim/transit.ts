/**
 * Crochets de transit des modules de rôles : un rôle peut faire router un serveur, traduire des
 * adresses (NAT), répondre à l'ARP pour une adresse qu'il ne porte pas ou encapsuler des paquets
 * dans un tunnel (VPN), sans que l'acheminement IP du cœur ne connaisse ce rôle.
 */
import type { Device, LabState } from '../model/schema'
import type { PduLayer, TraceEffect } from './trace'

/** Paquet en transit, tel que vu par les crochets. */
export interface TransitPacket {
  src: string
  dst: string
  summary: string
}

/** Paquet évalué par un filtre (liste d'accès) : transport et port de destination. */
export interface FilterPacket extends TransitPacket {
  protocol: 'icmp' | 'tcp' | 'udp' | 'other'
  /** Port de destination TCP / UDP (absent pour une réponse ou un autre protocole). */
  dstPort?: number
  /** Réponse à un échange autorisé (les filtres à états la laissent passer). */
  reply?: boolean
}

/**
 * Décision d'un filtre à états (pare-feu pfSense) : le paquet est autorisé (`pass`, la note explique
 * la règle appliquée), détruit en silence (`block`) ou rejeté (`reject` : l'émetteur reçoit un
 * TCP RST ou un ICMP « port inaccessible »).
 */
export interface FilterDecision {
  action: 'pass' | 'block' | 'reject'
  note: string
  rejectWith?: 'tcp-rst' | 'icmp-port-unreachable'
}

/** Tunnel : le paquet est encapsulé jusqu'à `endpointId`. */
export interface Tunnel {
  /** Adresses du paquet externe (encapsulant). */
  outerSrc: string
  outerDst: string
  endpointId: string
  /** Adresse source du paquet interne à la sortie du tunnel (adresse attribuée au client VPN). */
  innerSrc?: string
  /** Le paquet interne est remis à l'extrémité (sinon il y poursuit sa route). */
  deliver: boolean
  /** Paquet externe en réponse à un échange établi (pare-feu à états). */
  reply: boolean
  summary: string
  upper: PduLayer[]
  /** Explication à l'arrivée du paquet interne. */
  note: string
}

export interface TransitContext {
  state: LabState
  /** Traductions NAT de l'opération : « équipement|adresse publique|hôte distant » → adresse privée. */
  nat: Map<string, string>
  /** Effets durables de l'opération (traductions NAT, compteurs d'ACL…). */
  effects: TraceEffect[]
}

export interface TransitHooks {
  /** Le serveur route-t-il les paquets qui ne lui sont pas destinés (routage LAN) ? */
  forwards?(state: LabState, device: Device): boolean
  /** Adresse portée par l'équipement sans être celle d'une carte (adresse virtuelle HSRP) ? */
  owns?(state: LabState, device: Device, ip: string): boolean
  /** Répond-il à l'ARP pour cette adresse (proxy ARP, clients VPN) ? */
  proxyArp?(state: LabState, device: Device, ip: string): boolean
  /** Paquet adressé à l'une de ses adresses : nouvelle destination (retraduction NAT), ou null. */
  untranslate?(
    ctx: TransitContext,
    device: Device,
    packet: TransitPacket
  ): { dst: string; note: string } | null
  /** Paquet routé par l'interface de sortie : nouvelle adresse source (NAT), ou null. */
  translate?(
    ctx: TransitContext,
    device: Device,
    ingressIfaceId: string | null,
    egressIfaceId: string,
    packet: TransitPacket
  ): { src: string; note: string } | null
  /**
   * Filtrage du paquet à l'entrée (`ingressIfaceId`) ou à la sortie (`egressIfaceId`) d'une
   * interface (listes d'accès, pare-feu) : explication du refus (texte) ou décision d'un filtre à
   * états, ou null s'il passe.
   */
  filter?(
    ctx: TransitContext,
    device: Device,
    ingressIfaceId: string | null,
    egressIfaceId: string | null,
    packet: FilterPacket
  ): string | FilterDecision | null
  /** Tunnel à emprunter depuis cet équipement pour ce paquet (VPN), ou null. */
  tunnel?(state: LabState, device: Device, packet: TransitPacket): Tunnel | null
}
