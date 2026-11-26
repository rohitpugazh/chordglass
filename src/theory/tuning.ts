// Guitar tunings: presets, parsing what people write in chord sheets
// ("Eb", "half step down", "Drop D", "D A D G B E"), and describing them.

import { mod12, noteName, parseNote } from './chord'

export interface Tuning {
  name: string
  /** MIDI note per string, low (6th) to high (1st). */
  midi: number[]
  /** Semitones every string is shifted from standard, or null when strings differ (drop/open tunings). */
  uniformOffset: number | null
}

const STANDARD = [40, 45, 50, 55, 59, 64] // E2 A2 D3 G3 B3 E4

const shift = (n: number) => STANDARD.map(m => m + n)

const PRESETS: { name: string; aliases: string[]; midi: number[] }[] = [
  { name: 'Standard', aliases: ['standard', 'std', 'e standard', 'e', 'eadgbe', 'normal'], midi: STANDARD },
  { name: 'Eb standard', aliases: ['eb', 'eb standard', 'd#', 'd# standard', 'half step down', 'half-step down', '1/2 step down', 'half down', 'ebabdbgbbbeb'], midi: shift(-1) },
  { name: 'D standard', aliases: ['d', 'd standard', 'whole step down', 'full step down', 'one step down', 'dgcfad'], midi: shift(-2) },
  { name: 'C# standard', aliases: ['c#', 'c# standard', 'db', 'db standard', '1.5 steps down', 'one and a half steps down'], midi: shift(-3) },
  { name: 'C standard', aliases: ['c', 'c standard', 'two steps down', 'cfa#d#gc', 'cfbbebgc'], midi: shift(-4) },
  { name: 'B standard', aliases: ['b', 'b standard', 'beadf#b'], midi: shift(-5) },
  { name: 'Half step up', aliases: ['half step up', 'f standard', 'f'], midi: shift(1) },
  { name: 'Drop D', aliases: ['drop d', 'dropd', 'dadgbe'], midi: [38, 45, 50, 55, 59, 64] },
  { name: 'Drop C#', aliases: ['drop c#', 'drop db', 'c#g#c#f#a#d#'], midi: [37, 44, 49, 54, 58, 63] },
  { name: 'Drop C', aliases: ['drop c', 'cgcfad'], midi: [36, 43, 48, 53, 57, 62] },
  { name: 'Drop B', aliases: ['drop b', 'bf#beg#c#'], midi: [35, 42, 47, 52, 56, 61] },
  { name: 'Double drop D', aliases: ['double drop d', 'dadgbd'], midi: [38, 45, 50, 55, 59, 62] },
  { name: 'DADGAD', aliases: ['dadgad'], midi: [38, 45, 50, 55, 57, 62] },
  { name: 'Open G', aliases: ['open g', 'dgdgbd'], midi: [38, 43, 50, 55, 59, 62] },
  { name: 'Open D', aliases: ['open d', 'dadf#ad'], midi: [38, 45, 50, 54, 57, 62] },
  { name: 'Open E', aliases: ['open e', 'ebeg#be'], midi: [40, 47, 52, 56, 59, 64] },
  { name: 'Open C', aliases: ['open c', 'cgcgce'], midi: [36, 43, 48, 55, 60, 64] },
  { name: 'Open A', aliases: ['open a', 'eaeac#e'], midi: [40, 45, 52, 57, 61, 64] },
]

function uniformOffset(midi: number[]): number | null {
  if (midi.length !== 6) return null
  const d = midi[0] - STANDARD[0]
  return midi.every((m, i) => m - STANDARD[i] === d) ? d : null
}

function make(name: string, midi: number[]): Tuning {
  return { name, midi, uniformOffset: uniformOffset(midi) }
}

export const STANDARD_TUNING: Tuning = make('Standard', STANDARD)

const squash = (s: string) => s.toLowerCase().replace(/[♯]/g, '#').replace(/[♭]/g, 'b').replace(/\s+/g, ' ').trim()

/** Six note names low to high, e.g. "D A D G B E" or "DADGBE", placed in the octave nearest standard. */
function parseNoteList(text: string): number[] | null {
  const compact = text.replace(/[\s,\-|]/g, '')
  const notes: number[] = []
  let i = 0
  while (i < compact.length) {
    const n = parseNote(compact.slice(i))
    if (!n) return null
    // parseNote reads Chordonomicon's "s" as a sharp; a tuning never uses it, and
    // "s" can't follow a note letter in a note list, so this is safe.
    notes.push(n.pc)
    i += n.length
  }
  if (notes.length !== 6) return null
  return notes.map((pc, idx) => {
    const ref = STANDARD[idx]
    let best = ref
    let bestDist = Infinity
    for (let m = ref - 7; m <= ref + 5; m++) {
      if (mod12(m) === pc && Math.abs(m - ref) < bestDist) { best = m; bestDist = Math.abs(m - ref) }
    }
    return best
  })
}

/** Accepts a preset name or alias, six note names, or six MIDI numbers (either order). */
export function parseTuning(text: string | undefined | null): Tuning | null {
  if (!text?.trim()) return null
  const s = squash(text)
  const preset = PRESETS.find(p => p.aliases.includes(s) || p.name.toLowerCase() === s)
  if (preset) return make(preset.name, preset.midi)

  const nums = s.split(/[\s,]+/).map(Number)
  if (nums.length === 6 && nums.every(n => Number.isInteger(n) && n > 20 && n < 90)) {
    const lowToHigh = nums[0] > nums[5] ? [...nums].reverse() : nums   // Songsterr lists high to low
    return named(lowToHigh)
  }

  const notes = parseNoteList(text)
  return notes ? named(notes) : null
}

/** Uses the preset name when the notes match one. */
function named(midi: number[]): Tuning {
  const preset = PRESETS.find(p => p.midi.every((m, i) => m === midi[i]))
  return make(preset?.name ?? 'Custom', midi)
}

/** "Eb Ab Db Gb Bb Eb" */
export function tuningNotes(t: Tuning): string {
  const flats = (t.uniformOffset ?? 0) < 0
  return t.midi.map(m => noteName(m, flats)).join(' ')
}

/** Short label for the glasses, e.g. "Std", "Eb std", "Drop D", "Custom DADGBD". */
export function tuningShort(t: Tuning): string {
  if (t.name === 'Standard') return 'Std tuning'
  if (t.name === 'Custom') return tuningNotes(t).replace(/ /g, '')
  return t.name.replace(' standard', ' std')
}

/** One line of advice: what to do to the guitar. */
export function tuningAdvice(t: Tuning): string {
  const off = t.uniformOffset
  if (off === 0) return 'Standard tuning'
  if (off !== null) {
    const steps = Math.abs(off) / 2
    const word = steps === 0.5 ? 'half a step' : steps === 1 ? 'a whole step' : `${steps} steps`
    return `All strings ${word} ${off < 0 ? 'down' : 'up'}`
  }
  const ordinal = ['6th', '5th', '4th', '3rd', '2nd', '1st']
  const changed = t.midi
    .map((m, i) => ({ i, m, d: m - STANDARD[i] }))
    .filter(x => x.d !== 0)
    .map(x => `${ordinal[x.i]} ${x.d > 0 ? 'up' : 'down'} ${Math.abs(x.d)} to ${noteName(x.m, false)}`)
  return changed.join(', ')
}
