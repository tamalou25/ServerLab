/**
 * Opérateurs de liste de la console bash (#373) : `;`, `&&`, `||` (bash(1), « Lists of Commands »),
 * statut de sortie de chaque commande, tube plus prioritaire, constructions non simulées refusées.
 */
import { describe, expect, it } from 'vitest'
import { Bash } from './bash-helpers'

const sh = () => new Bash()

describe('bash : listes de commandes (;, &&, ||)', () => {
  it('; enchaîne sans condition', () => {
    expect(sh().run('echo a ; echo b').text).toBe('a\nb')
    expect(sh().run('cat /nexiste; echo b').text).toBe('cat: /nexiste: No such file or directory\nb')
  })

  it('&& exécute la suite seulement après un succès', () => {
    expect(sh().run('echo a && echo b').text).toBe('a\nb')
    const r = sh().run('cat /nexiste && echo b')
    expect(r.text).toBe('cat: /nexiste: No such file or directory')
  })

  it('|| exécute la suite seulement après un échec', () => {
    expect(sh().run('echo a || echo b').text).toBe('a')
    const r = sh().run('cat /nexiste || echo b')
    expect(r.text).toContain('b')
    expect(r.errors).toContain('No such file or directory')
  })

  it('associativité gauche comme bash', () => {
    // (true || echo x) && echo y -> y ; un échec suivi de || puis && : la suite s'exécute
    expect(sh().run('echo a || echo b && echo c').text).toBe('a\nc')
    expect(sh().run('cat /nexiste && echo b || echo c').text).toContain('\nc')
    expect(sh().run('cat /nexiste || cat /nexiste2 || echo fin').text).toMatch(/\nfin$/)
    // Une commande ignorée conserve le statut précédent
    expect(sh().run('cat /nexiste && echo b && echo c || echo d').text).toMatch(/\nd$/)
  })

  it('le tube lie plus fort que && et ||', () => {
    const b = sh()
    expect(b.run('echo hello | grep hello && echo oui').text).toBe('hello\noui')
    expect(b.run('echo a && echo hello | grep hello').text).toBe('a\nhello')
  })

  it('les opérateurs entre guillemets ou échappés ne sont pas des opérateurs', () => {
    expect(sh().run('echo "a && b"').text).toBe('a && b')
    expect(sh().run("echo 'a || b ; c'").text).toBe('a || b ; c')
    expect(sh().run('echo a\\;b').text).toBe('a;b')
    expect(sh().run('echo "a $(" ').errors).toContain('existe réellement')
    expect(sh().run("echo '$(x)'").text).toBe('$(x)')
  })

  it('statut de sortie : $? vaut 0 après un succès, non nul après un échec', () => {
    expect(sh().run('echo a ; echo $?').text).toBe('a\n0')
    expect(sh().run('cat /nexiste ; echo $?').text).toMatch(/\n1$/)
    expect(sh().run('commandeinconnue ; echo $?').text).toMatch(/\n127$/)
    expect(sh().run("cat /nexiste ; echo '$?'").text).toMatch(/\n\$\?$/)
  })

  it('un échec d’outil (permission refusée, sudo) donne un statut non nul', () => {
    const b = sh()
    expect(b.run('cat /etc/shadow || echo refus').text).toContain('refus')
    expect(b.run('cd /nexiste && echo ici').text).not.toContain('ici')
    expect(b.run('cd /tmp && pwd').text).toBe('/tmp')
  })

  it('syntaxe invalide : erreur de syntaxe sans rien exécuter', () => {
    for (const [line, token] of [
      ['&& echo a', '&&'],
      ['echo a && && echo b', '&&'],
      ['echo a &&', 'newline'],
      ['echo a ||', 'newline'],
      ['| echo a', '|']
    ] as const) {
      const r = sh().run(line)
      expect(r.text, line).toBe(r.errors)
      expect(r.errors, line).toContain(`syntax error near unexpected token \`${token}'`)
    }
    expect(sh().run('echo a ;').text).toBe('a')
    expect(sh().run('echo "a && b').errors).toContain('unexpected EOF')
  })
})

describe('bash : constructions non prises en charge', () => {
  it.each([
    ['echo $(whoami)', '$(commande)'],
    ['echo `whoami`', '`commande`'],
    ['echo "x $(whoami)"', '$(commande)'],
    ['sleep 1 &', '& (arrière-plan)'],
    ['for i in 1 2; do echo $i; done', 'for'],
    ['while true; do echo a; done', 'while'],
    ['if true; then echo a; fi', 'if'],
    ['case x in x) echo a;; esac', '( ) (sous-shell)'],
    ['{ echo a; }', '{'],
    ['(echo a)', '( ) (sous-shell)'],
    ['cat <<EOF', '<< (document en ligne)'],
    ['echo a && for i in 1; do echo $i; done', 'for'],
    ['echo a | while read x; do echo $x; done', 'while']
  ])('%s -> erreur explicite', (line, what) => {
    const r = sh().run(line)
    expect(r.text).toBe(r.errors)
    expect(r.errors).toBe(
      `bash: la construction « ${what} » existe réellement mais n’est pas simulée dans ServerLab.`
    )
  })
})
