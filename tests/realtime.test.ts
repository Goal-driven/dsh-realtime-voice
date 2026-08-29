import assert from 'node:assert/strict'
import test from 'node:test'
import { attachLiveMicrophone, RealtimeConnection, RealtimeEchoGuard } from '../src/client/realtime.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'

test('the assistant voice cannot return as a new Swedish Harness task', () => {
  const guard = new RealtimeEchoGuard()
  const answer = 'Självklart! Berätta vad du vill prata om — en kodfråga, något du vill bygga, eller något annat?'
  guard.recordSpeech(answer, 1_000)

  assert.equal(guard.shouldSuppress('Användarens meddelande: "Självklart! Berätta vad du vill prata om — en kodfråga, något du vill bygga, eller något annat?"', 1_800), true)
  assert.equal(guard.shouldSuppress('Kan du i stället öppna min Kanban-tavla?', 1_800), false)
  assert.equal(guard.shouldSuppress('Berätta vad du vill prata om', 1_800), false)
  assert.equal(guard.shouldSuppress('Kod', 1_800), false)
  assert.equal(guard.shouldSuppress('Stopp', 1_800), false)
  assert.equal(guard.shouldSuppress(answer, 20_000), false)
  assert.equal(guard.shouldSuppress(answer, 4_000), false)
})

test('OpenAI sends exact Swedish transcripts to Harness and preserves busy-turn provenance', async () => {
  const transcripts: Array<{ text: string; busy?: boolean }> = []
  let delegatedToolCalls = 0
  const states: Array<{ state: string; detail?: string }> = []
  const connection = new RealtimeConnection(prefs(), {
    onState(state, detail) { states.push({ state, detail }) },
    async onToolCall() { delegatedToolCalls++; return {} },
    async onTranscript(text, meta) { transcripts.push({ text, busy: meta?.capturedWhileBusy }) },
  })
  const internals = connection as unknown as { handleEvent(raw: unknown): Promise<void> }

  await internals.handleEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'idle-1' }))
  await internals.handleEvent(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'idle-1' }))
  await internals.handleEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'idle-1',
    transcript: 'Test ett två tre.',
  }))

  connection.setInputPhase('harness')
  await internals.handleEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'busy-1' }))
  await internals.handleEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'busy-1',
    transcript: 'Och fortsätt med nästa sak.',
  }))

  assert.deepEqual(transcripts, [
    { text: 'Test ett två tre.', busy: false },
    { text: 'Och fortsätt med nästa sak.', busy: true },
  ])
  assert.equal(delegatedToolCalls, 0)
  assert.equal(states.some(value => value.detail === 'Tal upptäckt'), true)
  assert.equal(states.some(value => value.detail === 'Bearbetar svenskt tal'), true)
})

test('OpenAI treats speech that starts after playback as a new voice turn', async () => {
  const transcripts: Array<{ text: string; busy?: boolean }> = []
  const connection = new RealtimeConnection(prefs(), {
    onState() {},
    async onToolCall() {},
    async onTranscript(text, meta) { transcripts.push({ text, busy: meta?.capturedWhileBusy }) },
  })
  const internals = connection as unknown as { handleEvent(raw: unknown): Promise<void> }

  connection.setInputPhase('post-playback')
  await internals.handleEvent(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'follow-up' }))
  connection.setInputPhase('listening')
  await internals.handleEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'follow-up',
    transcript: 'Det här är fråga två.',
  }))

  assert.deepEqual(transcripts, [{ text: 'Det här är fråga två.', busy: false }])
})

test('OpenAI reports transcription failures instead of listening forever', async () => {
  const states: Array<{ state: string; detail?: string }> = []
  const connection = new RealtimeConnection(prefs(), {
    onState(state, detail) { states.push({ state, detail }) },
    async onToolCall() {},
  })
  const internals = connection as unknown as { handleEvent(raw: unknown): Promise<void> }

  await internals.handleEvent(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'failed-1',
    error: { message: 'transcription unavailable' },
  }))

  assert.deepEqual(states.at(-1), {
    state: 'error',
    detail: 'Svensk taligenkänning misslyckades: transcription unavailable',
  })
})

test('the microphone stays attached while the initial WebRTC offer is negotiated', () => {
  const track = {} as MediaStreamTrack
  const stream = {} as MediaStream
  let replaceCalls = 0
  const sender = {
    async replaceTrack() { replaceCalls++ },
  } as unknown as RTCRtpSender
  const peer = {
    addTrack(value: MediaStreamTrack, source: MediaStream) {
      assert.equal(value, track)
      assert.equal(source, stream)
      return sender
    },
  } as unknown as RTCPeerConnection

  assert.equal(attachLiveMicrophone(peer, track, stream), sender)
  assert.equal(replaceCalls, 0)
})

test('out-of-band OpenAI speech reads streamed Harness text without polluting the conversation', async () => {
  const sent: Array<Record<string, unknown>> = []
  const connection = new RealtimeConnection(prefs(), { onState() {}, async onToolCall() {} })
  const internals = connection as unknown as {
    channel: { readyState: string; send(raw: string): void }
    audioSender: { replaceTrack(track: MediaStreamTrack | null): Promise<void> }
    microphoneTrack: MediaStreamTrack
    handleEvent(raw: unknown): Promise<void>
  }
  const microphoneTrack = {} as MediaStreamTrack
  const replacements: Array<MediaStreamTrack | null> = []
  internals.channel = {
    readyState: 'open',
    send(raw) { sent.push(JSON.parse(raw) as Record<string, unknown>) },
  }
  internals.microphoneTrack = microphoneTrack
  internals.audioSender = { replaceTrack: async track => { replacements.push(track) } }

  const speaking = connection.speak('Jag är här och lyssnar.')
  await Promise.resolve()
  const response = sent[0]?.response as Record<string, unknown>
  assert.equal(sent[0]?.type, 'response.create')
  assert.equal(response.conversation, 'none')
  assert.deepEqual(response.output_modalities, ['audio'])
  assert.equal(response.tool_choice, 'none')
  assert.match(String(response.instructions), /Jag är här och lyssnar/)

  await internals.handleEvent(JSON.stringify({ type: 'session.updated' }))
  assert.deepEqual(replacements, [null])

  await internals.handleEvent(JSON.stringify({
    type: 'response.done',
    response: { metadata: response.metadata, status: 'completed' },
  }))
  await internals.handleEvent(JSON.stringify({ type: 'session.updated' }))
  assert.deepEqual(replacements, [null])
  await speaking
  assert.deepEqual(replacements, [null, microphoneTrack])
})

test('OpenAI speech restores the microphone when the data channel closes during muting', async () => {
  let readyState = 'open'
  const connection = new RealtimeConnection(prefs(), { onState() {}, async onToolCall() {} })
  const microphoneTrack = {} as MediaStreamTrack
  const replacements: Array<MediaStreamTrack | null> = []
  const internals = connection as unknown as {
    channel: { readonly readyState: string; send(raw: string): void }
    audioSender: { replaceTrack(track: MediaStreamTrack | null): Promise<void> }
    microphoneTrack: MediaStreamTrack
  }
  internals.channel = {
    get readyState() { return readyState },
    send() {},
  }
  internals.microphoneTrack = microphoneTrack
  internals.audioSender = {
    replaceTrack: async track => {
      replacements.push(track)
      if (track === null) readyState = 'closed'
    },
  }

  await assert.rejects(
    Promise.race([
      connection.speak('Det här ska inte fastna.'),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), 50)),
    ]),
    /stängd|ansluten/,
  )
  assert.deepEqual(replacements, [null, microphoneTrack])
})

test('a failed OOB response rejects cleanly and restores the microphone', async () => {
  const sent: Array<Record<string, unknown>> = []
  const connection = new RealtimeConnection(prefs(), { onState() {}, async onToolCall() {} })
  const microphoneTrack = {} as MediaStreamTrack
  const replacements: Array<MediaStreamTrack | null> = []
  const internals = connection as unknown as {
    channel: { readyState: string; send(raw: string): void }
    audioSender: { replaceTrack(track: MediaStreamTrack | null): Promise<void> }
    microphoneTrack: MediaStreamTrack
    handleEvent(raw: unknown): Promise<void>
  }
  internals.channel = { readyState: 'open', send(raw) { sent.push(JSON.parse(raw) as Record<string, unknown>) } }
  internals.microphoneTrack = microphoneTrack
  internals.audioSender = { replaceTrack: async track => { replacements.push(track) } }

  const speaking = connection.speak('Det här misslyckas.')
  await Promise.resolve()
  const metadata = (sent[0]?.response as { metadata: Record<string, unknown> }).metadata
  await internals.handleEvent(JSON.stringify({ type: 'response.done', response: { metadata, status: 'failed' } }))

  await assert.rejects(speaking, /failed/)
  assert.deepEqual(replacements, [null, microphoneTrack])
})

test('a cancelled OOB response is cancelled again when its delayed response id arrives', async () => {
  const sent: Array<Record<string, unknown>> = []
  const connection = new RealtimeConnection(prefs(), { onState() {}, async onToolCall() {} })
  const internals = connection as unknown as {
    channel: { readyState: string; send(raw: string): void }
    audioSender: { replaceTrack(track: MediaStreamTrack | null): Promise<void> }
    microphoneTrack: MediaStreamTrack
    handleEvent(raw: unknown): Promise<void>
  }
  internals.channel = { readyState: 'open', send(raw) { sent.push(JSON.parse(raw) as Record<string, unknown>) } }
  internals.microphoneTrack = {} as MediaStreamTrack
  internals.audioSender = { replaceTrack: async () => {} }

  const speaking = connection.speak('Gammalt svar.')
  await Promise.resolve()
  const metadata = (sent[0]?.response as { metadata: Record<string, unknown> }).metadata
  connection.cancelSpeech()
  await assert.rejects(speaking, /avbröts/)
  await internals.handleEvent(JSON.stringify({ type: 'response.created', response: { id: 'late-response', metadata } }))

  assert.equal(sent.some(event => event.type === 'response.cancel' && event.response_id === 'late-response'), true)
})

test('a detected speaker echo is closed locally and never delegated to Harness', async () => {
  const sent: Array<Record<string, unknown>> = []
  let delegated = 0
  const connection = new RealtimeConnection(prefs(), {
    onState() {},
    async onToolCall() { delegated++; return { ok: true, text: 'should not run' } },
  })
  const internals = connection as unknown as {
    channel: { readyState: string; send(raw: string): void }
    echoGuard: RealtimeEchoGuard
    handleEvent(raw: unknown): Promise<void>
  }
  internals.channel = {
    readyState: 'open',
    send(raw) { sent.push(JSON.parse(raw) as Record<string, unknown>) },
  }
  internals.echoGuard.recordSpeech('Självklart, vad vill du prata om?')

  await internals.handleEvent(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'echo-call',
    name: 'delegate_to_harness',
    arguments: '{"task":"Självklart, vad vill du prata om?"}',
  }))

  assert.equal(delegated, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.type, 'conversation.item.create')
  assert.match(JSON.stringify(sent[0]), /Själveko/)
})

function prefs(): VoicePrefs {
  return {
    provider: 'openai',
    qwenWorkspaceId: '',
    qwenRegion: 'cn-beijing',
    qwenModel: 'qwen3.5-omni-plus-realtime',
    qwenVoice: 'Tina',
    qwenAsrModel: 'qwen3-asr-flash-realtime',
    qwenTtsModel: 'qwen3-tts-flash-realtime',
    qwenTtsVoice: 'Chelsie',
    qwenVadThreshold: 0.85,
    qwenSilenceMs: 700,
    qwenMergeMs: 1200,
    voiceDraftAutoSend: true,
    voiceDraftDwellMs: 1800,
    voiceDraftAllowWithoutVoiceprint: false,
    voiceDraftSensitiveDeny: true,
    floorDelayMs: 800,
    floorComposerEnabled: false,
    qwenFloorModel: 'qwen3.5-flash',
    openaiFloorModel: 'gpt-5-mini',
    voiceprintEnabled: false,
    voiceprintThreshold: 75,
    openaiModel: 'gpt-realtime-2.1-mini',
    openaiVoice: 'marin',
    instructions: 'Tala svenska.',
  }
}
