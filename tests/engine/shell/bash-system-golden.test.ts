/**
 * Tests golden des commandes d'administration Linux (v2.9, #236) : chaque sortie simulée est
 * comparée, ligne par ligne, à `docs/captures/bash/<commande>.txt` (en-tête « # Source: »).
 * Les captures sont reconstituées d'après les pages de manuel (docs/fidelite.md, « À vérifier
 * (v2.9 — Linux) ») ; seul le jeton `{mac}` est normalisé (adresses MAC dérivées de l'état).
 * Les remarques propres à ServerLab (valeurs non modélisées) ne font pas partie de la sortie réelle.
 */
import { describe, expect, it } from 'vitest'
import { expectGolden, type Token } from '../golden/golden'
import { Bash, buildLinuxLab } from './linux-lab'

/** [capture, ordinateur, ligne tapée, réponses aux invites, jetons normalisés, préparation sur le serveur] */
type Step = [string, 'srv' | 'off' | 'pc', string, string[]?, Token[]?, string[]?]

/** Le déroulé s'enchaîne sur le même serveur : l'ordre des étapes compte. */
const STEPS: Step[] = [
  ['ping', 'srv', 'ping -c 2 192.168.2.254'],
  ['ip-a', 'srv', 'ip a', [], ['mac']],
  ['apt-list-installed', 'srv', 'apt list --installed'],
  ['apt-update-sans-sudo', 'srv', 'apt update'],
  ['apt-update-echec', 'off', 'sudo apt update'],
  ['apt-update', 'srv', 'sudo apt update'],
  ['apt-install-introuvable', 'srv', 'sudo apt install apache3'],
  ['apt-install-apache2', 'srv', 'sudo apt install apache2', ['y']],
  ['apt-install-deja', 'srv', 'sudo apt install apache2', ['y']],
  ['systemctl-status-apache2', 'srv', 'sudo systemctl status apache2'],
  ['systemctl-is-active', 'srv', 'systemctl is-active apache2'],
  ['systemctl-status-inconnue', 'srv', 'systemctl status nginx'],
  ['systemctl-start-sans-sudo', 'srv', 'systemctl restart apache2'],
  ['journalctl-u-apache2', 'srv', 'sudo journalctl -u apache2'],
  ['journalctl-sans-droit', 'srv', 'journalctl -u apache2'],
  ['ss-tulpn', 'srv', 'sudo ss -tulpn'],
  ['ss-tuln-sans-sudo', 'srv', 'ss -tuln'],
  [
    'systemctl-status-apache2-arrete',
    'srv',
    'sudo systemctl status apache2',
    [],
    [],
    ['sudo systemctl stop apache2']
  ],
  ['apt-install-nginx', 'srv', 'sudo apt install nginx', ['y']],
  ['systemctl-start-conflit', 'srv', 'sudo systemctl start apache2'],
  ['systemctl-disable-nginx', 'srv', 'sudo systemctl disable nginx'],
  ['systemctl-is-enabled', 'srv', 'systemctl is-enabled nginx'],
  ['apt-search', 'srv', 'apt search web'],
  ['apt-remove-nginx', 'srv', 'sudo apt remove nginx', ['y']],
  ['ps-aux', 'srv', 'ps aux'],
  ['df-h', 'srv', 'df -h'],
  ['free-h', 'srv', 'free -h'],
  ['uname-a', 'srv', 'uname -a'],
  ['hostnamectl', 'srv', 'hostnamectl'],
  ['ip-neigh', 'srv', 'ip neigh', [], ['mac']],
  ['traceroute', 'srv', 'traceroute 8.8.8.8'],
  ['nslookup', 'srv', 'nslookup www.example.com'],
  ['nslookup-nxdomain', 'srv', 'nslookup nexiste.pas.example.com'],
  ['curl-head', 'pc', 'curl -I http://192.168.2.10', [], [], ['sudo systemctl start apache2']],
  ['curl-refuse', 'pc', 'curl -I http://192.168.2.10:8080']
]

describe('captures golden : administration Linux (docs/captures/bash)', () => {
  it('chaque sortie simulée est identique à sa capture', () => {
    const lab = buildLinuxLab()
    const srv = new Bash(lab.state, lab.ids.LSRV1!)
    const pc = new Bash(lab.state, lab.ids.LNX1!)
    const off = new Bash(buildLinuxLab({ internet: false }).state, lab.ids.LSRV1!)
    for (const [name, who, line, answers = [], tokens = [], prepare = []] of STEPS) {
      for (const prep of prepare) srv.real(prep)
      const shell = who === 'srv' ? srv : who === 'off' ? off : pc
      if (who === 'pc') pc.state = srv.state
      const out = shell.real(line, answers)
      expect(() => expectGolden(out.split('\n'), `bash/${name}`, tokens), name).not.toThrow()
    }
  })
})
