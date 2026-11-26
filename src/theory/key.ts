// Key finding from a chord progression: Krumhansl-Kessler key profiles
// correlated against a pitch-class histogram built from chord tones, with a
// small bonus for the key whose tonic chord opens, closes or dominates the song.

import { mod12, noteName, type Chord } from './chord'

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export type Mode = 'major' | 'minor'

export interface Key {
  tonic: number
  mode: Mode
  /** "G", "F#m", "Bbm" */
  name: string
  /** 0..1, how far ahead of the runner-up the winning key is. */
  confidence: number
}

/** Keys conventionally written with flats. */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6])      // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3])       // Dm Gm Cm Fm Bbm Ebm

export function keyPrefersFlats(tonic: number, mode: Mode): boolean {
  return mode === 'major' ? FLAT_MAJOR.has(mod12(tonic)) : FLAT_MINOR.has(mod12(tonic))
}

export function keyName(tonic: number, mode: Mode): string {
  return noteName(tonic, keyPrefersFlats(tonic, mode)) + (mode === 'minor' ? 'm' : '')
}

/** Relative major/minor: the key that shares the same notes. */
export function relativeKey(key: Pick<Key, 'tonic' | 'mode'>): { tonic: number; mode: Mode; name: string } {
  const tonic = key.mode === 'major' ? mod12(key.tonic + 9) : mod12(key.tonic + 3)
  const mode: Mode = key.mode === 'major' ? 'minor' : 'major'
  return { tonic, mode, name: keyName(tonic, mode) }
}

/** Parses "G", "F#m", "Bb minor", "A major", "C#min". */
export function parseKey(text: string): Pick<Key, 'tonic' | 'mode' | 'name'> | null {
  const m = text.trim().match(/^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?$/i)
  if (!m) return null
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase() as 'C']
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0
  const mode: Mode = m[3] && /^m(in(or)?)?$/i.test(m[3]) && m[3] !== 'M' ? 'minor' : 'major'
  const tonic = mod12(base + acc)
  return { tonic, mode, name: keyName(tonic, mode) }
}

function correlation(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

export interface WeightedChord {
  chord: Chord
  /** Duration in ms for timed charts, or 1 per occurrence for untimed ones. */
  weight: number
  /** First chord of a section (verse, chorus...). Sections tend to start on the tonal centre. */
  phraseStart?: boolean
}

/** Best guess at the key of a progression, or null if there are no chords. */
export function inferKey(chords: WeightedChord[]): Key | null {
  const usable = chords.filter(c => c.weight > 0)
  if (!usable.length) return null

  const hist = new Array(12).fill(0)
  let total = 0
  for (const { chord, weight } of usable) {
    chord.tones.forEach((pc, i) => { hist[pc] += weight * (i === 0 ? 1 : 0.7) })
    if (chord.bass !== undefined) hist[chord.bass] += weight * 0.3
    total += weight
  }

  const first = usable[0].chord
  const last = usable[usable.length - 1].chord
  const scores: { tonic: number; mode: Mode; score: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as Mode[]) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      const rotated = profile.map((_, pc) => profile[mod12(pc - tonic)])
      let score = correlation(hist, rotated)
      const isTonic = (c: Chord) => c.root === tonic && (mode === 'minor' ? c.minor : !c.minor)
      // Share of the song spent on this key's tonic chord.
      const tonicShare = usable.reduce((s, c) => s + (isTonic(c.chord) ? c.weight : 0), 0) / total
      score += 0.25 * tonicShare
      if (isTonic(first)) score += 0.06
      if (isTonic(last)) score += 0.06
      scores.push({ tonic, mode, score })
    }
  }
  scores.sort((a, b) => b.score - a.score)
  const [best, second] = scores
  const result: Key = {
    tonic: best.tonic,
    mode: best.mode,
    name: keyName(best.tonic, best.mode),
    confidence: Math.max(0, Math.min(1, (best.score - second.score) / 0.15)),
  }

  // Modal rock and pop (E D A = I bVII IV, "mixolydian") fools key profiles:
  // the notes fit D major, but the song keeps coming home to E. The chord that
  // opens most sections and frames the song is the tonal centre a player wants.
  const byRoot = new Map<number, { w: number; minorW: number; starts: number }>()
  for (const { chord, weight, phraseStart } of usable) {
    const s = byRoot.get(chord.root) ?? { w: 0, minorW: 0, starts: 0 }
    s.w += weight
    if (chord.minor) s.minorW += weight
    if (phraseStart) s.starts++
    byRoot.set(chord.root, s)
  }
  const startTotal = usable.filter(c => c.phraseStart).length || 1
  const centreScore = (root: number) => {
    const s = byRoot.get(root)
    if (!s) return 0
    return s.w / total + 0.5 * (s.starts / startTotal) + (first.root === root ? 0.1 : 0) + (last.root === root ? 0.1 : 0)
  }
  const [centre, stats] = [...byRoot].sort((a, b) => centreScore(b[0]) - centreScore(a[0]))[0]
  if (centre !== best.tonic && stats.w / total >= 0.15 && centreScore(centre) > centreScore(best.tonic) + 0.15) {
    const mode: Mode = stats.minorW > stats.w / 2 ? 'minor' : 'major'
    return {
      tonic: centre,
      mode,
      name: keyName(centre, mode),
      confidence: Math.max(0.2, Math.min(1, centreScore(centre) - centreScore(best.tonic))),
    }
  }
  return result
}
