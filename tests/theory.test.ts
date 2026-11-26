import { describe, expect, it } from 'vitest'
import { formatChord, normalizeChordSymbol, parseChord, transposeSymbol } from '../src/theory/chord'
import { inferKey, parseKey, relativeKey } from '../src/theory/key'
import { parseTuning, tuningAdvice, tuningNotes, tuningShort } from '../src/theory/tuning'

const chords = (s: string) => s.split(/\s+/).map(c => ({ chord: parseChord(c)!, weight: 1 }))

describe('parseChord', () => {
  it.each([
    ['C', 'C', [0, 4, 7]],
    ['Am', 'Am', [9, 0, 4]],
    ['F#m7', 'F#m7', [6, 9, 1, 4]],
    ['Bb/D', 'Bb/D', [10, 2, 5]],
    ['Dsus4', 'Dsus4', [2, 7, 9]],
    ['Dsus', 'Dsus4', [2, 7, 9]],
    ['E5', 'E5', [4, 11]],
    ['Cmaj7', 'Cmaj7', [0, 4, 7, 11]],
    ['CM7', 'Cmaj7', [0, 4, 7, 11]],
    ['Bm7b5', 'Bm7b5', [11, 2, 5, 9]],
    ['C#dim7', 'C#dim7', [1, 4, 7, 10]],
    ['G7sus4', 'G7sus4', [7, 0, 2, 5]],
    ['Cadd9', 'Cadd9', [0, 4, 7, 2]],
  ])('%s', (input, display, tones) => {
    const c = parseChord(input)!
    expect(formatChord(c)).toBe(display)
    expect(c.tones).toEqual(tones)
  })

  it('reads Chordonomicon spellings', () => {
    expect(normalizeChordSymbol('Fsmin')).toBe('F#m')
    expect(normalizeChordSymbol('Csmin7')).toBe('C#m7')
    expect(normalizeChordSymbol('Csus4')).toBe('Csus4')
    expect(normalizeChordSymbol('Cssus4')).toBe('C#sus4')
    expect(normalizeChordSymbol('D/Fs')).toBe('D/F#')
    expect(normalizeChordSymbol('Ano3d')).toBe('A5')
    expect(normalizeChordSymbol('Gadd13')).toBe('G6')
    expect(normalizeChordSymbol('Aminadd13')).toBe('Am6')
    expect(normalizeChordSymbol('Bbmin')).toBe('Bbm')
  })

  it('rejects non-chords', () => {
    expect(parseChord('N.C.')).toBeNull()
    expect(parseChord('Hello')).toBeNull()
    expect(parseChord('x2')).toBeNull()
    expect(parseChord('')).toBeNull()
  })

  it('transposes with the requested spelling', () => {
    expect(transposeSymbol('G', 2, false)).toBe('A')
    expect(transposeSymbol('D/F#', -2, false)).toBe('C/E')
    expect(transposeSymbol('Em7', 1, true)).toBe('Fm7')
    expect(transposeSymbol('A', 1, true)).toBe('Bb')
    expect(transposeSymbol('A', 1, false)).toBe('A#')
  })
})

describe('inferKey', () => {
  it.each([
    ['G D Em C G D Em C', 'G'],
    ['C F G7 C', 'C'],
    ['Am Dm E7 Am', 'Am'],
    ['E A B7 E A E B7 E', 'E'],
    ['D Dmaj7 Em A D G Em A D', 'D'],
    ['C#m A C#m A C#m A B C#m A F#m A B', 'C#m'],
    ['Bb F Gm Eb Bb F Eb Bb', 'Bb'],
    ['Dm Bb C Dm Bb C A7 Dm', 'Dm'],
  ])('%s -> %s', (progression, expected) => {
    expect(inferKey(chords(progression))?.name).toBe(expected)
  })

  it('returns null for nothing', () => {
    expect(inferKey([])).toBeNull()
  })

  it('weights by duration', () => {
    // Mostly A minor with a short C: A minor.
    const weighted = [
      { chord: parseChord('Am')!, weight: 8000 },
      { chord: parseChord('G')!, weight: 2000 },
      { chord: parseChord('F')!, weight: 2000 },
      { chord: parseChord('E')!, weight: 2000 },
      { chord: parseChord('Am')!, weight: 8000 },
    ]
    expect(inferKey(weighted)?.name).toBe('Am')
  })
})

describe('keys', () => {
  it('parses key names', () => {
    expect(parseKey('G')?.name).toBe('G')
    expect(parseKey('F#m')?.name).toBe('F#m')
    expect(parseKey('Bb minor')?.name).toBe('Bbm')
    expect(parseKey('eb major')?.name).toBe('Eb')
    expect(parseKey('nonsense')).toBeNull()
  })
  it('finds relative keys', () => {
    expect(relativeKey({ tonic: 7, mode: 'major' }).name).toBe('Em')
    expect(relativeKey({ tonic: 9, mode: 'minor' }).name).toBe('C')
  })
})

describe('tuning', () => {
  it('parses presets and aliases', () => {
    expect(parseTuning('Standard')?.uniformOffset).toBe(0)
    expect(parseTuning('Eb')?.name).toBe('Eb standard')
    expect(parseTuning('half step down')?.uniformOffset).toBe(-1)
    expect(parseTuning('Drop D')?.midi).toEqual([38, 45, 50, 55, 59, 64])
    expect(parseTuning('DADGAD')?.name).toBe('DADGAD')
  })
  it('parses note lists and Songsterr MIDI arrays', () => {
    expect(parseTuning('D A D G B E')?.name).toBe('Drop D')
    expect(parseTuning('Eb Ab Db Gb Bb Eb')?.name).toBe('Eb standard')
    expect(parseTuning('64 59 55 50 45 40')?.name).toBe('Standard')
    expect(parseTuning('C G C F A D')?.name).toBe('Drop C')
    expect(parseTuning('D A D G B D')?.name).toBe('Double drop D')
  })
  it('describes tunings', () => {
    const eb = parseTuning('Eb')!
    expect(tuningNotes(eb)).toBe('Eb Ab Db Gb Bb Eb')
    expect(tuningAdvice(eb)).toBe('All strings half a step down')
    expect(tuningShort(eb)).toBe('Eb std')
    expect(tuningAdvice(parseTuning('Drop D')!)).toBe('6th down 2 to D')
    expect(tuningShort(parseTuning('standard')!)).toBe('Std tuning')
  })
  it('rejects junk', () => {
    expect(parseTuning('')).toBeNull()
    expect(parseTuning('whatever')).toBeNull()
  })
})

describe('inferKey tonal centre', () => {
  it('hears E as home in an E D A rock progression', () => {
    const sections = ['E D A E D A E D A C', 'E G D A E G D A C D', 'E D A E D A E D A C', 'E G D A E G D A C D E']
    const input = sections.flatMap(sec =>
      sec.split(' ').map((c, i) => ({ chord: parseChord(c)!, weight: 1, phraseStart: i === 0 })),
    )
    expect(inferKey(input)?.name).toBe('E')
  })
})
