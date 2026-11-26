// Lines a chart up with what the listener heard (an HMM over the chart's
// chords, decoded with Viterbi), then predicts the next chords from there.
//
// - States are the chart's chords in order (back-to-back repeats merged).
// - Each heard frame scores every state by how likely the model thinks that
//   chord family is in that frame.
// - Moves: stay, step to the next chord, skip one, or jump from the end of a
//   section to the start of any section (sheets write a repeated chorus once).
// - After a gap in what was heard (pause, seek) any position may be re-entered,
//   nudged by where the song's elapsed time says we should be.

import type { Chart, TimedEvent } from '../chart/chart'
import { parseChord } from '../theory/chord'
import { FAMILIES, NO_CHORD, type HeardFrame } from './listener'

export interface AlignState {
  chord: string
  section: string
  /** Family indices this chord accepts (two for power chords). */
  fams: number[]
  /** Uniform-estimate start time, ms, for the position prior. */
  estMs: number
}

export interface Alignment {
  /** Timeline of past (heard) and predicted chords. */
  timeline: TimedEvent[]
  /** 0..1: how much of what was heard recently the aligned chords explain. */
  fit: number
  /** The same over the last ~3 s: drops where the band departs from the sheet. */
  recentFit: number
  /** Share of the chart's chords visited so far. */
  coverage: number
  /** The aligned chord changes so far, for saving as a timed chart. */
  runs: { state: number; startMs: number; endMs: number }[]
  states: AlignState[]
}

/**
 * Semitones between the chart as written and the recording, found by
 * comparing chord-family histograms at all 12 shifts. Charts are written in
 * shapes, so a song recorded in Eb standard sounds a semitone below its chart.
 * Returns 0 unless another shift fits clearly better.
 */
export function detectShift(states: AlignState[], frames: HeardFrame[]): { shift: number; score: number; scoreAsWritten: number } {
  const chart = new Float64Array(24)
  for (const s of states) for (const f of s.fams) if (f < 24) chart[f] += 1 / s.fams.length
  const heard = new Float64Array(24)
  for (const fr of frames) if (fr.fam[NO_CHORD] < 0.5) for (let f = 0; f < 24; f++) heard[f] += fr.fam[f]
  const cos = (shift: number) => {
    let dot = 0, a = 0, b = 0
    for (let f = 0; f < 24; f++) {
      const root = f >> 1, minor = f & 1
      const g = ((root + shift + 12) % 12) * 2 + minor
      dot += chart[f] * heard[g]
      a += chart[f] ** 2
      b += heard[g] ** 2
    }
    return a && b ? dot / Math.sqrt(a * b) : 0
  }
  const scoreAsWritten = cos(0)
  let best = 0, bestScore = scoreAsWritten
  for (let k = -5; k <= 6; k++) {
    const sc = cos(k)
    if (sc > bestScore) { best = k; bestScore = sc }
  }
  const clearlyBetter = best !== 0 && bestScore > 0.6 && bestScore > scoreAsWritten + 0.2
  return { shift: clearlyBetter ? best : 0, score: clearlyBetter ? bestScore : scoreAsWritten, scoreAsWritten }
}

/** The same states, listening for each chord `shift` semitones away from how it's written. */
export function shiftStates(states: AlignState[], shift: number): AlignState[] {
  if (!shift) return states
  return states.map(s => ({ ...s, fams: s.fams.map(f => (f === NO_CHORD ? f : (((f >> 1) + shift + 12) % 12) * 2 + (f & 1))) }))
}

export function alignStates(chart: Chart, durationMs: number): AlignState[] {
  const merged: { chord: string; section: string }[] = []
  for (const e of chart.events) {
    const section = e.section ?? ''
    const prev = merged[merged.length - 1]
    if (prev && prev.chord === e.chord && prev.section === section) continue
    merged.push({ chord: e.chord, section })
  }
  const n = merged.length
  return merged.map((m, i) => {
    const c = parseChord(m.chord)
    const fams = !c ? [NO_CHORD] : c.suffix === '5' ? [c.root * 2, c.root * 2 + 1] : [c.root * 2 + (c.minor ? 1 : 0)]
    return { ...m, fams, estMs: durationMs * (0.02 + (0.95 * (i + 0.5)) / Math.max(1, n)) }
  })
}

export function align(states: AlignState[], frames: HeardFrame[], durationMs: number, frameMs: number): Alignment | null {
  const K = states.length
  const T = frames.length
  if (!K || T < 8) return null

  const d = Math.min(80, Math.max(6, (durationMs * 0.95) / K / frameMs))
  const stay = Math.log(1 - 1 / d)
  const adv = Math.log(1 / d)
  const sigma = Math.max(20_000, durationMs * 0.2)
  const prior = (k: number, ms: number) => -0.5 * ((states[k].estMs - ms) / sigma) ** 2
  const isStart = states.map((s, k) => k === 0 || s.section !== states[k - 1].section)
  const isEnd = states.map((s, k) => k === K - 1 || s.section !== states[k + 1].section)

  const emit = (t: number, k: number) => {
    const f = frames[t].fam
    let p = 0
    for (const fam of states[k].fams) p += f[fam]
    return Math.log(p + 0.03)
  }

  let delta = new Float64Array(K)
  let next = new Float64Array(K)
  const back = new Int16Array(T * K)
  for (let k = 0; k < K; k++) delta[k] = prior(k, frames[0].songMs) + emit(0, k)

  for (let t = 1; t < T; t++) {
    const gap = frames[t].songMs - frames[t - 1].songMs > frameMs * 20
    let bestEnd = -Infinity, bestEndK = 0, bestAny = -Infinity, bestAnyK = 0
    for (let k = 0; k < K; k++) {
      if (isEnd[k] && delta[k] > bestEnd) { bestEnd = delta[k]; bestEndK = k }
      if (delta[k] > bestAny) { bestAny = delta[k]; bestAnyK = k }
    }
    for (let k = 0; k < K; k++) {
      let best = delta[k] + stay, arg = k
      if (k >= 1 && delta[k - 1] + adv > best) { best = delta[k - 1] + adv; arg = k - 1 }
      if (k >= 2 && delta[k - 2] + adv - 4 > best) { best = delta[k - 2] + adv - 4; arg = k - 2 }
      if (isStart[k] && bestEnd + adv - 3 > best && bestEndK !== k - 1) { best = bestEnd + adv - 3; arg = bestEndK }
      if (gap) {
        const v = bestAny - 2 + prior(k, frames[t].songMs)
        if (v > best) { best = v; arg = bestAnyK }
      }
      next[k] = best + emit(t, k)
      back[t * K + k] = arg
    }
    ;[delta, next] = [next, delta]
  }

  const path = new Int16Array(T)
  let last = 0
  for (let k = 1; k < K; k++) if (delta[k] > delta[last]) last = k
  path[T - 1] = last
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * K + path[t]]

  // Runs of frames in one state.
  const runs: Alignment['runs'] = []
  for (let t = 0; t < T; t++) {
    const startMs = frames[t].songMs - frameMs / 2
    const endMs = frames[t].songMs + frameMs / 2
    const r = runs[runs.length - 1]
    if (r && r.state === path[t] && startMs - r.endMs < frameMs * 3) r.endMs = endMs
    else runs.push({ state: path[t], startMs, endMs })
  }

  // Fit: how much of the strongest heard chord the aligned chord accounts for,
  // over the last ~8 s, and over the last ~3 s (skipping the newest, unsettled frames).
  const fitOver = (fromMs: number, skip: number) => {
    let num = 0, den = 0
    for (let t = Math.max(0, T - Math.round(fromMs / frameMs)); t < T - skip; t++) {
      const f = frames[t].fam
      let top = 0
      for (let k = 0; k < FAMILIES; k++) if (k !== NO_CHORD && f[k] > top) top = f[k]
      if (f[NO_CHORD] > 0.6) continue
      let p = 0
      for (const fam of states[path[t]].fams) p += f[fam]
      num += Math.min(p, top)
      den += top
    }
    return den ? num / den : 0
  }
  const fit = fitOver(8000, 0)
  const recentFit = fitOver(3500, Math.round(500 / frameMs))
  const visited = new Set(runs.map(r => r.state))

  return { timeline: predict(states, runs, durationMs, d * frameMs), fit, recentFit, coverage: visited.size / K, runs, states }
}

/**
 * Heard runs, then the following chart chords with durations learned from
 * what was heard.
 *
 * A chord's length depends on where it sits in the pattern (in "Dm F C" the
 * Dm may last two bars and the others one), so a chord is expected to last as
 * long as the last time the same chord led into the same next chord; failing
 * that, as long as the last time that chord was heard; failing that, a
 * typical recent chord length.
 */
function predict(states: AlignState[], runs: Alignment['runs'], durationMs: number, defaultMs: number): TimedEvent[] {
  const done = runs.slice(0, -1).filter(r => r.endMs - r.startMs > 300)
  const lenByState = new Map<number, number>()
  const lenByContext = new Map<string, number>()
  const lenByChord = new Map<string, number>()
  done.forEach((r, i) => {
    const len = r.endMs - r.startMs
    const chord = states[r.state].chord
    const after = done[i + 1] ?? runs[runs.length - 1]
    lenByState.set(r.state, len)
    if (after && after !== r) lenByContext.set(`${chord}>${states[after.state].chord}`, len)
    lenByChord.set(chord, len)
  })
  const recent = done.slice(-8).map(r => r.endMs - r.startMs).sort((a, b) => a - b)
  const typical = recent.length >= 3 ? recent[recent.length >> 1] : defaultMs
  const expected = (k: number) => {
    const chord = states[k].chord
    const next = states[k + 1]?.chord
    return (next !== undefined ? lenByContext.get(`${chord}>${next}`) : undefined)
      ?? lenByState.get(k)
      ?? lenByChord.get(chord)
      ?? typical
  }

  const out: TimedEvent[] = []
  const push = (k: number, start: number, end: number, estimated: boolean) => {
    const s = states[k]
    const prev = out[out.length - 1]
    if (prev && prev.chord === s.chord && prev.section === s.section) { prev.end = end; return }
    out.push({ index: k, start: Math.round(start), end: Math.round(end), chord: s.chord, section: s.section, estimated })
  }
  for (const r of done) push(r.state, r.startMs, r.endMs, false)
  const cur = runs[runs.length - 1]

  // Songs are loops: find the last time the band played the same chords
  // leading into the current one, and expect what came next that time, with
  // the same lengths. This follows the performance where it departs from the
  // sheet (a chorus repeated where the sheet moves on).
  const perf = [...done, cur]
  const chordOf = (i: number) => states[perf[i].state].chord
  const last = perf.length - 1
  let match = -1
  for (const ctx of [3, 2]) {
    for (let j = last - 1; j >= ctx - 1 && match < 0; j--) {
      let same = true
      for (let c = 0; c < ctx && same; c++) same = chordOf(j - c) === chordOf(last - c)
      // The earlier occurrence must have been followed by something we heard.
      if (same && j + 1 < last) match = j
    }
    if (match >= 0) break
  }

  // If the chord has already been heard going on past its expected length,
  // don't guess when it ends: hold it until the audio shows the change
  // (the next analysis comes well within this hold).
  const curLen = match >= 0 ? perf[match].endMs - perf[match].startMs : expected(cur.state)
  const expectedEnd = cur.startMs + curLen
  let t = expectedEnd > cur.endMs ? expectedEnd : cur.endMs + 2500
  push(cur.state, cur.startMs, t, false)

  if (match >= 0) {
    for (let j = match + 1; j < last && t < durationMs && out.length < done.length + 12; j++) {
      const end = Math.min(durationMs, t + (perf[j].endMs - perf[j].startMs))
      push(perf[j].state, t, end, true)
      t = end
    }
    return out
  }
  for (let k = cur.state + 1; k < states.length && t < durationMs; k++) {
    const end = Math.min(durationMs, t + expected(k))
    push(k, t, end, true)
    t = end
  }
  return out
}
