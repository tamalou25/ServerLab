/**
 * Évaluateur d'expressions PowerShell (v2.7, lot 1) : nombres, chaînes, opérateurs, plages,
 * tableaux, sous-expressions, variables de session.
 *
 * Chaque attendu est tiré d'un exemple de Microsoft Learn (PowerShell 5.1), cité en commentaire :
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_arithmetic_operators
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_operator_precedence
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_quoting_rules
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_operators
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_comparison_operators
 *  - https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_assignment_operators
 */
import { describe, expect, it } from 'vitest'
import { createShellSession, type LabState, type ShellSession } from '@engine/index'
import { buildReferenceLab } from '../serialization/reference-lab'
import { run } from './helpers'

const id = (s: LabState, name: string) => Object.values(s.devices).find((d) => d.name === name)?.id ?? ''

/** Exécute des lignes successives dans la même session ; renvoie la sortie de la dernière. */
function ps(...lines: string[]): { text: string; errors: string; session: ShellSession } {
  const s = buildReferenceLab()
  let session = createShellSession(s, id(s, 'SRV1'), 'powershell')
  let last = { text: '', errors: '' }
  for (const line of lines) {
    const r = run(s, id(s, 'SRV1'), line, { session })
    session = r.session
    last = r
  }
  return { ...last, session }
}

/** Sortie (lignes) d'une suite d'instructions, erreurs interdites. */
function out(...lines: string[]): string[] {
  const r = ps(...lines)
  if (r.errors) throw new Error(r.errors)
  return r.text.split('\n')
}

describe('arithmétique (about_Arithmetic_Operators)', () => {
  it('opérateurs + - * / % sur des nombres', () => {
    // « 6 + 2 # result = 8 », « 6 - 2 # result = 4 », « 6 * 2 # result = 12 »,
    // « 6 / 2 # result = 3 », « 7 % 2 # result = 1 », « - -6 # result = 6 »
    expect(out('6 + 2')).toEqual(['8'])
    expect(out('6 - 2')).toEqual(['4'])
    expect(out('6 * 2')).toEqual(['12'])
    expect(out('6 / 2')).toEqual(['3'])
    expect(out('7 % 2')).toEqual(['1'])
    expect(out('- -6')).toEqual(['6'])
    // Écriture sans espaces (mode expression)
    expect(out('2+3')).toEqual(['5'])
    expect(out('5 -3')).toEqual(['2'])
  })

  it('priorités et parenthèses', () => {
    // about_Operator_Precedence : « 2 + 3 * 4 → 14 », « (2 + 3) * 4 → 20 »
    expect(out('2 + 3 * 4')).toEqual(['14'])
    expect(out('(2 + 3) * 4')).toEqual(['20'])
    // about_Arithmetic_Operators : « 3+6/3*4 = 11 », « (3+6)/3*4 = 12 »
    expect(out('3+6/3*4')).toEqual(['11'])
    expect(out('(3+6)/3*4')).toEqual(['12'])
  })

  it('réels : 15 chiffres significatifs, virgule décimale à l’affichage (culture fr-FR)', () => {
    // about_Arithmetic_Operators : « 1 / 1.9 → 0.526315789473684 », « 3+6/(3*4) = 3.5 », « 2 + 3.1 → 5.1 »
    // about_Quoting_Rules : ToString() suit la culture courante, « "$x" » la culture invariante
    expect(out('1 / 1.9')).toEqual(['0,526315789473684'])
    expect(out('3+6/(3*4)')).toEqual(['3,5'])
    expect(out('2 + 3.1')).toEqual(['5,1'])
    expect(out('$x = 1.2', '"$x"')).toEqual(['1.2'])
  })

  it('chaînes et tableaux : concaténation et répétition, type de l’opérande de gauche', () => {
    // « "file" + "name" # result = "filename" », « "file" + 16 # result = "file16" »,
    // « "!" * 3 # result = "!!!" », « $array + 16 # result = 1,2,3,16 », « $array * 2 »
    expect(out('"file" + "name"')).toEqual(['filename'])
    expect(out('"file" + 16')).toEqual(['file16'])
    expect(out('"!" * 3')).toEqual(['!!!'])
    expect(out('$array = 1,2,3', '$array + 16')).toEqual(['1', '2', '3', '16'])
    expect(out('$array = 1,2,3', '$array * 2')).toEqual(['1', '2', '3', '1', '2', '3'])
    // « $a = 1,2,3 ; $b = "A","B","C" ; $a + $b »
    expect(out('$a = 1,2,3', '$b = "A","B","C"', '$a + $b')).toEqual(['1', '2', '3', 'A', 'B', 'C'])
    // « + '123' # result = 123 » et conversion d'une chaîne numérique à droite
    expect(out("+ '123'")).toEqual(['123'])
    expect(out('2 + "3"')).toEqual(['5'])
    expect(out('"2" + 3')).toEqual(['23'])
  })

  it('variables (« $intA = 6 ; $intB = 4 ; $intA + $intB → 10 », « $a + $b → PowerShell »)', () => {
    expect(out('$intA = 6', '$intB = 4', '$intA + $intB')).toEqual(['10'])
    expect(out('$a = "Power"', '$b = "Shell"', '$a + $b')).toEqual(['PowerShell'])
  })

  it('16 + "file" : conversion impossible vers le type de gauche', () => {
    // about_Arithmetic_Operators : « can't convert value "file" to type "System.Int32" »
    const r = ps('16 + "file"')
    expect(r.errors).toContain('Impossible de convertir la valeur « file » en type « System.Int32 »')
  })

  it('division par zéro : erreur d’exécution (message .NET, à vérifier sur capture)', () => {
    const r = ps('$zero = 0', '1 / $zero')
    expect(r.errors).toContain('Tentative de division par zéro.')
    expect(r.errors).toContain('RuntimeException')
  })

  it('tables de hachage : addition, clé en double refusée', () => {
    // « $hash1 + 2 → A hash table can only be added to another hash table. »
    expect(ps('$h = @{a=1}', '$h + 2').errors).toContain(
      'ne peut être ajoutée qu’à une autre table de hachage'
    )
    // « Item has already been added. Key in dictionary: 'c' »
    expect(ps('$h1 = @{a=1; c=3}', '$h2 = @{c="x"}', '$h1 + $h2').errors).toContain('déjà été ajouté')
  })
})

describe('chaînes (about_Quoting_Rules)', () => {
  it('développement des variables et des sous-expressions entre guillemets doubles', () => {
    // « $i = 5 ; "The value of $i is $i." → The value of 5 is 5. »
    expect(out('$i = 5', '"The value of $i is $i."')).toEqual(['The value of 5 is 5.'])
    // « "The value of $(2+3) is 5." → The value of 5 is 5. »
    expect(out('"The value of $(2+3) is 5."')).toEqual(['The value of 5 is 5.'])
    // « "The value of `$i is $i." → The value of $i is 5. »
    expect(out('$i = 5', '"The value of `$i is $i."')).toEqual(['The value of $i is 5.'])
    // « ${HOME}: » : nom délimité par des accolades
    expect(out('$nom = "SRV"', '"${nom}: ok"')).toEqual(['SRV: ok'])
  })

  it('guillemets simples : aucune substitution', () => {
    // « 'The value of $i is $i.' » et « 'The value of $(2+3) is 5.' » restent littéraux
    expect(out('$i = 5', "'The value of $i is $i.'")).toEqual(['The value of $i is $i.'])
    expect(out("'The value of $(2+3) is 5.'")).toEqual(['The value of $(2+3) is 5.'])
    // « 'don''t' → don't », « "As they say, ""live and learn.""" »
    expect(out("'don''t'")).toEqual(["don't"])
    expect(out('"As they say, ""live and learn."""')).toEqual(['As they say, "live and learn."'])
  })

  it('accès membre : seule la variable est développée, une sous-expression lit la propriété', () => {
    // « Variables references using array indexing or member access must be enclosed in a subexpression »
    expect(out('$t = 1,2,3', '"n = $t.Count"')).toEqual(['n = 1 2 3.Count'])
    expect(out('$t = 1,2,3', '"n = $($t.Count)"')).toEqual(['n = 3'])
    // Collections : éléments séparés par un espace ; sous-expression contenant des guillemets
    expect(out('$t = "a","b"', '"liste : $t"')).toEqual(['liste : a b'])
    expect(out('$n = "x"', '"<$($n + "y")>"')).toEqual(['<xy>'])
  })
})

describe('opérateurs (about_Operators)', () => {
  it('plage 1..10, décroissante, avec variables', () => {
    expect(out('1..5')).toEqual(['1', '2', '3', '4', '5'])
    expect(out('3..1')).toEqual(['3', '2', '1'])
    expect(out('$n = 3', '1..$n')).toEqual(['1', '2', '3'])
  })

  it('plage au-delà de la limite du simulateur : message honnête', () => {
    expect(ps('1..20000').errors).toContain('limite de 10000 éléments du simulateur ServerLab')
  })

  it('tableaux @( ), opérateur virgule, index [0] [-1] [2,1,0]', () => {
    // about_Operators : « $a = 1, 2, 3 ; $a[0] → 1 ; $a[-1] → 3 ; $a[2, 1, 0] → 3 2 1 »
    expect(out('$a = 1, 2, 3', '$a[0]')).toEqual(['1'])
    expect(out('$a = 1, 2, 3', '$a[-1]')).toEqual(['3'])
    expect(out('$a = 1, 2, 3', '$a[2, 1, 0]')).toEqual(['3', '2', '1'])
    expect(out('@(1,2,3).Count')).toEqual(['3'])
    expect(out('$v = @(5)', '$v.Count')).toEqual(['1'])
    expect(out('@()')).toEqual([''])
  })

  it('sous-expression $( ) et parenthèses', () => {
    expect(out('$(1+1; 2+2)')).toEqual(['2', '4'])
    expect(out('(Get-ADUser -Filter *).Count + 1')).toEqual(['5'])
  })

  it('opérateur de format -f', () => {
    // about_Operators : « "{0:00} {1:000} {2:000000}" -f 7, 24, 365 → 07 024 000365 »
    expect(out('"{0:00} {1:000} {2:000000}" -f 7, 24, 365')).toEqual(['07 024 000365'])
    // « "{0} vs. {{0}}" -f 'foo' → foo vs. {0} »
    expect(out('"{0} vs. {{0}}" -f \'foo\'')).toEqual(['foo vs. {0}'])
    // « "{0} {1,-10} {2:N}" -f 1,"hello",[Math]::PI → 1 hello      3.14 » (en-US) ;
    // en fr-FR, la virgule décimale (à vérifier sur capture)
    expect(out('"{0} {1,-10} {2:N}" -f 1,"hello",3.14159')).toEqual(['1 hello      3,14'])
    // Priorité : -f avant + (about_Operator_Precedence)
    expect(out("'{0}' -f 1 + 2")).toEqual(['12'])
  })

  it('format -f : index hors liste, format non simulé', () => {
    expect(ps("'{1}' -f 'a'").errors).toContain('L’index (de base zéro)')
    expect(ps("'{0:yyyy}' -f 5").errors).toContain('n’est pas simulé dans ServerLab')
  })
})

describe('comparaisons et logique', () => {
  it('résultats booléens, conversion vers le type de gauche', () => {
    // about_Comparison_Operators : « 2 -eq 2 → True », « "abc" -eq "abc" → True »
    expect(out('2 -eq 2')).toEqual(['True'])
    expect(out('"abc" -eq "ABC"')).toEqual(['True'])
    expect(out('10 -gt "9"')).toEqual(['True'])
    expect(out('"10" -gt "9"')).toEqual(['False'])
  })

  it('collection à gauche : éléments correspondants', () => {
    // about_Comparison_Operators : « 1,2,3 -eq 2 → 2 », « "abc","def" -ne "abc" → def »
    expect(out('1,2,3 -eq 2')).toEqual(['2'])
    expect(out('"abc", "def" -ne "abc"')).toEqual(['def'])
    expect(out('1,2,3 -contains 2')).toEqual(['True'])
    expect(out('2 -in 1,2,3')).toEqual(['True'])
  })

  it('-and, -or, -xor, -not, ! (même priorité, de gauche à droite)', () => {
    // about_Logical_Operators : « (1 -eq 1) -and (1 -eq 2) → False », « -not (1 -eq 1) → False »
    expect(out('(1 -eq 1) -and (1 -eq 2)')).toEqual(['False'])
    expect(out('(1 -eq 1) -or (1 -eq 2)')).toEqual(['True'])
    expect(out('(1 -eq 1) -xor (2 -eq 2)')).toEqual(['False'])
    expect(out('-not (1 -eq 1)')).toEqual(['False'])
    expect(out('!$false')).toEqual(['True'])
    expect(out('$true -or $false -and $false')).toEqual(['False'])
  })
})

describe('variables et affectations (about_Assignment_Operators)', () => {
  it('les variables persistent dans la session de la console', () => {
    const r = ps('$serveur = "SRV1"', '$serveur')
    expect(r.text).toBe('SRV1')
    expect(r.session.variables['serveur']).toBe('SRV1')
    // Nom insensible à la casse : la même variable est mise à jour
    expect(out('$X = 1', '$x = 2', '$X')).toEqual(['2'])
  })

  it('+= -= *= /= %= et ++ / --', () => {
    expect(out('$n = 10', '$n += 5', '$n')).toEqual(['15'])
    expect(out('$n = 10', '$n -= 3', '$n')).toEqual(['7'])
    expect(out('$n = 10', '$n *= 2', '$n')).toEqual(['20'])
    expect(out('$n = 10', '$n /= 4', '$n')).toEqual(['2,5'])
    expect(out('$n = 10', '$n %= 4', '$n')).toEqual(['2'])
    expect(out('$t = @()', '$t += "a"', '$t += "b"', '$t')).toEqual(['a', 'b'])
    // « $i++ » seul ne produit pas de sortie ; entre parenthèses, il renvoie l'ancienne valeur
    expect(out('$i = 1', '$i++', '$i')).toEqual(['2'])
    expect(out('$i = 1', '($i++)')).toEqual(['1'])
    expect(out('$i = 1', '(++$i)')).toEqual(['2'])
    expect(out('$i = 1', '$i--; $i')).toEqual(['0'])
  })

  it('variable inconnue : $null (pas d’erreur hors mode strict)', () => {
    // about_Automatic_Variables / about_Variables : une variable non initialisée vaut $null
    expect(out('$inconnue')).toEqual([''])
    expect(out('$inconnue + 1')).toEqual(['1'])
    expect(out('"[$inconnue]"')).toEqual(['[]'])
  })
})

describe('erreurs et constructions non simulées', () => {
  it('opérande manquant, jeton inattendu', () => {
    expect(ps('2 +').errors).toContain('Expression manquante après l’opérateur « + »')
    expect(ps('2 3').errors).toContain('Jeton inattendu « 3 »')
  })

  it('conversions [type], appels de méthode, opérateurs non simulés : message honnête', () => {
    expect(ps('[int]"5"').errors).toContain('n’est pas simulé dans ServerLab')
    expect(ps('$s = "abc"', '$s.ToUpper()').errors).toContain('L’appel de méthode « ToUpper() »')
    expect(ps("'a,b' -split ','").errors).toContain('L’opérateur « -split »')
  })

  it('les arguments de commande restent en mode argument', () => {
    expect(out('Write-Output 2+3')).toEqual(['2+3'])
    expect(out('Write-Output (2+3)')).toEqual(['5'])
  })
})
