import assert from 'node:assert/strict'
import test from 'node:test'
import { microphoneButtonPresentation } from '../src/client/components.tsx'
import { localizeVoiceError } from '../src/client/voice-errors.ts'

test('inactive microphone control remains visually discoverable', () => {
  const presentation = microphoneButtonPresentation(false, 'openai')

  assert.equal(presentation.ariaLabel, 'Starta realtidsröst')
  assert.match(presentation.title, /GPT-Realtime 2\.1 Mini/)
  assert.equal(presentation.style.width, 38)
  assert.equal(presentation.style.height, 38)
  assert.notEqual(presentation.style.background, 'transparent')
  assert.match(String(presentation.style.border), /^1px solid /)
})

test('missing OpenAI credential points to the working Models settings flow in Swedish', () => {
  assert.equal(
    localizeVoiceError('OPENAI_API_KEY is not configured'),
    'OpenAI API-nyckel saknas. Öppna Inställningar → Modeller → OpenAI och spara nyckeln.',
  )
})
