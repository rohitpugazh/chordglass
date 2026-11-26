// A chord chart: song metadata plus an ordered list of chord events, some or
// all of them with a start time. This is the one format every chord source
// (your own charts, Chordonomicon, the demo, later audio alignment) produces.
//
// Text format (what the phone editor shows):
//
//   title: Example
//   artist: Somebody
//   spotify: 4uLU6hMCjMI75M1A2tKUQC
//   key: G            (optional, inferred from the chords when missing)
//   tuning: Eb        (Standard, Drop D, DADGAD, "D A D G B E"...)
//   capo: 2
//   bpm: 96
//
//   [Intro]
//   0:00.0 G
//   0:02.5 D/F#
//   [Verse 1] 0:05.0
//   Em C G D x2       (untimed chords; spread evenly between timed ones)
//
// Times are m:ss.s from the start of the track. "x2" repeats the line, "|" is ignored.

import { normalizeChordSymbol, parseChord } from '../theory/chord'

export type ChartSourceKind = 'user' | 'chordonomicon' | 'demo'

export interface ChartEvent {
  /** Start in ms from the start of the track, or null when untimed. */
  t: number | null
  chord: string
  section?: string
}

export interface Chart {
  title?: string
  artist?: string
  spotifyId?: string
  key?: string
  tuning?: string
  capo?: number
  bpm?: number
  source: ChartSourceKind
  events: ChartEvent[]
}

export interface TimedEvent {
  index: number
  start: number
  end: number
  chord: string
  section: string
  /** True when the start was interpolated rather than given. */
  estimated: boolean
}

export interface ParseResult {
  chart: Chart
  /** Tokens that weren't chords, times or section names, with their line numbers. */
  warnings: string[]
}

const TIME = /^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/

export function parseTime(token: string): number | null {
  const m = token.match(TIME)
  if (!m) return null
  const minutes = m[1] ? Number(m[1]) : 0
  return Math.round((minutes * 60 + Number(m[2])) * 1000)
}

export function formatTime(ms: number, decimals = 1): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = total - m * 60
  const sec = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')
  return `${m}:${sec}`
}

const HEADER = /^(title|artist|spotify|key|tuning|capo|bpm)\s*:\s*(.*)$/i

export function parseChartText(text: string, source: ChartSourceKind = 'user'): ParseResult {
  const chart: Chart = { source, events: [] }
  const warnings: string[] = []
  let section = ''
  let pendingSectionTime: number | null = null

  text.split(/\r?\n/).forEach((rawLine, lineNo) => {
    const line = rawLine.replace(/\s+#.*$|^#.*$/, '').trim()
    if (!line) return

    const header = line.match(HEADER)
    if (header) {
      const [, field, value] = header
      const v = value.trim()
      switch (field.toLowerCase()) {
        case 'title': chart.title = v; break
        case 'artist': chart.artist = v; break
        case 'spotify': chart.spotifyId = v.replace(/^.*track[/:]/, '').replace(/\?.*$/, ''); break
        case 'key': chart.key = v || undefined; break
        case 'tuning': chart.tuning = v || undefined; break
        case 'capo': chart.capo = Number(v) || 0; break
        case 'bpm': chart.bpm = Number(v) || undefined; break
      }
      return
    }

    let rest = line
    let lineTime: number | null = null
    const sectionMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      rest = sectionMatch[2]
    }

    const tokens = rest.split(/\s+/).filter(t => t && t !== '|' && t !== '||')
    if (tokens.length && parseTime(tokens[0]) !== null) lineTime = parseTime(tokens.shift()!)

    let repeat = 1
    const last = tokens[tokens.length - 1]
    const rep = last?.match(/^\(?[x×](\d+)\)?$/i)
    if (rep) { repeat = Math.max(1, Math.min(16, Number(rep[1]))); tokens.pop() }

    const chords: string[] = []
    for (const token of tokens) {
      const cleaned = token.replace(/^\|+|\|+$/g, '')
      if (!cleaned) continue
      if (parseChord(cleaned)) chords.push(normalizeChordSymbol(cleaned))
      else if (cleaned === '%' && chords.length) chords.push(chords[chords.length - 1])
      else warnings.push(`line ${lineNo + 1}: "${cleaned}" isn't a chord`)
    }

    // A section line with a time but no chords times the section's first chord.
    if (!chords.length && lineTime !== null) {
      pendingSectionTime = lineTime
      return
    }
    for (let r = 0; r < repeat; r++) {
      chords.forEach((chord, i) => {
        let t: number | null = r === 0 && i === 0 ? lineTime : null
        if (t === null && pendingSectionTime !== null) t = pendingSectionTime
        pendingSectionTime = null
        chart.events.push({ t, chord, section: section || undefined })
      })
    }
  })

  return { chart, warnings }
}

export function serializeChart(chart: Chart): string {
  const lines: string[] = []
  if (chart.title) lines.push(`title: ${chart.title}`)
  if (chart.artist) lines.push(`artist: ${chart.artist}`)
  if (chart.spotifyId) lines.push(`spotify: ${chart.spotifyId}`)
  if (chart.key) lines.push(`key: ${chart.key}`)
  if (chart.tuning) lines.push(`tuning: ${chart.tuning}`)
  if (chart.capo) lines.push(`capo: ${chart.capo}`)
  if (chart.bpm) lines.push(`bpm: ${chart.bpm}`)
  if (lines.length) lines.push('')

  let section: string | undefined
  let untimed: string[] = []
  const flush = () => {
    for (let i = 0; i < untimed.length; i += 8) lines.push(untimed.slice(i, i + 8).join(' '))
    untimed = []
  }
  for (const e of chart.events) {
    if (e.section !== section) {
      flush()
      section = e.section
      if (section) lines.push(`[${section}]`)
    }
    if (e.t === null) untimed.push(e.chord)
    else {
      flush()
      lines.push(`${formatTime(e.t, 2)} ${e.chord}`)
    }
  }
  flush()
  return lines.join('\n') + '\n'
}

export const isTimed = (chart: Chart) => chart.events.some(e => e.t !== null)

/**
 * Resolves every event to a start and end time. Untimed events between two
 * timed ones are spread evenly; untimed events after the last timed one are
 * spread up to the end of the track. Returns [] for a chart with no times.
 */
export function buildTimeline(chart: Chart, durationMs: number): TimedEvent[] {
  const ev = chart.events
  const timed = ev.map((e, i) => (e.t !== null ? i : -1)).filter(i => i >= 0)
  if (!timed.length) return []
  const starts = ev.map(e => e.t ?? 0)

  const spread = (from: number, to: number, tFrom: number, tTo: number) => {
    // Events strictly between indices `from` and `to` get evenly spaced times.
    for (let j = from + 1; j < to; j++) starts[j] = tFrom + ((tTo - tFrom) * (j - from)) / (to - from)
  }
  const first = timed[0]
  if (first > 0) spread(-1, first, 0, ev[first].t!)
  for (let k = 0; k + 1 < timed.length; k++) spread(timed[k], timed[k + 1], ev[timed[k]].t!, ev[timed[k + 1]].t!)
  const last = timed[timed.length - 1]
  if (last < ev.length - 1) {
    const tLast = ev[last].t!
    const end = Math.max(durationMs, tLast + 2000 * (ev.length - last))
    spread(last, ev.length, tLast, end)
  }

  const out: TimedEvent[] = ev.map((e, index) => ({
    index,
    start: Math.round(starts[index]),
    end: 0,
    chord: e.chord,
    section: e.section ?? '',
    estimated: e.t === null,
  }))
  out.sort((a, b) => a.start - b.start || a.index - b.index)
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].start : Math.max(durationMs, out[i].start + 2000)
  }
  return out
}

/** Index of the event playing at `ms`, or -1 before the first chord. */
export function eventAt(timeline: TimedEvent[], ms: number): number {
  let lo = 0, hi = timeline.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timeline[mid].start <= ms) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

export interface Section {
  name: string
  /** Index into chart.events of the first chord. */
  first: number
  chords: string[]
}

/** Groups consecutive events by section label. */
export function sections(chart: Chart): Section[] {
  const out: Section[] = []
  chart.events.forEach((e, i) => {
    const name = e.section ?? ''
    const cur = out[out.length - 1]
    if (cur && cur.name === name) cur.chords.push(e.chord)
    else out.push({ name, first: i, chords: [e.chord] })
  })
  return out
}
