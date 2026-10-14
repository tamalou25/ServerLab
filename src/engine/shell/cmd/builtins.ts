/**
 * Commandes internes de l'Invite de commandes portant sur les variables et les fichiers :
 * set, type, cd / chdir, copy, move, ren / rename, changement de lecteur (« Z: »).
 *
 * Comportement d'après Microsoft Learn (fr-fr, windows-commands) :
 * - set : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/set_1
 *   (sans paramètre : variables actuelles ; `set p` : variables commençant par p ; `set x=` efface x) ;
 * - type : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/type
 *   (affiche un fichier texte sans le modifier ; plusieurs noms séparés par des espaces) ;
 * - cd : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/cd
 *   (/d change aussi le lecteur ; espaces non délimiteurs ; `cd X:` affiche le dossier de X:) ;
 * - copy : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/copy
 *   (/y supprime la confirmation de remplacement, /-y la demande ; sans destination, copie dans le
 *   dossier courant ; copie sur lui-même refusée) ;
 * - move : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/move
 *   (fichiers ou dossier ; déplacer ou renommer ; /y, /-y) ;
 * - ren : https://learn.microsoft.com/fr-fr/windows-server/administration/windows-commands/ren
 *   (ni lecteur ni chemin dans le nouveau nom ; nom en double ou fichier introuvable).
 * Les libellés français des messages ne figurent pas sur Learn : ils sont signalés « à vérifier »
 * dans docs/fidelite.md (Lot 3).
 */
import type { FsNode, ServerDevice } from '../../model/schema'
import { copyItem, moveItem, renameItem, writeFileContent } from '../../roles/files/actions'
import { accessPerms } from '../../roles/files/acl'
import { contentLines } from '../../roles/files/content'
import { changeDirectory } from '../../roles/files/tools'
import type { ExecContext } from '../context'
import { nodeAt, shellToken, translatePath, type FsTarget } from '../filesystem'
import { cmdVariables, setCmdVariable } from './env'

const SYNTAX_ERROR = 'La syntaxe de la commande n’est pas correcte.'
const NOT_FOUND = 'Le fichier spécifié est introuvable.'
const ACCESS_DENIED = 'Accès refusé.'

const shareOpt = (t: FsTarget) => (t.share ? { share: t.share.name } : {})
const hasWildcard = (p: string) => /[*?]/.test(p)

function wildcardUnsimulated(ctx: ExecContext, command: string): void {
  ctx.write(`Les caractères génériques (* et ?) de ${command} ne sont pas simulés dans ServerLab.`, 'error')
}

/** Traduit un chemin ; écrit l'erreur et renvoie null en cas d'échec. */
function resolve(ctx: ExecContext, path: string): FsTarget | null {
  const r = translatePath(ctx, path)
  if (!r.ok) {
    ctx.write(r.error, 'error')
    return null
  }
  return r.target
}

function engineError(ctx: ExecContext, code: string, message: string): void {
  ctx.write(code === 'AccessDenied' ? ACCESS_DENIED : message, 'error')
}

// ---------------------------------------------------------------------------------------------
// set

/** `set`, `set préfixe`, `set nom=valeur`, `set nom=` (texte après `set`, non découpé). */
export function runSet(ctx: ExecContext, text: string): void {
  const arg = text.trim()
  if (/^\/[ap](\s|$)/i.test(arg)) {
    ctx.write(`L’option ${arg.slice(0, 2).toLowerCase()} de set n’est pas simulée dans ServerLab.`, 'error')
    return
  }
  // Guillemets englobants : set "nom=valeur"
  const body = /^".*"$/.test(arg) ? arg.slice(1, -1) : arg
  const eq = body.indexOf('=')
  if (eq === 0) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  if (eq > 0) {
    const name = body.slice(0, eq)
    const value = body.slice(eq + 1)
    setCmdVariable(ctx, name, value === '' ? null : value)
    return
  }
  const prefix = body.toLowerCase()
  const vars = cmdVariables(ctx).filter(([n]) => n.toLowerCase().startsWith(prefix))
  if (vars.length === 0) {
    ctx.write(`La variable d’environnement ${body} n’est pas définie`, 'error')
    return
  }
  ctx.writeLines(vars.map(([n, v]) => `${n}=${v}`))
}

// ---------------------------------------------------------------------------------------------
// type

/** Fichier existant et lisible, ou message d'erreur écrit. */
function readable(ctx: ExecContext, path: string): { t: FsTarget; node: FsNode } | null {
  const t = resolve(ctx, path)
  if (!t) return null
  const node = nodeAt(t)
  if (node === undefined) {
    ctx.write(NOT_FOUND, 'error')
    return null
  }
  if (node === null || node.kind === 'folder') {
    ctx.write(ACCESS_DENIED, 'error')
    return null
  }
  if (!accessPerms(t.server.storage, node.id, shellToken(ctx), t.share).has('read')) {
    ctx.write(ACCESS_DENIED, 'error')
    return null
  }
  return { t, node }
}

export function runType(ctx: ExecContext, args: string[]): void {
  if (args.length === 0) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  for (const path of args) {
    if (hasWildcard(path)) {
      wildcardUnsimulated(ctx, 'type')
      continue
    }
    const f = readable(ctx, path)
    if (f) ctx.writeLines(contentLines(f.node.content ?? ''))
  }
}

// ---------------------------------------------------------------------------------------------
// cd / chdir, changement de lecteur

/** Lecteur d'un chemin absolu (« C: », « Z: »), null pour un chemin UNC ou relatif. */
function driveOf(path: string): string | null {
  const m = /^([a-z]):/i.exec(path)
  return m ? `${(m[1] as string).toUpperCase()}:` : null
}

export function runCd(ctx: ExecContext, args: string[]): void {
  const switchD = args.some((a) => a.toLowerCase() === '/d')
  // Les espaces ne sont pas des délimiteurs (extensions de commande activées)
  const target = args.filter((a) => a.toLowerCase() !== '/d').join(' ')
  if (target === '') {
    ctx.write(ctx.session.cwd)
    return
  }
  const current = driveOf(ctx.session.cwd)
  const drive = driveOf(target)
  // « cd X: » : affiche le dossier courant du lecteur (racine : dossier par lecteur non mémorisé)
  if (/^[a-z]:$/i.test(target)) {
    ctx.write(drive === current ? ctx.session.cwd : `${drive}\\`)
    return
  }
  if (drive && drive !== current && !switchD) {
    // Sans /d, le lecteur courant ne change pas : on vérifie seulement que le dossier existe
    const before = ctx.session
    changeDirectory(ctx, target)
    ctx.session = before
    return
  }
  changeDirectory(ctx, target)
}

/** « Z: » tapé seul : passe à la racine du lecteur. */
export function runDriveChange(ctx: ExecContext, drive: string): void {
  const r = translatePath(ctx, `${drive.toUpperCase()}\\`)
  if (!r.ok) {
    ctx.write('Le chemin d’accès spécifié est introuvable.', 'error')
    return
  }
  ctx.session = { ...ctx.session, cwd: `${drive.toUpperCase()}\\` }
}

// ---------------------------------------------------------------------------------------------
// copy / move

/** Options /y, /-y et chemins ; null si une option n'est pas simulée (message écrit). */
function parseCopyArgs(
  ctx: ExecContext,
  command: 'copy' | 'move',
  args: string[]
): { paths: string[]; confirm: boolean } | null {
  let confirm = true
  const paths: string[] = []
  // copy : /v (vérification) n'a pas d'effet observable dans le simulateur
  const accepted = command === 'copy' ? ['/v'] : []
  for (const a of args) {
    const lower = a.toLowerCase()
    if (lower === '/y') confirm = false
    else if (lower === '/-y' || lower === '-y') confirm = true
    else if (accepted.includes(lower)) continue
    else if (a.startsWith('/')) {
      ctx.write(`L’option ${a} de ${command} n’est pas simulée dans ServerLab.`, 'error')
      return null
    } else paths.push(a)
  }
  return { paths, confirm }
}

/** Confirmation de remplacement : true si l'utilisateur accepte. */
function confirmOverwrite(ctx: ExecContext, display: string): boolean {
  const answer = ctx.ask(`Remplacer ${display} (Oui/Non/Tous) : `).trim().toLowerCase()
  return answer.startsWith('o') || answer.startsWith('t')
}

/** Cible finale d'une copie ou d'un déplacement (dossier existant → même nom dedans). */
function finalTarget(
  dest: FsTarget,
  name: string
): { local: string; display: string; node: FsNode | null | undefined } {
  const node = nodeAt(dest)
  if (node === null || node?.kind === 'folder') {
    const local = `${dest.localPath.replace(/\\$/, '')}\\${name}`
    const display = `${dest.display.replace(/\\$/, '')}\\${name}`
    return { local, display, node: nodeAt({ ...dest, localPath: local }) }
  }
  return { local: dest.localPath, display: dest.display, node }
}

const sameFile = (a: FsTarget, bLocal: string, bServer: ServerDevice) =>
  a.server.id === bServer.id && a.localPath.toLowerCase() === bLocal.toLowerCase()

export function runCopy(ctx: ExecContext, args: string[]): void {
  const parsed = parseCopyArgs(ctx, 'copy', args)
  if (!parsed) return
  const { paths, confirm } = parsed
  if (paths.some((p) => p.includes('+'))) {
    ctx.write('La concaténation de fichiers (+) de copy n’est pas simulée dans ServerLab.', 'error')
    return
  }
  if (paths.length === 0 || paths.length > 2) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  const [source = '', destination = '.'] = paths
  if (hasWildcard(source) || hasWildcard(destination)) {
    wildcardUnsimulated(ctx, 'copy')
    return
  }
  const src = resolve(ctx, source)
  if (!src) return
  const node = nodeAt(src)
  if (node === undefined) {
    ctx.write(NOT_FOUND, 'error')
    ctx.write('        0 fichier(s) copié(s).')
    return
  }
  if (node === null || node.kind === 'folder') {
    ctx.write(
      'La copie d’un dossier par copy n’est pas simulée dans ServerLab (copier les fichiers un par un).',
      'error'
    )
    return
  }
  const dest = resolve(ctx, destination)
  if (!dest) return
  const target = finalTarget(dest, node.name)
  if (sameFile(src, target.local, dest.server)) {
    ctx.write('Le fichier ne peut pas être copié sur lui-même.', 'error')
    ctx.write('        0 fichier(s) copié(s).')
    return
  }
  if (target.node?.kind === 'folder') {
    ctx.write(ACCESS_DENIED, 'error')
    return
  }
  if (target.node && confirm && !confirmOverwrite(ctx, target.display)) {
    ctx.write('        0 fichier(s) copié(s).')
    return
  }
  const token = shellToken(ctx)
  const r =
    src.server.id === dest.server.id
      ? copyItem(ctx.state, src.server.id, src.localPath, target.local, token, {
          ...shareOpt(src),
          ...(dest.share ? { destinationShare: dest.share.name } : {})
        })
      : // Entre deux serveurs : lecture de la source puis écriture du contenu sur la destination
        accessPerms(src.server.storage, node.id, token, src.share).has('read')
        ? writeFileContent(ctx.state, dest.server.id, target.local, node.content ?? '', token, shareOpt(dest))
        : ({ ok: false, error: { code: 'AccessDenied', message: ACCESS_DENIED } } as const)
  if (!r.ok) {
    engineError(ctx, r.error.code, r.error.message)
    ctx.write('        0 fichier(s) copié(s).')
    return
  }
  ctx.state = r.state
  ctx.write('        1 fichier(s) copié(s).')
}

export function runMove(ctx: ExecContext, args: string[]): void {
  const parsed = parseCopyArgs(ctx, 'move', args)
  if (!parsed) return
  const { paths, confirm } = parsed
  if (paths.length !== 2) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  const [source = '', destination = ''] = paths
  if (hasWildcard(source) || hasWildcard(destination)) {
    wildcardUnsimulated(ctx, 'move')
    return
  }
  const src = resolve(ctx, source)
  if (!src) return
  const node = nodeAt(src)
  if (node === undefined) {
    ctx.write(NOT_FOUND, 'error')
    return
  }
  if (node === null) {
    ctx.write(ACCESS_DENIED, 'error')
    return
  }
  const dest = resolve(ctx, destination)
  if (!dest) return
  if (dest.server.id !== src.server.id) {
    ctx.write('Le déplacement entre deux serveurs n’est pas simulé dans ServerLab (copy puis del).', 'error')
    return
  }
  const target = finalTarget(dest, node.name)
  let replace = false
  if (target.node && target.node.id !== node.id) {
    if (target.node.kind === 'folder' || node.kind === 'folder') {
      ctx.write(ACCESS_DENIED, 'error')
      return
    }
    if (confirm && !confirmOverwrite(ctx, target.display)) {
      ctx.write('        0 fichier(s) déplacé(s).')
      return
    }
    replace = true
  }
  const r = moveItem(ctx.state, src.server.id, src.localPath, target.local, shellToken(ctx), {
    replace,
    ...shareOpt(src),
    ...(dest.share ? { destinationShare: dest.share.name } : {})
  })
  if (!r.ok) {
    engineError(ctx, r.error.code, r.error.message)
    return
  }
  ctx.state = r.state
  ctx.write(
    node.kind === 'folder' ? '        1 répertoire(s) déplacé(s).' : '        1 fichier(s) déplacé(s).'
  )
}

// ---------------------------------------------------------------------------------------------
// ren / rename

export function runRen(ctx: ExecContext, args: string[]): void {
  if (args.length !== 2) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  const [source = '', newName = ''] = args
  // Learn : ni nouveau lecteur ni chemin dans le nouveau nom
  if (/[\\/:]/.test(newName)) {
    ctx.write(SYNTAX_ERROR, 'error')
    return
  }
  if (hasWildcard(source) || hasWildcard(newName)) {
    wildcardUnsimulated(ctx, 'ren')
    return
  }
  const t = resolve(ctx, source)
  if (!t) return
  const node = nodeAt(t)
  const duplicate = 'Un fichier en double existe, ou le fichier est introuvable.'
  if (!node) {
    ctx.write(node === null ? ACCESS_DENIED : duplicate, 'error')
    return
  }
  const r = renameItem(ctx.state, t.server.id, t.localPath, newName, shellToken(ctx), shareOpt(t))
  if (!r.ok) {
    ctx.write(
      r.error.code === 'ItemExists'
        ? duplicate
        : r.error.code === 'AccessDenied'
          ? ACCESS_DENIED
          : r.error.message,
      'error'
    )
    return
  }
  ctx.state = r.state
}
