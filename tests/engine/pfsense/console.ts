/**
 * Aides des tests de la console pfSense : laboratoire type et transcription d'une session comme
 * l'affiche le terminal (sortie, invites suivies des réponses saisies).
 */
import {
  createShellSession,
  executeLine,
  shellBanner,
  shellPrompt,
  unwrap,
  setPfFilterEnabled,
  setPfInterfaceFromConsole,
  type LabState,
  type ShellSession
} from '@engine/index'
import { build, cable, setIp } from '../helpers'

/**
 * FW1 : em0 WAN 203.0.113.2/24 (ISP 203.0.113.1), em1 LAN 192.168.1.1/24 (PC1 .10), em2 DMZ 172.16.0.1/24
 * sans câble. Passerelle par défaut WANGW 203.0.113.1.
 */
export function lab() {
  const { state, ids } = build([
    ['firewall', 'FW1'],
    ['client', 'PC1'],
    ['client', 'ISP']
  ])
  let s = cable(state, ids.ISP!, 0, ids.FW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.FW1!, 1)
  s = setIp(s, ids.FW1!, 0, '203.0.113.2/24')
  s = setIp(s, ids.FW1!, 2, '172.16.0.1/24')
  s = setIp(s, ids.ISP!, 0, '203.0.113.1/24')
  s = setIp(s, ids.PC1!, 0, '192.168.1.10/24', '192.168.1.1')
  const fw = s.devices[ids.FW1!]
  if (!fw || fw.kind !== 'firewall') throw new Error('pare-feu absent')
  s = unwrap(
    setPfInterfaceFromConsole(s, ids.FW1!, {
      key: 'wan',
      address: '203.0.113.2',
      prefixLength: 24,
      gateway: '203.0.113.1',
      gatewayIsDefault: true,
      dhcp: { enabled: false },
      revertToHttp: false
    })
  ).state
  return { s, id: ids.FW1!, pc: ids.PC1!, isp: ids.ISP! }
}

export interface Session {
  state: LabState
  session: ShellSession
  /** Texte tel qu'affiché par le terminal depuis l'ouverture. */
  lines: string[]
  exited: boolean
}

export function open(state: LabState, deviceId: string): Session {
  const session = createShellSession(state, deviceId, 'cmd')
  const lines = [...shellBanner('pfsense', state, deviceId)]
  return { state, session, lines, exited: false }
}

/** Saisit une ligne et ses réponses aux invites ; ajoute la transcription (écho des saisies compris). */
export function type(sess: Session, line: string, answers: string[] = []): Session {
  const echo = `${shellPrompt(sess.session, sess.state)}${line}`
  const out: string[] = [echo]
  let given: string[] = []
  let shown = 0
  for (;;) {
    const r = executeLine(sess.state, sess.session, line, given)
    out.push(...r.output.slice(shown).map((o) => o.text))
    if (r.prompt && given.length < answers.length) {
      const answer = answers[given.length] as string
      out.push(`${r.prompt.message}${answer}`)
      shown = r.output.length
      given = [...given, answer]
      continue
    }
    if (r.prompt) {
      // Invite sans réponse fournie : affichée telle quelle
      out.push(r.prompt.message)
      return { ...sess, lines: [...sess.lines, ...out] }
    }
    const lines = [...sess.lines, ...out]
    if (r.exit) return { state: r.state, session: r.session, lines, exited: true }
    return { state: r.state, session: r.session, lines, exited: false }
  }
}

/** Texte de l'invite en attente de saisie, après la transcription. */
export const promptOf = (sess: Session): string => shellPrompt(sess.session, sess.state)

/** Transcription complète, invite finale comprise. */
export const transcript = (sess: Session): string[] => [...sess.lines, promptOf(sess)]

export function fwOf(state: LabState, id: string) {
  const d = state.devices[id]
  if (!d || d.kind !== 'firewall') throw new Error('pas un pare-feu')
  return d
}

export { setPfFilterEnabled }
