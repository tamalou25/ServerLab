/**
 * `sc qc <service>` : configuration d'un service (v2.8, chantier A, issue #225).
 *
 * Sources Microsoft Learn :
 * - Champs affichés par `qc` : SERVICE_NAME, TYPE, ERROR_CONTROL, BINARY_PATH_NAME, LOAD_ORDER_GROUP,
 *   TAG, DISPLAY_NAME, DEPENDENCIES, SERVICE_START_NAME (page SC de la bibliothèque TechNet,
 *   https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-xp/bb490995(v=technet.10) ;
 *   la page `windows-commands/sc-qc` n'existe pas sur Learn).
 * - Mise en page et valeurs : exemple `sc qc netlogon` d'un contrôleur de domaine
 *   (https://learn.microsoft.com/en-us/troubleshoot/windows-server/windows-security/troubleshoot-netlogon-service-startup-failures).
 *
 * Calculé depuis l'état : DISPLAY_NAME (modèle), START_TYPE (type de démarrage du service, le même
 * que Get-Service), DEPENDENCIES (servicedeps.ts). TYPE, ERROR_CONTROL, BINARY_PATH_NAME,
 * LOAD_ORDER_GROUP, TAG et SERVICE_START_NAME ne sont pas calculables : ils ne sont affichés que
 * pour les services dont une source donne la valeur (table ci-dessous). Les autres services
 * reçoivent un message honnête, jamais une valeur plausible (docs/fidelite.md, « À vérifier »).
 */
import { requiredServices, type ServiceInfo, type ServiceStartType } from '../../services/hostservices'
import type { ExecContext } from '../context'

/** Valeurs de configuration sourcées (clé : nom court en minuscules). */
interface SourcedConfig {
  type: string
  errorControl: string
  binaryPath: string
  loadOrderGroup: string
  tag: string
  startName: string
}

const SOURCED: Readonly<Record<string, SourcedConfig>> = {
  // Exemple `sc qc netlogon` du contrôleur de domaine (page Learn ci-dessus).
  netlogon: {
    type: '20 WIN32_SHARE_PROCESS',
    errorControl: '1 NORMAL',
    binaryPath: 'C:\\Windows\\system32\\lsass.exe',
    loadOrderGroup: 'MS_WindowsRemoteValidation',
    tag: '0',
    startName: 'LocalSystem'
  }
}

/** START_TYPE de l'API Win32 (SERVICE_AUTO_START = 2, DEMAND_START = 3, DISABLED = 4). */
const START_TYPE: Record<ServiceStartType, string> = {
  Automatic: '2 AUTO_START',
  Manual: '3 DEMAND_START',
  Disabled: '4 DISABLED'
}

/** `typed` : nom saisi par l'utilisateur (sc réaffiche le nom tel qu'il a été tapé). */
export function scQc(ctx: ExecContext, service: ServiceInfo, typed: string): void {
  const cfg = SOURCED[service.name.toLowerCase()]
  if (!cfg) {
    ctx.writeLines(
      [
        `La configuration détaillée de « ${service.name} » (TYPE, ERROR_CONTROL, BINARY_PATH_NAME, SERVICE_START_NAME) n’est pas simulée dans ServerLab : aucune source publiée ne donne ces valeurs pour ce service, elles ne sont donc pas inventées.`,
        `Type de démarrage et état : sc query ${service.name}, Get-Service ${service.name}. Dépendances : Get-Service ${service.name} -RequiredServices.`,
        ''
      ],
      'error'
    )
    return
  }
  const deps = requiredServices(ctx.state, ctx.deviceId, service.name).map((d) => d.name)
  const field = (label: string, value: string) => `   ${label.padEnd(19)}: ${value}`.trimEnd()
  const name = typed.toLowerCase() === service.name.toLowerCase() ? typed : service.name
  ctx.writeLines([
    '[SC] QueryServiceConfig réussite(s)',
    '',
    `NOM_SERVICE: ${name}`,
    field('TYPE', cfg.type),
    field('START_TYPE', START_TYPE[service.startType]),
    field('ERROR_CONTROL', cfg.errorControl),
    field('BINARY_PATH_NAME', cfg.binaryPath),
    field('LOAD_ORDER_GROUP', cfg.loadOrderGroup),
    field('TAG', cfg.tag),
    field('DISPLAY_NAME', service.display),
    field('DEPENDENCIES', deps[0] ?? ''),
    ...deps.slice(1).map((d) => field('', d)),
    field('SERVICE_START_NAME', cfg.startName),
    ''
  ])
}
