import { store } from '../bridge'

export interface Prefs {
  /** How far ahead of Spotify's position chords are shown, in ms. Covers Bluetooth and display latency. */
  leadMs: number
  /** Semitones to transpose the displayed chords. */
  transpose: number
  /** Draw the current chord large (an image). Off = text only. */
  bigChord: boolean
  /** Folder with the Chordonomicon shards. Empty = the cn/ folder next to the app. */
  chordIndexUrl: string
  /** Swap what swipe up and swipe down do. */
  swapSwipes: boolean
}

export const DEFAULT_PREFS: Prefs = {
  leadMs: 250,
  transpose: 0,
  bigChord: true,
  chordIndexUrl: '',
  swapSwipes: false,
}

const KEY = 'cg.prefs'
export const prefs: Prefs = { ...DEFAULT_PREFS }
const listeners = new Set<(changed: Partial<Prefs>) => void>()

export async function loadPrefs(): Promise<void> {
  try {
    const raw = await store.get(KEY)
    if (raw) Object.assign(prefs, DEFAULT_PREFS, JSON.parse(raw))
  } catch { /* keep defaults */ }
}

export async function savePrefs(changed: Partial<Prefs>): Promise<void> {
  Object.assign(prefs, changed)
  listeners.forEach(fn => fn(changed))
  await store.set(KEY, JSON.stringify(prefs))
}

export function onPrefsChange(fn: (changed: Partial<Prefs>) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function chordIndexUrl(): string {
  return prefs.chordIndexUrl.trim() || import.meta.env.VITE_CHORD_INDEX_URL || new URL('cn/', location.href).href
}
