import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeCqt, decodeCqtPlan } from '../src/audio/cqt'

const PLAN = 'public/models/chordmini/cqt-plan.bin'
const FIXTURE = 'tests/fixtures/cqt-librosa.bin'

/** Same signal as synth() in scripts/make_cqt_fixture.py. */
function synthSignal(): Float32Array {
  const SR = 22050
  const N = SR * 3
  const x = new Float64Array(N)
  const notes: [number, number, number][] = [
    [220.0, 0, 1.5], [261.63, 0, 1.5], [329.63, 0, 1.5],
    [261.63, 1.5, 3], [329.63, 1.5, 3], [392.0, 1.5, 3],
  ]
  for (let n = 0; n < N; n++) {
    const t = n / SR
    notes.forEach(([f0, start, end], i) => {
      if (t < start || t >= end) return
      for (const h of [1, 2, 3]) x[n] += (Math.sin(2 * Math.PI * f0 * h * t + i) / h) * 0.1
    })
    x[n] += 0.1 * Math.sin(2 * Math.PI * (55 + 20 * t) * t)
  }
  return Float32Array.from(x)
}

const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

// The plan ships with the model (npm run fetch-model); skip when it isn't downloaded.
describe.skipIf(!existsSync(PLAN))('CQT', () => {
  it('matches librosa.cqt on a synthetic signal', () => {
    const plan = decodeCqtPlan(toArrayBuffer(readFileSync(PLAN)))
    expect(plan.nBins).toBe(144)
    expect(plan.octaves).toHaveLength(6)

    const fixture = readFileSync(FIXTURE)
    const frames = fixture.readUInt32LE(0)
    const bins = fixture.readUInt32LE(4)
    const expected = new Float32Array(toArrayBuffer(fixture.subarray(8)))

    const { frameCount, data } = computeCqt(synthSignal(), plan)
    expect(frameCount).toBe(frames)
    let interior = 0
    let edge = 0
    let loud = 0
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        const i = f * bins + b
        // Compare where there is energy; near the log(1e-6) floor tiny differences explode.
        if (expected[i] < -9) continue
        loud++
        const err = Math.abs(data[i] - expected[i])
        // librosa pads its resampler slightly differently at the very ends of the
        // signal, which shows up only in the lowest octave of the first/last frames.
        if (f < 3 || f >= frames - 5) edge = Math.max(edge, err)
        else interior = Math.max(interior, err)
      }
    }
    expect(loud).toBeGreaterThan(frames * 40)
    expect(interior).toBeLessThan(0.05)
    expect(edge).toBeLessThan(0.25)
  })
})
