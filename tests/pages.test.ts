import { describe, expect, it } from 'vitest'
import { demoChart, DEMO_DURATION_MS } from '../src/app/demo'
import { timedPage, untimedPage } from '../src/app/pages'
import { songInfo } from '../src/app/songinfo'
import { chordonomiconToChart } from '../src/chart/chordonomicon'

const song = (positionMs: number) => ({ title: 'Demo Song', artist: 'ChordGlass', positionMs, durationMs: DEMO_DURATION_MS, playing: true })
const text = (page: ReturnType<typeof timedPage>, name: string) => page.texts.find(t => t.name === name)?.content ?? ''

describe('timed page', () => {
  const info = songInfo(demoChart(), DEMO_DURATION_MS, 0)

  it('shows the current chord big, the next one and the section', () => {
    // Bar 5 (9.6 s) is the first chord of Verse 1.
    const page = timedPage({ song: song(10_000), info, leadMs: 0, displayMs: 10_000, bigChord: true, flash: '' })
    expect(page.layout).toBe('timed-big')
    expect(page.images[0].key).toBe('G||')
    expect(text(page, 'side')).toContain('next  D')
    expect(text(page, 'side')).toContain('[Verse 1]')
    expect(text(page, 'foot')).toMatch(/^\[G\]  D  Em  C/)
    expect(text(page, 'foot')).toContain('Key G')
  })

  it('merges held chords and names the section the next chord starts', () => {
    // Verse 1 ends C C (bars 10-11), Chorus starts on C at bar 12.
    const page = timedPage({ song: song(25_000), info, leadMs: 0, displayMs: 25_000, bigChord: false, flash: '' })
    expect(page.layout).toBe('timed-text')
    expect(text(page, 'body')).toContain('NOW  C')
    expect(text(page, 'body')).toContain('next C  [Chorus]')
  })

  it('transposes what it shows', () => {
    const up2 = songInfo(demoChart(), DEMO_DURATION_MS, 2)
    const page = timedPage({ song: song(10_000), info: up2, leadMs: 0, displayMs: 10_000, bigChord: true, flash: '' })
    expect(page.images[0].key).toBe('A||')
    expect(text(page, 'foot')).toContain('shapes A')
  })

  it('shows a flash message in place of the status line', () => {
    const page = timedPage({ song: song(10_000), info, leadMs: 0, displayMs: 10_000, bigChord: true, flash: 'Sync: chords 350 ms early' })
    expect(text(page, 'foot')).toContain('Sync: chords 350 ms early')
  })
})

describe('untimed page', () => {
  it('steps through sections', () => {
    const chart = chordonomiconToChart('x', '<intro_1> E D A <verse_1> E D A C <chorus_1> E G D A')
    const info = songInfo(chart, 200_000, 0)
    const page = untimedPage({ song: song(0), info, chart, sectionIndex: 1, flash: '' })
    const body = text(page, 'body')
    expect(body).toContain('[Verse 1]  2/3')
    expect(body).toContain('E  D  A  C')
    expect(body).toContain('next [Chorus 1]  E G D A')
    expect(body).toContain('Key E')
  })
})

describe('estimated timing for untimed charts', () => {
  const chart = chordonomiconToChart('x', '<intro_1> E D A <verse_1> E D A C <chorus_1> E G D A')
  const info = songInfo(chart, 110_000, 0)

  it('spreads the chords over the song and says so', () => {
    expect(info.estimated).toBe(true)
    expect(info.timeline.length).toBe(11)
    expect(info.timeline[0].start).toBe(2200)
    expect(info.timeline[info.timeline.length - 1].end).toBeLessThanOrEqual(110_000 - 3300)
  })

  it('shows the big chord with an estimate marker', () => {
    const page = timedPage({ song: { ...song(30_000), durationMs: 110_000 }, info, leadMs: 0, displayMs: 30_000, bigChord: true, flash: '' })
    expect(page.layout).toBe('timed-big')
    expect(page.images[0].key).toMatch(/\|est$/)
    expect(text(page, 'foot')).toContain('~timing')
  })

  it('keeps real timing when the chart has it', () => {
    expect(songInfo(demoChart(), DEMO_DURATION_MS, 0).estimated).toBe(false)
  })
})
