// Renders a chord name large, for the glasses' one image container. The text
// font has a single small size, so a chord you can read at a glance while
// playing has to be an image. White on black: black is "off" on the display,
// and the host converts the PNG to 16 levels of green.

import { parseChord } from '../theory/chord'

export const CHORD_IMG_W = 288
export const CHORD_IMG_H = 144

let canvas: HTMLCanvasElement | null = null

const FONT = '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'

/** Splits "F#m7/C#" into "F♯", "m7", "/C♯" for typesetting. */
function parts(symbol: string): { root: string; suffix: string; bass: string } {
  const c = parseChord(symbol)
  const pretty = (s: string) => s.replace(/#/g, '♯').replace(/(?<=[A-G])b/g, '♭').replace(/b(?=\d)/g, '♭')
  if (!c) return { root: symbol, suffix: '', bass: '' }
  return {
    root: pretty(c.rootName),
    suffix: pretty(c.suffix),
    bass: c.bassName ? '/' + pretty(c.bassName) : '',
  }
}

/**
 * Draws `symbol` and returns a base64 PNG (no data: prefix). `caption` is a
 * small line along the bottom, e.g. the section name. `dim` draws it grey,
 * for a chord that hasn't started yet.
 */
export function renderChordPng(symbol: string, caption = '', dim = false): string {
  canvas ??= document.createElement('canvas')
  canvas.width = CHORD_IMG_W
  canvas.height = CHORD_IMG_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CHORD_IMG_W, CHORD_IMG_H)
  ctx.fillStyle = dim ? '#808080' : '#fff'
  ctx.textBaseline = 'alphabetic'

  const { root, suffix, bass } = parts(symbol)
  const maxW = CHORD_IMG_W - 16
  const baseline = caption ? 100 : 112
  let size = 104
  const measure = (s: number) => {
    ctx.font = `bold ${s}px ${FONT}`
    const r = ctx.measureText(root).width
    ctx.font = `bold ${Math.round(s * 0.55)}px ${FONT}`
    return r + ctx.measureText(suffix).width + ctx.measureText(bass).width + (suffix || bass ? s * 0.04 : 0)
  }
  while (size > 28 && measure(size) > maxW) size -= 4

  let x = 8
  ctx.font = `bold ${size}px ${FONT}`
  ctx.fillText(root, x, baseline)
  x += ctx.measureText(root).width + size * 0.04
  ctx.font = `bold ${Math.round(size * 0.55)}px ${FONT}`
  if (suffix) {
    // Quality letters (m, dim, sus, maj) sit on the baseline; a leading number
    // (7, 9, 13) is raised like a lead sheet: "Em7" reads E, m, then a small raised 7.
    const m = suffix.match(/^([a-z]*)(.*)$/)!
    if (m[1]) { ctx.fillText(m[1], x, baseline); x += ctx.measureText(m[1]).width }
    if (m[2]) { ctx.fillText(m[2], x, baseline - size * 0.36); x += ctx.measureText(m[2]).width }
  }
  if (bass) ctx.fillText(bass, x, baseline)

  if (caption) {
    ctx.fillStyle = '#b0b0b0'
    ctx.font = `bold 22px ${FONT}`
    ctx.fillText(caption, 8, CHORD_IMG_H - 10, maxW)
  }
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}
