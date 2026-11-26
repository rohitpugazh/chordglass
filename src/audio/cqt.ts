// Constant-Q transform on the CPU, equivalent to librosa.cqt as ChordMini
// expects it. The "plan" (octave schedule, sparse FFT basis, resampling FIR)
// is baked offline and ships with the model (cqt-plan.bin): it *defines* the
// features, so this file only executes it.
//
// Plan format and the algorithm (early downsample, per-octave framed 512-point
// FFT, sparse projection, log magnitude) follow musetric's packages/cqt
// (MIT, https://github.com/musetric/musetric), which runs the same plan on WebGPU.

export interface CqtOctave {
  index: number
  sampleRate: number
  hopLength: number
  fftSize: number
  binStart: number
  binCount: number
}

export interface CqtPlan {
  sampleRate: number
  hopLength: number
  nBins: number
  binsPerOctave: number
  fmin: number
  logOutput: boolean
  earlyDownsampleCount: number
  octaves: CqtOctave[]
  rowOffsets: Uint32Array
  fftBins: Uint32Array
  coefficients: Float32Array
  downsample: { tapCount: number; half: Float32Array; gain: number; delay: number }
}

const MAGIC = 0x5451434d
const HEADER = 128

export function decodeCqtPlan(buffer: ArrayBuffer): CqtPlan {
  const bytes = new Uint8Array(buffer.slice(0))
  const view = new DataView(bytes.buffer)
  if (bytes.byteLength < HEADER || view.getUint32(0, true) !== MAGIC) throw new Error('Not a CQT plan')
  if (HEADER + view.getUint32(60, true) !== bytes.byteLength) throw new Error('CQT plan has the wrong size')
  const nBins = view.getUint32(28, true)
  const octaveCount = view.getUint32(48, true)
  const tapCount = view.getUint32(52, true)
  const coefficientCount = view.getUint32(56, true)
  const at = (offset: number) => view.getUint32(offset, true)
  const octaves: CqtOctave[] = []
  for (let i = 0; i < octaveCount; i++) {
    const base = at(72) + i * 32
    octaves.push({
      index: view.getUint32(base, true),
      sampleRate: view.getFloat64(base + 4, true),
      hopLength: view.getUint32(base + 12, true),
      fftSize: view.getUint32(base + 16, true),
      binStart: view.getUint32(base + 20, true),
      binCount: view.getUint32(base + 24, true),
    })
  }
  if (octaves.some(o => o.fftSize !== FFT_SIZE)) throw new Error('Only 512-point CQT plans are supported')
  return {
    sampleRate: view.getFloat64(16, true),
    hopLength: at(24),
    nBins,
    binsPerOctave: at(32),
    fmin: view.getFloat64(40, true),
    logOutput: at(12) === 1,
    earlyDownsampleCount: at(36),
    octaves,
    rowOffsets: new Uint32Array(bytes.buffer, at(76), nBins + 1),
    fftBins: new Uint32Array(bytes.buffer, at(80), coefficientCount),
    coefficients: new Float32Array(bytes.buffer, at(84), coefficientCount * 2),
    downsample: {
      tapCount,
      half: new Float32Array(bytes.buffer, at(92), (tapCount + 1) / 2),
      gain: Math.SQRT2,
      delay: (tapCount - 1) / 2,
    },
  }
}

/** Halves the sample rate with the plan's symmetric low-pass FIR (zeros outside the signal). */
function downsample(input: Float32Array, plan: CqtPlan): Float32Array {
  const { half, gain, delay, tapCount } = plan.downsample
  const n = Math.ceil(input.length / 2)
  const out = new Float32Array(n)
  const last = input.length - 1
  for (let o = 0; o < n; o++) {
    const center = 2 * o
    const lo = Math.max(0, center - delay)
    const hi = Math.min(last, center - delay + tapCount - 1)
    let v = 0
    for (let s = lo; s <= hi; s++) v += input[s] * half[Math.abs(s - center)]
    out[o] = v * gain
  }
  return out
}

// ---- 512-point FFT (iterative radix-2) ----
const FFT_SIZE = 512
const LOG2 = 9
const COS = new Float64Array(FFT_SIZE / 2)
const SIN = new Float64Array(FFT_SIZE / 2)
const REV = new Uint16Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE)
  SIN[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE)
}
for (let i = 0; i < FFT_SIZE; i++) {
  let r = 0
  for (let b = 0; b < LOG2; b++) r |= ((i >> b) & 1) << (LOG2 - 1 - b)
  REV[i] = r
}

/** Forward DFT, X[k] = sum x[n] e^(-2 pi i k n / N), in place. */
function fft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = REV[i]
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const halfSize = size >> 1
    const step = FFT_SIZE / size
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < halfSize; k++) {
        const wr = COS[k * step], wi = SIN[k * step]
        const a = start + k, b = a + halfSize
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
      }
    }
  }
}

export function cqtFrameCount(sampleCount: number, plan: CqtPlan): number {
  let frames = Infinity
  for (const o of plan.octaves) {
    let n = sampleCount
    for (let d = 0; d < plan.earlyDownsampleCount + o.index; d++) n = Math.ceil(n / 2)
    frames = Math.min(frames, 1 + Math.floor(n / o.hopLength))
  }
  return frames
}

/**
 * CQT of `samples` (mono, plan.sampleRate). Returns frame-major features
 * [frameCount][nBins]; log(|C| + 1e-6) for ChordMini's plan. Frame f is
 * centred on sample f * hopLength.
 */
export function computeCqt(samples: Float32Array, plan: CqtPlan): { frameCount: number; data: Float32Array } {
  const frameCount = cqtFrameCount(samples.length, plan)
  const data = new Float32Array(frameCount * plan.nBins)
  const levels: Float32Array[] = []
  let level = samples
  const levelCount = plan.earlyDownsampleCount + plan.octaves.length - 1
  for (let l = 0; l < levelCount; l++) {
    level = downsample(level, plan)
    levels.push(level)
  }
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const { rowOffsets, fftBins, coefficients } = plan
  for (const o of plan.octaves) {
    const input = levels[plan.earlyDownsampleCount + o.index - 1]
    for (let f = 0; f < frameCount; f++) {
      const offset = f * o.hopLength - FFT_SIZE / 2
      for (let s = 0; s < FFT_SIZE; s++) {
        const i = offset + s
        re[s] = i >= 0 && i < input.length ? input[i] : 0
        im[s] = 0
      }
      fft(re, im)
      for (let b = o.binStart; b < o.binStart + o.binCount; b++) {
        let sr = 0, si = 0
        for (let c = rowOffsets[b]; c < rowOffsets[b + 1]; c++) {
          const k = fftBins[c]
          const cr = coefficients[2 * c], ci = coefficients[2 * c + 1]
          sr += cr * re[k] - ci * im[k]
          si += cr * im[k] + ci * re[k]
        }
        const mag = Math.sqrt(sr * sr + si * si)
        data[f * plan.nBins + b] = plan.logOutput ? Math.log(mag + 1e-6) : mag
      }
    }
  }
  return { frameCount, data }
}
