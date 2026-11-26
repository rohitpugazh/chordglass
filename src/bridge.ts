// The one place that talks to the Even app bridge.
//
// - Every bridge call goes through one queue: overlapping calls (a render and a
//   storage write, two text updates) can drop the BLE link.
// - Each call has a timeout so a call lost to a disconnect can't block the queue.
// - Storage uses the bridge's key-value store inside the Even app (browser
//   localStorage doesn't survive restarts there) and localStorage in a normal
//   browser, which is how the app runs on a laptop for sign-in and the demo.

import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

let bridge: EvenAppBridge | null = null
let tail: Promise<unknown> = Promise.resolve()

export function serial<T>(fn: (b: EvenAppBridge) => Promise<T>, timeoutMs = 6000): Promise<T> {
  const run = tail.then(
    () =>
      new Promise<T>((resolve, reject) => {
        if (!bridge) return reject(new Error('No glasses bridge'))
        const timer = setTimeout(() => reject(new Error('Glasses not responding')), timeoutMs)
        fn(bridge).then(resolve, reject).finally(() => clearTimeout(timer))
      }),
  )
  tail = run.catch(() => {})
  return run
}

/** The Even app (and its simulator) talk to the page through flutter_inappwebview. */
const hostPresent = () =>
  typeof (window as unknown as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview?.callHandler === 'function'

/**
 * Resolves to the bridge inside the Even app, or null in an ordinary browser.
 *
 * waitForEvenAppBridge() alone isn't enough: it also resolves in a plain
 * browser, where every call (including storage) silently goes nowhere. So the
 * bridge is only used once the Even app's WebView handler is actually there.
 */
export async function connectBridge(timeoutMs = 2500): Promise<EvenAppBridge | null> {
  const deadline = Date.now() + timeoutMs
  while (!hostPresent() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  if (!hostPresent()) return (bridge = null)
  const timeout = new Promise<null>(r => setTimeout(() => r(null), Math.max(500, deadline - Date.now())))
  bridge = await Promise.race([waitForEvenAppBridge(), timeout])
  return bridge
}

export const hasBridge = () => bridge !== null
export const getBridge = () => bridge

/** Key-value storage with an in-memory cache so reads are cheap after the first. */
const cache = new Map<string, string | null>()

export const store = {
  async get(key: string): Promise<string | null> {
    if (cache.has(key)) return cache.get(key)!
    const value = bridge ? (await serial(b => b.getLocalStorage(key))) || null : localStorage.getItem(key)
    cache.set(key, value)
    return value
  },
  async set(key: string, value: string): Promise<void> {
    cache.set(key, value)
    if (bridge) await serial(b => b.setLocalStorage(key, value))
    else localStorage.setItem(key, value)
  },
  /** The bridge has no delete, so an empty string means "not set". */
  async remove(key: string): Promise<void> {
    cache.set(key, null)
    if (bridge) await serial(b => b.setLocalStorage(key, ''))
    else localStorage.removeItem(key)
  },
  /** Forget cached values, e.g. when another copy of the app may have written. */
  forget(key: string) {
    cache.delete(key)
  },
}
