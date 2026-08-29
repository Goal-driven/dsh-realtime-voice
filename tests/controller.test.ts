import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceController, type VoiceConnection, type VoiceConnectionFactory } from '../src/client/controller.ts'
import type { HarnessBridge } from '../src/client/harness-delegate.ts'
import type { RealtimeCallbacks } from '../src/client/realtime.ts'
import { updatePrefs } from '../src/client/prefs.ts'
import { MIN_FLOOR_DELAY_MS } from '../src/floor-policy.ts'

function installBrowserStubs(): void {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '', href: 'http://127.0.0.1/' } })
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
}

test('stop during connection prevents a late failure from replacing idle state', async () => {
  installBrowserStubs()
  let rejectConnect!: (error: Error) => void
  let disconnects = 0
  const connection: VoiceConnection = {
    connect: async () => await new Promise<void>((_resolve, reject) => { rejectConnect = reject }),
    disconnect: () => { disconnects++ },
  }
  const factory: VoiceConnectionFactory = () => connection
  const bridge = {} as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  const connecting = controller.toggle()
  controller.stop()
  rejectConnect(new Error('late failure'))
  await connecting
  assert.equal(controller.getSnapshot().state, 'idle')
  assert.equal(disconnects >= 1, true)
})

test('background transcript does not abort an active Harness turn', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveDelegate!: (value: { ok: true; text: string }) => void
  let delegated = 0
  let activeSignal!: AbortSignal
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => {},
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async (_sessionId: string, _task: string, signal: AbortSignal) => {
      delegated++
      activeSignal = signal
      return await new Promise<{ ok: true; text: string }>(resolve => { resolveDelegate = resolve })
    },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('查询上海天气')
  await delay(130)
  await callbacks.onTranscript?.('旁边的人在说话')
  await delay(130)
  assert.equal(delegated, 1)
  assert.equal(activeSignal.aborted, false)
  assert.equal(draft, '旁边的人在说话')
  resolveDelegate({ ok: true, text: '天气晴朗' })
  await delay(450)
  assert.equal(controller.getSnapshot().state, 'listening')
  await callbacks.onTranscript?.('今晚就这样吧')
  await delay(130)
  assert.equal(delegated, 1)
  assert.equal(draft, '旁边的人在说话\n今晚就这样吧')
})

test('an existing native draft absorbs later listening transcripts until the user clears it', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let delegated = 0
  let draft = '或者说明天能去哪里玩呢？'
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegated++
      return { ok: true as const, text: '不应该执行' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('可以了，今晚就这样')
  await delay(130)
  assert.equal(delegated, 0)
  assert.equal(draft, '或者说明天能去哪里玩呢？\n可以了，今晚就这样')
  draft = ''
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await callbacks.onTranscript?.('这是清空后的新问题')
  await delay(130)
  assert.equal(delegated, 1)
})

test('Qwen composer mode auto-submits an idle utterance, stages busy speech, and speaks only the summary', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'qwen', qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let submits = 0
  const submitted: string[] = []
  let delegates = 0
  const spoken: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => { spoken.push(text) },
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => { delegates++; return { ok: true as const, text: '不应执行' } },
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({
    getDraft: () => draft,
    setDraft: value => { draft = value },
    submit: () => {
      submits++
      submitted.push(draft)
      draft = ''
      observer.onTurnStart('native-turn')
    },
  })
  await controller.toggle()
  await callbacks.onTranscript?.('太好了。')
  await delay(35)
  await callbacks.onTranscript?.('已经调试成功了。')
  await delay(130)
  assert.equal(delegates, 0)
  assert.equal(submits, 1)
  assert.deepEqual(submitted, ['太好了。\n已经调试成功了。'])
  assert.equal(draft, '')

  await callbacks.onTranscript?.('推理期间说的下一轮内容。', { capturedWhileBusy: true })
  await delay(130)
  assert.equal(submits, 1)
  assert.equal(draft, '推理期间说的下一轮内容。')

  observer.onTextDelta('native-turn', '<!-- voice-summary -->已经成功了。<!--')
  observer.onTextDelta('native-turn', ' /')
  observer.onTextDelta('native-turn', 'voice')
  observer.onTextDelta('native-turn', '-summary -->详细结果')
  observer.onTurnEnd('native-turn', { ok: true, text: '<!-- voice-summary -->已经成功了。<!-- /voice-summary -->详细结果' })
  await delay(450)
  assert.deepEqual(spoken, ['已经成功了。'])
  controller.stop()
})

test('native slow turn speaks one floor cue then the first answer paragraph', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'qwen', qwenMergeMs: 100, floorDelayMs: 400, floorComposerEnabled: false })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  const spoken: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => { spoken.push(text) },
  }
  const bridge = {
    delegate: async () => ({ ok: true as const, text: 'unused' }),
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({
    getDraft: () => draft,
    setDraft: value => { draft = value },
    submit: () => { draft = ''; observer.onTurnStart('slow-turn') },
  })
  await controller.toggle()
  await callbacks.onTranscript?.('分析一下这个训练计划')
  await delay(130)
  await delay(MIN_FLOOR_DELAY_MS + 30)
  observer.onTextDelta('slow-turn', '这个计划可以继续，但要调整动作顺序。\n\n以下是详细安排。')
  observer.onTurnEnd('slow-turn', { ok: true, text: '这个计划可以继续，但要调整动作顺序。\n\n以下是详细安排。' })
  await delay(450)
  assert.equal(spoken.length, 2)
  assert.match(spoken[0] ?? '', /训练计划|重点|理一理/)
  assert.equal(spoken[1], '这个计划可以继续，但要调整动作顺序。')
  controller.stop()
})

test('a short dialogue response never starts with a working cue', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'qwen', qwenMergeMs: 100, floorDelayMs: 400 })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  const spoken: string[] = []
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async text => { spoken.push(text) } }
  const bridge = {
    delegate: async () => ({ ok: true as const, text: 'unused' }),
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({
    getDraft: () => draft,
    setDraft: value => { draft = value },
    submit: () => { draft = ''; observer.onTurnStart('fast-turn') },
  })
  await controller.toggle()
  await callbacks.onTranscript?.('你好')
  await delay(130)
  await delay(800)
  observer.onTextDelta('fast-turn', '你好，很高兴见到你。')
  observer.onTurnEnd('fast-turn', { ok: true, text: '你好，很高兴见到你。' })
  await delay(450)
  assert.deepEqual(spoken, ['你好，很高兴见到你。'])
  controller.stop()
})

test('a busy transcript stays in the draft even when Harness completes before endpoint grace', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveDelegate!: (value: { ok: true; text: string }) => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return await new Promise<{ ok: true; text: string }>(resolve => { resolveDelegate = resolve })
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(130)
  await callbacks.onTranscript?.('完成后继续检查测试')
  resolveDelegate({ ok: true, text: '完成' })
  await delay(550)
  assert.equal(delegates, 1)
  assert.equal(draft, '完成后继续检查测试')
})

test('a late ASR final keeps the busy provenance from its speech-start event', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '已完成' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(550)
  assert.equal(controller.getSnapshot().state, 'listening')
  await callbacks.onTranscript?.('语音开始时其实仍在忙', { capturedWhileBusy: true })
  await delay(130)
  assert.equal(delegates, 1)
  assert.equal(draft, '语音开始时其实仍在忙')
})

test('speech captured during TTS is staged and never starts a second Harness turn', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let rejectSpeech!: (error: Error) => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => await new Promise<void>((_resolve, reject) => { rejectSpeech = reject }),
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '<!--voice-summary-->第一轮回答。<!--/voice-summary-->详细内容' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮问题')
  await delay(130)
  callbacks.onState('speaking')
  await callbacks.onTranscript?.('这是打断后准备发送的话')
  rejectSpeech(new Error('语音播放已被用户打断'))
  await delay(550)
  assert.equal(delegates, 1)
  assert.equal(draft, '这是打断后准备发送的话')
  assert.equal(controller.getSnapshot().state, 'listening')
})

test('short ASR finals merge into one Harness paragraph', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  const tasks: string[] = []
  const voiceContextFlags: boolean[] = []
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {} }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async (_sessionId: string, task: string, _signal: AbortSignal, options: { voiceOutputContract?: boolean }) => {
      tasks.push(task)
      voiceContextFlags.push(options.voiceOutputContract === true)
      return { ok: true as const, text: '收到' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  await controller.toggle()
  await callbacks.onTranscript?.('这是第一小句')
  await delay(35)
  await callbacks.onTranscript?.('这是接着说的第二小句')
  await delay(130)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0], '这是第一小句\n这是接着说的第二小句')
  assert.doesNotMatch(tasks[0] ?? '', /voice-summary|dsh-realtime-voice/)
  assert.deepEqual(voiceContextFlags, [true])
})

test('OpenAI tool turns stream the first summary sentence and mark the final result as already spoken', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'openai', floorDelayMs: 400, floorComposerEnabled: false })
  let callbacks!: RealtimeCallbacks
  let voiceOutputContract = false
  const spoken: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => { spoken.push(text) },
    waitForSpeechIdle: async () => {},
  }
  const bridge = {
    delegate: async (_sessionId: string, _task: string, _signal: AbortSignal, options: {
      voiceOutputContract?: boolean
      onTextDelta?(delta: string): void
    }) => {
      voiceOutputContract = options.voiceOutputContract === true
      options.onTextDelta?.('<!-- voice-summary -->Ja, jag hör dig nu.<!-- /voice-summary -->Detaljer följer.')
      return { ok: true as const, text: '<!-- voice-summary -->Ja, jag hör dig nu.<!-- /voice-summary -->Detaljer följer.' }
    },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  await controller.toggle()

  const result = await callbacks.onToolCall({ callId: 'call-1', name: 'delegate_to_harness', arguments: '{"task":"Är du där?"}' }) as {
    ok: boolean
    text: string
    voiceAlreadySpoken?: boolean
  }

  assert.equal(voiceOutputContract, true)
  assert.deepEqual(spoken, ['Ja, jag hör dig nu.'])
  assert.equal(result.voiceAlreadySpoken, true)
})

test('OpenAI slow tool turns acknowledge the wait in Swedish before Harness finishes', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'openai', floorDelayMs: 400, floorComposerEnabled: false })
  let callbacks!: RealtimeCallbacks
  let delegateCallbacks!: { onTextDelta?(delta: string): void }
  let resolveDelegate!: (value: { ok: true; text: string }) => void
  const spoken: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => { spoken.push(text) },
    waitForSpeechIdle: async () => {},
  }
  const bridge = {
    delegate: async (_sessionId: string, _task: string, _signal: AbortSignal, options: { onTextDelta?(delta: string): void }) => {
      delegateCallbacks = options
      return await new Promise<{ ok: true; text: string }>(resolve => { resolveDelegate = resolve })
    },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  await controller.toggle()

  const toolTurn = callbacks.onToolCall({ callId: 'call-2', name: 'delegate_to_harness', arguments: '{"task":"Kontrollera driftsättningen"}' })
  await delay(MIN_FLOOR_DELAY_MS + 30)
  assert.deepEqual(spoken, ['Jag arbetar på det.'])

  delegateCallbacks.onTextDelta?.('Driftsättningen är nu kontrollerad.')
  resolveDelegate({ ok: true, text: 'Driftsättningen är nu kontrollerad.' })
  const result = await toolTurn as { voiceAlreadySpoken?: boolean }
  assert.deepEqual(spoken, ['Jag arbetar på det.', 'Driftsättningen är nu kontrollerad.'])
  assert.equal(result.voiceAlreadySpoken, true)
})

test('OpenAI keeps an already completed answer marked when the earlier wait cue failed', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'openai', floorDelayMs: 400, floorComposerEnabled: false })
  let callbacks!: RealtimeCallbacks
  const spoken: string[] = []
  let cueAttempts = 0
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async text => {
      if (text === 'Jag arbetar på det.') { cueAttempts++; throw new Error('cue failed') }
      spoken.push(text)
    },
    waitForSpeechIdle: async () => {},
  }
  const bridge = {
    delegate: async (_sessionId: string, _task: string, _signal: AbortSignal, options: { onTextDelta?(delta: string): void }) => {
      await delay(MIN_FLOOR_DELAY_MS + 30)
      options.onTextDelta?.('Svaret är klart.')
      return { ok: true as const, text: 'Svaret är klart.' }
    },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  await controller.toggle()

  const result = await callbacks.onToolCall({ callId: 'call-3', name: 'delegate_to_harness', arguments: '{"task":"Kontrollera"}' }) as {
    voiceAlreadySpoken?: boolean
  }

  assert.deepEqual(spoken, ['Svaret är klart.'])
  assert.equal(cueAttempts, 1)
  assert.equal(result.voiceAlreadySpoken, true)
})

test('OpenAI delegate rejection disposes its Swedish wait cue', async () => {
  installBrowserStubs()
  updatePrefs({ provider: 'openai', floorDelayMs: 20, floorComposerEnabled: false })
  let callbacks!: RealtimeCallbacks
  const spoken: string[] = []
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async text => { spoken.push(text) } }
  const bridge = {
    delegate: async () => { throw new Error('delegate offline') },
    cancel: async () => false,
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  await controller.toggle()

  const result = await callbacks.onToolCall({ callId: 'call-4', name: 'delegate_to_harness', arguments: '{"task":"Kontrollera"}' }) as { ok: boolean; error: string }
  await delay(80)

  assert.equal(result.ok, false)
  assert.match(result.error, /offline/)
  assert.deepEqual(spoken, [])
})

test('a transcript arriving before TTS starts cannot preempt the pending reply', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100 })
  let callbacks!: RealtimeCallbacks
  let resolveSpeech!: () => void
  let delegates = 0
  let draft = ''
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => await new Promise<void>(resolve => { resolveSpeech = resolve }),
  }
  const factory: VoiceConnectionFactory = (_prefs, value) => { callbacks = value; return connection }
  const bridge = {
    delegate: async () => {
      delegates++
      return { ok: true as const, text: '<!--voice-summary-->第一轮结果。<!--/voice-summary-->详细结果' }
    },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, factory)
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value } })
  await controller.toggle()
  await callbacks.onTranscript?.('第一轮')
  await delay(130)
  await callbacks.onTranscript?.('播放前的背景短句')
  await delay(130)
  assert.equal(delegates, 1)
  assert.equal(draft, '播放前的背景短句')
  resolveSpeech()
  await delay(0)
})

test('busy ASR draft auto-submits once only after playback and dwell', async () => {
  installBrowserStubs()
  updatePrefs({
    provider: 'qwen',
    qwenMergeMs: 100,
    voiceDraftAutoSend: true,
    voiceDraftDwellMs: 500,
    voiceDraftAllowWithoutVoiceprint: true,
    voiceDraftSensitiveDeny: true,
  })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  const submitted: string[] = []
  const connection: VoiceConnection = {
    connect: async () => {},
    disconnect: () => {},
    speak: async () => {},
    waitForSpeechIdle: async () => {},
  }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({
    getDraft: () => draft,
    setDraft: value => { draft = value },
    submit: () => { submitted.push(draft); draft = '' },
  })
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('明天能去哪里玩？', { capturedWhileBusy: true })
  await delay(130)
  assert.equal(draft, '明天能去哪里玩？')
  observer.onTextDelta('busy-turn', '夜宵推荐已经整理好了。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '夜宵推荐已经整理好了。' })
  await delay(900)
  assert.deepEqual(submitted, [])
  await delay(500)
  assert.deepEqual(submitted, ['明天能去哪里玩？'])
  controller.stop()
})

test('new speech during draft dwell merges the whole utterance and restarts the timer', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100, voiceDraftAutoSend: true, voiceDraftDwellMs: 500, voiceDraftAllowWithoutVoiceprint: true })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  const submitted: string[] = []
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {}, waitForSpeechIdle: async () => {} }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value }, submit: () => { submitted.push(draft); draft = '' } })
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('明天能去哪里玩？', { capturedWhileBusy: true })
  await delay(130)
  observer.onTextDelta('busy-turn', '第一轮完成。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '第一轮完成。' })
  await delay(650)
  callbacks.onSpeechStart?.()
  await delay(250)
  assert.deepEqual(submitted, [])
  callbacks.onSpeechEnd?.()
  await callbacks.onTranscript?.('可以了，今晚就这样。')
  await delay(130)
  assert.equal(draft, '明天能去哪里玩？\n可以了，今晚就这样。')
  await delay(700)
  assert.deepEqual(submitted, [])
  await delay(300)
  assert.deepEqual(submitted, ['明天能去哪里玩？\n可以了，今晚就这样。'])
  controller.stop()
})

test('a user draft revision revokes the ASR lease even when text ends unchanged', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100, voiceDraftAutoSend: true, voiceDraftDwellMs: 500, voiceDraftAllowWithoutVoiceprint: true })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let draftRev = 0
  let submits = 0
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {}, waitForSpeechIdle: async () => {} }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  const bind = () => controller.bindDraft({
    getDraft: () => draft,
    getDraftRev: () => draftRev,
    getPhase: () => 'plain',
    setDraft: value => { draft = value; draftRev++ },
    submit: () => { submits++; draft = ''; draftRev++ },
  })
  bind()
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('原始语音', { capturedWhileBusy: true })
  await delay(130)
  bind()
  observer.onTextDelta('busy-turn', '完成。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '完成。' })
  await delay(500)
  // Simulate typing and undoing back to byte-identical text. draftRev still
  // proves that the user touched the composer, so auto-send must be revoked.
  draftRev++
  bind()
  await delay(650)
  assert.equal(submits, 0)
  assert.equal(draft, '原始语音')
  controller.stop()
})

test('voiceprint failures and sensitive drafts stay manual', async () => {
  installBrowserStubs()
  updatePrefs({
    qwenMergeMs: 100,
    voiceDraftAutoSend: true,
    voiceDraftDwellMs: 500,
    voiceDraftAllowWithoutVoiceprint: true,
    voiceDraftSensitiveDeny: true,
  })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let submits = 0
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {}, waitForSpeechIdle: async () => {} }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value }, submit: () => { submits++; draft = '' } })
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('旁边的人说的内容', { capturedWhileBusy: true, voiceprint: 'rejected' })
  await delay(130)
  observer.onTextDelta('busy-turn', '完成。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '完成。' })
  await delay(1100)
  assert.equal(submits, 0)
  draft = ''
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value }, submit: () => { submits++; draft = '' } })
  observer.onTurnStart('busy-turn-2')
  await callbacks.onTranscript?.('帮我付款一百元', { capturedWhileBusy: true })
  await delay(130)
  observer.onTextDelta('busy-turn-2', '完成。')
  observer.onTurnEnd('busy-turn-2', { ok: true, text: '完成。' })
  await delay(1100)
  assert.equal(submits, 0)
  assert.equal(draft, '帮我付款一百元')
  controller.stop()
})

test('speech activity cancels commit, never cuts a long phrase, and filler safely resumes after speech end', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100, voiceDraftAutoSend: true, voiceDraftDwellMs: 500, voiceDraftAllowWithoutVoiceprint: true })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let submits = 0
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {}, waitForSpeechIdle: async () => {} }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value }, submit: () => { submits++; draft = '' } })
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('保留这一句', { capturedWhileBusy: true })
  await delay(130)
  observer.onTextDelta('busy-turn', '完成。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '完成。' })
  await delay(950)
  assert.match(controller.getSnapshot().detail, /skickas snart/)
  callbacks.onSpeechStart?.()
  assert.match(controller.getSnapshot().detail, /väntar på att sammanfoga/i)
  await delay(2000)
  assert.equal(submits, 0)
  // Only speech_stopped may resume. No actionable final follows (for example
  // a cough), so the old lease resumes without cutting a long phrase.
  callbacks.onSpeechEnd?.()
  await delay(1600)
  assert.equal(submits, 1)
  controller.stop()
})

test('draft auto-send defaults fail closed without voiceprint opt-in', async () => {
  installBrowserStubs()
  updatePrefs({ qwenMergeMs: 100, voiceDraftAutoSend: true, voiceDraftDwellMs: 500, voiceDraftAllowWithoutVoiceprint: false, voiceprintEnabled: false })
  let callbacks!: RealtimeCallbacks
  let observer!: {
    onTurnStart(turn: string): void
    onTextDelta(turn: string, delta: string): void
    onTurnEnd(turn: string, result: { ok: true; text: string }): void
  }
  let draft = ''
  let submits = 0
  const connection: VoiceConnection = { connect: async () => {}, disconnect: () => {}, speak: async () => {}, waitForSpeechIdle: async () => {} }
  const bridge = {
    setVoiceMode: async () => {},
    observeSession: (_sessionId: string, value: typeof observer) => { observer = value; return () => {} },
  } as unknown as HarnessBridge
  const controller = new VoiceController('s1', bridge, (_prefs, value) => { callbacks = value; return connection })
  controller.bindDraft({ getDraft: () => draft, setDraft: value => { draft = value }, submit: () => { submits++; draft = '' } })
  await controller.toggle()
  observer.onTurnStart('busy-turn')
  await callbacks.onTranscript?.('无声纹的后续语音', { capturedWhileBusy: true })
  await delay(130)
  observer.onTextDelta('busy-turn', '完成。')
  observer.onTurnEnd('busy-turn', { ok: true, text: '完成。' })
  await delay(1500)
  assert.equal(submits, 0)
  assert.equal(draft, '无声纹的后续语音')
  controller.stop()
})

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
