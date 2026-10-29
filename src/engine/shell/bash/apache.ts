/**
 * Administration d'Apache2 d'une console bash (v2.9, #238) : `a2ensite`, `a2dissite`, `a2enmod`,
 * `a2dismod`, `a2enconf`, `a2disconf` (port du script Perl `a2enmod` du paquet Debian, mêmes messages,
 * mêmes dépendances entre modules) et `apache2ctl` / `apachectl` (configtest, -S, -M, -v, start, stop,
 * restart, graceful), d'après debian/a2enmod et debian/apache2ctl 2.4.68-1~deb12u1.
 *
 * Les liens symboliques de sites-enabled, mods-enabled et conf-enabled sont de vrais nœuds `link` du
 * système de fichiers simulé : `ls -l` les montre, `cat` les suit. Rien ne change dans le site servi tant
 * qu'Apache n'a pas relu sa configuration (`systemctl reload apache2`, services/linuxhttp.ts).
 */
import { APACHE_DIR, configTest, dumpVhosts, linkNode, type ApacheConfig } from '../../services/linuxapache'
import { apacheConfig, serverContext, serverDescription } from '../../services/linuxapachehost'
import { isInstalled } from '../../services/linuxpackages'
import { jobFailedLines, unitAction, unitStatus } from '../../services/linuxsystem'
import { findUnit } from '../../services/linuxcatalog'
import { providedText, resolveLink } from '../../services/linuxconfig'
import { CommandFailure, type ExecContext } from '../context'
import type { ToolDef } from '../tools/types'
import { unsimulatedOptionMessage } from '../unsimulated'
import { cloneFiles, commitFiles, linuxFiles, type LinuxFiles } from './linuxfs'

const installed = (ctx: ExecContext) => isInstalled(ctx.host, 'apache2')

// ---------------------------------------------------------------------------------------------
// a2ensite, a2dissite, a2enmod, a2dismod, a2enconf, a2disconf
// ---------------------------------------------------------------------------------------------

type Kind = 'mod' | 'site' | 'conf'
type Act = 'enable' | 'disable'

/** Modules dont la désactivation demande confirmation (@essential_module_list de a2enmod). */
const ESSENTIAL = [
  'alias',
  'auth_basic',
  'authn_file',
  'authz_host',
  'authz_user',
  'autoindex',
  'deflate',
  'dir',
  'env',
  'filter',
  'logio',
  'mime',
  'negotiation',
  'setenvif',
  'unixd',
  'version',
  'watchdog'
]

/** Arrêt du script a2enmod (die, exit) : le message est déjà écrit. */
class A2Stop extends Error {}

const globRegExp = (g: string) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )

/** Port de a2enmod : une exécution = une série d'actions sur une copie de l'arborescence. */
class A2 {
  private readonly files: LinuxFiles
  private requestReload = false
  rc = 0
  private readonly dir: string
  private readonly sffx: string
  private readonly objName: string
  private readonly label: string
  private readonly reload: string

  constructor(
    private readonly ctx: ExecContext,
    private readonly kind: Kind,
    private readonly act: Act,
    private readonly quiet: boolean,
    private readonly force: boolean
  ) {
    this.files = cloneFiles(linuxFiles(ctx))
    this.dir = kind === 'mod' ? 'mods' : kind === 'site' ? 'sites' : 'conf'
    this.sffx = kind === 'mod' ? '.load' : '.conf'
    this.objName = kind === 'mod' ? 'module' : kind
    this.label = this.objName.charAt(0).toUpperCase() + this.objName.slice(1)
    this.reload = kind === 'mod' ? 'restart' : 'reload'
  }

  get result(): LinuxFiles {
    return this.files
  }

  private get avail() {
    return `${APACHE_DIR}/${this.dir}-available`
  }
  private get enabl() {
    return `${APACHE_DIR}/${this.dir}-enabled`
  }

  private info(text: string) {
    if (!this.quiet) this.ctx.write(text)
  }
  private error(text: string) {
    this.ctx.write(`ERROR: ${text}`, 'error')
  }
  private warning(text: string) {
    this.ctx.write(`WARNING: ${text}`, 'error')
  }

  private resolve(path: string): string | null {
    let p = path
    for (let i = 0; i < 8; i++) {
      const n = this.files[p]
      if (!n) return null
      if (n.link === undefined) return p
      p = resolveLink(p, n.link)
    }
    return null
  }
  private exists = (path: string) => this.resolve(path) !== null
  private isLink = (path: string) => this.files[path]?.link !== undefined

  /** Noms (sans suffixe) des fichiers `dir/<glob><suffixe>`. */
  private glob(dir: string, g: string, sffx: string): string[] {
    const re = globRegExp(`${g}${sffx}`)
    return Object.keys(this.files)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1))
      .filter((n) => re.test(n))
      .sort()
      .map((n) => n.slice(0, n.length - sffx.length))
  }

  /** Cible relative d'un lien (File::Spec->abs2rel). */
  private relative(target: string, linkDir: string): string {
    const a = target.split('/').filter(Boolean)
    const b = linkDir.split('/').filter(Boolean)
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return [...b.slice(i).map(() => '..'), ...a.slice(i)].join('/')
  }

  private checkLink(tgt: string, link: string): string {
    if (!this.exists(link)) {
      if (this.isLink(link)) {
        // pointe dans le vide
        this.info(`Removing dangling link ${link}`)
        delete this.files[link]
      }
      return 'missing'
    }
    if (!this.isLink(link)) return `${link} is a real file, not touching it`
    if (this.resolve(link) !== this.resolve(tgt))
      return `${link} exists but does not point to ${tgt}, not touching it`
    return 'ok'
  }

  private addLink(tgt: string, link: string): boolean {
    if (!this.ctx.root) {
      this.ctx.write(`Could not create ${link}: Permission denied`, 'error')
      throw new A2Stop()
    }
    this.files[link] = {
      ...linkNode(this.relative(tgt, link.slice(0, link.lastIndexOf('/')))),
      mtime: this.ctx.state.clock
    }
    this.requestReload = true
    return true
  }

  private removeLink(link: string): boolean {
    if (this.isLink(link)) {
      if (!this.ctx.root) {
        this.ctx.write(`Could not remove ${link}: Permission denied`, 'error')
        throw new A2Stop()
      }
      delete this.files[link]
    } else if (this.exists(link)) {
      this.error(`${link} is not a symbolic link, not deleting`)
      return false
    }
    this.requestReload = true
    return true
  }

  private special(name: string) {
    if (this.kind === 'mod' && name === 'ssl' && this.act === 'enable')
      this.info(
        'See /usr/share/doc/apache2/README.Debian.gz on how to configure SSL and create self-signed certificates.'
      )
  }

  private doDeps(name: string, deps: string[], act: Act = this.act): boolean {
    for (const d of deps) {
      this.info(`Considering dependency ${d} for ${name}:`)
      if (!this.doit(d, act)) {
        this.error(`Could not ${act} dependency ${d} for ${name}, aborting`)
        return false
      }
    }
    return true
  }

  /** Texte d'un fichier (lien suivi) : contenu écrit, sinon contenu fourni par le paquet. */
  private textOf(path: string): string {
    const r = this.resolve(path)
    return r ? (this.files[r]?.content ?? providedText(r) ?? '') : ''
  }

  /** Dépendances (« # Depends: ») ou conflits d'un fichier de la configuration disponible. */
  private depsOf(path: string, type = 'Depends'): string[] {
    for (const line of this.textOf(path).split('\n')) {
      const m = new RegExp(`^# ${type}:\\s+(.*?)\\s*$`).exec(line)
      if (m) return (m[1] as string).split(/[\n\s]+/)
      if (!/^\s*(#.*)?$/.test(line)) break
    }
    return []
  }

  doit(acton: string, act: Act = this.act): boolean {
    const tgt = `${this.avail}/${acton}${this.sffx}`
    const link = `${this.enabl}/${acton}${this.sffx}`
    let conftgt: string | null = null
    let conflink: string | null = null
    if (this.kind === 'mod') {
      conftgt = `${this.avail}/${acton}.conf`
      if (this.exists(conftgt)) conflink = `${this.enabl}/${acton}.conf`
      else conftgt = null
    }
    if (!this.exists(tgt)) {
      if (this.isLink(link) && !this.exists(link)) {
        if (act === 'disable') {
          this.info(`removing dangling symlink ${link}`)
          delete this.files[link]
          const cl = `${this.enabl}/${acton}.conf`
          if (this.isLink(cl) && !this.exists(cl)) {
            this.info(`removing dangling symlink ${cl}`)
            delete this.files[cl]
          }
          return true
        }
        this.error(`${link} is a dangling symlink!`)
      }
      this.error(`${this.label} ${acton} does not exist!`)
      return false
    }

    if (this.kind === 'mod') {
      if (act === 'enable') {
        if (!this.doDeps(acton, this.depsOf(tgt), act)) return false
        const conflicts = this.depsOf(tgt, 'Conflicts')
        let bad = 0
        for (const d of conflicts) {
          this.info(`Considering conflict ${d} for ${acton}:`)
          if (this.checkLink(`${this.avail}/${d}${this.sffx}`, `${this.enabl}/${d}${this.sffx}`) === 'ok') {
            this.error(
              `Module ${d} is enabled - cannot proceed due to conflicts. It needs to be disabled first!`
            )
            bad++
          }
        }
        if (bad > 0) return false
      } else {
        const depending = this.glob(this.enabl, '*', '.load').filter((m) =>
          this.depsOf(`${this.enabl}/${m}.load`).includes(acton)
        )
        if (depending.length > 0) {
          if (this.force) {
            if (!this.doDeps(acton, depending, act)) return false
          } else {
            this.error(
              `The following modules depend on ${acton} and need to be disabled first: ${depending.join(' ')}`
            )
            return false
          }
        }
      }
    } else if (act === 'enable') {
      for (const d of this.depsOf(tgt)) {
        this.info(`Checking dependency ${d} for ${acton}:`)
        if (!this.exists(`${APACHE_DIR}/mods-enabled/${d}.load`)) {
          this.warning(`Module ${d} is not enabled, but ${acton} depends on it, aborting`)
          return false
        }
      }
    }

    if (act === 'enable') {
      const check = this.checkLink(tgt, link)
      if (check === 'ok') {
        if (conflink && conftgt) {
          const confcheck = this.checkLink(conftgt, conflink)
          if (confcheck === 'ok') {
            this.info(`${this.label} ${acton} already enabled`)
            return true
          }
          if (confcheck === 'missing') {
            this.ctx.write(`Enabling config file ${acton}.conf.`)
            return this.addLink(conftgt, conflink)
          }
          this.error(`Config file ${acton}.conf not properly enabled: ${confcheck}`)
          return false
        }
        this.info(`${this.label} ${acton} already enabled`)
        return true
      }
      if (check === 'missing') {
        if (conflink && conftgt) {
          const confcheck = this.checkLink(conftgt, conflink)
          if (confcheck === 'missing') {
            if (!this.addLink(conftgt, conflink)) return false
          } else if (confcheck !== 'ok') {
            this.error(`Config file ${acton}.conf not properly enabled: ${confcheck}`)
            return false
          }
        }
        this.ctx.write(`Enabling ${this.objName} ${acton}.`)
        this.special(acton)
        return this.addLink(tgt, link)
      }
      this.error(`${this.label} ${acton} not properly enabled: ${check}`)
      return false
    }

    // disable
    if (this.exists(link) || this.isLink(link)) {
      this.special(acton)
      if (this.kind === 'mod' && ESSENTIAL.includes(acton) && !this.force) {
        this.ctx.write('WARNING: The following essential module will be disabled.')
        this.ctx.write('This might result in unexpected behavior and should NOT be done')
        this.ctx.write('unless you know exactly what you are doing!')
        this.ctx.write(` ${acton}`)
        this.ctx.write('')
        const answer = this.ctx.ask(
          "To continue type in the phrase 'Yes, do as I say!' or retry by passing '-f': "
        )
        if (answer.trim() !== 'Yes, do as I say!') {
          this.ctx.write('Aborting')
          throw new A2Stop()
        }
      }
      this.removeLink(link)
      if (conflink && this.exists(conflink)) this.removeLink(conflink)
      this.ctx.write(`${this.label} ${acton} disabled.`)
    } else if (conflink && this.exists(conflink)) {
      this.ctx.write(`Disabling stale config file ${acton}.conf.`)
      this.removeLink(conflink)
    } else {
      this.info(`${this.label} ${acton} already disabled`)
    }
    return true
  }

  run(args: string[]): void {
    let names = args
    if (names.length === 0) {
      const choiceDir = this.act === 'enable' ? this.avail : this.enabl
      this.ctx.write(`Your choices are: ${this.glob(choiceDir, '*', this.sffx).join(' ')}`)
      names = this.ctx
        .ask(`Which ${this.objName}(s) do you want to ${this.act} (wildcards ok)?\n`)
        .split(/\s+/)
        .filter(Boolean)
    }
    const choiceDir = this.act === 'enable' ? this.avail : this.enabl
    const found: string[] = []
    for (const raw of names) {
      const arg = raw.endsWith(this.sffx) ? raw.slice(0, -this.sffx.length) : raw
      const matches = this.glob(choiceDir, arg, this.sffx)
      if (matches.length === 0) {
        this.error(`No ${this.objName} found matching ${arg}!`)
        this.rc = 1
      } else found.push(...matches)
    }
    for (const n of found) if (!this.doit(n)) this.rc = 1
    if (this.requestReload)
      this.info(`To activate the new configuration, you need to run:\n  systemctl ${this.reload} apache2`)
  }
}

function a2Tool(name: string, kind: Kind, act: Act): ToolDef {
  return {
    name,
    synopsis: `${act === 'enable' ? 'Active' : 'Désactive'} ${kind === 'mod' ? 'un module' : kind === 'site' ? 'un site' : 'une configuration'} Apache (${name} [-q] [-f] nom).`,
    switches: ['-q', '-f'],
    available: installed,
    run(ctx, args) {
      let quiet = false
      let force = false
      const rest: string[] = []
      for (const a of args) {
        if (a === '--') continue
        if (a.startsWith('--')) {
          if (a === '--quiet') quiet = true
          else if (a === '--force') force = true
          else if (a === '--maintmode' || a === '--purge')
            throw new CommandFailure(unsimulatedOptionMessage(name, a), 'NotSupported')
          else throw new CommandFailure(`Unknown option: ${a.slice(2)}`, 'InvalidArgument')
        } else if (a.startsWith('-') && a.length > 1) {
          for (const c of a.slice(1)) {
            if (c === 'q') quiet = true
            else if (c === 'f') force = true
            else if (c === 'm' || c === 'p')
              throw new CommandFailure(unsimulatedOptionMessage(name, `-${c}`), 'NotSupported')
            else throw new CommandFailure(`Unknown option: ${c}`, 'InvalidArgument')
          }
        } else rest.push(a)
      }
      const runner = new A2(ctx, kind, act, quiet, force)
      try {
        runner.run(rest)
      } catch (e) {
        if (!(e instanceof A2Stop)) throw e
      }
      // Les liens créés avant une éventuelle interruption sont conservés, comme sur le vrai système
      if (ctx.root) commitFiles(ctx, runner.result)
    }
  }
}

export const apacheEnableTools: ToolDef[] = [
  a2Tool('a2ensite', 'site', 'enable'),
  a2Tool('a2dissite', 'site', 'disable'),
  a2Tool('a2enmod', 'mod', 'enable'),
  a2Tool('a2dismod', 'mod', 'disable'),
  a2Tool('a2enconf', 'conf', 'enable'),
  a2Tool('a2disconf', 'conf', 'disable')
]

// ---------------------------------------------------------------------------------------------
// apache2ctl
// ---------------------------------------------------------------------------------------------

const ACTION_FAILED = (arg: string) => [
  `Action '${arg}' failed.`,
  'The Apache error log may have more information.'
]

/** Modules compilés dans le binaire Debian (apache2 -l), dans l'ordre de `apache2 -M`. */
const STATIC_MODULES = ['core', 'so', 'watchdog', 'http', 'log_config', 'logio', 'version', 'unixd']

function runningWord(ctx: ExecContext): boolean {
  const unit = findUnit('apache2')
  return !!unit && unitStatus(ctx.host, unit).active
}

function apacheCtl(name: string): ToolDef {
  return {
    name,
    synopsis: `Pilote Apache (${name} configtest | -S | -M | -v | start | stop | restart | graceful).`,
    switches: ['configtest', 'start', 'stop', 'restart', 'graceful', '-t', '-S', '-M', '-v'],
    available: installed,
    run(ctx, args) {
      const path = `/usr/sbin/${name}`
      const arg = args.join(' ')
      if (arg === '' || arg === 'usage' || arg === 'help' || arg === '--help') {
        ctx.writeLines(
          [
            `Usage: ${path} start|stop|restart|graceful|graceful-stop|configtest|status|fullstatus|help`,
            `       ${path} <apache2 args>`,
            `       ${path} -h            (for help on <apache2 args>)`
          ],
          'error'
        )
        return
      }
      const failed = (): void => ctx.writeLines(ACTION_FAILED(arg), 'error')
      const test = (cfg: ApacheConfig): boolean => {
        const r = configTest(cfg)
        ctx.writeLines(r.stderr, 'error')
        return r.ok
      }
      const unit = findUnit('apache2')
      const control = (action: 'start' | 'stop' | 'restart' | 'reload'): boolean => {
        const r = unitAction(ctx.state, ctx.deviceId, 'apache2', action)
        if (!r.ok) throw new CommandFailure(r.error.message, r.error.code)
        ctx.state = r.state
        if (r.value.startFailed && unit) ctx.writeLines(jobFailedLines(unit), 'error')
        return !r.value.startFailed
      }
      switch (arg) {
        case 'configtest':
        case '-t':
          if (!test(apacheConfig(ctx.host, 'live'))) failed()
          return
        case '-S': {
          const cfg = apacheConfig(ctx.host, 'live')
          const r = configTest(cfg)
          if (!r.ok) {
            ctx.writeLines(r.stderr, 'error')
            failed()
            return
          }
          ctx.writeLines(cfg.warnings, 'error')
          ctx.writeLines(dumpVhosts(cfg, serverContext(ctx.host)))
          return
        }
        case '-M': {
          const cfg = apacheConfig(ctx.host, 'live')
          const r = configTest(cfg)
          if (!r.ok) {
            ctx.writeLines(r.stderr, 'error')
            failed()
            return
          }
          ctx.writeLines(cfg.warnings, 'error')
          ctx.write('Loaded Modules:')
          ctx.writeLines([
            ...STATIC_MODULES.map((m) => ` ${m}_module (static)`),
            ...cfg.modules.map((m) => ` ${m}_module (shared)`)
          ])
          return
        }
        case '-v':
          ctx.write(`Server version: ${serverDescription(ctx.host)}`)
          ctx.write(
            'apache2ctl -v : la date de compilation (« Server built ») n’est pas reproduite par ServerLab.',
            'warning'
          )
          return
        case 'start':
          ctx.write("Invoking 'systemctl start apache2'.")
          ctx.write("Use 'systemctl status apache2' for more info.")
          if (!ctx.root) {
            ctx.writeLines(
              [
                'Failed to start apache2.service: Interactive authentication required.',
                "See system logs and 'systemctl status apache2.service' for details."
              ],
              'error'
            )
            failed()
            return
          }
          if (!control('start')) failed()
          return
        case 'stop':
        case 'graceful-stop':
        case 'restart':
        case 'graceful': {
          if (!ctx.root)
            throw new CommandFailure(
              `${name} ${arg} : droits root requis (sudo) ; le message d’Apache sans privilèges n’est pas reproduit par ServerLab.`,
              'NotSupported'
            )
          if (arg === 'restart' || arg === 'graceful') {
            // Le premier -t est silencieux ; en cas d'erreur il est rejoué à l'écran
            const r = configTest(apacheConfig(ctx.host, 'live'))
            if (!r.ok) {
              ctx.writeLines(r.stderr, 'error')
              failed()
              return
            }
          }
          if (!runningWord(ctx)) {
            if (arg === 'stop' || arg === 'graceful-stop') {
              ctx.write('httpd (no pid file) not running')
              failed()
              return
            }
            ctx.write('httpd not running, trying to start')
            if (!control('start')) failed()
            return
          }
          const ok =
            arg === 'stop' || arg === 'graceful-stop'
              ? control('stop')
              : control(arg === 'restart' ? 'restart' : 'reload')
          if (!ok) failed()
          return
        }
        case 'status':
        case 'fullstatus':
          throw new CommandFailure(unsimulatedOptionMessage(name, arg), 'NotSupported')
        default:
          throw new CommandFailure(unsimulatedOptionMessage(name, arg), 'NotSupported')
      }
    }
  }
}

export const apacheCtlTools: ToolDef[] = [apacheCtl('apache2ctl'), apacheCtl('apachectl')]
export const apacheBashTools: ToolDef[] = [...apacheEnableTools, ...apacheCtlTools]
