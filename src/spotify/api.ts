// The only Spotify Web API call this app needs: what's playing and where.
// (GET /me/player/currently-playing is still available to Development Mode apps
// after Spotify's February 2026 changes; audio-features/analysis are not.)

import { getAccessToken, invalidateAccessToken } from './auth'

const API = 'https://api.spotify.com/v1'

export class SpotifyError extends Error {
  constructor(public status: number, message: string, public retryAfterSec = 0) {
    super(message)
  }
}

export interface Playback {
  kind: 'track' | 'episode' | 'ad' | 'unknown'
  trackId: string
  title: string
  artists: string
  album: string
  durationMs: number
  isPlaying: boolean
  progressMs: number
  /** performance.now() at the estimated moment Spotify measured progressMs (request midpoint). */
  sampledAt: number
  /** Round trip of the request in ms; the position is uncertain by about half of this. */
  rttMs: number
}

let blockedUntil = 0
export const rateLimitedForMs = () => Math.max(0, blockedUntil - Date.now())

function friendly(status: number, message: string): string {
  if (/not registered|user may not be registered/i.test(message)) return 'Add your Spotify account under User Management in your Spotify app'
  if (status === 401) return 'Spotify sign-in expired'
  if (status === 403) return 'Spotify refused the request'
  if (status === 429) return 'Spotify is rate limiting, slowing down'
  if (status >= 500) return 'Spotify is having trouble'
  return message || `Spotify error ${status}`
}

/** null when nothing is playing or paused on any device. */
export async function getPlayback(attempt = 0): Promise<Playback | null> {
  if (Date.now() < blockedUntil) throw new SpotifyError(429, friendly(429, ''), Math.ceil(rateLimitedForMs() / 1000))
  const token = await getAccessToken()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const t0 = performance.now()
  let res: Response
  try {
    res = await fetch(`${API}/me/player/currently-playing?additional_types=episode`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
  } catch {
    throw new SpotifyError(0, 'No connection to Spotify')
  } finally {
    clearTimeout(timer)
  }
  const t1 = performance.now()

  if (res.status === 204) return null
  if (res.status === 401 && attempt === 0) {
    invalidateAccessToken()
    return getPlayback(1)
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After')) || 5
    blockedUntil = Date.now() + retry * 1000
    throw new SpotifyError(429, friendly(429, ''), retry)
  }
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw new SpotifyError(res.status, friendly(res.status, data?.error?.message ?? ''))
  if (!data) return null

  const item = data.item
  const base = {
    isPlaying: !!data.is_playing,
    progressMs: data.progress_ms ?? 0,
    sampledAt: (t0 + t1) / 2,
    rttMs: t1 - t0,
  }
  if (!item) {
    return { ...base, kind: data.currently_playing_type === 'ad' ? 'ad' : 'unknown', trackId: '', title: '', artists: '', album: '', durationMs: 0 }
  }
  if (item.type === 'episode') {
    return { ...base, kind: 'episode', trackId: item.id, title: item.name, artists: item.show?.name ?? '', album: '', durationMs: item.duration_ms ?? 0 }
  }
  return {
    ...base,
    kind: 'track',
    trackId: item.id,
    title: item.name ?? '',
    artists: (item.artists ?? []).map((a: { name: string }) => a.name).join(', '),
    album: item.album?.name ?? '',
    durationMs: item.duration_ms ?? 0,
  }
}
