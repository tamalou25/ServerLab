/**
 * Encodages de fichier et taille en octets (module sans dépendance : évite les imports circulaires).
 */

/**
 * Encodages des cmdlets de contenu de Windows PowerShell 5.1 (paramètre -Encoding de Set-Content,
 * Add-Content, Out-File, Export-Csv) :
 * https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1
 */
export const FILE_ENCODINGS = [
  'ASCII',
  'BigEndianUnicode',
  'BigEndianUTF32',
  'Default',
  'OEM',
  'String',
  'Unicode',
  'Unknown',
  'UTF7',
  'UTF8',
  'UTF32'
] as const
export type FileEncoding = (typeof FILE_ENCODINGS)[number]

/** Octets d'un texte en UTF-8. */
function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * Taille en octets d'un texte encodé : UTF-16 (Unicode, BigEndianUnicode), UTF-32 et UTF-8 de
 * Windows PowerShell 5.1 précédés de leur marque d'ordre des octets (BOM) ; ASCII, Default (ANSI),
 * OEM : un octet par caractère. `bom` = faux pour un ajout à un fichier existant.
 */
export function encodedSize(text: string, encoding: FileEncoding, bom = true): number {
  switch (encoding) {
    case 'Unicode':
    case 'BigEndianUnicode':
    case 'String':
    case 'Unknown':
      return (bom ? 2 : 0) + text.length * 2
    case 'UTF32':
    case 'BigEndianUTF32':
      return (bom ? 4 : 0) + [...text].length * 4
    case 'UTF8':
      return (bom ? 3 : 0) + utf8Bytes(text)
    case 'UTF7':
      return utf8Bytes(text)
    default:
      return [...text].length
  }
}
