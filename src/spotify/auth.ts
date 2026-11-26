// Spotify sign-in: Authorization Code with PKCE, so there's no client secret.
//
// Spotify's Development Mode allows 5 users per app and requires the app
// owner to have Premium, so each person uses their own Client ID from
// developer.spotify.com (free to create). Redirect URIs must be https or
// http://127.0.0.1, which is why sign-in runs from the hosted https build or a
// laptop on 127.0.0.1, and a "sign-in key" can carry the result into the
// Even app when it's loaded from a LAN dev server.

import { store } from '../bridge'

const ACCOUNTS = 'https://accounts.spotify.com'
export const SCOPES = ['user-read-playback-state', 'user-read-currently-playing']

const K = {
  clientId: 'cg.spotify.client_id',
  verifier: 'cg.spotify.pkce_verifier',
  refresh: 'cg.spotify.refresh_token',
}

export class NotSignedIn extends Error {
  constructor(public reason: 'missing' | 'revoked' = 'missing') {
    super(reason === 'revoked' ? 'Spotify sign-in expired' : 'Not signed in to Spotify')
  }
}

/** This page's address without query string or index.html: what to register in the Spotify dashboard. */
export function redirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '')
}

/** Why sign-in can't run from this address, or null if it can. */
export function signInProblem(): string | null {
  const { protocol, hostname, port, pathname } = location
  if (!crypto?.subtle) return 'This address isn\'t secure enough for sign-in (no Web Crypto).'
  if (protocol === 'https:') return null
  if (protocol === 'http:' && (hostname === '127.0.0.1' || hostname === '[::1]')) return null
  if (protocol === 'http:' && hostname === 'localhost') {
    return `Spotify rejects "localhost". Open http://127.0.0.1:${port || 80}${pathname} instead.`
  }
  return 'Sign-in needs the https:// build or http://127.0.0.1. Sign in there and paste the sign-in key here.'
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// The sign-in round trip (to Spotify and back) reloads the page. The verifier
// is kept in the page's own localStorage as well as the Even app's storage, so
// it survives even if the bridge comes up slowly (or not at all) on the way back.
const pageStore = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  remove: (k: string) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}

export async function startSignIn(clientId: string): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  pageStore.set(K.clientId, clientId.trim())
  pageStore.set(K.verifier, verifier)
  try {
    await store.set(K.clientId, clientId.trim())
    await store.set(K.verifier, verifier)
  } catch { /* pageStore has it */ }
  location.href = `${ACCOUNTS}/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId.trim(),
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })
}

let accessToken = ''
let expiresAt = 0

async function tokenRequest(params: Record<string, string>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description ?? data.error ?? `Spotify sign-in error ${res.status}`) as Error & { code?: string }
    err.code = data.error
    throw err
  }
  accessToken = data.access_token
  expiresAt = Date.now() + data.expires_in * 1000
  // PKCE refresh tokens rotate: always keep the newest.
  if (data.refresh_token) await store.set(K.refresh, data.refresh_token)
}

/** Call once on page load. Completes a sign-in if Spotify just redirected back; returns an error message or null. */
export async function finishSignIn(): Promise<string | null> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const error = params.get('error')
  if (!code && !error) return null
  history.replaceState(null, '', redirectUri() + (params.has('demo') ? '?demo' : ''))
  if (error) return error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${error}`

  const fromStore = async (k: string) => { try { return await store.get(k) } catch { return null } }
  const clientId = pageStore.get(K.clientId) || (await fromStore(K.clientId))
  const verifier = pageStore.get(K.verifier) || (await fromStore(K.verifier))
  if (!clientId || !verifier) {
    // Spotify sent the browser back somewhere other than where sign-in began
    // (e.g. Safari instead of the Even app), so the secret half is missing.
    return 'This sign-in was started in another app or browser. Tap Connect Spotify again here.'
  }
  try {
    await tokenRequest({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    })
    await store.set(K.clientId, clientId)
    pageStore.remove(K.verifier)
    await store.remove(K.verifier).catch(() => {})
    return null
  } catch (e) {
    return `Spotify sign-in failed: ${(e as Error).message}`
  }
}

let refreshing: Promise<void> | null = null

async function refresh(): Promise<void> {
  const clientId = await store.get(K.clientId)
  const used = await store.get(K.refresh)
  if (!clientId || !used) throw new NotSignedIn()
  try {
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: used, client_id: clientId })
  } catch (e) {
    if ((e as { code?: string }).code !== 'invalid_grant') throw e
    // The Even app can keep a second WebView of this app alive; it may have
    // rotated the token a moment ago. Try the stored one before giving up.
    store.forget(K.refresh)
    const latest = await store.get(K.refresh)
    if (latest && latest !== used) {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: latest, client_id: clientId })
      return
    }
    await store.remove(K.refresh)
    throw new NotSignedIn('revoked')
  }
}

export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - 30_000) return accessToken
  refreshing ??= refresh().finally(() => { refreshing = null })
  await refreshing
  return accessToken
}

export function invalidateAccessToken() {
  accessToken = ''
}

export async function isSignedIn(): Promise<boolean> {
  return !!(await store.get(K.refresh))
}

/**
 * This build's own Spotify app. A Client ID is public (PKCE has no secret);
 * only accounts added under User Management in that app can sign in.
 * Paste a different one on the phone page to use your own Spotify app.
 */
export const DEFAULT_CLIENT_ID = 'f29d72ced8454a9c98bd5c2f1602a517'

export async function savedClientId(): Promise<string> {
  return (await store.get(K.clientId)) || DEFAULT_CLIENT_ID
}

export async function signOut(): Promise<void> {
  invalidateAccessToken()
  await store.remove(K.refresh)
}

// ---- Sign-in key: move a sign-in from a laptop browser into the Even app ----

export async function exportSignInKey(): Promise<string | null> {
  const clientId = await store.get(K.clientId)
  const token = await store.get(K.refresh)
  return clientId && token ? `cg1.${clientId}.${token}` : null
}

export async function importSignInKey(key: string): Promise<boolean> {
  const m = key.trim().match(/^cg1\.([0-9a-f]{32})\.(\S{20,})$/i)
  if (!m) return false
  await store.set(K.clientId, m[1])
  await store.set(K.refresh, m[2])
  invalidateAccessToken()
  try {
    await getAccessToken()
    return true
  } catch {
    return false
  }
}
