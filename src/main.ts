import './phone/styles.css'
import { App } from './app/controller'
import { loadPrefs } from './app/prefs'
import { connectBridge } from './bridge'
import { mountPhoneUi } from './phone/ui'
import { finishSignIn } from './spotify/auth'

async function boot() {
  const params = new URLSearchParams(location.search)
  const demo = params.has('demo')
  // ?demo=<Spotify track ID> shows that track's chords on the demo clock (handy without Spotify).
  const demoTrack = /^[0-9A-Za-z]{22}$/.test(params.get('demo') ?? '') ? params.get('demo')! : undefined
  // Connect first: storage lives behind the bridge inside the Even app.
  const bridge = await connectBridge()
  await loadPrefs()
  const signInError = await finishSignIn()
  const app = new App()
  mountPhoneUi(app, { signInError, inEvenApp: !!bridge })
  await app.start({ demo, demoTrack })
}

void boot().catch(err => {
  console.error(err)
  document.body.textContent = `ChordGlass failed to start: ${(err as Error).message}`
})
