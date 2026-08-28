import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPrefs } from '../src/client/prefs.ts'

test('defaults to Swedish GPT-Realtime 2.1 Mini voice', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  })
  const prefs = loadPrefs()
  assert.equal(prefs.provider, 'openai')
  assert.equal(prefs.openaiModel, 'gpt-realtime-2.1-mini')
  assert.match(prefs.instructions, /svenska|sv-SE/i)
})
