/**
 * Instructions du langage PowerShell (v2.7, lot 1) : foreach, for, while, if/elseif/else, switch,
 * break/continue, garde-fou d'itérations, ForEach-Object et Where-Object (nouvel évaluateur).
 *
 * Attendus tirés des exemples de Microsoft Learn (PowerShell 5.1), cités en commentaire :
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_foreach
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_for
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_while
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_if
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_switch
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/foreach-object
 */
import { describe, expect, it } from 'vitest'
import { createShellSession, type LabState } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** Exécute des lignes successives dans la même session ; renvoie la sortie de la dernière. */
function ps(...lines: string[]): { text: string; errors: string } {
  const s = buildReferenceLab()
  let session = createShellSession(s, id(s, 'SRV1'), 'powershell')
  let last = { text: '', errors: '' }
  for (const line of lines) {
    const r = run(s, id(s, 'SRV1'), line, { session })
    session = r.session
    last = r
  }
  return last
}

function out(...lines: string[]): string[] {
  const r = ps(...lines)
  if (r.errors) throw new Error(r.errors)
  return r.text.split('\n')
}

describe('foreach (about_Foreach)', () => {
  it('parcourt un tableau, sur une ligne ou plusieurs', () => {
    // « $letterArray = 'a','b','c','d' ; foreach ($letter in $letterArray) { Write-Host $letter } »
    expect(
      out("$letterArray = 'a','b','c','d'", 'foreach ($letter in $letterArray) { Write-Host $letter }')
    ).toEqual(['a', 'b', 'c', 'd'])
    expect(
      out("$letterArray = 'a','b'\nforeach ($letter in $letterArray)\n{\n  Write-Host $letter\n}")
    ).toEqual(['a', 'b'])
  })

  it('collection issue d’une commande, compteur extérieur à la boucle, if/else après', () => {
    // Exemple « $i = 0 ; foreach (…) { if (…) { $i = $i + 1 } } ; if ($i -ne 0) {…} else {…} »
    expect(
      out(
        '$i = 0; foreach ($u in Get-ADUser -Filter *) { if ($u.Enabled) { $i = $i + 1 } }; if ($i -ne 0) { "$i compte(s) actif(s)" } else { "Aucun compte actif" }'
      )
    ).toEqual(['2 compte(s) actif(s)'])
  })

  it('$null : aucune itération ; sortie des objets regroupée en un seul tableau', () => {
    expect(out('foreach ($x in $null) { "jamais" }')).toEqual([''])
    const text = out('foreach ($u in Get-ADUser -Filter *) { $u | Select-Object Name }').join('\n')
    expect(text.match(/^Name$/gm)?.length).toBe(1)
    expect(text).toContain('Jean Dupont')
  })

  it('erreur dans le corps : l’instruction échoue, la boucle continue', () => {
    const r = ps('foreach ($d in 1,0,2) { 10 / $d }')
    expect(r.text.split('\n')[0]).toBe('10')
    expect(r.errors).toContain('Tentative de division par zéro.')
    expect(r.text.trimEnd().endsWith('5')).toBe(true)
  })
})

describe('for (about_For)', () => {
  it('init ; condition ; répétition', () => {
    // « for($i=1; $i -le 10; $i++){Write-Host $i} »
    expect(out('for($i=1; $i -le 10; $i++){Write-Host $i}')).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10'
    ])
    // « for ($i = 0; $i -le 20; $i += 2) { Write-Host $i } »
    expect(out('for ($i = 0; $i -le 20; $i += 2) { Write-Host $i }')).toEqual([
      '0',
      '2',
      '4',
      '6',
      '8',
      '10',
      '12',
      '14',
      '16',
      '18',
      '20'
    ])
  })

  it('affectations multiples séparées par des virgules', () => {
    // « for (($i = 0), ($j = 0); $i -lt 10 -and $j -lt 10; $i++,$j++) { "`$i:$i" ; "`$j:$j" } »
    const lines = out('for (($i = 0), ($j = 0); $i -lt 2 -and $j -lt 2; $i++,$j++) { "`$i:$i"; "`$j:$j" }')
    expect(lines).toEqual(['$i:0', '$j:0', '$i:1', '$j:1'])
  })

  it('for (;;) : garde-fou de 10 000 itérations, message honnête', () => {
    const r = ps('$n = 0; for (;;) { $n++ }; "suite"')
    expect(r.errors).toContain('Boucle « for » interrompue : plus de 10000 itérations')
    expect(r.errors).toContain('propre au simulateur ServerLab')
    // L'instruction suivante de la ligne s'exécute
    expect(r.text).toContain('suite')
  })
})

describe('while (about_While)', () => {
  it('« while($val -ne 3){$val++; Write-Host $val} » affiche 1 à 3', () => {
    expect(out('while($val -ne 3){$val++; Write-Host $val}')).toEqual(['1', '2', '3'])
  })

  it('boucle infinie interrompue par le garde-fou', () => {
    expect(ps('while ($true) { }').errors).toContain('Boucle « while » interrompue')
  })
})

describe('if / elseif / else (about_If)', () => {
  const script = (a: string) =>
    `$a = ${a}\nif ($a -gt 2) {\n    Write-Host "The value $a is greater than 2."\n}\nelseif ($a -eq 2) {\n    Write-Host "The value $a is equal to 2."\n}\nelse {\n    Write-Host ("The value $a is less than 2 or" +\n        " was not created or initialized.")\n}`

  it('exemple de la documentation, trois branches', () => {
    expect(out(script('5'))).toEqual(['The value 5 is greater than 2.'])
    expect(out(script('2'))).toEqual(['The value 2 is equal to 2.'])
    expect(out(script('1'))).toEqual(['The value 1 is less than 2 or was not created or initialized.'])
  })

  it('sur une ligne', () => {
    expect(out('if (1 -gt 2) { "oui" } else { "non" }')).toEqual(['non'])
    expect(out('if (Get-ADUser -Filter "Name -eq \'krbtgt\'") { "trouvé" }')).toEqual(['trouvé'])
  })
})

describe('switch (about_Switch)', () => {
  it('correspondance simple, toutes les conditions testées', () => {
    // « switch (3) { 1 {…} 2 {…} 3 { "It's three." } 4 {…} 3 { "Three again." } »
    expect(
      out(
        `switch (3) { 1 { "It's one." } 2 { "It's two." } 3 { "It's three." } 4 { "It's four." } 3 { "Three again." } }`
      )
    ).toEqual(["It's three.", 'Three again.'])
  })

  const fourteen = (flag: string, withDefault: boolean) =>
    `switch ${flag}("fourteen") {\n    1     { "It's one.";   break }\n    2     { "It's two.";   break }\n    3     { "It's three."; break }\n    4     { "It's four.";  break }\n    "fo*" { "That's too many."   }\n${withDefault ? '    default { "No matches" }\n' : ''}}`

  it('default, -Wildcard', () => {
    // « No matches » puis, avec -Wildcard, « That's too many. »
    expect(out(fourteen('', true))).toEqual(['No matches'])
    expect(out(fourteen('', false))).toEqual([''])
    expect(out(fourteen('-Wildcard ', false))).toEqual(["That's too many."])
  })

  it('-Regex et $Matches', () => {
    // « https://bing.com is a web address that uses https »
    const script =
      "$target = 'https://bing.com'\nswitch -Regex ($target) {\n    '^ftp\\://.*$'\n        {\n            \"$_ is an ftp address\"\n            break\n        }\n    '^(http[s]?)\\://.*$'\n        {\n            \"$_ is a web address that uses $($Matches[1])\"\n            break\n        }\n}"
    expect(out(script)).toEqual(['https://bing.com is a web address that uses https'])
  })

  it('collection, conditions en bloc de script, break et continue', () => {
    // D'après l'exemple « switch (1,4,-1,3,"Hello",2,1) » (sans -isnot [int32], non simulé)
    expect(
      out(
        'switch (1,4,-1,3,2) { {$_ -lt 0} { continue } {$_ % 2} { "$_ is Odd" } {-not ($_ % 2)} { "$_ is Even" } }'
      )
    ).toEqual(['1 is Odd', '4 is Even', '3 is Odd', '2 is Even'])
    expect(out('switch (1,2,3) { 2 { "deux"; break } default { "$_" } }')).toEqual(['1', 'deux'])
  })

  it('switch -File : non simulé', () => {
    expect(ps('switch -File C:\\a.txt { default { $_ } }').errors).toContain(
      'n’est pas simulé dans ServerLab'
    )
  })
})

describe('break, continue', () => {
  it('dans les boucles', () => {
    expect(out('foreach ($i in 1..10) { if ($i -eq 3) { break }; $i }')).toEqual(['1', '2'])
    expect(out('foreach ($i in 1..4) { if ($i % 2) { continue }; $i }')).toEqual(['2', '4'])
    expect(out('$i = 0; while ($true) { $i++; if ($i -ge 3) { break } }; $i')).toEqual(['3'])
  })
})

describe('ForEach-Object et Where-Object', () => {
  it('ForEach-Object { … $_ … }, alias % et foreach, -Begin / -End, nom de propriété', () => {
    expect(out('1..3 | ForEach-Object { $_ * 2 }')).toEqual(['2', '4', '6'])
    expect(out('1..3 | % { "n$_" }')).toEqual(['n1', 'n2', 'n3'])
    expect(out('1,2 | foreach { $_ + 10 }')).toEqual(['11', '12'])
    expect(out('1..3 | ForEach-Object -Begin { "début" } -Process { $_ } -End { "fin" }')).toEqual([
      'début',
      '1',
      '2',
      '3',
      'fin'
    ])
    expect(out('Get-ADUser -Filter "Name -like \'J*\'" | ForEach-Object Name')).toEqual(['Jean Dupont'])
  })

  it('Where-Object { … } passe par l’évaluateur complet', () => {
    expect(out('1..10 | Where-Object { $_ % 3 -eq 0 }')).toEqual(['3', '6', '9'])
    expect(out('1..5 | ? { $_ -gt 2 -and $_ -lt 5 } | % { $_ * $_ }')).toEqual(['9', '16'])
  })

  it('variables modifiées dans un bloc ForEach-Object : visibles ensuite', () => {
    expect(out('$total = 0', '1..4 | ForEach-Object { $total += $_ }', '$total')).toEqual(['10'])
  })
})

describe('erreurs de syntaxe', () => {
  it('mots clés incomplets', () => {
    expect(ps('foreach ($x 1,2) { $x }').errors).toContain('Mot clé « in » manquant')
    expect(ps('if (1)').errors).toContain('Accolade ouvrante « { » manquante')
    expect(ps('while 1 { }').errors).toContain(
      'Parenthèse ouvrante « ( » manquante après le mot clé « while »'
    )
    expect(ps('for ($i = 0) { }').errors).toContain('Point-virgule « ; » manquant')
  })

  it('erreur dans un bloc : position réelle dans la ligne', () => {
    const r = ps('1..2 | Where-Object { $_ -eq }')
    expect(r.errors).toContain('Expression manquante')
    // Position signalée : juste après « -eq » (caractère 29 de la ligne, pas du bloc)
    expect(r.errors).toContain('Ligne:1 : 29')
  })
})
