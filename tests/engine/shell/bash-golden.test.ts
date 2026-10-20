/**
 * Tests golden de la console bash (v2.9, issue #235) : pour chaque capture de docs/captures/bash/,
 * la commande de l'en-tête est rejouée sur un poste Linux préparé et sa sortie (standard + erreurs)
 * est comparée ligne par ligne. Les invites de saisie (mots de passe) ne font pas partie des lignes.
 */
import { APACHE_STEPS } from './bash-apache-golden.test'
import { SAMBA_STEPS } from './bash-samba-golden.test'
import { SSH_STEPS } from './bash-ssh-golden.test'
import { STEPS } from './bash-system-golden.test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPTURES_DIR, expectGolden, readCapture } from '../golden/golden'
import { Bash } from './bash-helpers'

interface Step {
  line: string
  answers?: string[]
}
interface Case {
  /** Commandes jouées avant celle de la capture. */
  setup?: Step[]
  /** Réponses aux invites de la commande de la capture. */
  answers?: string[]
}

const A: Step[] = [{ line: 'echo bonjour > a.txt' }]
const BOB: Step[] = [{ line: 'sudo useradd -m bob' }, { line: 'sudo passwd bob', answers: ['Bob1', 'Bob1'] }]
const BOB_SESSION: Step[] = [...BOB, { line: 'su - bob', answers: ['Bob1'] }]

const CASES: Record<string, Case> = {
  cat: {},
  'cat-absent': {},
  'cat-refuse': {},
  'cat-dossier': {},
  'cat-option': {},
  echo: {},
  'echo-refuse': {},
  'echo-sudo': {},
  'echo-dossier': {},
  'echo-absent': {},
  tee: {},
  'tee-refuse': {},
  'tee-option': {},
  sed: { setup: A },
  'sed-i': { setup: A },
  'sed-absent': {},
  'sed-refuse': {},
  'sed-commande': { setup: A },
  'sed-inacheve': { setup: A },
  'sed-drapeau': { setup: A },
  useradd: {},
  'useradd-existe': {},
  'useradd-refuse': {},
  'useradd-groupe': {},
  'useradd-nom': {},
  usermod: {},
  'usermod-inconnu': {},
  'usermod-groupe': {},
  'usermod-refuse': {},
  groupadd: {},
  'groupadd-existe': {},
  'groupadd-refuse': {},
  'groupadd-nom': {},
  passwd: { answers: ['Secret1', 'Secret1'] },
  'passwd-soi': { answers: ['Secret1', 'Secret1'] },
  'passwd-differents': { answers: ['Secret1', 'Secret2'] },
  'passwd-autre': {},
  'passwd-inconnu': {},
  chmod: { setup: A },
  'chmod-symbolique': { setup: A },
  'chmod-absent': {},
  'chmod-refuse': {},
  'chmod-mode': { setup: A },
  'chmod-operande': {},
  'chmod-option': { setup: A },
  chown: {},
  'chown-refuse': { setup: A },
  'chown-utilisateur': { setup: A },
  'chown-groupe': { setup: A },
  'chown-absent': {},
  'chown-operande': {},
  id: {},
  'id-root': {},
  'id-un': {},
  'id-groupes': {},
  'id-inconnu': {},
  'id-option': {},
  su: { setup: BOB, answers: ['Bob1'] },
  'su-echec': { setup: BOB, answers: ['mauvais'] },
  'su-inconnu': {},
  'su-nologin': {},
  sudo: {},
  'sudo-pas-sudoer': { setup: BOB_SESSION, answers: ['Bob1'] },
  'sudo-introuvable': {},
  ls: {},
  'ls-ld': {},
  'ls-la': {},
  'ls-absent': {},
  'ls-refuse': {},
  'ls-traverse': {},
  'ls-option': {},
  touch: {},
  'touch-refuse': {},
  'touch-absent': {},
  'touch-operande': {},
  'touch-option': {},
  mkdir: {},
  'mkdir-p': {},
  'mkdir-existe': {},
  'mkdir-refuse': {},
  'mkdir-absent': {},
  'mkdir-operande': {},
  'mkdir-option': {}
}

describe('captures bash (docs/captures/bash)', () => {
  it('chaque capture a son cas de test, et inversement', () => {
    const files = readdirSync(join(CAPTURES_DIR, 'bash'))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -4))
      .sort()
    // Captures de l'administration Linux (#236) : testées par bash-system-golden.test.ts
    const system = STEPS.map(([name]) => name)
    // Captures SSH, fail2ban et rsyslog (#237) : testées par bash-ssh-golden.test.ts
    const ssh = SSH_STEPS.map(([name]) => name)
    // Captures Apache2 (#238) : testées par bash-apache-golden.test.ts
    const apache = APACHE_STEPS.map(([name]) => name)
    // Captures Samba (#239) : testées par bash-samba-golden.test.ts
    const samba = SAMBA_STEPS.map(([name]) => name)
    expect(files).toEqual([...Object.keys(CASES), ...system, ...ssh, ...apache, ...samba].sort())
  })

  it('chaque commande simulée de ce chantier a au moins une capture sourcée', () => {
    const tools = ['cat', 'echo', 'tee', 'sed', 'useradd', 'usermod', 'groupadd', 'passwd', 'chmod', 'chown']
    const rest = ['id', 'su', 'sudo', 'ls', 'touch', 'mkdir']
    for (const t of [...tools, ...rest]) expect(CASES[t], `capture ${t}.txt`).toBeDefined()
  })

  for (const [name, c] of Object.entries(CASES)) {
    it(name, () => {
      const capture = readCapture(`bash/${name}`)
      expect(capture.source).toMatch(/^https:\/\/manpages\.debian\.org\/bookworm\//)
      const sh = new Bash()
      for (const step of c.setup ?? []) sh.run(step.line, step.answers ?? [])
      const r = sh.run(capture.command, c.answers ?? [])
      expectGolden(r.text, `bash/${name}`)
    })
  }
})
