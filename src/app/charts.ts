// Where a track's chords come from, in order:
//   1. a chart you made or timed (saved on the phone, per Spotify track ID)
//   2. Chordonomicon (untimed progressions for ~430k Spotify tracks), by the
//      playing track's ID, or else by another release of the same song
//      (Spotify has separate IDs for the single, album, remaster...)

import { store } from '../bridge'
import { parseChartText, serializeChart, type Chart } from '../chart/chart'
import { lookupChordonomicon } from '../chart/chordonomicon'
import { baseTitle, findOtherReleases } from '../spotify/api'
import { chordIndexUrl } from './prefs'

const userKey = (trackId: string) => `cg.chart.${trackId}`
/** Which other release's chords a track uses, or "-" when none was found. */
const aliasKey = (trackId: string) => `cg.alias.${trackId}`

export type ChartLookup =
  | { status: 'found'; chart: Chart; via?: string }
  | { status: 'missing' }
  | { status: 'error'; message: string }

export interface TrackMeta {
  title: string
  artist: string
}

export async function findChart(trackId: string, meta?: TrackMeta): Promise<ChartLookup> {
  const saved = await store.get(userKey(trackId))
  if (saved) {
    const { chart } = parseChartText(saved, 'user')
    if (chart.events.length) return { status: 'found', chart }
  }
  try {
    const direct = await lookupChordonomicon(chordIndexUrl(), trackId)
    if (direct) return { status: 'found', chart: direct }

    const alias = await store.get(aliasKey(trackId))
    if (alias === '-') return { status: 'missing' }
    if (alias) {
      const chart = await lookupChordonomicon(chordIndexUrl(), alias)
      if (chart) return { status: 'found', chart: { ...chart, spotifyId: trackId }, via: alias }
    }
    if (!meta?.title) return { status: 'missing' }

    const ids = await findOtherReleases(baseTitle(meta.title), meta.artist).catch(() => [] as string[])
    for (const id of ids) {
      if (id === trackId) continue
      const chart = await lookupChordonomicon(chordIndexUrl(), id)
      if (chart) {
        await store.set(aliasKey(trackId), id)
        return { status: 'found', chart: { ...chart, spotifyId: trackId }, via: id }
      }
    }
    if (ids.length) await store.set(aliasKey(trackId), '-')
    return { status: 'missing' }
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
}

export async function saveUserChart(trackId: string, chart: Chart): Promise<void> {
  await store.set(userKey(trackId), serializeChart({ ...chart, source: 'user', spotifyId: trackId }))
}

export async function saveUserChartText(trackId: string, text: string): Promise<void> {
  await store.set(userKey(trackId), text)
}

export async function deleteUserChart(trackId: string): Promise<void> {
  await store.remove(userKey(trackId))
}

export async function hasUserChart(trackId: string): Promise<boolean> {
  return !!(await store.get(userKey(trackId)))
}
