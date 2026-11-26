import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ChordModel, familyMap, smoothedProbs, vocabLabel, type ChordModelConfig } from '../src/audio/chordModel'
import { computeCqt, decodeCqtPlan } from '../src/audio/cqt'

const DIR = 'public/models/chordmini'
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** Piano-ish synthetic chords: each note with decaying harmonics, re-struck every half second. */
function progression(chords: number[][], secondsEach: number, sr: number): Float32Array {
  const n = Math.round(chords.length * secondsEach * sr)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const c = Math.min(chords.length - 1, Math.floor(t / secondsEach))
    const sinceStrike = t % 0.5
    const env = Math.exp(-3 * sinceStrike)
    let v = 0
    for (const midi of chords[c]) {
      const f = 440 * 2 ** ((midi - 69) / 12)
      for (let h = 1; h <= 5; h++) v += (Math.sin(2 * Math.PI * f * h * t) / h ** 1.5) * env
    }
    x[i] = v * 0.05
  }
  return x
}

describe.skipIf(!existsSync(`${DIR}/chordnet.onnx`))('ChordMini model', () => {
  it('hears Am C G F in a synthetic progression', async () => {
    const config = JSON.parse(readFileSync(`${DIR}/config.json`, 'utf8')) as ChordModelConfig
    const plan = decodeCqtPlan(ab(readFileSync(`${DIR}/cqt-plan.bin`)))
    const ort = await import('onnxruntime-web')
    ort.env.wasm.numThreads = 1
    const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(`${DIR}/chordnet.onnx`)), { executionProviders: ['wasm'] })
    const model = ChordModel.fromSession(session, ort, config, plan)

    // Am (A2 C4 E4 A4), C (C3 E4 G4 C5), G (G2 B3 D4 G4), F (F2 A3 C4 F4)
    const chords = [[45, 60, 64, 69], [48, 64, 67, 72], [43, 59, 62, 67], [41, 57, 60, 65]]
    const audio = progression(chords, 2.5, config.sampleRate)
    const { frameCount, data } = computeCqt(audio, plan)
    const window = new Float32Array(config.seqLen * config.nBins)
    window.set(data.subarray(0, Math.min(frameCount, config.seqLen) * config.nBins))
    const [logits] = await model.run([window])
    const probs = smoothedProbs(logits, config.seqLen, config.numChords, config.smoothingKernel)

    const frameSec = config.hopLength / config.sampleRate
    const fam = familyMap(config.chordVocab)
    const heard: string[] = []
    for (let c = 0; c < 4; c++) {
      // Majority family in the middle of each chord.
      const votes = new Map<string, number>()
      for (let t = Math.ceil((c * 2.5 + 0.5) / frameSec); t < Math.floor(((c + 1) * 2.5 - 0.3) / frameSec); t++) {
        let best = 0
        for (let k = 1; k < config.numChords; k++) if (probs[t * config.numChords + k] > probs[t * config.numChords + best]) best = k
        const label = vocabLabel(config.chordVocab[best])
        const family = fam[best] === 24 ? 'N' : `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][fam[best] >> 1]}${fam[best] & 1 ? 'm' : ''}`
        void label
        votes.set(family, (votes.get(family) ?? 0) + 1)
      }
      heard.push([...votes].sort((a, b) => b[1] - a[1])[0][0])
    }
    expect(heard).toEqual(['Am', 'C', 'G', 'F'])
  }, 60_000)
})
