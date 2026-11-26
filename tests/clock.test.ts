import { describe, expect, it } from 'vitest'
import { PlaybackClock } from '../src/spotify/clock'

function fakeClock() {
  let t = 0
  const clock = new PlaybackClock(() => t)
  return { clock, advance: (ms: number) => { t += ms }, at: () => t }
}

const sample = (over: Partial<Parameters<PlaybackClock['sync']>[0]>) => ({
  trackId: 'a', progressMs: 0, durationMs: 200_000, isPlaying: true, sampledAt: 0, rttMs: 100, ...over,
})

describe('PlaybackClock', () => {
  it('extrapolates while playing and freezes while paused', () => {
    const { clock, advance, at } = fakeClock()
    expect(clock.sync(sample({ progressMs: 10_000, sampledAt: at() }))).toBe('jump')
    advance(2500)
    expect(clock.position()).toBe(12_500)
    clock.sync(sample({ progressMs: 12_500, sampledAt: at(), isPlaying: false }))
    advance(5000)
    expect(clock.position()).toBe(12_500)
  })

  it('anchors at the request midpoint', () => {
    const { clock, advance, at } = fakeClock()
    // Request took 400 ms; Spotify measured 10 s at its midpoint (200 ms ago).
    advance(400)
    clock.sync(sample({ progressMs: 10_000, sampledAt: at() - 200, rttMs: 400 }))
    expect(clock.position()).toBe(10_200)
  })

  it('blends in small errors instead of jumping', () => {
    const { clock, advance, at } = fakeClock()
    clock.sync(sample({ progressMs: 0, sampledAt: at() }))
    advance(3000)
    // Spotify says 3.2 s; we predicted 3.0 s. Fast request -> move half way.
    expect(clock.sync(sample({ progressMs: 3200, sampledAt: at(), rttMs: 100 }))).toBe('adjust')
    expect(clock.position()).toBe(3100)
    expect(clock.lastErrorMs).toBe(200)
  })

  it('trusts slow requests less', () => {
    const { clock, advance, at } = fakeClock()
    clock.sync(sample({ progressMs: 0, sampledAt: at() }))
    advance(3000)
    clock.sync(sample({ progressMs: 3400, sampledAt: at(), rttMs: 900 }))
    expect(clock.position()).toBe(3040)
  })

  it('jumps on seeks, track changes and resume', () => {
    const { clock, advance, at } = fakeClock()
    clock.sync(sample({ progressMs: 0, sampledAt: at() }))
    advance(3000)
    expect(clock.sync(sample({ progressMs: 60_000, sampledAt: at() }))).toBe('jump')
    expect(clock.position()).toBe(60_000)
    expect(clock.sync(sample({ trackId: 'b', progressMs: 500, sampledAt: at() }))).toBe('jump')
    expect(clock.trackId).toBe('b')
    clock.sync(sample({ trackId: 'b', progressMs: 500, sampledAt: at(), isPlaying: false }))
    advance(10_000)
    expect(clock.sync(sample({ trackId: 'b', progressMs: 600, sampledAt: at() }))).toBe('jump')
    expect(clock.position()).toBe(600)
  })

  it('never runs past the end of the track', () => {
    const { clock, advance, at } = fakeClock()
    clock.sync(sample({ progressMs: 199_000, sampledAt: at() }))
    advance(5000)
    expect(clock.position()).toBe(200_000)
  })
})
