// The phone-side page (what the Even app shows on your phone, or a laptop
// browser shows during development): Spotify connection, a live preview of
// the glasses, the chord chart editor for the current song, and settings.

import type { App } from '../app/controller'
import { deleteUserChart, saveUserChartText } from '../app/charts'
import { DEFAULT_PREFS, prefs, savePrefs } from '../app/prefs'
import { keyLine, setupLine } from '../app/songinfo'
import { isTimed, parseChartText, serializeChart } from '../chart/chart'
import {
  exportSignInKey, importSignInKey, isSignedIn, redirectUri, savedClientId, signInProblem, signOut, startSignIn,
} from '../spotify/auth'
import { DomPreview } from './preview'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const TEMPLATE = `
<main>
  <h1>ChordGlass</h1>
  <p class="muted" id="env"></p>

  <section class="card">
    <h2>On your glasses</h2>
    <div class="g2-wrap" id="preview"></div>
    <p class="muted" id="now"></p>
  </section>

  <section class="card" id="spotify">
    <h2>Spotify</h2>
    <p id="sp-status"></p>
    <div id="sp-connected" hidden>
      <div class="row">
        <button id="sp-export">Show sign-in key</button>
        <button id="sp-signout">Disconnect</button>
      </div>
      <textarea id="sp-key-out" readonly hidden style="min-height:80px"></textarea>
      <small id="sp-key-hint" hidden>Paste this into ChordGlass inside the Even app (Spotify &gt; Sign-in key). Keep it private: it lets anyone read what you're playing.</small>
    </div>
    <div id="sp-setup" hidden>
      <div class="row"><button class="primary" id="sp-connect">Connect Spotify</button></div>
      <details>
        <summary class="muted">Using your own Spotify app</summary>
        <ol>
          <li>Create an app at <code>developer.spotify.com/dashboard</code> and tick <b>Web API</b>. (Spotify needs the app owner to have Premium.)</li>
          <li>Add this Redirect URI: <code id="sp-redirect"></code></li>
          <li>Under <b>User Management</b>, add the Spotify account you listen with.</li>
          <li>Paste the app's Client ID here and connect.</li>
        </ol>
        <input type="text" id="sp-client" placeholder="Client ID" autocomplete="off" spellcheck="false" />
      </details>
      <p class="status-warn" id="sp-problem" hidden></p>
      <p class="muted">Signing in somewhere else (e.g. a laptop at http://127.0.0.1:5173)? Paste the sign-in key it shows:</p>
      <input type="text" id="sp-key-in" placeholder="cg1...." autocomplete="off" spellcheck="false" />
      <div class="row"><button id="sp-import">Use sign-in key</button></div>
      <p class="muted">Google/Apple/Facebook login doesn't work inside the Even app; use Spotify's email login or the sign-in key.</p>
    </div>
  </section>

  <section class="card">
    <h2>Chords for this song</h2>
    <p class="muted" id="chart-status">Play a song on Spotify.</p>
    <textarea id="chart-text" spellcheck="false" placeholder="Play a song to edit its chords"></textarea>
    <div class="warnings" id="chart-warn"></div>
    <div class="row">
      <button class="primary" id="chart-save">Save</button>
      <button id="chart-load">Reload from current</button>
      <button id="chart-delete">Delete my chart</button>
    </div>
    <details>
      <summary class="muted">Chart format</summary>
      <pre class="muted" style="white-space:pre-wrap;font-size:12px">title: Song
artist: Band
key: G          (optional; guessed from the chords)
tuning: Eb      (Standard, Drop D, DADGAD, "D A D G B E"...)
capo: 2

[Intro]
0:00.0 G        (m:ss.s when the chord starts)
0:02.5 D/F#
[Verse 1] 0:05.0
Em C G D x2     (untimed chords are spread between timed ones)</pre>
      <p class="muted">Untimed chart? On the glasses hold for the menu &gt; <b>Record chord timings</b>, restart the song and tap the ring as each chord starts.</p>
    </details>
  </section>

  <section class="card">
    <h2>Settings</h2>
    <label>Sync: show chords <b id="lead-val"></b> early
      <input type="range" id="lead" min="-1000" max="2000" step="50" />
    </label>
    <small>Swipe up/down on the glasses or ring to nudge this by 100 ms while a song plays.</small>
    <label>Transpose
      <select id="transpose"></select>
    </label>
    <label class="check"><input type="checkbox" id="bigchord" /> Big chord on the glasses (off: text only)</label>
    <label class="check"><input type="checkbox" id="swap" /> Swap swipe up and down</label>
    <label class="check"><input type="checkbox" id="demo" /> Demo song (no Spotify needed)</label>
    <label>Chord index URL <small>(folder with Chordonomicon shards; empty = next to this app)</small>
      <input type="text" id="index-url" placeholder="https://rohitpugazh.github.io/chordglass/cn/" spellcheck="false" />
    </label>
  </section>

  <p class="muted" style="font-size:12px">Chord progressions: <a href="https://huggingface.co/datasets/ailsntua/Chordonomicon" style="color:inherit">Chordonomicon</a>
  (Kantarelis et al., 2024), CC BY-NC 4.0. Not affiliated with Spotify or Even Realities. Playback data comes from your own Spotify developer app.</p>
</main>`

export function mountPhoneUi(app: App, opts: { signInError: string | null; inEvenApp: boolean }) {
  document.body.innerHTML = TEMPLATE
  $('#env').textContent = opts.inEvenApp
    ? 'Running in the Even app. The glasses show the same as the preview below.'
    : 'Running in a browser (no glasses). The preview shows what the glasses would.'

  const preview = new DomPreview($('#preview'))
  app.screen.preview = preview
  const fit = () => {
    const wrap = $('#preview')
    const screen = wrap.querySelector('.g2-screen') as HTMLElement
    screen.style.transform = `scale(${wrap.clientWidth / 576})`
  }
  new ResizeObserver(fit).observe($('#preview'))

  // ---------- Spotify ----------
  const renderSpotify = async () => {
    const signedIn = await isSignedIn()
    $('#sp-connected').hidden = !signedIn
    $('#sp-setup').hidden = signedIn
    $('#sp-status').textContent = signedIn ? 'Connected.' : 'Not connected.'
    $('#sp-status').className = signedIn ? 'status-ok' : 'status-warn'
    $('#sp-redirect').textContent = redirectUri()
    const problem = signInProblem()
    $<HTMLButtonElement>('#sp-connect').disabled = !!problem
    $('#sp-problem').hidden = !problem && !opts.signInError
    $('#sp-problem').textContent = opts.signInError ?? problem ?? ''
    const input = $<HTMLInputElement>('#sp-client')
    if (!input.value) input.value = await savedClientId()
  }
  void renderSpotify()

  $('#sp-connect').onclick = () => {
    const id = $<HTMLInputElement>('#sp-client').value.trim()
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      $('#sp-problem').hidden = false
      $('#sp-problem').textContent = 'A Client ID is 32 letters and digits, from your app\'s Settings page.'
      return
    }
    void startSignIn(id)
  }
  $('#sp-import').onclick = async () => {
    const ok = await importSignInKey($<HTMLInputElement>('#sp-key-in').value)
    opts.signInError = ok ? null : 'That sign-in key didn\'t work. Copy it again from the other device.'
    await renderSpotify()
    if (ok) app.refreshNow()
  }
  $('#sp-export').onclick = async () => {
    const key = await exportSignInKey()
    const out = $<HTMLTextAreaElement>('#sp-key-out')
    out.value = key ?? ''
    out.hidden = !key
    $('#sp-key-hint').hidden = !key
    out.select()
  }
  $('#sp-signout').onclick = async () => {
    await signOut()
    await renderSpotify()
    app.refreshNow()
  }

  // ---------- Chart editor ----------
  let editorTrack = ''
  const fillEditor = () => {
    const s = app.snapshot()
    if (!s.track) return
    editorTrack = s.track.id
    const text = $<HTMLTextAreaElement>('#chart-text')
    if (s.chart.status === 'ready') {
      const c = s.chart.chart
      text.value = serializeChart({ ...c, title: c.title ?? s.track.title, artist: c.artist ?? s.track.artists, spotifyId: s.track.id })
    } else {
      text.value = `title: ${s.track.title}\nartist: ${s.track.artists}\nspotify: ${s.track.id}\ntuning: Standard\n\n[Verse 1]\n`
    }
    $('#chart-warn').textContent = ''
  }
  $('#chart-text').addEventListener('input', () => {
    const { warnings, chart } = parseChartText($<HTMLTextAreaElement>('#chart-text').value)
    $('#chart-warn').textContent = warnings.slice(0, 6).join('\n') + (chart.events.length ? '' : '\nNo chords yet.')
  })
  $('#chart-save').onclick = async () => {
    const s = app.snapshot()
    if (!s.track || s.demo) return
    await saveUserChartText(s.track.id, $<HTMLTextAreaElement>('#chart-text').value)
    await app.chartEdited()
    $('#chart-warn').textContent = 'Saved.'
  }
  $('#chart-load').onclick = fillEditor
  $('#chart-delete').onclick = async () => {
    const s = app.snapshot()
    if (!s.track || s.demo) return
    await deleteUserChart(s.track.id)
    await app.chartEdited()
    fillEditor()
  }

  // ---------- Settings ----------
  const lead = $<HTMLInputElement>('#lead')
  const showLead = () => { $('#lead-val').textContent = `${prefs.leadMs} ms` }
  lead.value = String(prefs.leadMs)
  showLead()
  lead.oninput = () => { void savePrefs({ leadMs: Number(lead.value) }); showLead() }

  const tr = $<HTMLSelectElement>('#transpose')
  for (let n = -6; n <= 6; n++) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = n === 0 ? 'None' : `${n > 0 ? '+' : ''}${n} semitone${Math.abs(n) > 1 ? 's' : ''}`
    tr.appendChild(o)
  }
  tr.value = String(prefs.transpose)
  tr.onchange = () => void savePrefs({ transpose: Number(tr.value) })

  const big = $<HTMLInputElement>('#bigchord')
  big.checked = prefs.bigChord
  big.onchange = () => void savePrefs({ bigChord: big.checked })
  const swap = $<HTMLInputElement>('#swap')
  swap.checked = prefs.swapSwipes
  swap.onchange = () => void savePrefs({ swapSwipes: swap.checked })
  const url = $<HTMLInputElement>('#index-url')
  url.value = prefs.chordIndexUrl
  url.onchange = () => void savePrefs({ chordIndexUrl: url.value.trim() || DEFAULT_PREFS.chordIndexUrl })
  const demo = $<HTMLInputElement>('#demo')
  demo.onchange = () => app.setDemo(demo.checked)

  // ---------- Live status ----------
  let lastStatusKey = ''
  app.subscribe(() => {
    fit()
    const s = app.snapshot()
    demo.checked = s.demo
    lead.value = String(prefs.leadMs)
    showLead()
    tr.value = String(prefs.transpose)

    const now = s.track ? `${s.track.title} - ${s.track.artists}` : s.problem || 'Nothing playing.'
    if ($('#now').textContent !== now) $('#now').textContent = now

    let status = 'Play a song on Spotify.'
    if (s.track) {
      const c = s.chart
      if (c.status === 'loading') status = 'Looking up chords...'
      else if (c.status === 'missing') status = `No chords found for this track (${s.track.id}). Type them below and Save.`
      else if (c.status === 'error') status = `Chord lookup failed: ${c.message}`
      else if (c.status === 'ready') {
        const src = c.chart.source === 'user' ? 'Your chart' : c.chart.source === 'demo' ? 'Demo chart' : 'From Chordonomicon'
        status = `${src}, ${c.chart.events.length} chords, ${isTimed(c.chart) ? 'timed' : 'untimed'}. ${keyLine(c.info)}${setupLine(c.info) ? ' · ' + setupLine(c.info) : ''}`
      }
    }
    if (status !== lastStatusKey) {
      lastStatusKey = status
      $('#chart-status').textContent = status
    }
    // Fill the editor when the song changes, unless you're typing in it.
    const typing = document.activeElement === $('#chart-text')
    if (s.track && s.track.id !== editorTrack && !typing && s.chart.status !== 'loading') fillEditor()
  })
}
