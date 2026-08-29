import type { VoicePrefs } from './prefs.ts'
import { parseToolCall, sessionUpdate, toolOutput, type ToolCall } from './protocol.ts'
import { VoiceTelemetryTracker, type VoiceTelemetrySnapshot } from './telemetry.ts'
import type { TurnPhase } from './turn-coordinator.ts'

export interface TranscriptMeta {
  capturedWhileBusy?: boolean
  voiceprint?: 'approved' | 'rejected' | 'unavailable'
}

export interface RealtimeCallbacks {
  onState(state: 'connecting' | 'listening' | 'speaking' | 'error', detail?: string): void
  onToolCall(call: ToolCall): Promise<unknown>
  onSpeechStart?(): void
  onSpeechEnd?(): void
  onTranscript?(text: string, meta?: TranscriptMeta): Promise<void>
  onTelemetry?(snapshot: VoiceTelemetrySnapshot): void
}

export class RealtimeConnection {
  private peer?: RTCPeerConnection
  private channel?: RTCDataChannel
  private inboundChannel?: RTCDataChannel
  private microphone?: MediaStream
  private microphoneTrack?: MediaStreamTrack
  private audioSender?: RTCRtpSender
  private audio?: HTMLAudioElement
  private seenCalls = new Set<string>()
  private sessionCreated = false
  private updateSent = false
  private responseActive = false
  private readonly echoGuard = new RealtimeEchoGuard()
  private speechSequence = 0
  private readonly speechWaiters = new Map<string, { resolve(): void; reject(error: Error): void; responseId?: string; timeout: ReturnType<typeof setTimeout>; speech: string }>()
  private readonly speechIdleWaiters = new Set<() => void>()
  private readonly cancelledSpeech = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly utteranceBusy = new Map<string, boolean>()
  private speechMuteHolds = 0
  private inputPhase: TurnPhase = 'listening'
  private readonly telemetry: VoiceTelemetryTracker

  constructor(private readonly prefs: VoicePrefs, private readonly callbacks: RealtimeCallbacks) {
    this.telemetry = new VoiceTelemetryTracker(prefs.openaiModel)
  }

  async connect(): Promise<void> {
    this.callbacks.onState('connecting')
    if (this.prefs.provider === 'qwen' && this.prefs.qwenWorkspaceId.trim() === '') {
      throw new Error('Fyll i Alibaba Cloud Bailian Workspace-ID i plugininställningarna')
    }
    if (navigator.mediaDevices?.getUserMedia === undefined) throw new Error('Sidan kan inte komma åt mikrofonen. Öppna Harness-adressen i Chrome.')

    this.microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const peer = new RTCPeerConnection({ iceServers: [] })
    this.peer = peer
    const track = this.microphone.getAudioTracks()[0]
    if (track === undefined) throw new Error('Ingen mikrofonkanal är tillgänglig')
    this.microphoneTrack = track
    this.audioSender = attachLiveMicrophone(peer, track, this.microphone)
    track.addEventListener('ended', () => this.callbacks.onState('error', 'Mikrofonspåret avslutades. Starta rösten igen.'))

    this.audio = document.createElement('audio')
    this.audio.autoplay = true
    this.audio.style.display = 'none'
    document.body.appendChild(this.audio)
    peer.ontrack = event => {
      if (this.audio === undefined) return
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void this.audio.play().catch(error => {
        this.callbacks.onState('error', `Chrome kunde inte spela upp rösten: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        this.callbacks.onState('error', `WebRTC ${peer.connectionState}`)
      }
    }
    peer.ondatachannel = event => {
      this.inboundChannel = event.channel
      event.channel.onmessage = message => { void this.handleEvent(message.data) }
    }

    const channel = peer.createDataChannel('oai-events')
    this.channel = channel
    channel.onmessage = event => { void this.handleEvent(event.data) }
    channel.onopen = () => { this.maybeSendSessionUpdate() }
    channel.onclose = () => { this.rejectSpeech(new Error('OpenAI-röstkanalen stängdes')) }

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForIce(peer, 3_000)
    const localSdp = peer.localDescription?.sdp
    if (localSdp === undefined) throw new Error('Det gick inte att skapa WebRTC SDP')
    const payload: Record<string, unknown> = {
      sdp: localSdp,
      instructions: this.prefs.instructions,
    }
    if (this.prefs.provider === 'openai') {
      payload.model = this.prefs.openaiModel
      payload.voice = this.prefs.openaiVoice
    } else {
      payload.model = this.prefs.qwenModel
      payload.voice = this.prefs.qwenVoice
      payload.workspaceId = this.prefs.qwenWorkspaceId
      payload.region = this.prefs.qwenRegion
    }
    const response = await fetch(`/dsh-realtime-voice/signaling/${this.prefs.provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
      throw new Error(error.error ?? `Signaleringen misslyckades: ${response.status}`)
    }
    await peer.setRemoteDescription({ type: 'answer', sdp: normalizeSdp(await response.text()) })
  }

  async speak(text: string): Promise<void> {
    const speech = text.trim()
    if (speech === '') return
    if (this.channel?.readyState !== 'open') throw new Error('OpenAI-röstkanalen är inte ansluten')
    const requestId = `valuehub-speech-${++this.speechSequence}`
    let requestSent = false
    if (this.audioSender !== undefined) await this.audioSender.replaceTrack(null)
    if (this.channel?.readyState !== 'open') {
      if (this.audioSender !== undefined && this.microphoneTrack !== undefined) await this.audioSender.replaceTrack(this.microphoneTrack)
      throw new Error('OpenAI-röstkanalen är inte längre ansluten')
    }
    this.speechMuteHolds++
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiter = this.speechWaiters.get(requestId)
        if (waiter?.responseId !== undefined) this.send({ type: 'response.cancel', response_id: waiter.responseId })
        else {
          this.send({ type: 'response.cancel' })
          this.trackCancelledSpeech(requestId)
        }
        this.speechWaiters.delete(requestId)
        reject(new Error('OpenAI-uppläsningen tog för lång tid'))
        this.resolveSpeechIdle()
      }, 30_000)
      this.speechWaiters.set(requestId, { resolve, reject, timeout, speech })
    })
    try {
      try {
        this.sendRequired({
          type: 'response.create',
          response: {
            conversation: 'none',
            metadata: { valuehub_voice: 'harness-stream', request_id: requestId },
            output_modalities: ['audio'],
            tool_choice: 'none',
            input: [],
            instructions: `Läs upp exakt följande svenska text utan inledning, kommentar eller omskrivning:\n\n${speech}`,
          },
        })
        requestSent = true
        this.echoGuard.recordSpeech(speech)
      } catch (error) {
        const waiter = this.speechWaiters.get(requestId)
        if (waiter !== undefined) {
          clearTimeout(waiter.timeout)
          this.speechWaiters.delete(requestId)
          waiter.reject(error instanceof Error ? error : new Error(String(error)))
          this.resolveSpeechIdle()
        }
      }
      await completion
    } finally {
      if (requestSent) await delay(300)
      this.speechMuteHolds = Math.max(0, this.speechMuteHolds - 1)
      if (this.speechMuteHolds === 0 && this.speechWaiters.size === 0 && this.audioSender !== undefined && this.microphoneTrack !== undefined) {
        await this.audioSender.replaceTrack(this.microphoneTrack)
      }
    }
  }

  async waitForSpeechIdle(): Promise<void> {
    if (this.speechWaiters.size === 0) return
    await new Promise<void>(resolve => { this.speechIdleWaiters.add(resolve) })
  }

  setInputPhase(phase: TurnPhase): void {
    this.inputPhase = phase
  }

  cancelSpeech(): void {
    for (const [requestId, waiter] of this.speechWaiters) {
      if (waiter.responseId !== undefined) this.send({ type: 'response.cancel', response_id: waiter.responseId })
      else {
        this.send({ type: 'response.cancel' })
        this.trackCancelledSpeech(requestId)
      }
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('Röstuppspelningen avbröts'))
      this.speechWaiters.delete(requestId)
    }
    this.resolveSpeechIdle()
  }

  disconnect(): void {
    try { this.send({ type: 'response.cancel' }) } catch { /* channel may already be closed */ }
    this.channel?.close()
    this.inboundChannel?.close()
    this.peer?.close()
    this.microphone?.getTracks().forEach(track => track.stop())
    this.audio?.remove()
    this.channel = undefined
    this.inboundChannel = undefined
    this.peer = undefined
    this.microphone = undefined
    this.microphoneTrack = undefined
    this.audioSender = undefined
    this.audio = undefined
    this.seenCalls.clear()
    this.sessionCreated = false
    this.updateSent = false
    this.responseActive = false
    this.speechMuteHolds = 0
    this.inputPhase = 'listening'
    this.utteranceBusy.clear()
    for (const timeout of this.cancelledSpeech.values()) clearTimeout(timeout)
    this.cancelledSpeech.clear()
    this.rejectSpeech(new Error('Röstanslutningen stängdes'))
  }

  private async handleEvent(raw: unknown): Promise<void> {
    let event: unknown
    try { event = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    const type = typeof event === 'object' && event !== null ? (event as Record<string, unknown>).type : undefined
    const telemetry = this.telemetry.consume(event, globalThis.performance?.now() ?? Date.now())
    if (telemetry !== undefined) this.publishTelemetry(telemetry)
    if (type === 'session.created') {
      this.sessionCreated = true
      this.maybeSendSessionUpdate()
    }
    if (type === 'session.updated') {
      if (this.audioSender !== undefined && this.microphoneTrack !== undefined) {
        if (this.speechMuteHolds === 0 && this.speechWaiters.size === 0) await this.audioSender.replaceTrack(this.microphoneTrack)
      }
      this.callbacks.onState('listening', 'Lyssnar efter svenska')
    }
    if (type === 'input_audio_buffer.speech_started') {
      const itemId = eventString(event, 'item_id')
      if (itemId !== undefined) this.utteranceBusy.set(itemId, isBusyPhase(this.inputPhase))
      this.callbacks.onSpeechStart?.()
      if (this.responseActive) this.send({ type: 'response.cancel' })
      this.callbacks.onState('listening', 'Tal upptäckt')
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.callbacks.onSpeechEnd?.()
      this.callbacks.onState('listening', 'Bearbetar svenskt tal')
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = eventString(event, 'transcript')?.trim() ?? ''
      const itemId = eventString(event, 'item_id')
      const capturedWhileBusy = itemId === undefined
        ? isBusyPhase(this.inputPhase)
        : this.utteranceBusy.get(itemId) ?? isBusyPhase(this.inputPhase)
      if (itemId !== undefined) this.utteranceBusy.delete(itemId)
      if (transcript === '') return
      if (this.echoGuard.shouldSuppress(transcript)) {
        this.callbacks.onState('listening', 'Själveko ignorerat')
        return
      }
      await this.callbacks.onTranscript?.(transcript, { capturedWhileBusy })
      return
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const itemId = eventString(event, 'item_id')
      if (itemId !== undefined) this.utteranceBusy.delete(itemId)
      const error = eventRecord(event, 'error')
      const message = typeof error.message === 'string' && error.message.trim() !== ''
        ? error.message.trim()
        : 'okänt fel'
      this.callbacks.onState('error', `Svensk taligenkänning misslyckades: ${message}`)
      return
    }
    if (type === 'response.created' && !this.captureSpeechResponse(event)) this.responseActive = true
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta' || type === 'response.audio_transcript.delta') this.callbacks.onState('speaking')
    if (type === 'response.done' && this.settleSpeechResponse(event)) return
    if (type === 'response.done') { this.responseActive = false; this.callbacks.onState('listening') }
    if (type === 'error') {
      const detail = JSON.stringify((event as Record<string, unknown>).error ?? event).slice(0, 500)
      this.rejectSpeech(new Error(detail))
      this.callbacks.onState('error', detail)
    }

    const call = parseToolCall(event)
    if (call === undefined || this.seenCalls.has(call.callId)) return
    this.seenCalls.add(call.callId)
    if (call.name === 'delegate_to_harness' && this.echoGuard.shouldSuppress(toolTask(call.arguments))) {
      this.responseActive = false
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.callId, output: 'Själveko från uppläsningen ignorerades; inget användaryttrande mottogs.' },
      })
      this.callbacks.onState('listening', 'Själveko ignorerat')
      return
    }
    try {
      const output = await this.callbacks.onToolCall(call)
      const outbound = toolOutput(call.callId, output)
      const delivered = outbound.every(event => this.send(event))
      if (delivered) this.recordToolSpeech(outbound)
    } catch (error) {
      const outbound = toolOutput(call.callId, { ok: false, error: error instanceof Error ? error.message : String(error) })
      const delivered = outbound.every(event => this.send(event))
      if (delivered) this.recordToolSpeech(outbound)
    }
  }

  private recordToolSpeech(events: Array<Record<string, unknown>>): void {
    if (events.length < 2) return
    const item = events[0]?.item
    if (typeof item !== 'object' || item === null) return
    const output = (item as Record<string, unknown>).output
    if (typeof output === 'string') this.echoGuard.recordSpeech(output)
  }

  private captureSpeechResponse(event: unknown): boolean {
    const response = eventRecord(event, 'response')
    const metadata = eventRecord(response, 'metadata')
    const requestId = typeof metadata.request_id === 'string' ? metadata.request_id : undefined
    const responseId = typeof response.id === 'string' ? response.id : undefined
    if (metadata.valuehub_voice !== 'harness-stream' || requestId === undefined) return false
    const waiter = this.speechWaiters.get(requestId)
    if (waiter !== undefined && responseId !== undefined) waiter.responseId = responseId
    const cancelled = this.cancelledSpeech.get(requestId)
    if (cancelled !== undefined) {
      clearTimeout(cancelled)
      this.cancelledSpeech.delete(requestId)
      if (responseId !== undefined) this.send({ type: 'response.cancel', response_id: responseId })
    }
    return true
  }

  private settleSpeechResponse(event: unknown): boolean {
    const response = eventRecord(event, 'response')
    const metadata = eventRecord(response, 'metadata')
    if (metadata.valuehub_voice !== 'harness-stream' || typeof metadata.request_id !== 'string') return false
    const cancelled = this.cancelledSpeech.get(metadata.request_id)
    if (cancelled !== undefined) {
      clearTimeout(cancelled)
      this.cancelledSpeech.delete(metadata.request_id)
    }
    const waiter = this.speechWaiters.get(metadata.request_id)
    if (waiter === undefined) return true
    this.speechWaiters.delete(metadata.request_id)
    clearTimeout(waiter.timeout)
    this.resolveSpeechIdle()
    this.echoGuard.recordSpeech(waiter.speech)
    if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'incomplete') {
      waiter.reject(new Error(`OpenAI-uppläsningen avslutades med status ${String(response.status)}`))
    } else {
      waiter.resolve()
    }
    return true
  }

  private resolveSpeechIdle(): void {
    if (this.speechWaiters.size !== 0) return
    for (const resolve of this.speechIdleWaiters) resolve()
    this.speechIdleWaiters.clear()
  }

  private rejectSpeech(error: Error): void {
    for (const [requestId, waiter] of this.speechWaiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
      this.speechWaiters.delete(requestId)
    }
    this.resolveSpeechIdle()
  }

  private trackCancelledSpeech(requestId: string): void {
    const previous = this.cancelledSpeech.get(requestId)
    if (previous !== undefined) clearTimeout(previous)
    const timeout = setTimeout(() => { this.cancelledSpeech.delete(requestId) }, 30_000)
    this.cancelledSpeech.set(requestId, timeout)
  }

  private send(event: unknown): boolean {
    if (this.channel?.readyState !== 'open') return false
    try {
      this.channel.send(JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }

  private sendRequired(event: unknown): void {
    if (this.channel?.readyState !== 'open') throw new Error('OpenAI-röstkanalen är inte längre ansluten')
    this.channel.send(JSON.stringify(event))
  }

  private maybeSendSessionUpdate(): void {
    if (!this.sessionCreated || this.updateSent || this.channel?.readyState !== 'open') return
    this.updateSent = true
    this.send(sessionUpdate(this.prefs))
  }

  private publishTelemetry(snapshot: VoiceTelemetrySnapshot): void {
    this.callbacks.onTelemetry?.(snapshot)
    if (typeof window === 'undefined') return
    const target = window as Window & { __VALUEHUB_VOICE_TELEMETRY__?: VoiceTelemetrySnapshot }
    target.__VALUEHUB_VOICE_TELEMETRY__ = snapshot
    window.dispatchEvent(new CustomEvent<VoiceTelemetrySnapshot>('valuehub:voice-telemetry', { detail: snapshot }))
  }
}

export function attachLiveMicrophone(peer: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
  return peer.addTrack(track, stream)
}

function eventRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === 'object' && nested !== null ? nested as Record<string, unknown> : {}
}

function eventString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const nested = (value as Record<string, unknown>)[key]
  return typeof nested === 'string' ? nested : undefined
}

function isBusyPhase(phase: TurnPhase): boolean {
  return phase !== 'listening' && phase !== 'endpoint-candidate'
}

const ECHO_WINDOW_MS = 2_000

export class RealtimeEchoGuard {
  private recentSpeech = ''
  private recordedAt = 0

  recordSpeech(text: string, now = Date.now()): void {
    const clean = text.trim()
    if (clean === '') return
    this.recentSpeech = clean
    this.recordedAt = now
  }

  shouldSuppress(task: string, now = Date.now()): boolean {
    if (now - this.recordedAt > ECHO_WINDOW_MS) return false
    return isLikelyEcho(task, this.recentSpeech)
  }
}

function toolTask(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as { task?: unknown }
    return typeof parsed.task === 'string' ? parsed.task : ''
  } catch {
    return ''
  }
}

function isLikelyEcho(task: string, speech: string): boolean {
  const heard = normalizeSpeech(task)
  const spoken = normalizeSpeech(speech)
  if (heard.length < 3 || spoken.length < 3 || isExplicitBargeIn(heard)) return false
  if (heard === spoken) return true
  if (heard.includes(spoken)) return true
  const shorter = Math.min(heard.length, spoken.length)
  const longer = Math.max(heard.length, spoken.length)
  if (shorter / longer < 0.72) return false
  if (spoken.includes(heard)) return true
  if (longestCommonSubstring(heard, spoken) / shorter >= 0.72) return true
  return bigramDice(heard, spoken) >= 0.62
}

function isExplicitBargeIn(normalized: string): boolean {
  return /^(stopp|stoppa|sluta|vänta|väntalite|avbryt|nej|fel|stop|cancel|停|停止|停下|打住|别说了|等一下|等等|不对|取消|取消任务|不要了|算了)$/.test(normalized)
}

function normalizeSpeech(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 512)
}

function longestCommonSubstring(left: string, right: string): number {
  const row = new Uint16Array(right.length + 1)
  let longest = 0
  for (let i = 1; i <= left.length; i++) {
    for (let j = right.length; j >= 1; j--) {
      const value = left.charAt(i - 1) === right.charAt(j - 1) ? (row[j - 1] ?? 0) + 1 : 0
      row[j] = value
      if (value > longest) longest = value
    }
  }
  return longest
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0
  const counts = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index++) {
    const gram = left.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (let index = 0; index < right.length - 1; index++) {
    const gram = right.slice(index, index + 2)
    const count = counts.get(gram) ?? 0
    if (count <= 0) continue
    overlap++
    counts.set(gram, count - 1)
  }
  return (2 * overlap) / (left.length + right.length - 2)
}

function normalizeSdp(sdp: string): string {
  return sdp.replace(/\r?\n/g, '\r\n').replace(/(?:\r\n)*$/, '\r\n')
}

async function waitForIce(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, timeoutMs)
    function done(): void {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', changed)
      resolve()
    }
    function changed(): void { if (peer.iceGatheringState === 'complete') done() }
    peer.addEventListener('icegatheringstatechange', changed)
  })
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
