/**
 * Snap-in Services (services.msc) : liste des services de l'ordinateur, démarrage, arrêt,
 * redémarrage et propriétés (type de démarrage, dépendances). L'état vient du moteur ;
 * toute modification passe par les commandes nommées `service.*` (annulables).
 * Le moteur ne modélise ni la pause ni les dépendances : pas d'action « Suspendre », onglet
 * Dépendances en lecture seule.
 */
import { useState } from 'react'
import { Cog } from 'lucide-react'
import { command, computerServices, type HostDevice, type ServiceStartType } from '@engine/index'
import { runCommandOk } from '../../lib/run'
import { logonAccount, START_TYPE_LABELS, statusLabel } from '../../lib/services'
import { useLabStore } from '../../store/lab'
import { DialogBody, DialogFooter, TabStrip, WinButton } from '../desktop/shell/classic'
import { Mmc, MmcAction, MmcTable, type MmcNode } from '../mmc/Mmc'

type Tab = 'general' | 'deps'

const NODES: MmcNode[] = [{ id: 'root', label: 'Services (local)', icon: Cog }]

export function ServicesApp({ device }: { device: HostDevice }) {
  const lab = useLabStore((s) => s.lab)
  const [selected, setSelected] = useState<string | null>(null)
  const [props, setProps] = useState<string | null>(null)
  const services = computerServices(lab, device.id)
  const current = services.find((s) => s.name === selected)

  const run = (type: 'service.start' | 'service.stop' | 'service.restart', name: string) =>
    runCommandOk(command(type, device.id, name))

  const actions = current ? (
    <>
      <MmcAction onClick={() => run('service.start', current.name)} testId="svc-start">
        Démarrer
      </MmcAction>
      <MmcAction onClick={() => run('service.stop', current.name)} testId="svc-stop">
        Arrêter
      </MmcAction>
      <MmcAction onClick={() => run('service.restart', current.name)} testId="svc-restart">
        Redémarrer
      </MmcAction>
      <MmcAction onClick={() => setProps(current.name)} testId="svc-properties">
        Propriétés
      </MmcAction>
    </>
  ) : (
    <span className="px-2 py-1 text-xs text-slate-400">Sélectionnez un service.</span>
  )

  return (
    <Mmc nodes={NODES} selected="root" onSelect={() => undefined} actions={actions} testId="services-mmc">
      <MmcTable
        testId="svc-table"
        columns={['Nom', 'Description', 'État', 'Type de démarrage', 'Ouvrir une session en tant que']}
        empty="Aucun service."
        rows={services.map((s) => [
          <span
            key="n"
            className={`block cursor-pointer ${selected === s.name ? 'bg-sky-100 font-semibold' : ''}`}
            onClick={() => setSelected(s.name)}
            onDoubleClick={() => setProps(s.name)}
            data-testid={`svc-row-${s.name}`}
          >
            {s.display}
          </span>,
          '',
          <span key="s" data-testid={`svc-status-${s.name}`}>
            {statusLabel(s)}
          </span>,
          <span key="t" data-testid={`svc-start-${s.name}`}>
            {START_TYPE_LABELS[s.startType]}
          </span>,
          logonAccount(s.name)
        ])}
      />
      {props && <ServiceProperties deviceId={device.id} name={props} onClose={() => setProps(null)} />}
    </Mmc>
  )
}

/** Fenêtre de propriétés d'un service : onglets Général et Dépendances. */
function ServiceProperties({
  deviceId,
  name,
  onClose
}: {
  deviceId: string
  name: string
  onClose: () => void
}) {
  const lab = useLabStore((s) => s.lab)
  const svc = computerServices(lab, deviceId).find((s) => s.name === name)
  const [tab, setTab] = useState<Tab>('general')
  const [startType, setStartType] = useState<ServiceStartType | null>(null)
  if (!svc) return null
  const chosen = startType ?? svc.startType
  const apply = () =>
    chosen === svc.startType || runCommandOk(command('service.setStartType', deviceId, svc.name, chosen))
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/10">
      <div
        className="flex w-96 flex-col border border-[#7a7a7a] bg-[#f0f0f0] text-xs text-black shadow-xl"
        data-testid="svc-dialog"
      >
        <p className="px-3 pt-2 pb-1 font-semibold">Propriétés de {svc.display} (Ordinateur local)</p>
        <TabStrip
          tabs={[
            { id: 'general' as const, label: 'Général' },
            { id: 'deps' as const, label: 'Dépendances' }
          ]}
          active={tab}
          onChange={setTab}
        />
        <DialogBody className="min-h-48 bg-white">
          {tab === 'general' ? (
            <div className="flex flex-col gap-2" data-testid="svc-general">
              <p>
                Nom du service : <span className="selectable">{svc.name}</span>
              </p>
              <p>
                Nom complet : <span className="selectable">{svc.display}</span>
              </p>
              <label className="flex flex-col gap-1">
                Type de démarrage :
                <select
                  className="h-[23px] border border-[#7a7a7a] bg-white px-1 text-xs"
                  value={chosen}
                  onChange={(e) => setStartType(e.target.value as ServiceStartType)}
                  data-testid="svc-starttype"
                >
                  {(Object.keys(START_TYPE_LABELS) as ServiceStartType[]).map((t) => (
                    <option key={t} value={t}>
                      {START_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <p>État du service : {statusLabel(svc)}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="svc-deps">
              <p>Ce service dépend des composants système suivants :</p>
              <div className="border border-[#7a7a7a] px-2 py-1 text-[#6d6d6d]">aucune</div>
              <p>Les composants système suivants dépendent de ce service :</p>
              <div className="border border-[#7a7a7a] px-2 py-1 text-[#6d6d6d]">aucune</div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <WinButton
            primary
            onClick={() => {
              if (apply()) onClose()
            }}
            data-testid="svc-ok"
          >
            OK
          </WinButton>
          <WinButton onClick={onClose}>Annuler</WinButton>
          <WinButton onClick={() => void apply()} data-testid="svc-apply">
            Appliquer
          </WinButton>
        </DialogFooter>
      </div>
    </div>
  )
}
