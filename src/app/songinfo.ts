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
  /** True when the chart has no times and the timeline is a guess spread over the song. */
  estimated: boolean
  /** Where the timeline comes from: the chart's own times, an even spread, the music (listening), or nothing (heard chords only). */
  mode: 'timed' | 'estimated' | 'aligned' | 'heard'
  /** Listening found the recording this many semitones from the chart (tuned down, capo...). */
  recordingShift?: number
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

/**
 * A guess for charts without times: chords spread evenly over the track,
 * leaving a little room for a count-in and a fade-out. Often a chord or two
 * off, which is why it's marked as estimated and swipes move it a chord at a time.
 */
export function estimateTimeline(chart: Chart, durationMs: number): TimedEvent[] {
  const n = chart.events.length
  if (!n || durationMs <= 0) return []
  const start = Math.min(3000, durationMs * 0.02)
  const end = durationMs - Math.min(5000, durationMs * 0.03)
  const step = (end - start) / n
  return chart.events.map((e, index) => ({
    index,
    start: Math.round(start + index * step),
    end: Math.round(start + (index + 1) * step),
    chord: e.chord,
    section: e.section ?? '',
    estimated: true,
  }))
}

export function songInfo(chart: Chart, durationMs: number, transpose: number): SongInfo {
  const given = buildTimeline(chart, durationMs)
  const estimated = !given.length && durationMs > 0 && chart.events.length > 0
  const timeline = mergeRepeats(estimated ? estimateTimeline(chart, durationMs) : given)
  const parsed: WeightedChord[] = []
  const source = timeline.length
    ? timeline.map(e => ({ chord: e.chord, section: e.section, weight: Math.max(1, e.end - e.start) }))
    : chart.events.map(e => ({ chord: e.chord, section: e.section ?? '', weight: 1 }))
  source.forEach((e, i) => {
    const c = parseChord(e.chord)
    const phraseStart = i === 0 || source[i - 1].section !== e.section
    if (c) parsed.push({ chord: c, weight: e.weight, phraseStart })
  })

  const givenKey = chart.key ? parseKey(chart.key) : null
  const inferred = givenKey ? null : inferKey(parsed)
  const written = givenKey ?? (inferred ? { tonic: inferred.tonic, mode: inferred.mode, name: inferred.name } : null)

  const tuning = parseTuning(chart.tuning) ?? STANDARD_TUNING
  const capo = chart.capo ?? 0
  const offset = tuning.uniformOffset ?? 0
  const name = (shift: number) => (written ? keyName(mod12(written.tonic + shift), written.mode) : '?')
  const shapeTonic = written ? mod12(written.tonic + transpose) : 0
  const preferFlats = written ? keyPrefersFlats(shapeTonic, written.mode) : false

  return {
    writtenKey: written,
    keySource: givenKey ? 'chart' : inferred ? 'chords' : null,
    keyConfidence: givenKey ? 1 : inferred?.confidence ?? 0,
    shapeKey: name(transpose),
    soundingKey: name(capo + offset),
    relative: written ? relativeKey(written).name : '',
    tuning,
    tuningGiven: !!chart.tuning,
    capo,
    transpose,
    preferFlats,
    timeline,
    estimated,
    mode: estimated ? 'estimated' : 'timed',
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
  const s = info.recordingShift ?? 0
  // The record sounds lower/higher than the chart: tune down/up by that much (or capo when higher).
  if (s < 0) parts.push(s === -1 ? 'Tune 1/2 step down' : `Tune ${-s / 2} steps down`)
  if (s > 0) parts.push(`Capo ${s} (record is higher)`)
  if (info.tuningGiven || info.tuning.uniformOffset !== 0) parts.push(tuningShort(info.tuning))
  if (info.capo) parts.push(`Capo ${info.capo}`)
  if (info.transpose) parts.push(`Transposed ${info.transpose > 0 ? '+' : ''}${info.transpose}`)
  return parts.join(' · ')
}
