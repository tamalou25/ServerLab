/**
 * Tutoriel « premier ping » : carte de guidage (bienvenue, étapes, félicitations) et mise en
 * évidence de la zone à utiliser. Les étapes se valident d'elles-mêmes dès que l'état du lab est
 * le bon (moteur : `tutorialProgress`) ; aucun bouton « Suivant ».
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Circle, CircleDot, GraduationCap, PartyPopper, X } from 'lucide-react'
import {
  suggestPeerAddress,
  TUTORIAL_STEPS,
  tutorialProgress,
  type TutorialProgress,
  type TutorialStepId
} from '@engine/index'
import {
  closeTutorial,
  completeTutorial,
  setTutorialAtStartup,
  startTutorial,
  tutorialTargets
} from '../../lib/tutorial'
import { useLabStore } from '../../store/lab'
import { useLabsStore } from '../../store/labs'
import { useTutorialStore } from '../../store/tutorial'
import { useUiStore } from '../../store/ui'
import { Button } from '../common/ui'
import { t } from '../../lib/i18n'

const STEP_TITLES: Record<TutorialStepId, string> = {
  get 'place-server'() {
    return t('tuto.step.place_server')
  },
  get 'place-client'() {
    return t('tuto.step.place_client')
  },
  get cable() {
    return t('tuto.step.cable')
  },
  get 'ip-server'() {
    return t('tuto.step.ip_server')
  },
  get 'ip-client'() {
    return t('tuto.step.ip_client')
  },
  get ping() {
    return t('tuto.step.ping')
  }
}

export function TutorialCoach() {
  const phase = useTutorialStore((s) => s.phase)
  if (phase === 'off') return null
  // En haut à droite : colonne laissée libre par les fenêtres d'équipement (ouvertes à gauche)
  return (
    <aside
      className="fixed top-24 right-3 z-[280] w-[300px] rounded-md border border-line bg-overlay p-4 text-ui text-fg shadow-lg"
      aria-label={t('tuto.tutoriel')}
      data-testid="tutorial-card"
      data-phase={phase}
    >
      {phase === 'welcome' && <Welcome />}
      {phase === 'running' && <Running />}
      {phase === 'done' && <Done />}
    </aside>
  )
}

function Header({ icon, title, onClose }: { icon: ReactNode; title: string; onClose?: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-accent">{icon}</span>
      <h2 className="text-title font-semibold">{title}</h2>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label={t('tuto.quitterLeTutoriel')}
          title={t('tuto.quitterLeTutorielRelancable')}
          data-testid="tutorial-quit"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function Welcome() {
  const [atStartup, setAtStartup] = useState<boolean | null>(null)
  useEffect(() => {
    void window.serverlab.tutorialAtStartup().then(setAtStartup)
  }, [])
  return (
    <>
      <Header icon={<GraduationCap size={18} />} title={t('tuto.bienvenueDansServerlab')} />
      <p className="text-fg-muted">{t('tuto.intro')}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={() => void startTutorial()} data-testid="tutorial-start">
          Commencer
        </Button>
        <Button variant="ghost" onClick={closeTutorial} data-testid="tutorial-skip">
          Passer
        </Button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-dense text-fg-muted">
        <input
          type="checkbox"
          checked={atStartup ?? true}
          disabled={atStartup === null}
          onChange={(e) => {
            setAtStartup(e.target.checked)
            setTutorialAtStartup(e.target.checked)
          }}
          data-testid="tutorial-at-startup"
        />
        {t('tuto.proposerLeTutorielAu')}
      </label>
    </>
  )
}

function Running() {
  const lab = useLabStore((s) => s.lab)
  const revision = useLabStore((s) => s.revision)
  const tutorialRevision = useTutorialStore((s) => s.revision)
  const echoes = useTutorialStore((s) => s.echoes)
  const progress = useMemo(() => tutorialProgress(lab, echoes), [lab, echoes])

  // Un autre document a été chargé : le tutoriel s'arrête
  useEffect(() => {
    if (revision !== tutorialRevision) closeTutorial()
  }, [revision, tutorialRevision])

  // Dernière étape validée : félicitations, le tutoriel n'est plus proposé au démarrage
  const finished = progress.current === null
  useEffect(() => {
    if (finished) completeTutorial()
  }, [finished])

  const index = progress.current ? TUTORIAL_STEPS.indexOf(progress.current) + 1 : TUTORIAL_STEPS.length
  return (
    <div data-testid="tutorial-step" data-step={progress.current ?? 'done'}>
      <Header
        icon={<GraduationCap size={18} />}
        title={t('tuto.stepOf', { index, total: TUTORIAL_STEPS.length })}
        onClose={closeTutorial}
      />
      <ol className="mb-3 flex flex-col gap-1">
        {progress.steps.map((step) => {
          const isCurrent = step.id === progress.current
          return (
            <li
              key={step.id}
              className={`flex items-center gap-2 text-dense ${isCurrent ? 'font-semibold text-fg' : step.done ? 'text-fg-muted' : 'text-fg-subtle'}`}
            >
              {step.done ? (
                <CheckCircle2 size={14} className="shrink-0 text-ok-text" aria-label={t('tuto.validee')} />
              ) : isCurrent ? (
                <CircleDot size={14} className="shrink-0 text-accent" aria-label={t('tuto.enCours')} />
              ) : (
                <Circle size={14} className="shrink-0" aria-hidden />
              )}
              {STEP_TITLES[step.id]}
            </li>
          )
        })}
      </ol>
      <div
        className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-fg"
        data-testid="tutorial-instruction"
      >
        <Instruction progress={progress} />
      </div>
      <p className="mt-2 text-meta text-fg-subtle">{t('tuto.chaqueEtapeSeValide')}</p>
      <Spotlight progress={progress} />
    </div>
  )
}

const Mono = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-surface px-1 font-mono text-dense">{children}</code>
)

/** Consigne de l'étape en cours, avec les noms et adresses réels du lab. */
function Instruction({ progress }: { progress: TutorialProgress }) {
  const armed = useUiStore((s) => s.armed)
  const tool = useUiStore((s) => s.tool)
  const cableStart = useUiStore((s) => s.cableStart)
  const windows = useUiStore((s) => s.windows)
  const { server, client } = progress
  const windowOf = (id: string | undefined) => windows.find((w) => w.deviceId === id)

  switch (progress.current) {
    case 'place-server':
      return armed === 'server' ? (
        <>{t('tuto.cliquezSurLeCanvas')}</>
      ) : (
        <>
          Dans la palette, cliquez sur <strong>{t('tuto.serveur')}</strong> (ou faites-le glisser sur le
          canvas).
        </>
      )
    case 'place-client':
      return armed === 'client' ? (
        <>{t('tuto.cliquezSurLeCanvas2')}</>
      ) : (
        <>
          Dans la palette, cliquez sur <strong>{t('tuto.posteClient')}</strong>, puis sur le canvas.
        </>
      )
    case 'cable':
      if (tool !== 'cable')
        return (
          <>
            Choisissez l’outil <strong>{t('tuto.cable')}</strong> {t('tuto.dansLaBarreDoutils')}{' '}
            <Mono>C</Mono>).
          </>
        )
      return cableStart ? (
        <>
          Cliquez maintenant sur{' '}
          <strong>{cableStart.deviceId === server?.id ? client?.name : server?.name}</strong> et choisissez
          son port <Mono>Ethernet0</Mono>.
        </>
      ) : (
        <>
          Cliquez sur <strong>{server?.name}</strong> {t('tuto.etChoisissezLePort')} <Mono>Ethernet0</Mono>.
        </>
      )
    case 'ip-server':
    case 'ip-client': {
      const host = progress.current === 'ip-server' ? server : client
      if (!windowOf(host?.id))
        return (
          <>
            Double-cliquez sur <strong>{host?.name}</strong> pour ouvrir sa fenêtre.
          </>
        )
      if (progress.current === 'ip-server')
        return (
          <>
            Onglet <strong>{t('tuto.config')}</strong>
            {t('tuto.carte')} <Mono>Ethernet0</Mono> : choisissez « Utiliser l’adresse IP suivante »,
            saisissez par exemple <Mono>192.168.1.1</Mono> {t('tuto.etLeMasque')} <Mono>255.255.255.0</Mono>,
            puis <strong>{t('tuto.appliquer')}</strong>.
          </>
        )
      const suggestion =
        server?.address && server.prefixLength !== null
          ? suggestPeerAddress(server.address, server.prefixLength)
          : null
      return (
        <>
          Même démarche pour <strong>{client?.name}</strong>, avec une adresse du réseau de {server?.name} (
          <Mono>
            {server?.address}/{server?.prefixLength}
          </Mono>
          )
          {suggestion && (
            <>
              , par exemple <Mono>{suggestion}</Mono>
            </>
          )}
          , puis <strong>{t('tuto.appliquer')}</strong>.
        </>
      )
    }
    case 'ping': {
      const win = windowOf(client?.id)
      if (!win)
        return (
          <>
            Double-cliquez sur <strong>{client?.name}</strong>
            {t('tuto.puisOuvrezLonglet')} <strong>{t('tuto.console')}</strong>.
          </>
        )
      if (win.tab !== 'console')
        return (
          <>
            Ouvrez l’onglet <strong>{t('tuto.console')}</strong> de {client?.name}.
          </>
        )
      return (
        <>
          Tapez <Mono>ping {server?.address}</Mono> {t('tuto.puisEntreeLoutil')}{' '}
          <strong>{t('tuto.pduSimple')}</strong> de {client?.name} vers {server?.name} fonctionne aussi.)
        </>
      )
    }
    default:
      return null
  }
}

/**
 * Cadre lumineux autour de la zone à utiliser. Il ne capte jamais la souris (le sélecteur de
 * ports se fermerait) et suit la zone à chaque image : panoramique, zoom, fenêtre déplacée.
 */
function Spotlight({ progress }: { progress: TutorialProgress }) {
  const armed = useUiStore((s) => s.armed)
  const tool = useUiStore((s) => s.tool)
  const cableStart = useUiStore((s) => s.cableStart)
  const windows = useUiStore((s) => s.windows)
  const home = useUiStore((s) => s.home)
  const selectors = useMemo(
    () => (home ? [] : tutorialTargets(progress, { armed, tool, cableStart, windows })),
    [progress, armed, tool, cableStart, windows, home]
  )
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let frame = 0
    const place = () => {
      const box = ref.current
      if (box) {
        const target = selectors
          .map((selector) => ({ selector, node: document.querySelector(selector) }))
          .find((t) => t.node)
        const rect = target?.node?.getBoundingClientRect()
        if (target && rect && rect.width > 0 && rect.height > 0) {
          box.style.display = 'block'
          box.style.left = `${rect.left - 4}px`
          box.style.top = `${rect.top - 4}px`
          box.style.width = `${rect.width + 8}px`
          box.style.height = `${rect.height + 8}px`
          box.dataset['target'] = target.selector
        } else {
          box.style.display = 'none'
          delete box.dataset['target']
        }
      }
      frame = requestAnimationFrame(place)
    }
    frame = requestAnimationFrame(place)
    return () => cancelAnimationFrame(frame)
  }, [selectors])

  return (
    <div
      ref={ref}
      className="pointer-events-none fixed z-[270] hidden rounded-md border-2 border-accent shadow-[0_0_0_4px_var(--color-accent-soft)] motion-safe:animate-pulse"
      data-testid="tutorial-spotlight"
      aria-hidden
    />
  )
}

function Done() {
  const lab = useLabStore((s) => s.lab)
  const echoes = useTutorialStore((s) => s.echoes)
  const { server, client } = useMemo(() => tutorialProgress(lab, echoes), [lab, echoes])
  const openLabPicker = () => {
    closeTutorial()
    useLabsStore.getState().setPickerOpen(true)
  }
  return (
    <>
      <Header icon={<PartyPopper size={18} />} title={t('tuto.bravo')} />
      <p className="text-fg-muted" data-testid="tutorial-done">
        Premier ping réussi entre <strong className="text-fg">{client?.name}</strong> et{' '}
        <strong className="text-fg">{server?.name}</strong> : votre premier réseau fonctionne. Poursuivez avec
        un lab guidé (DHCP, DNS, Active Directory…).
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={openLabPicker} data-testid="tutorial-open-lab">
          {t('tuto.ouvrirUnLab')}
        </Button>
        <Button variant="ghost" onClick={closeTutorial} data-testid="tutorial-finish">
          Terminer
        </Button>
      </div>
    </>
  )
}
