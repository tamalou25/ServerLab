/**
 * Barre de menu native, dans la langue de l'interface (Affichage > Langue).
 * Les actions métier sont déléguées au renderer via le canal IPC `menu:command`.
 */
import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { LANGUAGE_NAMES } from '../shared/i18n'
import {
  IPC,
  LANGS,
  type LanguagePreference,
  type MenuCommand,
  type MenuState,
  type RecentFile,
  type ThemePreference
} from '../shared/ipc'
import { accelerator } from '../shared/shortcuts'
import { openBugReport } from './external'
import { t } from './i18n'

export interface MenuContext {
  window: BrowserWindow
  state: MenuState
  recent: RecentFile[]
  /** Préférence de thème (bouton radio coché dans Affichage > Thème). */
  theme: ThemePreference
  onTheme: (preference: ThemePreference) => void
  /** Préférence de langue (bouton radio coché dans Affichage > Langue). */
  language: LanguagePreference
  onLanguage: (preference: LanguagePreference) => void
  onCheckUpdates?: () => void
}

/** Envoie une commande de menu au renderer. */
function send(win: BrowserWindow, command: MenuCommand, arg?: string): void {
  if (!win.isDestroyed())
    win.webContents.send(IPC.menuCommand, arg === undefined ? { command } : { command, arg })
}

/**
 * Raccourci affiché mais non intercepté par le menu : le renderer le gère lui-même
 * (ex. Suppr ou Ctrl+Z ne doivent pas être volés aux champs de saisie).
 */
function displayOnly(
  accelerator: string
): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
  return { accelerator, registerAccelerator: false }
}

export function buildMenu(ctx: MenuContext): Menu {
  const { window: win, state, recent } = ctx
  const cmd = (command: MenuCommand, arg?: string) => () => send(win, command, arg)

  const recentItems: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: t('menu.file.noRecent'), enabled: false }]
      : recent.map((r, i) => ({
          label: `${i + 1}. ${r.name}`,
          toolTip: r.path,
          click: cmd('file:openRecent', r.path)
        }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.file.home'), click: cmd('file:home') },
        { type: 'separator' },
        { label: t('menu.file.new'), accelerator: accelerator('newFile'), click: cmd('file:new') },
        { label: t('menu.file.open'), accelerator: accelerator('open'), click: cmd('file:open') },
        { label: t('menu.file.recent'), submenu: recentItems },
        { type: 'separator' },
        { label: t('menu.file.save'), accelerator: accelerator('save'), click: cmd('file:save') },
        { label: t('menu.file.saveAs'), accelerator: accelerator('saveAs'), click: cmd('file:saveAs') },
        { type: 'separator' },
        { label: t('menu.file.openLab'), accelerator: accelerator('openLab'), click: cmd('file:openLab') },
        { label: t('menu.file.troubleshoot'), click: cmd('file:troubleshoot') },
        { type: 'separator' },
        { label: t('menu.file.quit'), accelerator: accelerator('quit'), click: () => win.close() }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        {
          label: state.undoLabel ?? t('menu.edit.undo'),
          enabled: state.undoLabel !== null,
          ...displayOnly(accelerator('undo')),
          click: cmd('edit:undo')
        },
        {
          label: state.redoLabel ?? t('menu.edit.redo'),
          enabled: state.redoLabel !== null,
          ...displayOnly(accelerator('redo')),
          click: cmd('edit:redo')
        },
        { type: 'separator' },
        { label: t('menu.edit.copy'), ...displayOnly(accelerator('copy')), click: cmd('edit:copy') },
        { label: t('menu.edit.paste'), ...displayOnly(accelerator('paste')), click: cmd('edit:paste') },
        { label: t('menu.edit.delete'), ...displayOnly(accelerator('delete')), click: cmd('edit:delete') },
        { type: 'separator' },
        {
          label: t('menu.edit.selectAll'),
          ...displayOnly(accelerator('selectAll')),
          click: cmd('edit:selectAll')
        }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.view.zoomIn'), accelerator: accelerator('zoomIn'), click: cmd('view:zoomIn') },
        { label: t('menu.view.zoomOut'), accelerator: accelerator('zoomOut'), click: cmd('view:zoomOut') },
        { label: t('menu.view.fit'), accelerator: accelerator('fit'), click: cmd('view:fit') },
        { type: 'separator' },
        {
          label: t('menu.view.portLabels'),
          type: 'checkbox',
          checked: state.showPortLabels,
          click: cmd('view:togglePortLabels')
        },
        {
          label: t('menu.view.properties'),
          type: 'checkbox',
          checked: state.showProperties,
          click: cmd('view:toggleProperties')
        },
        {
          label: t('menu.view.minimap'),
          type: 'checkbox',
          checked: state.showMinimap,
          click: cmd('view:toggleMinimap')
        },
        { type: 'separator' },
        {
          label: t('menu.view.theme'),
          submenu: (['system', 'dark', 'light'] as const).map((preference) => ({
            label: t(`menu.view.theme.${preference}`),
            type: 'radio' as const,
            checked: ctx.theme === preference,
            click: () => ctx.onTheme(preference)
          }))
        },
        {
          label: t('menu.view.language'),
          submenu: (['system', ...LANGS] as const).map((preference) => ({
            // Chaque langue est nommée dans sa propre langue (repérable quelle que soit l'interface)
            label: preference === 'system' ? t('menu.view.language.system') : LANGUAGE_NAMES[preference],
            type: 'radio' as const,
            checked: ctx.language === preference,
            click: () => ctx.onLanguage(preference)
          }))
        },
        { type: 'separator' },
        {
          label: t('menu.view.fullScreen'),
          role: 'togglefullscreen',
          accelerator: accelerator('fullScreen')
        },
        ...(app.isPackaged
          ? []
          : ([
              { type: 'separator' },
              { label: t('menu.view.reload'), role: 'reload' },
              { label: t('menu.view.devTools'), role: 'toggleDevTools' }
            ] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: t('menu.sim'),
      submenu: [
        {
          label: t('menu.sim.realtime'),
          type: 'radio',
          checked: state.mode === 'realtime',
          accelerator: accelerator('realtime'),
          click: cmd('sim:realtime')
        },
        {
          label: t('menu.sim.simulation'),
          type: 'radio',
          checked: state.mode === 'simulation',
          accelerator: accelerator('simulation'),
          click: cmd('sim:simulation')
        },
        { type: 'separator' },
        {
          label: t('menu.sim.step'),
          accelerator: accelerator('step'),
          enabled: state.mode === 'simulation',
          click: cmd('sim:step')
        },
        {
          label: t('menu.sim.play'),
          accelerator: accelerator('play'),
          enabled: state.mode === 'simulation',
          click: cmd('sim:play')
        },
        {
          label: t('menu.sim.reset'),
          accelerator: accelerator('reset'),
          enabled: state.mode === 'simulation',
          click: cmd('sim:reset')
        }
      ]
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.help.guide'), accelerator: accelerator('guide'), click: cmd('help:guide') },
        { label: t('menu.help.tutorial'), click: cmd('help:tutorial') },
        { label: t('menu.help.shortcuts'), click: cmd('help:shortcuts') },
        { type: 'separator' },
        { label: t('menu.help.bug'), click: () => void openBugReport() },
        ...(ctx.onCheckUpdates
          ? ([
              { label: t('menu.help.updates'), click: ctx.onCheckUpdates }
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        {
          label: t('menu.help.about'),
          click: () => {
            void dialog.showMessageBox(win, {
              type: 'info',
              title: t('menu.help.about'),
              message: `ServerLab ${app.getVersion()}`,
              detail: t('about.detail', {
                electron: process.versions.electron,
                chrome: process.versions.chrome
              })
            })
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
