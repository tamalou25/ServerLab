/**
 * Tests golden Samba (v2.9, #239) : chaque sortie simulée est comparée, ligne par ligne, à
 * `docs/captures/bash/<nom>.txt` (en-tête « # Source: »). Les captures sont reconstituées d'après les
 * sources Debian du paquet samba 2:4.17.12+dfsg-0+deb12u4 (testparm.c, smbpasswd.c, pdbedit.c, status.c,
 * client.c, passdb.c, debian/smb.conf) : pas de VM, docs/fidelite.md, « À vérifier (v2.9 — Linux) »,
 * lignes L-80 à L-89.
 *
 * Le déroulé suit UN SEUL lab (serveur LSRV1, poste LNX1, poste Windows PC1) : l'ordre des étapes compte.
 */
import { describe, expect, it } from 'vitest'
import { expectGolden } from '../golden/golden'
import { appendLines, buildSambaLab, Consoles, type Command, type Who } from './samba-lab'

/** [capture, machine, ligne tapée, réponses aux invites, préparation (non comparée)] */
type Step = [string, Who, string, string[]?, Command[]?]

const PW = ['Passw0rd', 'Passw0rd']
const RESTART: Command = ['srv', 'sudo systemctl restart smbd']

/** Partages du lab : public (alice, écriture), lecture (invités, lecture seule). */
const SHARES: Command[] = [
  ['srv', 'sudo mkdir -p /srv/samba/public /srv/samba/lecture'],
  ['srv', 'sudo chown alice:alice /srv/samba/public'],
  ['srv', "echo 'Bienvenue' | sudo tee /srv/samba/public/lisezmoi.txt"],
  ['srv', "echo 'Document public' | sudo tee /srv/samba/lecture/notice.txt"],
  ...appendLines('/etc/samba/smb.conf', [
    '[public]',
    '   comment = Documents partages',
    '   path = /srv/samba/public',
    '   read only = no',
    '   valid users = alice',
    '[lecture]',
    '   path = /srv/samba/lecture',
    '   guest ok = yes'
  ]),
  RESTART
]

export const SAMBA_STEPS: Step[] = [
  ['testparm-defaut', 'srv', 'sudo testparm -s', [], [['srv', 'sudo apt install samba', ['y']]]],
  ['testparm-parametre', 'srv', 'sudo testparm -s --parameter-name=workgroup'],
  ['testparm-parametre-inconnu', 'srv', 'sudo testparm -s --parameter-name=nexistepas'],
  ['testparm-section-inconnue', 'srv', 'sudo testparm -s --section-name=nexiste'],
  ['pdbedit-liste-vide', 'srv', 'sudo pdbedit -L'],
  ['pdbedit-sans-sudo', 'srv', 'pdbedit -L'],
  ['smbpasswd-a-unix-absent', 'srv', 'sudo smbpasswd -a ghost', ['x', 'x']],
  ['smbpasswd-x-absent', 'srv', 'sudo smbpasswd -x ghost'],
  ['smbpasswd-sans-sudo', 'srv', 'smbpasswd -a alice'],
  [
    'smbpasswd-mismatch',
    'srv',
    'sudo smbpasswd -a alice',
    ['a', 'b'],
    [
      ['srv', 'sudo useradd -m alice'],
      ['srv', 'sudo useradd -m bob']
    ]
  ],
  ['smbpasswd-a', 'srv', 'sudo smbpasswd -a alice', PW],
  ['smbpasswd-a-deja', 'srv', 'sudo smbpasswd -a alice', PW],
  [
    'smbpasswd-d',
    'srv',
    'sudo smbpasswd -d alice',
    [],
    [['srv', 'sudo smbpasswd -a bob', ['Secret1', 'Secret1']]]
  ],
  ['smbpasswd-e', 'srv', 'sudo smbpasswd -e alice'],
  [
    'smbpasswd-x',
    'srv',
    'sudo smbpasswd -x bob',
    [],
    [['srv', 'sudo smbpasswd -a bob', ['Secret1', 'Secret1']]]
  ],
  ['pdbedit-liste', 'srv', 'sudo pdbedit -L', [], [['srv', 'sudo smbpasswd -a bob', ['Secret1', 'Secret1']]]],
  ['pdbedit-u', 'srv', 'sudo pdbedit -L -u alice'],
  ['pdbedit-u-inconnu', 'srv', 'sudo pdbedit -L -u ghost'],
  ['pdbedit-x-absent', 'srv', 'sudo pdbedit -x -u ghost'],
  ['smbstatus-sans-sudo', 'srv', 'smbstatus'],
  ['smbstatus-vide', 'srv', 'sudo smbstatus'],
  ['smbclient-L-anonyme', 'pc', 'smbclient -L //192.168.2.10 -N'],
  ['testparm-partages', 'srv', 'sudo testparm -s', [], SHARES],
  ['smbclient-L', 'pc', 'smbclient -L //192.168.2.10 -U alice%Passw0rd'],
  ['smbclient-L-invite', 'pc', 'smbclient -L //192.168.2.10 -U inconnu%x'],
  ['smbclient-logon-failure', 'pc', 'smbclient -L //192.168.2.10 -U alice%mauvais'],
  ['smbclient-ls', 'pc', "smbclient //192.168.2.10/public -U alice%Passw0rd -c 'ls'"],
  ['smbclient-acces-refuse', 'pc', "smbclient //192.168.2.10/public -U bob%Secret1 -c 'ls'"],
  ['smbclient-partage-inconnu', 'pc', "smbclient //192.168.2.10/nexiste -U alice%Passw0rd -c 'ls'"],
  ['smbclient-invite', 'pc', "smbclient //192.168.2.10/lecture -N -c 'ls'"],
  ['smbclient-mkdir-lecture-seule', 'pc', "smbclient //192.168.2.10/lecture -U alice%Passw0rd -c 'mkdir x'"],
  ['smbclient-mkdir', 'pc', "smbclient //192.168.2.10/public -U alice%Passw0rd -c 'mkdir docs; ls'"],
  ['smbclient-mkdir-existe', 'pc', "smbclient //192.168.2.10/public -U alice%Passw0rd -c 'mkdir docs'"],
  [
    'smbclient-ls-unix-refuse',
    'pc',
    "smbclient //192.168.2.10/public -U alice%Passw0rd -c 'ls secret'",
    [],
    [
      ['srv', 'sudo mkdir /srv/samba/public/secret'],
      ['srv', 'sudo chmod 700 /srv/samba/public/secret']
    ]
  ],
  ['smbclient-ls-absent', 'pc', "smbclient //192.168.2.10/public -U alice%Passw0rd -c 'ls nexiste'"],
  [
    'smbstatus-sessions',
    'srv',
    'sudo smbstatus',
    [],
    [['win', 'net use Z: \\\\LSRV1\\public /user:alice Passw0rd']]
  ],
  ['smbstatus-S', 'srv', 'sudo smbstatus -S'],
  ['smbstatus-p', 'srv', 'sudo smbstatus -p'],
  [
    'testparm-parametre-inconnu-conf',
    'srv',
    'sudo testparm -s',
    [],
    [...appendLines('/etc/samba/smb.conf', ['[test]', '   pathh = /tmp', '   workgroup = AUTRE'])]
  ]
]

/** Rejoue le déroulé et transmet la sortie de chaque étape à `visit`. */
export function playSamba(visit: (name: string, output: string, line: string) => void): void {
  const consoles = new Consoles(buildSambaLab())
  for (const [name, who, line, answers = [], prepare = []] of SAMBA_STEPS) {
    for (const [pwho, pline, panswers] of prepare) consoles.run(pwho, pline, panswers)
    visit(name, consoles.run(who, line, answers), line)
  }
}

describe('captures golden : Samba (docs/captures/bash)', () => {
  it('chaque sortie simulée est identique à sa capture', () => {
    playSamba((name, output) => {
      expect(() => expectGolden(output === '' ? [] : output.split('\n'), `bash/${name}`), name).not.toThrow()
    })
  })
})
