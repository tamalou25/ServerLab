/**
 * Paquets installés d'un serveur ou poste Linux (v2.9, #236) : version du système, paquets de base
 * et paquets ajoutés par apt. Module sans dépendance au reste des services Linux.
 */
import type { Draft } from 'immer'
import type { HostDevice } from '../model/schema'
import { PACKAGES, type LinuxRelease } from './linuxcatalog'

type AnyHost = HostDevice | Draft<HostDevice>

/** Version du système : serveur = distribution du champ `linux` (Debian 12 par défaut), poste = Ubuntu 22.04. */
export function linuxRelease(host: AnyHost): LinuxRelease {
  if (host.kind === 'client') return 'ubuntu2204'
  return host.host.linux?.distro === 'ubuntu2404' ? 'ubuntu2404' : 'debian12'
}

/** Paquets installés d'office (système neuf). */
export function basePackages(host: AnyHost): string[] {
  return PACKAGES.filter((p) => p.base === 'all' || (p.base === 'server' && host.kind === 'server')).map(
    (p) => p.name
  )
}

/** Paquets installés, triés par nom. */
export function installedPackages(host: AnyHost): string[] {
  return [...(host.host.linux?.packages ?? basePackages(host))].sort()
}

export const isInstalled = (host: AnyHost, pkg: string) => installedPackages(host).includes(pkg)
