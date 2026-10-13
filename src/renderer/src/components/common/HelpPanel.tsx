/**
 * Aide intégrée : guide de démarrage et raccourcis clavier (générés depuis le catalogue partagé
 * `shared/shortcuts.ts`, d'où le menu natif tire aussi ses accélérateurs).
 */
import { X } from 'lucide-react'
import { useDialog } from '../../hooks/useDialog'
import {
  formatShortcut,
  SHORTCUT_GROUPS,
  shortcutGroupLabel,
  shortcutLabel,
  SHORTCUTS,
  type ShortcutId
} from '@shared/shortcuts'
import { rich, useT } from '../../lib/i18n'
import { useUiStore } from '../../store/ui'

/** Raccourcis groupés, dans l'ordre de l'aide (catalogue partagé avec le menu natif). */
const SHORTCUT_ROWS = SHORTCUT_GROUPS.map((group) => ({
  group,
  rows: (Object.keys(SHORTCUTS) as ShortcutId[]).filter((id) => SHORTCUTS[id].group === group)
}))

export function HelpPanel() {
  const panel = useUiStore((s) => s.helpPanel)
  const { lang, t } = useT()
  const close = () => useUiStore.getState().setHelpPanel(null)
  const { ref, titleId } = useDialog(!!panel, close)
  if (!panel) return null
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="fixed inset-0 z-[350] flex items-center justify-center bg-scrim outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={close}
    >
      <div
        className="max-h-[80vh] w-[560px] overflow-y-auto rounded-md border border-line bg-overlay p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold text-fg">
            {panel === 'guide' ? t('help.guide.title') : t('help.shortcuts.title')}
          </h2>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
            title={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
        {panel === 'shortcuts' ? (
          <table className="w-full text-sm" data-testid="shortcuts-table">
            {SHORTCUT_ROWS.map(({ group, rows }) => (
              <tbody key={group}>
                <tr>
                  <th
                    colSpan={2}
                    className="pt-3 pb-1 text-left text-xs font-semibold text-fg-subtle uppercase"
                  >
                    {shortcutGroupLabel(group, lang)}
                  </th>
                </tr>
                {rows.map((id) => (
                  <tr key={id} className="border-b border-line">
                    <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-fg-muted">
                      {SHORTCUTS[id].keys
                        .map((key) => formatShortcut(key, lang))
                        .join(` ${t('shortcut.or')} `)}
                    </td>
                    <td className="py-1.5 text-fg">{shortcutLabel(id, lang)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        ) : (
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-[13px] text-fg">
            <li>{t('help.guide.1')}</li>
            <li>{t('help.guide.2')}</li>
            <li>
              {rich(t('help.guide.3'), {
                green: <b className="text-ok">{t('help.guide.green')}</b>,
                orange: <b className="text-warn">{t('help.guide.orange')}</b>,
                red: <b className="text-danger">{t('help.guide.red')}</b>
              })}
            </li>
            <li>{t('help.guide.4')}</li>
            <li>{t('help.guide.5')}</li>
            <li>{t('help.guide.6')}</li>
          </ol>
        )}
      </div>
    </div>
  )
}
