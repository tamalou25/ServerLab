/**
 * Dépendances entre services système (v2.8, chantier A, issue #223).
 *
 * Table constante, pure et sans état : rien n'est stocké dans le fichier .slab. Elle est
 * appliquée aux services réellement présents sur l'ordinateur (`hostServices`) : un service
 * dépendant d'un rôle absent n'existe pas, et une dépendance vers un service absent est ignorée.
 *
 * Règle : n'y figurent QUE des dépendances sourcées. Les autres sont listées « à vérifier » dans
 * docs/fidelite.md (« À vérifier (v2.8 — services) ») et ne sont pas codées.
 */

/** Dépendances directes : nom du service → noms des services dont il a besoin (`DependOnService`). */
export const SERVICE_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  // « To stop the web server, you must stop the Windows Process Activation Service (WAS) and the
  // World Wide Web Publishing Service (W3SVC) » ; « net stop WAS … type Y to stop W3SVC as well » ;
  // « net start W3SVC … to start both WAS and W3SVC ».
  // https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/jj635851(v=ws.11)
  W3SVC: ['WAS'],
  // « The Netlogon service depends on the Workstation service. […] On DCs, the Netlogon service
  // has additional dependencies on the Server service » ; `sc qc netlogon` (contrôleur de
  // domaine) : « DEPENDENCIES : LanmanWorkstation / LanmanServer ». Netlogon n'existe dans le
  // modèle que sur un contrôleur de domaine (rôle AD DS).
  // https://learn.microsoft.com/en-us/troubleshoot/windows-server/windows-security/troubleshoot-netlogon-service-startup-failures
  Netlogon: ['LanmanWorkstation', 'LanmanServer']
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Services requis directement par `name`, restreints aux services présents (`present` : noms
 * courts des services de l'ordinateur). Ordre de la table.
 */
export function requiredNames(name: string, present: readonly string[]): string[] {
  const key = Object.keys(SERVICE_REQUIRES).find((k) => eq(k, name))
  const wanted = key ? (SERVICE_REQUIRES[key] ?? []) : []
  return wanted.flatMap((w) => present.find((p) => eq(p, w)) ?? [])
}

/** Services qui dépendent directement de `name` (parmi les services présents). */
export function directDependentNames(name: string, present: readonly string[]): string[] {
  return present.filter((p) => requiredNames(p, present).some((r) => eq(r, name)))
}

/**
 * Tous les services qui dépendent de `name`, directement ou non (ServiceController.DependentServices).
 * Ordre : les plus éloignés d'abord, c'est l'ordre dans lequel il faut les arrêter.
 */
export function dependentNames(name: string, present: readonly string[]): string[] {
  const out: string[] = []
  const visit = (n: string, seen: string[]) => {
    for (const d of directDependentNames(n, present)) {
      if (seen.some((s) => eq(s, d))) continue
      visit(d, [...seen, d])
      if (!out.some((o) => eq(o, d))) out.push(d)
    }
  }
  visit(name, [name])
  return out
}

/** Dépendances requises, directes ou non, dans l'ordre de démarrage (les plus profondes d'abord). */
export function requiredChain(name: string, present: readonly string[]): string[] {
  const out: string[] = []
  const visit = (n: string, seen: string[]) => {
    for (const r of requiredNames(n, present)) {
      if (seen.some((s) => eq(s, r))) continue
      visit(r, [...seen, r])
      if (!out.some((o) => eq(o, r))) out.push(r)
    }
  }
  visit(name, [name])
  return out
}
