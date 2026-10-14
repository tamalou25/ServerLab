/**
 * Horloge simulée : le temps du lab part du lundi 5 janvier 2026 à 8 h.
 * Les fonctions de formatage sont déterministes (pas d'accès à l'horloge système).
 */

export const LAB_EPOCH_MS = Date.UTC(2026, 0, 5, 8, 0, 0)

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre'
]

/** Composantes (UTC) de l'horloge du lab. */
export function clockParts(clock: number) {
  const d = new Date(LAB_EPOCH_MS + clock)
  return {
    day: d.getUTCDay(),
    date: d.getUTCDate(),
    month: d.getUTCMonth(),
    year: d.getUTCFullYear(),
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    s: d.getUTCSeconds()
  }
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** « lundi 5 janvier 2026 08:00:00 » (format d'ipconfig /all). */
export function formatLongDate(clock: number): string {
  const t = clockParts(clock)
  return `${DAYS[t.day]} ${t.date} ${MONTHS[t.month]} ${t.year} ${p2(t.h)}:${p2(t.m)}:${p2(t.s)}`
}

/** « 05/01/2026 08:00:00 ». */
export function formatShortDate(clock: number): string {
  const t = clockParts(clock)
  return `${p2(t.date)}/${p2(t.month + 1)}/${t.year} ${p2(t.h)}:${p2(t.m)}:${p2(t.s)}`
}

/** Éléments d'horloge pour l'affichage (barre des tâches, écran de verrouillage). */
export function formatClockParts(clock: number): { time: string; date: string; longDate: string } {
  const t = clockParts(clock)
  return {
    time: `${p2(t.h)}:${p2(t.m)}`,
    date: `${p2(t.date)}/${p2(t.month + 1)}/${t.year}`,
    longDate: `${DAYS[t.day]} ${t.date} ${MONTHS[t.month]}`
  }
}

/**
 * Date saisie (« 05/01/2026 08:30 », « 2026-01-05 08:30:00 ») → horloge du lab, ou null.
 * Heure facultative (minuit).
 */
export function parseLabDate(text: string): number | null {
  const t = text.trim()
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  const m = fr
    ? [fr[3], fr[2], fr[1], fr[4], fr[5], fr[6]]
    : iso
      ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
      : null
  if (!m) return null
  const [y, mo, d, h, mi, se] = m.map((x) => Number(x ?? 0))
  const ms = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, se ?? 0)
  return Number.isNaN(ms) ? null : ms - LAB_EPOCH_MS
}
