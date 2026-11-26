// Text for the G2 firmware font: one proportional font, no sizes, and any
// glyph it lacks is silently dropped (no ♯ ♭ ♪, no curly quotes, no emoji).
// Glyph coverage per github.com/nickustinov/even-g2-notes (docs/display.md).

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
  [/…/g, '...'],
  [/♯/g, '#'],
  [/♭/g, 'b'],
  [/[  -  ]/g, ' '],
  [/•/g, '·'],
]

// Emoji, dingbats, misc technical, variation selectors, zero-width joiners.
const UNSUPPORTED = /[\p{Extended_Pictographic}⌀-⏿✀-➿︀-️​-‍]/gu
const KEEP = new Set('©®™↔↕↖↗↘↙★☆♠♡♣♤♥♧')

/** Makes a string safe for the glasses font. Keeps newlines. */
export function glassesText(input: string): string {
  let s = input
  for (const [pattern, replacement] of REPLACEMENTS) s = s.replace(pattern, replacement)
  return s.replace(UNSUPPORTED, ch => (KEEP.has(ch) ? ch : ''))
}

/**
 * Approximate rendered width in pixels. The font is proportional; these
 * widths are rough averages that run slightly wide so lines don't wrap.
 */
export function approxPx(s: string): number {
  let w = 0
  for (const ch of s) {
    if (/[⺀-￯]/.test(ch)) w += 24
    else if (/[━─▕▏█▒]/.test(ch)) w += 20
    else if (/[MWmw@%]/.test(ch)) w += 16
    else if (/[A-Z]/.test(ch)) w += /[IJ]/.test(ch) ? 6 : 12
    else if (/[0-9]/.test(ch)) w += 11.5
    else if (/[ijl.,:;'!|·]/.test(ch)) w += 5
    else if (/[frt]/.test(ch)) w += 7
    else if (ch === ' ') w += 5.3
    else if (/[-"()[\]/#]/.test(ch)) w += 8
    else w += 10.3
  }
  return Math.ceil(w)
}

/** Cuts a single line to fit `maxPx`, ending in "..." when shortened. */
export function clipPx(input: string, maxPx: number): string {
  // Keep runs of spaces: chord lists use two spaces between chords for legibility.
  let s = glassesText(input).replace(/[\r\n\t]+/g, ' ').trim()
  if (approxPx(s) <= maxPx) return s
  while (s.length && approxPx(s + '...') > maxPx) s = Array.from(s).slice(0, -1).join('')
  return s.trimEnd() + '...'
}

/** Joins items with `sep` until the next one wouldn't fit in `maxPx`. */
export function fitItems(items: string[], maxPx: number, sep = '  '): string {
  let out = ''
  for (const item of items) {
    const next = out ? out + sep + item : item
    if (approxPx(next) > maxPx) break
    out = next
  }
  return out
}

/** "━━━━━━────" for a fraction 0..1. */
export function bar(fraction: number, cells = 10): string {
  const f = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(f * cells)
  return '━'.repeat(filled) + '─'.repeat(cells - filled)
}

export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
