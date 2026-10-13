/**
 * Routage statique d'un routeur et table de routage effective.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { prefixToMask, routingTable, type RouterDevice, command } from '@engine/index'
import { useLabStore } from '../../../store/lab'
import { useUiStore } from '../../../store/ui'
import { runCommand } from '../../../lib/run'
import { Button, Section, inputClass } from '../../common/ui'
import { t } from '../../../lib/i18n'

const SOURCE_LABEL = { connected: 'C', static: 'S', default: 'S*', ospf: 'O' } as const

export function RoutesPanel({ device }: { device: RouterDevice }) {
  const lab = useLabStore((s) => s.lab)
  const [network, setNetwork] = useState('')
  const [mask, setMask] = useState('')
  const [nextHop, setNextHop] = useState('')
  const table = routingTable(lab, device)

  const add = () => {
    const result = runCommand(command('net.addStaticRoute', device.id, { network, mask, nextHop }))
    if (!result) return
    result.warnings.forEach((w) => useUiStore.getState().notify('warning', w))
    setNetwork('')
    setMask('')
    setNextHop('')
  }

  return (
    <>
      <Section title={t('win.routesStatiques')}>
        <table className="mb-3 w-full max-w-xl text-xs">
          <thead className="text-left text-fg-muted">
            <tr>
              <th className="py-1">{t('win.reseau')}</th>
              <th className="py-1">{t('win.masque')}</th>
              <th className="py-1">{t('win.prochainSaut')}</th>
              <th />
            </tr>
          </thead>
          <tbody className="font-mono">
            {device.routes.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 font-sans text-fg-subtle">
                  {t('win.aucuneRouteStatique')}
                </td>
              </tr>
            )}
            {device.routes.map((r, i) => (
              <tr key={`${r.network}/${r.prefixLength}-${r.nextHop}`} className="border-t border-line">
                <td className="py-1">{r.network}</td>
                <td className="py-1">{prefixToMask(r.prefixLength)}</td>
                <td className="py-1">{r.nextHop}</td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    className="rounded p-1 text-fg-subtle hover:bg-danger-soft hover:text-danger"
                    title={t('win.supprimerLaRoute')}
                    onClick={() => runCommand(command('net.removeStaticRoute', device.id, i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid max-w-xl grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
          <input
            className={inputClass}
            placeholder={t('win.reseau1921682')}
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            aria-label={t('win.reseau')}
          />
          <input
            className={inputClass}
            placeholder={t('win.masque255255255')}
            value={mask}
            onChange={(e) => setMask(e.target.value)}
            aria-label={t('win.masque')}
          />
          <input
            className={inputClass}
            placeholder={t('win.prochainSaut')}
            value={nextHop}
            onChange={(e) => setNextHop(e.target.value)}
            aria-label={t('win.prochainSaut')}
          />
          <Button variant="primary" onClick={add}>
            Ajouter
          </Button>
        </div>
        <p className="mt-2 text-xs text-fg-muted">{t('win.routeParDefautReseau')}</p>
      </Section>
      <Section title={t('win.tableDeRoutage')}>
        <pre className="selectable rounded border border-line bg-app p-3 font-mono text-[11px] leading-5 text-fg">
          {table.length === 0
            ? t('win.noRoutes')
            : table
                .map((r) => {
                  const code = SOURCE_LABEL[r.source].padEnd(3)
                  const iface = device.interfaces.find((i) => i.id === r.ifaceId)?.name ?? ''
                  return r.gateway
                    ? t('win.routeVia', {
                        code,
                        network: r.network,
                        prefix: r.prefixLength,
                        gateway: r.gateway,
                        iface
                      })
                    : t('win.routeConnected', { code, network: r.network, prefix: r.prefixLength, iface })
                })
                .join('\n')}
        </pre>
      </Section>
    </>
  )
}
