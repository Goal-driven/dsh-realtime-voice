import assert from 'node:assert/strict'
import test from 'node:test'
import { parseToolCall, sessionUpdate, toolOutput } from '../src/client/protocol.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'

const base: VoicePrefs = {
  provider: 'openai',
  qwenWorkspaceId: 'ws_123',
  qwenRegion: 'cn-beijing',
  qwenModel: 'qwen3.5-omni-plus-realtime',
  qwenVoice: 'Tina',
  qwenAsrModel: 'qwen3-asr-flash-realtime',
  qwenTtsModel: 'qwen3-tts-flash-realtime',
  qwenTtsVoice: 'Chelsie',
  qwenVadThreshold: 0.85,
  qwenSilenceMs: 700,
  qwenMergeMs: 900,
  voiceDraftAutoSend: true,
  voiceDraftDwellMs: 1800,
  voiceDraftAllowWithoutVoiceprint: false,
  voiceDraftSensitiveDeny: true,
  floorDelayMs: 800,
  floorComposerEnabled: true,
  qwenFloorModel: 'qwen3.5-flash',
  openaiFloorModel: 'gpt-5-mini',
  voiceprintEnabled: false,
  voiceprintThreshold: 75,
  openaiModel: 'gpt-realtime-2.1-mini',
  openaiVoice: 'marin',
  instructions: 'test',
}

test('OpenAI and Qwen expose only the mandatory Harness delegate', () => {
  const openai = sessionUpdate(base) as { session: { tools: Array<{ name: string }> } }
  const qwen = sessionUpdate({ ...base, provider: 'qwen' }) as { session: { tools: Array<{ function: { name: string } }> } }
  assert.deepEqual(openai.session.tools.map(tool => tool.name), ['delegate_to_harness'])
  assert.deepEqual(qwen.session.tools.map(tool => tool.function.name), ['delegate_to_harness'])
})

test('OpenAI forces the only Harness tool instead of relying on model choice', () => {
  const openai = sessionUpdate(base) as { session: { tool_choice: string; audio: { input: { turn_detection: { eagerness: string } } } } }
  assert.equal(openai.session.tool_choice, 'required')
  assert.equal(openai.session.audio.input.turn_detection.eagerness, 'high')
})

test('both providers receive the Harness-first policy', () => {
  const openai = sessionUpdate(base) as { session: { instructions: string; truncation: unknown } }
  const qwen = sessionUpdate({ ...base, provider: 'qwen' }) as { session: { instructions: string; input_audio_transcription: { model: string; language: string } } }
  assert.match(openai.session.instructions, /varje giltigt yttrande/i)
  assert.match(qwen.session.instructions, /delegate_to_harness/)
  assert.deepEqual(openai.session.truncation, {
    type: 'retention_ratio',
    retention_ratio: 0.8,
    token_limits: { post_instructions: 96_000 },
  })
  assert.deepEqual(qwen.session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime', language: 'zh' })
})

test('parses function calls from both supported event envelopes', () => {
  const item = { type: 'function_call', call_id: 'call-1', name: 'delegate_to_harness', arguments: '{"task":"x"}' }
  assert.deepEqual(parseToolCall({ type: 'response.output_item.done', item }), {
    callId: 'call-1', name: 'delegate_to_harness', arguments: '{"task":"x"}',
  })
  assert.equal(parseToolCall({ type: 'conversation.item.created', item: { ...item, name: 'unknown' } }), undefined)
  assert.deepEqual(parseToolCall({ type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'cancel_harness_task', arguments: '{}' }), {
    callId: 'call-2', name: 'cancel_harness_task', arguments: '{}',
  })
})

test('tool output resumes with audio and disables the mandatory tool for the spoken answer', () => {
  const events = toolOutput('call-1', { ok: true, text: 'done' })
  assert.equal(events[0]?.type, 'conversation.item.create')
  assert.equal((events[0]?.item as { output?: string }).output, 'done')
  assert.deepEqual(events[1], {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      tool_choice: 'none',
    },
  })
})

test('tool output turns Harness failures into speakable text', () => {
  const events = toolOutput('call-1', { ok: false, error: 'offline' })
  assert.equal((events[0]?.item as { output?: string }).output, 'Harness kunde inte slutföra uppgiften: offline')
})

test('a result already streamed as speech closes the tool call without speaking twice', () => {
  const events = toolOutput('call-1', { ok: true, text: 'Redan uppläst.', voiceAlreadySpoken: true })
  assert.equal(events.length, 1)
  assert.equal((events[0]?.item as { output?: string }).output, 'Redan uppläst.')
})
