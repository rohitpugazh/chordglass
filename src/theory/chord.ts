// Chord symbols: parsing (standard and Chordonomicon spellings), pitch content,
// transposition and display. Pure functions, no DOM, so they run in tests.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface Chord {
  /** Root pitch class, 0 = C. */
  root: number
  /** Root as written or as re-spelled after transposition, e.g. "F#", "Bb". */
  rootName: string
  /** Normalised suffix: "", "m", "7", "m7", "maj7", "5", "sus4", "m7b5", "add9"... */
  suffix: string
  bass?: number
  bassName?: string
  /** Chord tones as pitch classes, root first. */
  tones: number[]
  /** True for a minor-third chord (m, m7, dim, m7b5...). */
  minor: boolean
}

export const mod12 = (n: number) => ((n % 12) + 12) % 12

/** "F#", "Bb", "Fs" (Chordonomicon), "F♯" → pitch class and canonical spelling. */
export function parseNote(text: string): { pc: number; name: string; length: number } | null {
  const letter = text[0]?.toUpperCase()
  if (!letter || !(letter in LETTER_PC)) return null
  let pc = LETTER_PC[letter]
  let name = letter
  let i = 1
  const next = text[i]
  if (next === '#' || next === '♯') { pc += 1; name += '#'; i++ }
  else if (next === 'b' || next === '♭') { pc -= 1; name += 'b'; i++ }
  // Chordonomicon writes sharps as "s" (Fsmin = F#m) but "sus" is a suffix (Csus4).
  else if (next === 's' && !text.startsWith('sus', 1)) { pc += 1; name += '#'; i++ }
  return { pc: mod12(pc), name, length: i }
}

// Rare Chordonomicon suffixes that don't follow the general rules below.
const CHORDONOMICON_SUFFIX: Record<string, string> = {
  no3d: '5',
  add13: '6',
  minadd13: 'm6',
  minadd9: 'madd9',
  minadd11: 'madd11',
  minmaj7: 'mmaj7',
  minmaj9: 'mmaj9',
  minmaj13: 'mmaj13',
  maj911s: 'maj9#11',
  majs911s: 'maj9#11',
  maj1311s: 'maj13#11',
  majs9: 'maj9',
  '11s': '7#11',
  '13b': '7b13',
  '13b9': '13b9',
  minb9: 'mb9',
  dimb7: 'dim7',
  dimb9: 'dim7b9',
  dimadd13: 'dim7',
  min1113b: 'm11b13',
  augmaj7: 'maj7#5',
  augmaj9: 'maj9#5',
  augmaj11: 'maj11#5',
}

// What a normalised suffix may look like: quality, seventh/extension, alterations.
const SUFFIX_GRAMMAR = /^(?:m|dim|aug)?(?:maj)?(?:\d{1,2})?(?:sus[24]|add\d{1,2}|[b#]\d{1,2})*$/

/** Brings the many ways of writing a chord quality down to one spelling. */
export function normalizeSuffix(raw: string): string {
  let q = raw.trim().replace(/[()]/g, '')
  if (q in CHORDONOMICON_SUFFIX) return CHORDONOMICON_SUFFIX[q]
  if (q === 'Δ' || q === 'Δ7') return 'maj7'
  q = q.replace(/^min/, 'm').replace(/^mi(?!n)/, 'm')
  q = q.replace(/^-/, 'm')
  q = q.replace(/^m(Maj|MAJ|M)(?=\d)/, 'mmaj')
  q = q.replace(/^(Maj|MAJ|Ma|ma|M|Δ)(?=\d)/, 'maj')
  if (/^(maj|Maj|MAJ|M)$/.test(q)) q = ''
  q = q.replace(/^ø7?$/, 'm7b5').replace(/^°7$/, 'dim7').replace(/^°$/, 'dim').replace(/^o7$/, 'dim7').replace(/^o$/, 'dim')
  q = q.replace(/^\+$/, 'aug').replace(/^\+(?=\d)/, 'aug')
  q = q.replace(/^no3d?$/, '5')
  q = q.replace(/sus(?!\d)/, 'sus4')
  q = q.replace(/^m(add13)$/, 'm6').replace(/^add13$/, '6')
  return q
}

/** Chord tones (intervals above the root) for a normalised suffix. Good enough for key finding. */
export function suffixIntervals(q: string): number[] {
  if (q === '5') return [0, 7]
  let third = 4
  let fifth = 7
  const extra: number[] = []
  let rest = q

  if (rest.startsWith('dim')) {
    third = 3; fifth = 6; rest = rest.slice(3)
    if (rest.startsWith('7')) { extra.push(9); rest = rest.slice(1) }
  } else if (rest.startsWith('aug')) {
    fifth = 8; rest = rest.slice(3)
  } else if (/^m(?!aj)/.test(rest)) {
    third = 3; rest = rest.slice(1)
  }

  if (/sus2/.test(rest)) third = 2
  else if (/sus4/.test(rest)) third = 5
  if (/b5/.test(rest)) fifth = 6
  if (/#5/.test(rest)) fifth = 8

  const ext = rest.replace(/sus\d|add\d+|[b#]\d+/g, '')
  const maj = /maj/.test(ext)
  const num = Number(ext.replace(/\D/g, '') || 0)
  if (num === 6) extra.push(9)
  if (num >= 7) extra.push(maj ? 11 : 10)
  if (num >= 9) extra.push(2)
  if (num >= 11) extra.push(5)
  if (num >= 13) extra.push(9)

  for (const m of rest.matchAll(/add(\d+)/g)) {
    const deg = Number(m[1])
    extra.push(({ 2: 2, 9: 2, 4: 5, 11: 5, 6: 9, 13: 9 } as Record<number, number>)[deg] ?? 0)
  }
  for (const m of rest.matchAll(/([b#])(9|11|13)/g)) {
    const base = ({ 9: 2, 11: 5, 13: 9 } as Record<string, number>)[m[2]]
    extra.push(mod12(base + (m[1] === '#' ? 1 : -1)))
  }

  const tones = [0, third, fifth, ...extra]
  return [...new Set(tones)]
}

/**
 * Parses "F#m7", "Bb/D", "Dsus4", "E5", "C#m7b5", and Chordonomicon tokens like
 * "Fsmin7", "D/Fs", "Ano3d". Returns null for anything that isn't a chord
 * (including "N.C.").
 */
export function parseChord(symbol: string): Chord | null {
  const text = symbol.trim()
  if (!text || /^n\.?c\.?$/i.test(text)) return null
  const root = parseNote(text)
  if (!root) return null

  let rest = text.slice(root.length)
  let bass: ReturnType<typeof parseNote> = null
  const slash = rest.lastIndexOf('/')
  if (slash >= 0) {
    const after = rest.slice(slash + 1)
    bass = parseNote(after)
    // "6/9" style suffixes have a digit after the slash, not a bass note.
    if (bass && bass.length === after.length) rest = rest.slice(0, slash)
    else bass = null
  }
  // Chord sheets write roots in capitals; this also keeps words like "banana" out.
  if (!/^[A-G]/.test(text)) return null

  const suffix = normalizeSuffix(rest)
  if (!SUFFIX_GRAMMAR.test(suffix)) return null
  const intervals = suffixIntervals(suffix)
  return {
    root: root.pc,
    rootName: root.name,
    suffix,
    bass: bass?.pc,
    bassName: bass?.name,
    tones: intervals.map(i => mod12(root.pc + i)),
    minor: intervals.includes(3) && !intervals.includes(4),
  }
}

export function noteName(pc: number, preferFlats: boolean): string {
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)]
}

export function transposeChord(chord: Chord, semitones: number, preferFlats: boolean): Chord {
  if (!semitones) return chord
  const root = mod12(chord.root + semitones)
  const bass = chord.bass === undefined ? undefined : mod12(chord.bass + semitones)
  return {
    ...chord,
    root,
    rootName: noteName(root, preferFlats),
    bass,
    bassName: bass === undefined ? undefined : noteName(bass, preferFlats),
    tones: chord.tones.map(t => mod12(t + semitones)),
  }
}

/** "F#m7/C#": ASCII only, safe for the glasses font. */
export function formatChord(chord: Chord): string {
  return chord.rootName + chord.suffix + (chord.bassName ? '/' + chord.bassName : '')
}

/** Normalises a chord symbol to standard spelling, or returns it unchanged if it can't be parsed. */
export function normalizeChordSymbol(symbol: string): string {
  const c = parseChord(symbol)
  return c ? formatChord(c) : symbol.trim()
}

/** Transposes a written chord symbol; unparseable symbols pass through. */
export function transposeSymbol(symbol: string, semitones: number, preferFlats: boolean): string {
  const c = parseChord(symbol)
  return c ? formatChord(transposeChord(c, semitones, preferFlats)) : symbol
}
