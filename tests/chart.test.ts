import { describe, expect, it } from 'vitest'
import { buildTimeline, eventAt, formatTime, parseChartText, parseTime, sections, serializeChart } from '../src/chart/chart'
import { chordonomiconToChart, shardOf } from '../src/chart/chordonomicon'

const SAMPLE = `title: Example
artist: Somebody
spotify: https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc
tuning: Eb
capo: 2
bpm: 96

[Intro]
0:00.0 G
0:02.5 D/F#
[Verse 1] 0:05.0
Em C G D x2
0:15.0 G
`

describe('chart text', () => {
  it('parses headers, sections, times and repeats', () => {
    const { chart, warnings } = parseChartText(SAMPLE)
    expect(warnings).toEqual([])
    expect(chart.title).toBe('Example')
    expect(chart.spotifyId).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(chart.tuning).toBe('Eb')
    expect(chart.capo).toBe(2)
    expect(chart.bpm).toBe(96)
    expect(chart.events.map(e => e.chord)).toEqual(['G', 'D/F#', 'Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D', 'G'])
    expect(chart.events[2]).toEqual({ t: 5000, chord: 'Em', section: 'Verse 1' })
    expect(chart.events[3].t).toBeNull()
  })

  it('flags tokens that are not chords', () => {
    const { warnings } = parseChartText('G D banana C')
    expect(warnings).toEqual(['line 1: "banana" isn\'t a chord'])
  })

  it('round-trips through serializeChart', () => {
    const { chart } = parseChartText(SAMPLE)
    const again = parseChartText(serializeChart(chart)).chart
    expect(again.events).toEqual(chart.events)
    expect(again.capo).toBe(2)
  })

  it('parses and formats times', () => {
    expect(parseTime('1:02.5')).toBe(62500)
    expect(parseTime('12.25')).toBe(12250)
    expect(parseTime('G')).toBeNull()
    expect(formatTime(62500)).toBe('1:02.5')
    expect(formatTime(5000, 2)).toBe('0:05.00')
  })
})

describe('timeline', () => {
  it('spreads untimed chords between timed ones', () => {
    const { chart } = parseChartText(SAMPLE)
    const tl = buildTimeline(chart, 30_000)
    // Verse: Em at 5.0, then 7 untimed chords before G at 15.0 -> 1.25 s apart.
    expect(tl.slice(2, 10).map(e => e.start)).toEqual([5000, 6250, 7500, 8750, 10000, 11250, 12500, 13750])
    expect(tl[3].estimated).toBe(true)
    expect(tl[10]).toMatchObject({ chord: 'G', start: 15000, end: 30000, estimated: false })
  })

  it('finds the chord at a time', () => {
    const tl = buildTimeline(parseChartText(SAMPLE).chart, 30_000)
    expect(eventAt(tl, -1)).toBe(-1)
    expect(eventAt(tl, 0)).toBe(0)
    expect(eventAt(tl, 2499)).toBe(0)
    expect(eventAt(tl, 2500)).toBe(1)
    expect(eventAt(tl, 29_000)).toBe(10)
  })

  it('is empty for untimed charts', () => {
    expect(buildTimeline(parseChartText('G D Em C').chart, 10_000)).toEqual([])
  })

  it('spreads trailing untimed chords to the end of the track', () => {
    const tl = buildTimeline(parseChartText('0:10 G\nD Em C').chart, 18_000)
    expect(tl.map(e => e.start)).toEqual([10_000, 12_000, 14_000, 16_000])
  })
})

describe('chordonomicon', () => {
  it('hashes IDs to the same shards as the Python builder', () => {
    expect(shardOf('4AIEGdwDzPELXYgM5JaEY5')).toBe('0171')
    expect(shardOf('2ffJZ2r8HxI5DHcmf3BO6c')).toBe('0974')
    expect(shardOf('5KiY8SZEnvCPyIEkFGRR3y')).toBe('0929')
    expect(shardOf('01TtAcUqyLCRBZq4ZZiQWS')).toBe('0941')
  })

  it('converts a chord string to an untimed chart with sections', () => {
    const chart = chordonomiconToChart('x', '<intro_1> E D A/Cs <verse_1> Csmin A Fsmin B <chorus_1> E Bno3d')
    expect(chart.events.map(e => e.chord)).toEqual(['E', 'D', 'A/C#', 'C#m', 'A', 'F#m', 'B', 'E', 'B5'])
    expect(sections(chart).map(s => s.name)).toEqual(['Intro 1', 'Verse 1', 'Chorus 1'])
    expect(chart.events.every(e => e.t === null)).toBe(true)
  })
})
