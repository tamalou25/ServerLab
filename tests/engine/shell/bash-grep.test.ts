/**
 * grep de la console bash (#374) : -c, -n (avec -i, -v), options réelles refusées, statut de sortie
 * 0 / 1 / 2 exploité avec && et || (source : grep(1), Debian bookworm).
 */
import { describe, expect, it } from 'vitest'
import { Bash } from './bash-helpers'

function lab(): Bash {
  const b = new Bash()
  b.run('echo "Alpha" > f')
  b.run('echo "beta" >> f')
  b.run('echo "alphabet" >> f')
  return b
}

describe('grep -c / -n', () => {
  it('-c compte les lignes correspondantes', () => {
    const b = lab()
    expect(b.run('grep -c alpha f').text).toBe('1')
    expect(b.run('grep -ci alpha f').text).toBe('2')
    expect(b.run('grep -cv alpha f').text).toBe('2')
    expect(b.run('cat f | grep -c a').text).toBe('3')
  })

  it('-n préfixe le numéro de ligne', () => {
    const b = lab()
    expect(b.run('grep -n bet f').text).toBe('2:beta\n3:alphabet')
    expect(b.run('grep -ni alpha f').text).toBe('1:Alpha\n3:alphabet')
    expect(b.run('grep -nv bet f').text).toBe('1:Alpha')
    expect(b.run('cat f | grep -n beta').text).toBe('2:beta')
  })

  it('plusieurs fichiers : préfixe fichier:', () => {
    const b = lab()
    expect(b.run('grep -c beta f /etc/hostname').text).toBe('f:1\n/etc/hostname:0')
  })

  it('-v ne rajoute pas de ligne vide finale', () => {
    const r = lab().run('grep -v zzz f')
    expect(r.text).toBe('Alpha\nbeta\nalphabet')
  })
})

describe('grep : options réelles non simulées', () => {
  it.each(['-E', '-r', '-w', '-x', '-l', '-o', '-ie', '--color', '-A'])('%s refusée', (opt) => {
    const r = lab().run(`grep ${opt} beta f`)
    expect(r.errors).toContain('existe réellement mais n’est pas simulée dans ServerLab')
    expect(r.errors).not.toContain('command not found')
    expect(r.text).toBe(r.errors)
  })

  it('refusée aussi dans un tube', () => {
    const r = lab().run('cat f | grep -E beta')
    expect(r.errors).toContain('L’option « -E » de grep existe réellement')
  })
})

describe('grep : statut de sortie', () => {
  it('0 avec correspondance, 1 sans, 2 sur erreur de fichier', () => {
    const b = lab()
    expect(b.run('grep beta f ; echo $?').text).toBe('beta\n0')
    expect(b.run('grep zzz f ; echo $?').text).toBe('1')
    expect(b.run('grep -c zzz f ; echo $?').text).toBe('0\n1')
    expect(b.run('grep beta /nexiste ; echo $?').text).toMatch(/\n2$/)
    expect(b.run('cat f | grep zzz ; echo $?').text).toBe('1')
  })

  it('avec && et ||', () => {
    const b = lab()
    expect(b.run('grep beta f && echo oui').text).toBe('beta\noui')
    expect(b.run('grep zzz f && echo oui').text).toBe('')
    expect(b.run('grep zzz f || echo non').text).toBe('non')
    expect(b.run('grep beta f || echo non').text).toBe('beta')
    expect(b.run('cat f | grep zzz || echo non').text).toBe('non')
  })
})
