/**
 * Aides des tests Apache2 (v2.9, #238) : écriture de fichiers de plusieurs lignes avec `tee` et fichiers
 * de sites (un hôte virtuel par nom sur le port 80).
 */
export type Who = 'srv' | 'pc'
/** [machine, ligne tapée, réponses aux invites] */
export type Command = [Who, string, string[]?]

/** Écrit un fichier de plusieurs lignes avec `tee` (une commande par ligne, la première crée le fichier). */
export function writeFile(path: string, lines: string[]): Command[] {
  return lines.map((l, i) => ['srv', `echo '${l}' | sudo tee ${i === 0 ? '' : '-a '}${path}`] as Command)
}

/** Fichier de site Apache : un hôte virtuel par nom sur le port 80. */
export function siteFile(name: string, root: string, extra: string[] = []): Command[] {
  return writeFile(`/etc/apache2/sites-available/${name}.conf`, [
    '<VirtualHost *:80>',
    `    ServerName ${name}.lab.local`,
    `    DocumentRoot ${root}`,
    ...extra,
    '</VirtualHost>'
  ])
}
