// Downloads the ChordMini chord-recognition model into public/models/chordmini
// (pinned revision, every file checked against its SHA-256).
// (onnxruntime-web's WebAssembly runtime is bundled by Vite.)
//
// Model: ChordMini ChordNet 2E1D (ptnghia-j/ChordMini, MIT), ONNX export and CQT
// plan musetric/chordmini-onnx (MIT) on Hugging Face.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'https://huggingface.co/musetric/chordmini-onnx/resolve/8ab85fc0f61439900cd07ac21257a43eac57075c/'
const FILES = [
  ['chordnet.onnx', '1faee8e1cf168300afe0f47517e76836ac200c3841b0fb430fad7dfea5ad6394'],
  ['config.json', '1f26c11ebea51ec08f12e813eb213a729fa0ecc407ac7632dfdc7bad67e65aa4'],
  ['cqt-plan.bin', 'c31f0a6fd2d582d753be6628b5daecdee58acba53cba93b2bc2b5c75dee2ba48'],
]
const sha256 = data => createHash('sha256').update(data).digest('hex')

const modelDir = join('public', 'models', 'chordmini')
mkdirSync(modelDir, { recursive: true })
for (const [name, hash] of FILES) {
  const target = join(modelDir, name)
  if (existsSync(target) && sha256(readFileSync(target)) === hash) {
    console.log(`ok        ${name}`)
    continue
  }
  const res = await fetch(BASE + name)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (sha256(data) !== hash) throw new Error(`${name}: SHA-256 mismatch`)
  writeFileSync(target, data)
  console.log(`download  ${name} (${(data.length / 1e6).toFixed(1)} MB)`)
}

