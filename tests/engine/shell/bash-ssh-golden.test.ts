/**
 * Tests golden SSH, fail2ban et rsyslog (v2.9, #237) : chaque sortie simulée est comparée, ligne par
 * ligne, à `docs/captures/bash/<nom>.txt` (en-tête « # Source: »). Les captures sont reconstituées d'après
 * les pages de manuel et le code source Debian (pas de VM) : docs/fidelite.md, « À vérifier (v2.9 — Linux) ».
 *
 * Le déroulé suit UN SEUL lab (serveur LSRV1, poste LNX1) : l'ordre des étapes compte, l'état est partagé
 * (journaux du serveur, clés d'hôte connues du poste, bannissements).
 */
import { describe, expect, it } from 'vitest'
import { expectGolden } from '../golden/golden'
import { Bash, buildLinuxLab } from './linux-lab'

type Who = 'srv' | 'pc'
/** [machine, ligne tapée, réponses aux invites] */
type Command = [Who, string, string[]?]
/** [capture, machine, ligne tapée, réponses aux invites, préparation (non comparée)] */
type Step = [string, Who, string, string[]?, Command[]?]

const SED_ROOT: Command = [
  'srv',
  "sudo sed -i 's/^#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config"
]
const RESTART_SSH: Command = ['srv', 'sudo systemctl restart ssh']
const FAIL: Command = ['pc', 'ssh alice@192.168.2.10 hostname', ['x', 'x', 'x']]
const IMTCP: Command[] = [
  ['pc', 'sudo sed -i \'s/^#module(load="imtcp")/module(load="imtcp")/\' /etc/rsyslog.conf'],
  [
    'pc',
    'sudo sed -i \'s/^#input(type="imtcp" port="514")/input(type="imtcp" port="514")/\' /etc/rsyslog.conf'
  ],
  ['pc', 'sudo systemctl restart rsyslog'],
  ['srv', "echo '*.* @@192.168.2.20:514' | sudo tee /etc/rsyslog.d/50-remote.conf"],
  ['srv', 'sudo systemctl restart rsyslog']
]

/** Préparation commune : un compte bob (mot de passe Bob1) sur le serveur. */
const SETUP: Command[] = [
  ['srv', 'sudo useradd -m bob'],
  ['srv', 'sudo passwd bob', ['Bob1', 'Bob1']]
]

export const SSH_STEPS: Step[] = [
  ['ssh-sans-argument', 'pc', 'ssh'],
  ['ssh-hote-inconnu', 'pc', 'ssh bob@nexiste.example.com hostname'],
  ['ssh-delai', 'pc', 'ssh bob@10.9.9.9 hostname'],
  ['ssh-refuse', 'pc', 'ssh -p 2222 bob@192.168.2.10 hostname'],
  ['ssh-cle-hote-refusee', 'pc', 'ssh bob@192.168.2.10 hostname', ['no']],
  ['ssh-mot-de-passe-faux', 'pc', 'ssh bob@192.168.2.10 hostname', ['yes', 'x', 'y', 'z']],
  ['ssh-commande', 'pc', 'ssh bob@192.168.2.10 hostname', ['Bob1']],
  ['auth-log', 'srv', 'sudo cat /var/log/auth.log'],
  [
    'ssh-root-refuse',
    'pc',
    'ssh root@192.168.2.10 hostname',
    ['Root1', 'Root1', 'Root1'],
    [['srv', 'sudo passwd root', ['Root1', 'Root1']]]
  ],
  ['ssh-root-autorise', 'pc', 'ssh root@192.168.2.10 hostname', ['Root1'], [SED_ROOT, RESTART_SSH]],
  ['ssh-keygen', 'pc', 'ssh-keygen -t ed25519', ['', '', '']],
  ['ssh-keygen-l', 'pc', 'ssh-keygen -l -f .ssh/id_ed25519.pub'],
  ['ssh-copy-id', 'pc', 'ssh-copy-id bob@192.168.2.10', ['Bob1']],
  ['ssh-cle', 'pc', 'ssh bob@192.168.2.10 whoami'],
  ['ssh-copy-id-deja', 'pc', 'ssh-copy-id bob@192.168.2.10'],
  ['apt-install-fail2ban', 'srv', 'sudo apt install fail2ban', ['y']],
  ['fail2ban-client-status', 'srv', 'sudo fail2ban-client status'],
  ['fail2ban-client-status-sshd', 'srv', 'sudo fail2ban-client status sshd'],
  ['fail2ban-client-sans-sudo', 'srv', 'fail2ban-client status'],
  ['fail2ban-client-prison-inconnue', 'srv', 'sudo fail2ban-client status ssh'],
  ['fail2ban-client-status-sshd-banni', 'srv', 'sudo fail2ban-client status sshd', [], [FAIL, FAIL]],
  ['ssh-banni', 'pc', 'ssh bob@192.168.2.10 hostname'],
  ['fail2ban-log', 'srv', 'sudo cat /var/log/fail2ban.log'],
  ['fail2ban-client-unbanip', 'srv', 'sudo fail2ban-client set sshd unbanip 192.168.2.20'],
  ['ssh-debanni', 'pc', 'ssh bob@192.168.2.10 whoami'],
  [
    'fail2ban-client-arrete',
    'srv',
    'sudo fail2ban-client status',
    [],
    [['srv', 'sudo systemctl stop fail2ban']]
  ],
  ['logger', 'srv', 'logger bonjour-collecteur', [], [['srv', 'sudo systemctl start fail2ban'], ...IMTCP]],
  ['syslog-local', 'srv', 'cat /var/log/syslog | grep bonjour-collecteur'],
  ['syslog-collecteur', 'pc', 'cat /var/log/syslog | grep bonjour-collecteur'],
  [
    'auth-log-collecteur',
    'pc',
    'cat /var/log/auth.log | grep Accepted',
    [],
    [['pc', 'ssh bob@192.168.2.10 whoami']]
  ],
  [
    'ssh-mot-de-passe-desactive',
    'pc',
    'ssh zz@192.168.2.10 hostname',
    [],
    [
      ['srv', "sudo sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config"],
      RESTART_SSH
    ]
  ],
  [
    'ss-tln-ssh-port',
    'srv',
    'sudo ss -tln',
    [],
    [['srv', "sudo sed -i 's/^#Port 22/Port 2222/' /etc/ssh/sshd_config"], RESTART_SSH]
  ],
  ['ssh-refuse-port-22', 'pc', 'ssh bob@192.168.2.10 hostname'],
  ['ssh-port', 'pc', 'ssh -p 2222 bob@192.168.2.10 whoami']
]

/** Rejoue le déroulé et transmet la sortie de chaque étape à `visit`. */
export function playSsh(visit: (name: string, output: string) => void): void {
  const lab = buildLinuxLab()
  let state = lab.state
  const shells: Record<Who, Bash> = {
    srv: new Bash(lab.state, lab.ids.LSRV1!),
    pc: new Bash(lab.state, lab.ids.LNX1!)
  }
  const run = (who: Who, line: string, answers: string[] = []) => {
    const shell = shells[who]
    shell.state = state
    const out = shell.real(line, answers)
    state = shell.state
    return out
  }
  for (const [who, line, answers] of SETUP) run(who, line, answers)
  for (const [name, who, line, answers = [], prepare = []] of SSH_STEPS) {
    for (const [pwho, pline, panswers] of prepare) run(pwho, pline, panswers)
    visit(name, run(who, line, answers))
  }
}

describe('captures golden : SSH, fail2ban, rsyslog (docs/captures/bash)', () => {
  it('chaque sortie simulée est identique à sa capture', () => {
    playSsh((name, output) => {
      expect(() => expectGolden(output === '' ? [] : output.split('\n'), `bash/${name}`), name).not.toThrow()
    })
  })
})
