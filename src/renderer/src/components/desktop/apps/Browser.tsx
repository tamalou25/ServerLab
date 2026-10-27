/**
 * Navigateur Web simulé : barre d'adresse, requête HTTP/HTTPS (rejouée en mode Simulation),
 * page servie, pages d'erreur et avertissement de certificat.
 */
import { useState } from 'react'
import { ArrowRight, Globe, Lock, LockOpen, TriangleAlert } from 'lucide-react'
import { command, httpGet, type HttpResult, type HostDevice, type PfWebResult } from '@engine/index'
import { runNetworkOperation } from '../../../lib/network'
import { useLabStore } from '../../../store/lab'
import { PfSenseWeb } from './pfsense/PfSenseWeb'

export function Browser({ device }: { device: HostDevice }) {
  const [address, setAddress] = useState('http://')
  const [result, setResult] = useState<HttpResult | null>(null)
  const [accepted, setAccepted] = useState(false)
  // Interface web d'un pare-feu pfSense joint par cette adresse (moteur : commande pf.webRequest)
  const [pfWeb, setPfWeb] = useState<Exclude<PfWebResult, { kind: 'not-firewall' }> | null>(null)
  const go = () => {
    const store = useLabStore.getState()
    const prepared = store.prepare(command('pf.webRequest', device.id, address))
    const web = prepared.result.ok ? prepared.result.value : null
    setPfWeb(null)
    if (web && web.kind !== 'not-firewall') {
      setResult(null)
      setAccepted(false)
      const show = () => {
        useLabStore.getState().commit(prepared)
        if (web.kind === 'response') setAddress(web.url)
        setPfWeb(web)
      }
      if (web.trace) runNetworkOperation(web.trace, show)
      else show()
      return
    }
    const r = httpGet(useLabStore.getState().lab, device.id, address)
    setAccepted(false)
    if (r.trace) runNetworkOperation(r.trace, () => setResult(r))
    else setResult(r)
  }
  const pfBlocked = pfWeb?.kind === 'response' && pfWeb.certificateWarning !== null && !accepted
  const secure = result?.kind === 'response' && result.certificate && !result.certificateWarning
  return (
    <div className="flex h-full flex-col bg-white text-[13px] text-[#1b1b1b]" data-testid="browser">
      <div className="flex items-center gap-2 border-b border-[#e5e5e5] bg-[#f7f7f7] px-2 py-1.5">
        {secure ? (
          <Lock size={13} className="text-[#107c10]" />
        ) : (
          <LockOpen size={13} className="text-[#777]" />
        )}
        <input
          className="h-7 flex-1 rounded-full border border-[#d1d1d1] bg-white px-3 text-[13px] outline-none focus:border-[#0067c0]"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          data-testid="browser-address"
        />
        <button
          type="button"
          onClick={go}
          className="rounded p-1 hover:bg-[#e5e5e5]"
          data-testid="browser-go"
        >
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-8" data-testid="browser-page">
        {pfWeb?.kind === 'failure' && (
          <div data-testid="browser-pf-failure">
            <Globe size={32} className="mb-3 text-[#777]" />
            <h1 className="mb-2 text-xl font-light">Impossible d’accéder à cette page</h1>
            <p>{pfWeb.message}</p>
            <p className="mt-2 text-xs text-[#777]">{pfWeb.url}</p>
          </div>
        )}
        {pfBlocked && (
          <div data-testid="browser-cert-warning">
            <TriangleAlert size={32} className="mb-3 text-[#c50f1f]" />
            <h1 className="mb-2 text-xl font-light">Votre connexion n’est pas privée</h1>
            <p>{pfWeb?.kind === 'response' ? pfWeb.certificateWarning : ''}</p>
            <button
              type="button"
              className="mt-4 text-[#0067c0] hover:underline"
              onClick={() => setAccepted(true)}
              data-testid="browser-continue"
            >
              Continuer vers {pfWeb?.kind === 'response' ? pfWeb.url : ''} (non recommandé)
            </button>
          </div>
        )}
        {pfWeb?.kind === 'response' && !pfBlocked && (
          <PfSenseWeb firewallId={pfWeb.firewallId} url={pfWeb.url} />
        )}
        {!result && !pfWeb && (
          <p className="text-[#777]">Saisissez une adresse (http://intranet.lab.local).</p>
        )}
        {result?.kind === 'failure' && (
          <div>
            <Globe size={32} className="mb-3 text-[#777]" />
            <h1 className="mb-2 text-xl font-light">Impossible d’accéder à cette page</h1>
            <p>{result.message}</p>
            <p className="mt-2 text-xs text-[#777]">{result.url}</p>
          </div>
        )}
        {result?.kind === 'response' && result.certificateWarning && !accepted && (
          <div data-testid="browser-cert-warning">
            <TriangleAlert size={32} className="mb-3 text-[#c50f1f]" />
            <h1 className="mb-2 text-xl font-light">Votre connexion n’est pas privée</h1>
            <p>{result.certificateWarning}</p>
            <button
              type="button"
              className="mt-4 text-[#0067c0] hover:underline"
              onClick={() => setAccepted(true)}
              data-testid="browser-continue"
            >
              Continuer vers {result.url} (non recommandé)
            </button>
          </div>
        )}
        {result?.kind === 'response' && (!result.certificateWarning || accepted) && (
          <div data-testid="browser-content">
            {result.status === 200 ? (
              result.file?.toLowerCase().endsWith('iisstart.htm') ? (
                <div className="text-center">
                  <h1 className="mb-2 text-3xl font-light text-[#0067c0]">Serveur Web IIS</h1>
                  <p className="text-[#555]">Page d’accueil par défaut du site « {result.site?.name} ».</p>
                </div>
              ) : (
                <div>
                  <h1 className="mb-2 text-xl">{result.file?.split(/[\\/]/).pop()}</h1>
                  <p className="text-[#555]">{result.body}</p>
                </div>
              )
            ) : (
              <div>
                <h1 className="mb-2 text-xl text-[#a4262c]">
                  {result.status} - {result.statusText}
                </h1>
                <p>{result.body}</p>
              </div>
            )}
            <p className="mt-6 text-[11px] text-[#999]">
              Réponse de {result.server.name} — HTTP {result.status}.{result.subStatus}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
