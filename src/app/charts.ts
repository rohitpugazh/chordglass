// Where a track's chords come from, in order:
//   1. a chart you made or timed (saved on the phone, per Spotify track ID)
//   2. Chordonomicon (untimed progressions for ~430k Spotify tracks)
// Later sources (audio alignment, tab files) slot in here.

import { store } from '../bridge'
import { parseChartText, serializeChart, type Chart } from '../chart/chart'
import { lookupChordonomicon } from '../chart/chordonomicon'
import { chordIndexUrl } from './prefs'

const userKey = (trackId: string) => `cg.chart.${trackId}`

export type ChartLookup =
  | { status: 'found'; chart: Chart }
  | { status: 'missing' }
  | { status: 'error'; message: string }

export async function findChart(trackId: string): Promise<ChartLookup> {
  const saved = await store.get(userKey(trackId))
  if (saved) {
    const { chart } = parseChartText(saved, 'user')
    if (chart.events.length) return { status: 'found', chart }
  }
  try {
    const chart = await lookupChordonomicon(chordIndexUrl(), trackId)
    return chart ? { status: 'found', chart } : { status: 'missing' }
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
