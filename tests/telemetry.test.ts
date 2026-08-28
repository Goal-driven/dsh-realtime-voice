import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceTelemetryTracker } from '../src/client/telemetry.ts'

test('prices cached and uncached realtime text/audio tokens separately', () => {
  const tracker = new VoiceTelemetryTracker('gpt-realtime-2.1-mini')
  tracker.consume({ type: 'input_audio_buffer.speech_stopped' }, 1_000)
  tracker.consume({ type: 'response.audio.delta', delta: 'AA==' }, 1_245)
  const snapshot = tracker.consume({
    type: 'response.done',
    response: {
      usage: {
        input_tokens: 3_000,
        input_token_details: {
          text_tokens: 1_000,
          audio_tokens: 2_000,
          cached_tokens: 2_000,
          cached_tokens_details: { text_tokens: 500, audio_tokens: 1_500 },
        },
        output_tokens: 300,
        output_token_details: { text_tokens: 100, audio_tokens: 200 },
      },
    },
  }, 1_500)

  assert.ok(snapshot)
  assert.equal(snapshot.responses, 1)
  assert.equal(snapshot.firstAudioLatencyMs, 245)
  assert.equal(snapshot.cacheHitPercent.toFixed(2), '66.67')
  assert.equal(snapshot.lastResponseCostUsd.toFixed(5), '0.01002')
  assert.equal(snapshot.totalCostUsd.toFixed(5), '0.01002')
})

test('supports plural token detail field names and accumulates responses', () => {
  const tracker = new VoiceTelemetryTracker('gpt-realtime-2.1-mini')
  const event = {
    type: 'response.done', response: { usage: {
      input_tokens: 1_000,
      input_tokens_details: { text_tokens: 1_000, cached_tokens: 600, cached_tokens_details: { text_tokens: 600 } },
      output_tokens: 100,
      output_tokens_details: { text_tokens: 100 },
    } },
  }
  tracker.consume(event, 10)
  const snapshot = tracker.consume(event, 20)
  assert.ok(snapshot)
  assert.equal(snapshot.responses, 2)
  assert.equal(snapshot.cacheHitPercent, 60)
  assert.ok(snapshot.totalCostUsd > snapshot.lastResponseCostUsd)
})

test('ignores malformed usage without producing negative costs', () => {
  const tracker = new VoiceTelemetryTracker('gpt-realtime-2.1-mini')
  const snapshot = tracker.consume({
    type: 'response.done', response: { usage: {
      input_tokens: -10,
      input_token_details: { text_tokens: 10, cached_tokens: 100, cached_tokens_details: { text_tokens: 100 } },
      output_tokens: Number.NaN,
    } },
  }, 10)
  assert.ok(snapshot)
  assert.equal(snapshot.totalCostUsd >= 0, true)
  assert.equal(snapshot.cacheHitPercent, 0)
})
