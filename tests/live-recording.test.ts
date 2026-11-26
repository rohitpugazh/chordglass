import { existsSync, readFileSync } from 'node:fs'
import { it } from 'vitest'
import { align, alignStates } from '../src/audio/align'
import { ChordModel, type ChordModelConfig } from '../src/audio/chordModel'
import { decodeCqtPlan } from '../src/audio/cqt'
import { ChordListener } from '../src/audio/listener'
import { chordonomiconToChart, shardOf } from '../src/chart/chordonomicon'

// Optional check on a real recording (scripts/loopback.py record), skipped unless configured:
//   LIVE_WAV=song.wav LIVE_TRACK=<spotify id> LIVE_START_MS=<song ms at the start of the wav> LIVE_DURATION_MS=<track length> npx vitest run tests/live-recording.test.ts
// Needs the chord index (public/cn) and the model (npm run fetch-model).
const WAV = process.env.LIVE_WAV ?? ''
const TRACK = process.env.LIVE_TRACK ?? ''
const START = Number(process.env.LIVE_START_MS ?? 0)
const DURATION = Number(process.env.LIVE_DURATION_MS ?? 0)
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

it.skipIf(!WAV || !existsSync(WAV) || !TRACK)('streams a real recording through listener + aligner', async () => {
  const dir = 'public/models/chordmini'
  const config = JSON.parse(readFileSync(`${dir}/config.json`, 'utf8')) as ChordModelConfig
  const ort = await import('onnxruntime-web')
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(`${dir}/chordnet.onnx`)), { executionProviders: ['wasm'] })
  const model = ChordModel.fromSession(session, ort, config, decodeCqtPlan(ab(readFileSync(`${dir}/cqt-plan.bin`))))
  const listener = new ChordListener(model)

  const raw = JSON.parse(readFileSync(`public/cn/${shardOf(TRACK)}.json`, 'utf8'))[TRACK] as string
  const chart = chordonomiconToChart(TRACK, raw)
  const duration = DURATION
  const states = alignStates(chart, duration)

  const wav = readFileSync(WAV)
  const pcm = new Int16Array(ab(wav.subarray(44)))
  const startSong = START
  const chunk = 1600 // 100 ms
  const log: string[] = []
  let nextAnalysis = 2.5
  let analysisTotal = 0, analyses = 0
  for (let i = 0; i + chunk <= pcm.length; i += chunk) {
    const f = new Float32Array(chunk)
    for (let j = 0; j < chunk; j++) f[j] = pcm[i + j] / 32768
    const t = (i + chunk) / 16000
    listener.push(f, startSong + t * 1000)
    if (t >= nextAnalysis) {
      nextAnalysis += 2.5
      if (await listener.analyze()) {
        analysisTotal += listener.lastAnalysisMs; analyses++
        const a = align(states, listener.heard(), duration, listener.frameMs)
        if (a && Math.round(t) % 10 === 0) {
          const nowMs = startSong + t * 1000
          const cur = a.timeline.find(e => e.start <= nowMs && nowMs < e.end)
          const next = a.timeline.find(e => e.start > nowMs)
          log.push(`t=${(nowMs / 1000).toFixed(0)}s fit ${Math.round(a.fit * 100)}% now ${cur?.chord ?? '-'} next ${next?.chord ?? '-'}@${next ? (next.start / 1000).toFixed(1) : ''} heard ${listener.current()?.label ?? '-'}`)
        }
      }
    }
  }
  const a = align(states, listener.heard(), duration, listener.frameMs)!
  console.log(log.join('\n'))
  console.log(`avg analysis ${Math.round(analysisTotal / analyses)} ms over ${analyses} runs; final fit ${Math.round(a.fit * 100)}%, coverage ${Math.round(a.coverage * 100)}%`)
  console.log('aligned:', a.timeline.filter(e => !e.estimated).map(e => `${(e.start / 1000).toFixed(1)}:${e.chord}`).join(' '))
}, 300_000)
