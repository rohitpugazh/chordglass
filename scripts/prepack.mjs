// Runs before `evenhub pack`: keeps the 138 MB chord index out of the .ehpk
// (the packed app fetches it from your hosted copy instead) and refuses to
// pack while app.json still has the placeholder network whitelist entry.
import { readFileSync, rmSync } from 'node:fs'

const app = JSON.parse(readFileSync('app.json', 'utf8'))
const whitelist = app.permissions?.find(p => p.name === 'network')?.whitelist ?? []
const placeholder = whitelist.find(u => u.includes('YOUR-GITHUB-USER'))
if (placeholder) {
  console.error(`app.json: replace ${placeholder} with the origin hosting your build (e.g. https://<you>.github.io).`)
  process.exit(1)
}
rmSync('dist/cn', { recursive: true, force: true })
console.log('dist/cn removed from the package; chords will load from the chord index URL.')
