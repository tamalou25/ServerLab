/**
 * Labs sains de référence des pannes Windows (#230) : les labs fournis avec leur solution appliquée
 * (mêmes actions que l'interface et les consoles). Les domaines ont une stratégie de verrouillage
 * (3 échecs) pour que les comptes puissent se verrouiller.
 */
import {
  addScope,
  autoConfigureDhcp,
  buildLabStart,
  command,
  createItem,
  createShare,
  DEFAULT_DOMAIN_POLICY_ID,
  dispatch,
  domainToken,
  grantNtfs,
  installFeatures,
  joinDomain,
  logon,
  mapDrive,
  parseLab,
  removeNtfs,
  restartComputer,
  sessionToken,
  setDhcpOptions,
  setNtfsInheritance,
  unwrap,
  updateGpoSettings,
  type AnyCommand,
  type Domain,
  type LabState
} from '@engine/index'
import lab2 from '../../../labs/lab-02-dhcp.json'
import lab4 from '../../../labs/lab-04-ad-gpo.json'
import lab5 from '../../../labs/lab-05-ntfs.json'
import lab7 from '../../../labs/lab-07-iis.json'
import { run } from '../shell/helpers'
import { idOf } from './bases'

function start(raw: unknown): LabState {
  const parsed = parseLab(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return buildLabStart(parsed.lab.start)
}

function exec(state: LabState, cmd: AnyCommand): LabState {
  const r = dispatch(state, cmd)
  if (!r.ok) throw new Error(`${cmd.type} : ${r.error.message}`)
  return r.state
}

/** Stratégie de verrouillage du domaine : 3 échecs, 30 minutes. */
const withLockout = (s: LabState): LabState =>
  exec(
    s,
    command('gpo.updateSettings', 'lab.local', DEFAULT_DOMAIN_POLICY_ID, {
      computer: { lockoutThreshold: 3, lockoutDuration: 30, lockoutReset: 30 }
    })
  )

/** Lab 2 (DHCP) résolu : SRV1 distribue 192.168.10.100-200 à PC1 et PC2. */
export function healthyLab02(): LabState {
  let s = start(lab2)
  const srv = idOf(s, 'SRV1')
  s = unwrap(installFeatures(s, srv, ['DHCP'], { includeManagementTools: true })).state
  const scope = unwrap(
    addScope(s, srv, { name: 'LAN', start: '192.168.10.100', end: '192.168.10.200', mask: '255.255.255.0' })
  )
  s = unwrap(
    setDhcpOptions(scope.state, srv, scope.value, {
      router: ['192.168.10.254'],
      dnsServers: ['192.168.10.1']
    })
  ).state
  return autoConfigureDhcp(s).state
}

/** Lab 4 (AD et GPO) résolu : GPO-Compta liée à l'OU Compta, jdupont connecté sur PC1. */
export function healthyLab04(): LabState {
  let s = start(lab4)
  const ps = (line: string) => {
    s = run(s, idOf(s, 'SRV1'), line).state
  }
  ps('New-ADOrganizationalUnit -Name Compta')
  ps(
    'New-ADUser -Name "Jean Dupont" -SamAccountName jdupont -Path "OU=Compta,DC=lab,DC=local" -AccountPassword (ConvertTo-SecureString "Azerty123!" -AsPlainText -Force) -Enabled $true'
  )
  ps('New-ADGroup -Name GG_Compta -GroupScope Global -Path "OU=Compta,DC=lab,DC=local"')
  ps('Add-ADGroupMember -Identity GG_Compta -Members jdupont')
  const pc1 = idOf(s, 'PC1')
  const joined = joinDomain(s, pc1, {
    domain: 'lab.local',
    user: 'LAB\\Administrateur',
    password: 'P@ssw0rd'
  })
  s = unwrap(restartComputer(joined.state, pc1)).state
  ps('New-GPO -Name GPO-Compta')
  ps('New-GPLink -Name GPO-Compta -Target "OU=Compta,DC=lab,DC=local"')
  const gpo = (s.domains['lab.local'] as Domain).gpos.find((g) => g.name === 'GPO-Compta')
  s = unwrap(updateGpoSettings(s, 'lab.local', gpo?.id ?? '', { user: { noControlPanel: 'Enabled' } })).state
  s = logon(s, pc1, { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' }).state
  return withLockout(s)
}

/** Lab 5 (NTFS) résolu : partage Compta (Tout le monde en contrôle total), GG_Compta en modification. */
export function healthyLab05(): LabState {
  let s = start(lab5)
  const srv = idOf(s, 'SRV1')
  const pc1 = idOf(s, 'PC1')
  const admin = domainToken(s.domains['lab.local'] as Domain, 'Administrateur')!
  const path = 'C:\\Partages\\Compta'
  s = unwrap(createItem(s, srv, path, 'folder', admin, { parents: true })).state
  s = unwrap(createShare(s, srv, { name: 'Compta', path, full: ['Tout le monde'] }, admin)).state
  s = unwrap(setNtfsInheritance(s, srv, path, 'convert', admin)).state
  s = unwrap(removeNtfs(s, srv, path, 'BUILTIN\\Utilisateurs', 'all', admin)).state
  s = unwrap(
    grantNtfs(s, srv, path, { principal: 'LAB\\GG_Compta', type: 'Allow', rights: ['Modify'] }, admin)
  ).state
  s = unwrap(
    grantNtfs(
      s,
      srv,
      path,
      { principal: 'LAB\\GG_Direction', type: 'Allow', rights: ['ReadAndExecute'] },
      admin
    )
  ).state
  s = logon(s, pc1, { user: 'jdupont', password: 'Azerty123!', domain: 'LAB' }).state
  s = mapDrive(s, pc1, 'S', '\\\\SRV1\\Compta', sessionToken(s, pc1)).state
  return withLockout(s)
}

/** Lab 7 (IIS) résolu : site Intranet (intranet.lab.local) servi par SRV1. */
export function healthyLab07(): LabState {
  let s = start(lab7)
  const srv = idOf(s, 'SRV1')
  const admin = domainToken(s.domains['lab.local'] as Domain, 'Administrateur')!
  s = unwrap(installFeatures(s, srv, ['Web-Server'], { includeManagementTools: true })).state
  s = unwrap(createItem(s, srv, 'C:\\Sites\\Intranet', 'folder', admin, { parents: true })).state
  s = unwrap(createItem(s, srv, 'C:\\Sites\\Intranet\\index.html', 'file', admin)).state
  for (const cmd of [
    command('iis.addSite', srv, {
      name: 'Intranet',
      physicalPath: 'C:\\Sites\\Intranet',
      binding: { port: 80, host: 'intranet.lab.local' }
    }),
    command('dns.addRecord', srv, 'lab.local', { name: 'intranet', type: 'CNAME', data: 'srv1.lab.local' })
  ])
    s = exec(s, cmd)
  return s
}

export const WINDOWS_BASES: { name: string; build: () => LabState }[] = [
  { name: 'lab-02-dhcp', build: healthyLab02 },
  { name: 'lab-04-ad-gpo', build: healthyLab04 },
  { name: 'lab-05-ntfs', build: healthyLab05 },
  { name: 'lab-07-iis', build: healthyLab07 }
]
