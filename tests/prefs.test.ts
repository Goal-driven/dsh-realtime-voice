import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FLOOR_DELAY_MS, MIN_FLOOR_DELAY_MS } from '../src/floor-policy.ts'
import { loadPrefs, updatePrefs } from '../src/client/prefs.ts'

test('defaults to Swedish GPT-Realtime 2.1 Mini voice', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  })
  const prefs = loadPrefs()
  assert.equal(prefs.provider, 'openai')
  assert.equal(prefs.openaiModel, 'gpt-realtime-2.1-mini')
  assert.equal(prefs.floorDelayMs, DEFAULT_FLOOR_DELAY_MS)
  assert.match(prefs.instructions, /svenska|sv-SE/i)
  assert.equal(updatePrefs({ floorDelayMs: 800 }).floorDelayMs, MIN_FLOOR_DELAY_MS)
})
