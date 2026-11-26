import { describe, expect, it } from 'vitest'
import { align, alignStates } from '../src/audio/align'
import { FAMILIES, NO_CHORD, type HeardFrame } from '../src/audio/listener'
import { chordonomiconToChart } from '../src/chart/chordonomicon'
import { parseChord } from '../src/theory/chord'

const FRAME = 2048 / 22050 * 1000

/** Fake listener output: `script` is [chord, seconds] as performed; noise mixes in a wrong chord. */
function heard(script: [string, number][], startMs = 0, noise = 0.3): HeardFrame[] {
  const frames: HeardFrame[] = []
  let t = startMs
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (const [chord, sec] of script) {
    const c = parseChord(chord)!
    const f = c.root * 2 + (c.minor ? 1 : 0)
    for (let i = 0; i < Math.round((sec * 1000) / FRAME); i++) {
      const fam = new Float32Array(FAMILIES).fill(0.005)
      fam[f] = 1 - noise
      fam[Math.floor(rand() * 24)] += noise
      fam[NO_CHORD] = 0.01
      frames.push({ songMs: t, fam, label: chord, context: 30 })
      t += FRAME
    }
  }
  return frames
}

describe('align', () => {
  const chart = chordonomiconToChart('x', '<verse_1> Dmin F C Dmin F C <chorus_1> Bb C F C')

  it('follows a performance of the chart and predicts the next chord', () => {
    const states = alignStates(chart, 60_000)
    const frames = heard([['Dm', 2], ['F', 2], ['C', 2], ['Dm', 2], ['F', 2], ['C', 2], ['Bb', 2], ['C', 1]])
    const a = align(states, frames, 60_000, FRAME)!
    expect(a.fit).toBeGreaterThan(0.8)
    const chords = a.timeline.filter(e => !e.estimated).map(e => e.chord)
    expect(chords).toEqual(['Dm', 'F', 'C', 'Dm', 'F', 'C', 'Bb', 'C'])
    // Changes land within a frame or two of the truth.
    expect(Math.abs(a.timeline[1].start - 2000)).toBeLessThan(250)
    expect(Math.abs(a.timeline[6].start - 12000)).toBeLessThan(250)
    // Next predicted: F after the C, about 2 s per chord as heard.
    const next = a.timeline.find(e => e.estimated)!
    expect(next.chord).toBe('F')
    expect(next.end - next.start).toBeGreaterThan(1500)
  })

  it('follows a repeated section the sheet wrote once', () => {
    const states = alignStates(chart, 60_000)
    const chorus: [string, number][] = [['Bb', 2], ['C', 2], ['F', 2], ['C', 2]]
    const frames = heard([['Dm', 2], ['F', 2], ['C', 2], ['Dm', 2], ['F', 2], ['C', 2], ...chorus, ...chorus, ['Bb', 1.5]])
    const a = align(states, frames, 60_000, FRAME)!
    const chords = a.timeline.filter(e => !e.estimated).map(e => e.chord)
    // The chorus is heard twice, then the start of a third time.
    expect(chords.join(' ')).toContain('Bb C F C Bb C F C Bb')
    expect(a.fit).toBeGreaterThan(0.8)
  })

  it('finds its place when listening starts mid-song', () => {
    const states = alignStates(chart, 40_000)
    // Starts at the chorus, 24 s in.
    const frames = heard([['Bb', 2], ['C', 2], ['F', 2], ['C', 1]], 24_000)
    const a = align(states, frames, 40_000, FRAME)!
    expect(a.timeline.filter(e => !e.estimated).map(e => e.chord)).toEqual(['Bb', 'C', 'F', 'C'])
  })

  it('reports a poor fit when the audio is another song', () => {
    const states = alignStates(chart, 60_000)
    const frames = heard([['E', 3], ['A', 3], ['B', 3], ['E', 3]])
    const a = align(states, frames, 60_000, FRAME)!
    expect(a.fit).toBeLessThan(0.4)
  })
})

describe('detectShift', () => {
  it('finds a recording a half step below its chart (Eb standard)', async () => {
    const { detectShift } = await import('../src/audio/align')
    const chart = chordonomiconToChart('x', '<verse_1> E A B E A B <chorus_1> Csmin A E B')
    const states = alignStates(chart, 60_000)
    // Performed a semitone lower: Eb Ab Bb ... Cm
    const frames = heard([['D#', 2], ['G#', 2], ['A#', 2], ['D#', 2], ['G#', 2], ['A#', 2], ['Cm', 2], ['G#', 2], ['D#', 2], ['A#', 2]])
    expect(detectShift(states, frames).shift).toBe(-1)
    // And the original key reads as no shift.
    expect(detectShift(states, heard([['E', 2], ['A', 2], ['B', 2], ['C#m', 2]])).shift).toBe(0)
  })
})
