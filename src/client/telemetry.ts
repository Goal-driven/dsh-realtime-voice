export interface VoiceTelemetrySnapshot {
  model: string
  responses: number
  cacheHitPercent: number
  firstAudioLatencyMs?: number
  totalCostUsd: number
  lastResponseCostUsd: number
}

interface Rates {
  textInput: number
  textCached: number
  textOutput: number
  audioInput: number
  audioCached: number
  audioOutput: number
}

// USD per 1M tokens, published for GPT-Realtime-2.1 Mini.
const MINI_RATES: Rates = {
  textInput: 0.60,
  textCached: 0.06,
  textOutput: 2.40,
  audioInput: 10.00,
  audioCached: 0.30,
  audioOutput: 20.00,
}

export class VoiceTelemetryTracker {
  private responses = 0
  private totalInputTokens = 0
  private totalCachedTokens = 0
  private totalCostUsd = 0
  private lastResponseCostUsd = 0
  private speechStoppedAt?: number
  private firstAudioLatencyMs?: number

  constructor(private readonly model: string) {}

  consume(event: unknown, nowMs: number): VoiceTelemetrySnapshot | undefined {
    const record = asRecord(event)
    if (record.type === 'input_audio_buffer.speech_stopped') {
      this.speechStoppedAt = nowMs
      this.firstAudioLatencyMs = undefined
      return undefined
    }
    if ((record.type === 'response.audio.delta' || record.type === 'response.output_audio.delta')
      && this.speechStoppedAt !== undefined && this.firstAudioLatencyMs === undefined) {
      this.firstAudioLatencyMs = Math.max(0, nowMs - this.speechStoppedAt)
      return this.snapshot()
    }
    if (record.type !== 'response.done') return undefined

    const usage = asRecord(asRecord(record.response).usage)
    const input = nonNegative(usage.input_tokens)
    const output = nonNegative(usage.output_tokens)
    const inputDetails = detailRecord(usage, 'input_token_details', 'input_tokens_details')
    const outputDetails = detailRecord(usage, 'output_token_details', 'output_tokens_details')
    const cachedDetails = detailRecord(inputDetails, 'cached_tokens_details')
    const cached = Math.min(input, nonNegative(inputDetails.cached_tokens))

    const inputAudio = Math.min(input, nonNegative(inputDetails.audio_tokens))
    const inputText = Math.min(input - inputAudio, nonNegative(inputDetails.text_tokens) || Math.max(0, input - inputAudio))
    const cachedAudio = Math.min(inputAudio, nonNegative(cachedDetails.audio_tokens))
    const cachedText = Math.min(inputText, nonNegative(cachedDetails.text_tokens) || Math.max(0, cached - cachedAudio))
    const outputAudio = Math.min(output, nonNegative(outputDetails.audio_tokens))
    const outputText = Math.min(output - outputAudio, nonNegative(outputDetails.text_tokens) || Math.max(0, output - outputAudio))

    this.lastResponseCostUsd = perMillion(
      (inputText - cachedText) * MINI_RATES.textInput
      + cachedText * MINI_RATES.textCached
      + (inputAudio - cachedAudio) * MINI_RATES.audioInput
      + cachedAudio * MINI_RATES.audioCached
      + outputText * MINI_RATES.textOutput
      + outputAudio * MINI_RATES.audioOutput,
    )
    this.responses += 1
    this.totalInputTokens += input
    this.totalCachedTokens += cached
    this.totalCostUsd += this.lastResponseCostUsd
    return this.snapshot()
  }

  private snapshot(): VoiceTelemetrySnapshot {
    return {
      model: this.model,
      responses: this.responses,
      cacheHitPercent: this.totalInputTokens === 0 ? 0 : Math.min(100, (this.totalCachedTokens / this.totalInputTokens) * 100),
      ...(this.firstAudioLatencyMs === undefined ? {} : { firstAudioLatencyMs: this.firstAudioLatencyMs }),
      totalCostUsd: this.totalCostUsd,
      lastResponseCostUsd: this.lastResponseCostUsd,
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function detailRecord(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = asRecord(record[key])
    if (Object.keys(value).length > 0) return value
  }
  return {}
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function perMillion(value: number): number {
  return Math.max(0, value) / 1_000_000
}
