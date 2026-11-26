// Key, tuning and capo for a chart, worked out once per chart.
//
// Charts are written in chord *shapes* (what you fret). The key you hear is
// the shape key moved up by the capo and by the tuning (Eb standard sounds a
// half step lower than written).

import { buildTimeline, type Chart, type TimedEvent } from '../chart/chart'
import { mod12, parseChord, transposeSymbol } from '../theory/chord'
import { inferKey, keyName, keyPrefersFlats, parseKey, relativeKey, type Mode, type WeightedChord } from '../theory/key'
import { parseTuning, STANDARD_TUNING, tuningShort, type Tuning } from '../theory/tuning'

export interface SongInfo {
  /** Key of the chords as written, before your transposition. */
  writtenKey: { tonic: number; mode: Mode; name: string } | null
  keySource: 'chart' | 'chords' | null
  keyConfidence: number
  /** Key of the shapes you'll play (written + your transposition). */
  shapeKey: string
  /** Key you hear (written + capo + tuning offset). */
  soundingKey: string
  relative: string
  tuning: Tuning
  tuningGiven: boolean
  capo: number
  transpose: number
  preferFlats: boolean
  timeline: TimedEvent[]
  /** Chord symbol as you should play it (transposed, spelled for the key). */
  display: (symbol: string) => string
}

/**
 * Joins back-to-back repeats of a chord within a section ("C C" = two bars of C):
 * on the glasses "next" should be the next change, not the same chord again.
 */
export function mergeRepeats(timeline: TimedEvent[]): TimedEvent[] {
  const out: TimedEvent[] = []
  for (const e of timeline) {
    const prev = out[out.length - 1]
    if (prev && prev.chord === e.chord && prev.section === e.section) prev.end = e.end
    else out.push({ ...e })
  }
  return out
}

export function songInfo(chart: Chart, durationMs: number, transpose: number): SongInfo {
  const timeline = mergeRepeats(buildTimeline(chart, durationMs))
  const parsed: WeightedChord[] = []
  const source = timeline.length
    ? timeline.map(e => ({ chord: e.chord, section: e.section, weight: Math.max(1, e.end - e.start) }))
    : chart.events.map(e => ({ chord: e.chord, section: e.section ?? '', weight: 1 }))
  source.forEach((e, i) => {
    const c = parseChord(e.chord)
    const phraseStart = i === 0 || source[i - 1].section !== e.section
    if (c) parsed.push({ chord: c, weight: e.weight, phraseStart })
  })

  const given = chart.key ? parseKey(chart.key) : null
  const inferred = given ? null : inferKey(parsed)
  const written = given ?? (inferred ? { tonic: inferred.tonic, mode: inferred.mode, name: inferred.name } : null)

  const tuning = parseTuning(chart.tuning) ?? STANDARD_TUNING
  const capo = chart.capo ?? 0
  const offset = tuning.uniformOffset ?? 0
  const name = (shift: number) => (written ? keyName(mod12(written.tonic + shift), written.mode) : '?')
  const shapeTonic = written ? mod12(written.tonic + transpose) : 0
  const preferFlats = written ? keyPrefersFlats(shapeTonic, written.mode) : false

  return {
    writtenKey: written,
    keySource: given ? 'chart' : inferred ? 'chords' : null,
    keyConfidence: given ? 1 : inferred?.confidence ?? 0,
    shapeKey: name(transpose),
    soundingKey: name(capo + offset),
    relative: written ? relativeKey(written).name : '',
    tuning,
    tuningGiven: !!chart.tuning,
    capo,
    transpose,
    preferFlats,
    timeline,
    display: (symbol: string) => (transpose ? transposeSymbol(symbol, transpose, preferFlats) : symbol),
  }
}

/** "Key G", or "Key A · shapes G" when capo/tuning/transposition make them differ. */
export function keyLine(info: SongInfo): string {
  if (!info.writtenKey) return 'Key ?'
  const unsure = info.keySource === 'chords' && info.keyConfidence < 0.2 ? '?' : ''
  const parts = [`Key ${info.soundingKey}${unsure}`]
  if (info.shapeKey !== info.soundingKey) parts.push(`shapes ${info.shapeKey}`)
  return parts.join(' · ')
}

/** "Eb std · Capo 2" etc. Omits standard tuning when the chart didn't say. */
export function setupLine(info: SongInfo): string {
  const parts: string[] = []
  if (info.tuningGiven || info.tuning.uniformOffset !== 0) parts.push(tuningShort(info.tuning))
  if (info.capo) parts.push(`Capo ${info.capo}`)
  if (info.transpose) parts.push(`Transposed ${info.transpose > 0 ? '+' : ''}${info.transpose}`)
  return parts.join(' · ')
}
