/**
 * Contenu des fenêtres du Bureau simulé selon l'application.
 */
import type { ReactNode } from 'react'
import type { HostDevice } from '@engine/index'
import type { DesktopWindow } from '../../store/desktop'
import { AdacApp } from '../apps/AdacApp'
import { AducApp } from '../apps/AducApp'
import { CertSrvApp } from '../apps/CertSrvApp'
import { DfsApp } from '../apps/DfsApp'
import { DhcpApp } from '../apps/DhcpApp'
import { DnsApp } from '../apps/DnsApp'
import { FirewallApp } from '../apps/FirewallApp'
import { ServicesApp } from '../apps/ServicesApp'
import { GpmcApp } from '../apps/GpmcApp'
import { GpoEditor } from '../apps/GpoEditor'
import { HyperVApp } from '../apps/HyperVApp'
import { IisApp } from '../apps/IisApp'
import { RdsApp } from '../apps/RdsApp'
import { RrasApp } from '../apps/RrasApp'
import { DssiteApp } from '../apps/DssiteApp'
import { NpsApp } from '../apps/NpsApp'
import { WbadminApp } from '../apps/WbadminApp'
import { WsusApp } from '../apps/WsusApp'
import { Terminal } from '../console/Terminal'
import { AddRolesWizard } from './apps/AddRolesWizard'
import { CmdDisabled } from './apps/CmdDisabled'
import { ControlPanel } from './apps/ControlPanel'
import { DhcpPostInstall } from './apps/DhcpPostInstall'
import { EventViewer } from './apps/EventViewer'
import {
  AdapterPropertiesDialog,
  AdapterStatusDialog,
  Ipv4PropertiesDialog,
  NetDetailsDialog,
  NetworkConnections
} from './apps/Network'
import { PromoteWizard } from './apps/PromoteWizard'
import { RecycleBin } from './apps/RecycleBin'
import { RunDialog } from './apps/RunDialog'
import { ServerManager } from './apps/ServerManager'
import { ComputerNameDialog, SystemProperties } from './apps/System'
import { Explorer } from './apps/Explorer'
import { FileProperties } from './apps/FileProperties'
import { NewShareDialog } from './apps/NewShareDialog'
import { WindowsUpdate } from './apps/WindowsUpdate'
import { Browser } from './apps/Browser'
import { RemoteDesktop } from './apps/RemoteDesktop'
import { VpnSettings } from './apps/VpnSettings'

function unavailable(): ReactNode {
  return <div className="p-6 text-sm text-slate-500">Application indisponible sur cet ordinateur.</div>
}

export function renderApp(win: DesktopWindow, device: HostDevice): ReactNode {
  const server = device.kind === 'server' ? device : null
  switch (win.app) {
    case 'servermanager':
      return server ? <ServerManager device={server} /> : unavailable()
    case 'powershell':
      return <Terminal deviceId={device.id} kind="powershell" autoFocus />
    case 'cmd':
      // Invite de commandes désactivée par stratégie de groupe (PowerShell reste disponible)
      return device.host.policy.user?.settings.noCmd === 'Enabled' ? (
        <CmdDisabled />
      ) : (
        <Terminal deviceId={device.id} kind="cmd" autoFocus />
      )
    case 'ncpa':
      return <NetworkConnections device={device} />
    case 'netstatus':
      return <AdapterStatusDialog device={device} ifaceId={win.arg} />
    case 'netprops':
      return <AdapterPropertiesDialog device={device} ifaceId={win.arg} />
    case 'netdetails':
      return <NetDetailsDialog device={device} ifaceId={win.arg} />
    case 'ipv4':
      return <Ipv4PropertiesDialog device={device} ifaceId={win.arg} />
    case 'sysdm':
      return <SystemProperties device={device} />
    case 'sysdmname':
      return <ComputerNameDialog device={device} />
    case 'control':
      return <ControlPanel device={device} />
    case 'eventvwr':
      return <EventViewer device={device} />
    case 'services':
      return <ServicesApp device={device} />
    case 'wf':
      return <FirewallApp device={device} />
    case 'dhcp':
      return server ? <DhcpApp device={server} /> : unavailable()
    case 'dns':
      return server ? <DnsApp device={server} /> : unavailable()
    case 'aduc':
      return <AducApp device={device} />
    case 'dsac':
      return <AdacApp device={device} />
    case 'gpmc':
      return <GpmcApp device={device} />
    case 'gpme':
      return <GpoEditor device={device} gpoId={win.arg} />
    case 'explorer':
      return <Explorer device={device} {...(win.arg !== undefined ? { initial: win.arg } : {})} />
    case 'fileprops':
      return <FileProperties device={device} path={win.arg} />
    case 'newshare':
      return server ? <NewShareDialog device={server} /> : unavailable()
    case 'wsus':
      return server ? <WsusApp device={server} /> : unavailable()
    case 'inetmgr':
      return server ? <IisApp device={server} /> : unavailable()
    case 'dfsmgmt':
      return server ? <DfsApp device={server} /> : unavailable()
    case 'wbadmin':
      return server ? <WbadminApp device={server} /> : unavailable()
    case 'certsrv':
      return server ? <CertSrvApp device={server} /> : unavailable()
    case 'hypervmgr':
      return server ? <HyperVApp device={server} /> : unavailable()
    case 'rdsmgr':
      return server ? <RdsApp device={server} /> : unavailable()
    case 'mstsc':
      return <RemoteDesktop device={device} />
    case 'dssite':
      return <DssiteApp device={device} />
    case 'rrasmgmt':
      return server ? <RrasApp device={server} /> : unavailable()
    case 'nps':
      return server ? <NpsApp device={server} /> : unavailable()
    case 'vpnclient':
      return <VpnSettings device={device} />
    case 'browser':
      return <Browser device={device} />
    case 'wuclient':
      return <WindowsUpdate device={device} />
    case 'run':
      return <RunDialog device={device} />
    case 'addroles':
      return server ? (
        <AddRolesWizard device={server} mode={win.arg === 'remove' ? 'remove' : 'install'} />
      ) : (
        unavailable()
      )
    case 'adpromote':
      return server ? <PromoteWizard device={server} /> : unavailable()
    case 'dhcppost':
      return server ? <DhcpPostInstall device={server} /> : unavailable()
    case 'recycle':
      return <RecycleBin />
    default:
      return unavailable()
  }
}
