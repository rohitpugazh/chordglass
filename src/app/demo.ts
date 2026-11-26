// A made-up song for trying the display without Spotify (?demo in the URL, or
// "Demo" on the phone page). The progression is generic, not from any record.

import { parseChartText } from '../chart/chart'

const BAR = 2400 // 100 bpm, 4/4

function bars(chords: string[], startBar: number): string {
  return chords.map((c, i) => `${((startBar + i) * BAR / 1000).toFixed(2)} ${c}`).join('\n')
}

const intro = ['G', 'D/F#', 'Em', 'C']
const verse = ['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'C']
const chorus = ['C', 'G', 'D', 'Em', 'C', 'G', 'D', 'D']
const bridge = ['Am7', 'Bm7', 'C', 'Dsus4']

export const DEMO_TRACK_ID = 'demo'
export const DEMO_TITLE = 'Demo Song'
export const DEMO_ARTIST = 'ChordGlass'

export const DEMO_CHART_TEXT = [
  `title: ${DEMO_TITLE}`,
  `artist: ${DEMO_ARTIST}`,
  'tuning: Standard',
  'capo: 0',
  'bpm: 100',
  '',
  '[Intro]', bars(intro, 0),
  '[Verse 1]', bars(verse, 4),
  '[Chorus]', bars(chorus, 12),
  '[Verse 2]', bars(verse, 20),
  '[Chorus]', bars(chorus, 28),
  '[Bridge]', bars(bridge, 36),
  '[Outro]', bars(['G', 'D', 'C', 'G'], 40),
].join('\n')

export const DEMO_DURATION_MS = 45 * BAR

export const demoChart = () => ({ ...parseChartText(DEMO_CHART_TEXT, 'demo').chart, source: 'demo' as const })
