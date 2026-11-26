import { describe, expect, it } from 'vitest'
import { baseTitle } from '../src/spotify/api'

describe('baseTitle', () => {
  it.each([
    ['Toxicity', 'Toxicity'],
    ['Hey Jude - Remastered 2015', 'Hey Jude'],
    ['Wonderwall - 2014 Remaster', 'Wonderwall'],
    ['Wake Me Up (feat. Justice)', 'Wake Me Up'],
    ['Creep - Live', 'Creep'],
    ['Under Pressure (Remastered 2011)', 'Under Pressure'],
    ['Mr. Brightside', 'Mr. Brightside'],
    ['Sweet Child O\' Mine - Radio Edit', 'Sweet Child O\' Mine'],
  ])('%s -> %s', (input, expected) => {
    expect(baseTitle(input)).toBe(expected)
  })
})
