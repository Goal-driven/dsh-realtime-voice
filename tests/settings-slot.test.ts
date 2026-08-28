import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VOICE_SETTINGS_NAMESPACE,
  voiceSettingsSlotRegistration,
} from '../src/client/settings-slot.ts'

test('settings card supports the current keyed Harness slot', () => {
  const registration = voiceSettingsSlotRegistration()
  assert.equal(registration.name, 'settings.plugin.item')
  assert.equal(registration.key, VOICE_SETTINGS_NAMESPACE)
  assert.equal(registration.id, 'realtime-voice-settings')
  assert.equal(registration.order, 25)
})
