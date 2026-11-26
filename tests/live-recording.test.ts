import { existsSync, readFileSync } from 'node:fs'
import { it } from 'vitest'
import { align, alignStates } from '../src/audio/align'
import { ChordModel, type ChordModelConfig } from '../src/audio/chordModel'
import { decodeCqtPlan } from '../src/audio/cqt'
import { ChordListener, NO_CHORD } from '../src/audio/listener'
import { chordonomiconToChart, shardOf } from '../src/chart/chordonomicon'
import { parseChord } from '../src/theory/chord'

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
  const cadence = Number(process.env.LIVE_CADENCE_S ?? 1.2) // seconds between analyses, like the app
  let nextAnalysis = cadence
  let analysisTotal = 0, analyses = 0
  let current: ReturnType<typeof align> = null
  // What the glasses would show at each moment (no lead: this audio has exact song times).
  const shown: { t: number; chord: string; heard: string; ahead: number; past: string }[] = []
  let lastHeardMs = 0
  for (let i = 0; i + chunk <= pcm.length; i += chunk) {
    const f = new Float32Array(chunk)
    for (let j = 0; j < chunk; j++) f[j] = pcm[i + j] / 32768
    const t = (i + chunk) / 16000
    const nowMs = startSong + t * 1000
    listener.push(f, nowMs)
    if (t >= nextAnalysis) {
      nextAnalysis += cadence
      if (await listener.analyze()) {
        analysisTotal += listener.lastAnalysisMs; analyses++
        current = align(states, listener.heard(), duration, listener.frameMs)
        const h = listener.heard()
        lastHeardMs = h.length ? h[h.length - 1].songMs : 0
      }
    }
    if (current && t > 12) {
      const pastMs = lastHeardMs - 1500
      shown.push({
        t: nowMs,
        chord: (process.env.LIVE_NO_OVERRIDE || current.recentFit >= 0.45 || !listener.current())
          ? current.timeline.find(e => e.start <= nowMs && nowMs < e.end)?.chord ?? ''
          : listener.current()!.label,
        heard: listener.current()?.label ?? '',
        ahead: nowMs - lastHeardMs,
        // What the live alignment says about a moment it has already heard well (1.5 s before its newest audio).
        past: current.timeline.find(e => e.start <= pastMs && pastMs < e.end)?.chord ?? '',
      })
    }
  }

  // Hindsight: the alignment of the whole clip, which had all the audio around every moment.
  const final = align(states, listener.heard(), duration, listener.frameMs)!
  const truthAt = (ms: number) => final.timeline.find(e => !e.estimated && e.start <= ms && ms < e.end)?.chord ?? ''
  const agreement = (shiftMs: number) => {
    let ok = 0, n = 0
    for (const s of shown) {
      const truth = truthAt(s.t + shiftMs)
      if (!truth) continue
      n++
      if (truth === s.chord) ok++
    }
    return n ? ok / n : 0
  }
  // Second reference: what the model heard in hindsight (settled frames), as chord families.
  // Where the recording departs from the sheet (a held chord the sheet doesn't have), this is the fairer judge.
  const heardFinal = listener.heard()
  const familyOf = (sym: string) => {
    const c = parseChord(sym)
    return c ? (c.suffix === '5' ? c.root * 2 : c.root * 2 + (c.minor ? 1 : 0)) : -1
  }
  const heardFamilyAt = (ms: number) => {
    let lo = 0, hi = heardFinal.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (heardFinal[mid].songMs < ms) lo = mid + 1; else hi = mid }
    const f = heardFinal[lo]
    if (!f || Math.abs(f.songMs - ms) > 200 || f.fam[NO_CHORD] > 0.5) return -1
    let b = 0
    for (let k = 1; k < 24; k++) if (f.fam[k] > f.fam[b]) b = k
    return b
  }
  let okHeard = 0, nHeard = 0
  for (const s of shown) {
    const truth = heardFamilyAt(s.t)
    if (truth < 0) continue
    nHeard++
    if (familyOf(s.chord) === truth) okHeard++
  }
  console.log(`shown chord matches what the model heard (hindsight): ${Math.round((okHeard / Math.max(1, nHeard)) * 100)}%`)
  // Reference points: the hindsight alignment itself (ceiling for a chart-following display),
  // and simply showing the last heard chord (what the app does without a chart).
  let okCeil = 0, okBase = 0, n2 = 0
  for (const s2 of shown) {
    const truth = heardFamilyAt(s2.t)
    if (truth < 0) continue
    n2++
    if (familyOf(truthAt(s2.t)) === truth) okCeil++
    if (familyOf(s2.heard) === truth) okBase++
  }
  console.log(`ceiling (hindsight alignment vs heard): ${Math.round((okCeil / n2) * 100)}% · baseline (show last heard chord): ${Math.round((okBase / n2) * 100)}%`)
  // Is the live alignment right about what it has already heard, and how does accuracy fall with prediction distance?
  {
    let ok = 0, n = 0
    for (const s2 of shown) { const tr = truthAt(s2.t - (s2.ahead) - 1500); if (!tr) continue; n++; if (tr === s2.past) ok++ }
    const buckets = [0, 500, 1000, 1500, 2000, 3000, 5000].map((lo, i, arr) => {
      const hi = arr[i + 1] ?? Infinity
      const sel = shown.filter(x => x.ahead >= lo && x.ahead < hi && truthAt(x.t))
      const okb = sel.filter(x => truthAt(x.t) === x.chord).length
      return `${lo}-${hi === Infinity ? '' : hi}ms: ${sel.length ? Math.round((okb / sel.length) * 100) : '-'}% (n=${sel.length})`
    })
    console.log(`live alignment of already-heard audio (1.5 s back) vs hindsight: ${Math.round((ok / n) * 100)}%`)
    console.log('accuracy by how far the shown moment is past the newest heard audio:', buckets.join(' | '))
  }
  // What a player feels: the right chord mid-chord, and how early/late each change appears.
  {
    const changes = final.timeline.filter(e => !e.estimated).slice(1).map(e => ({ t: e.start, chord: e.chord }))
    const nearChange = (ms: number) => changes.some(c => Math.abs(c.t - ms) < 400)
    const interior = shown.filter(x => truthAt(x.t) && !nearChange(x.t))
    const okI = interior.filter(x => truthAt(x.t) === x.chord).length
    console.log(`mid-chord accuracy (more than 0.4 s from a change): ${Math.round((okI / interior.length) * 100)}% of ${interior.length}`)
    const split = Number(process.env.LIVE_SPLIT_MS ?? 0)
    if (split) {
      for (const [name, sel] of [['before', interior.filter(x => x.t < split)], ['after', interior.filter(x => x.t >= split)]] as const) {
        console.log(`  mid-chord ${name} ${split / 1000}s: ${Math.round((sel.filter(x => truthAt(x.t) === x.chord).length / Math.max(1, sel.length)) * 100)}% of ${sel.length}`)
      }
    }
    const lat: number[] = []
    let missed = 0
    for (const c of changes) {
      if (c.t < shown[0].t + 1500) continue
      // First moment within [-1.5 s, +3 s] of the change where the display shows the new chord.
      const hit = shown.find(x => x.t >= c.t - 1500 && x.t <= c.t + 3000 && x.chord === c.chord)
      if (hit) lat.push(hit.t - c.t); else missed++
    }
    lat.sort((x, y) => x - y)
    const q = (f: number) => lat[Math.min(lat.length - 1, Math.floor(f * lat.length))]
    console.log(`chord changes: ${lat.length} shown, ${missed} missed; display switches median ${q(0.5)} ms (positive = late), 10% ${q(0.1)} ms, 90% ${q(0.9)} ms`)
  }
  const shifts = [-2000, -1500, -1000, -750, -500, -250, 0, 250, 500, 750, 1000, 1500, 2000]
  const scores = shifts.map(s => ({ s, a: agreement(s) }))
  const best = scores.reduce((x, y) => (y.a > x.a ? y : x))
  console.log(`avg analysis ${Math.round(analysisTotal / analyses)} ms over ${analyses} runs; final fit ${Math.round(final.fit * 100)}%`)
  console.log(`shown chord right (vs hindsight) at the same moment: ${Math.round(agreement(0) * 100)}%`)
  console.log('by offset (ms: agreement):', scores.map(x => `${x.s}:${Math.round(x.a * 100)}`).join(' '))
  console.log(`best offset ${best.s} ms (${Math.round(best.a * 100)}%): ${best.s > 0 ? 'display runs early' : best.s < 0 ? 'display runs late' : 'no systematic lag'}`)
  if (process.env.LIVE_DUMP) {
    const rows: string[] = []
    for (let k = 0; k < shown.length; k += 5) {
      const s = shown[k]
      const truth = truthAt(s.t)
      rows.push(`${(s.t / 1000).toFixed(1)} ${s.chord.padEnd(4)} ${truth.padEnd(4)}${s.chord === truth ? '' : ' X'}`)
    }
    console.log('time shown truth\n' + rows.join('\n'))
  }
}, 600_000)
