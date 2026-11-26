// Chordonomicon (Kantarelis et al. 2024, CC BY-NC 4.0): ~680k chord progressions
// scraped from chord sheets, ~430k of them tagged with a Spotify track ID.
// Each song is one string: "<intro_1> C <verse_1> F C E7 Amin ...".
// scripts/build_chordonomicon_index.py turns the CSV into small static JSON
// shards keyed by Spotify track ID; this module looks a track up and turns it
// into an untimed Chart.

import { normalizeChordSymbol, parseChord } from '../theory/chord'
import type { Chart } from './chart'

export const SHARD_COUNT = 2048

/** FNV-1a 32-bit. Must match shard_of() in scripts/build_chordonomicon_index.py. */
export function shardOf(spotifyId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < spotifyId.length; i++) {
    h ^= spotifyId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return String(h % SHARD_COUNT).padStart(4, '0')
}

function sectionName(tag: string): string {
  // "verse_1" -> "Verse 1", "intro_riff" -> "Intro riff"
  const words = tag.replace(/[<>]/g, '').split('_')
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function chordonomiconToChart(spotifyId: string, raw: string): Chart {
  const chart: Chart = { source: 'chordonomicon', spotifyId, events: [] }
  let section: string | undefined
  for (const token of raw.trim().split(/\s+/)) {
    if (token.startsWith('<')) { section = sectionName(token); continue }
    if (!parseChord(token)) continue
    chart.events.push({ t: null, chord: normalizeChordSymbol(token), section })
  }
  return chart
}

const shardCache = new Map<string, Promise<Record<string, string> | null>>()

/**
 * Fetches the shard holding `spotifyId` from `baseUrl` (a folder containing
 * 0000.json ... 2047.json) and returns its chart, or null when the track isn't
 * in the dataset. Throws on network errors so callers can tell "missing" from "offline".
 */
export async function lookupChordonomicon(baseUrl: string, spotifyId: string): Promise<Chart | null> {
  const shard = shardOf(spotifyId)
  const url = new URL(`${shard}.json`, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href
  let pending = shardCache.get(url)
  if (!pending) {
    pending = fetch(url).then(async res => {
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Chord index error ${res.status}`)
      return (await res.json()) as Record<string, string>
    })
    shardCache.set(url, pending)
    pending.catch(() => shardCache.delete(url))
  }
  const data = await pending
  const raw = data?.[spotifyId]
  return raw ? chordonomiconToChart(spotifyId, raw) : null
}
