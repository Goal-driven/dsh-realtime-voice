import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from '../src/host/security.ts'
import { normalizeSdp, openAiInitialSession, parseSignalRequest, qwenEndpoint } from '../src/host/signaling.ts'

test('normalizes SDP and builds allowlisted Qwen endpoint', () => {
  const request = parseSignalRequest({
    sdp: 'v=0\no=- 1 1 IN IP4 127.0.0.1\n',
    workspaceId: 'ws_12345',
    region: 'cn-beijing',
  }, 'qwen')
  assert.equal(request.sdp, 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n')
  assert.equal(qwenEndpoint(request), 'https://ws_12345.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime')
})

test('uses the official Singapore workspace domain', () => {
  const request = parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'ws_12345', region: 'ap-southeast-1' }, 'qwen')
  assert.equal(qwenEndpoint(request), 'https://ws_12345.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime')
})

test('rejects endpoint injection and oversized provider fields', () => {
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'bad.example.com/' }, 'qwen'), HttpError)
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', workspaceId: 'valid_id', region: 'evil' }, 'qwen'), HttpError)
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', model: 'x'.repeat(129) }, 'openai'), HttpError)
  assert.throws(() => parseSignalRequest({ sdp: 'v=0\nlong-enough', model: 'gpt-realtime-2.1' }, 'openai'), HttpError)
  assert.equal(parseSignalRequest({ sdp: 'v=0\nlong-enough', model: 'gpt-realtime-2.1-mini' }, 'openai').model, 'gpt-realtime-2.1-mini')
})

test('normalizeSdp is idempotent', () => {
  const once = normalizeSdp('v=0\r\na=1\r\n')
  assert.equal(normalizeSdp(once), once)
})

test('OpenAI starts with Swedish ASR and manual Harness turn control', () => {
  const session = openAiInitialSession({
    provider: 'openai',
    sdp: 'v=0\r\nlong-enough\r\n',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    instructions: 'Tala svenska.',
  }) as {
    model: string
    audio: { input: { transcription: { model: string; language: string }; turn_detection: { create_response: boolean; interrupt_response: boolean } } }
  }

  assert.equal(session.model, 'gpt-realtime-2.1-mini')
  assert.deepEqual(session.audio.input.transcription, {
    model: 'gpt-4o-mini-transcribe',
    language: 'sv',
    prompt: 'Svenskt samtal. Bevara namn, produktnamn och tekniska termer ordagrant.',
  })
  assert.equal(session.audio.input.turn_detection.create_response, false)
  assert.equal(session.audio.input.turn_detection.interrupt_response, false)
})
