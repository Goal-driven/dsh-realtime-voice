import type { VoicePrefs } from './prefs.ts'

export const HARNESS_FIRST_POLICY = `
Du är DeepSeek Harness lager för realtime-röst, inte en fristående assistent.
För varje giltigt yttrande från användaren – samtal, frågor, sökning, datoråtgärder eller flerstegsarbete – måste ditt första och enda steg vara att anropa delegate_to_harness.
Återge användarens fullständiga avsikt troget i task. Svara, sök, resonera eller kör inga andra verktyg själv och utelämna inga krav.
När delegate_to_harness returnerar ska du endast läsa upp verktygets naturliga språk. Lägg inte till, skriv inte om, sammanfatta inte och anropa inget nytt verktyg.
`.trim()

export interface ToolCall {
  callId: string
  name: 'delegate_to_harness' | 'cancel_harness_task'
  arguments: string
}

export function sessionUpdate(prefs: VoicePrefs): Record<string, unknown> {
  const functions = [{
    name: 'delegate_to_harness',
    description: 'Måste anropas för varje giltigt yttrande. Överlämna användarens fullständiga avsikt till aktuell DeepSeek Harness-session för resonemang, minne, sökning, plugins och verktyg.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Användarens fullständiga, trogna och körbara avsikt. Svara inte själv och ändra inget.' } },
      required: ['task'],
      additionalProperties: false,
    },
  }]

  if (prefs.provider === 'openai') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: prefs.instructions.trim(),
        output_modalities: ['audio'],
        truncation: {
          type: 'retention_ratio',
          retention_ratio: 0.8,
          token_limits: { post_instructions: 96_000 },
        },
        audio: {
          input: {
            noise_reduction: { type: 'far_field' },
            transcription: {
              model: 'gpt-4o-mini-transcribe',
              language: 'sv',
              prompt: 'Svenskt samtal. Bevara namn, produktnamn och tekniska termer ordagrant.',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.35,
              prefix_padding_ms: 400,
              silence_duration_ms: 700,
              create_response: false,
              interrupt_response: false,
            },
          },
          output: { voice: prefs.openaiVoice },
        },
      },
    }
  }

  const instructions = `${prefs.instructions.trim()}\n\n${HARNESS_FIRST_POLICY}`.trim()

  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions,
      voice: prefs.qwenVoice,
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: 'zh',
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 450,
        create_response: true,
      },
      tools: functions.map(fn => ({ type: 'function', function: fn })),
      tool_choice: 'auto',
    },
  }
}

export function parseToolCall(event: unknown): ToolCall | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  if (record.type === 'response.function_call_arguments.done') {
    if (record.name !== 'delegate_to_harness' && record.name !== 'cancel_harness_task') return undefined
    if (typeof record.call_id !== 'string') return undefined
    return {
      callId: record.call_id,
      name: record.name,
      arguments: typeof record.arguments === 'string' ? record.arguments : '{}',
    }
  }
  const item = record.type === 'response.output_item.done'
    ? record.item
    : record.type === 'conversation.item.created'
      ? record.item
      : undefined
  if (typeof item !== 'object' || item === null) return undefined
  const call = item as Record<string, unknown>
  if (call.type !== 'function_call') return undefined
  if (call.name !== 'delegate_to_harness' && call.name !== 'cancel_harness_task') return undefined
  const callId = typeof call.call_id === 'string' ? call.call_id : typeof call.id === 'string' ? call.id : undefined
  if (callId === undefined) return undefined
  return {
    callId,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
  }
}

export function toolOutput(callId: string, output: unknown): Array<Record<string, unknown>> {
  const spoken = normalizeHarnessOutput(output)
  const events: Array<Record<string, unknown>> = [{
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: spoken },
  }]
  if (voiceAlreadySpoken(output)) return events
  events.push({
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      tool_choice: 'none',
    },
  })
  return events
}

function voiceAlreadySpoken(output: unknown): boolean {
  return typeof output === 'object' && output !== null && (output as { voiceAlreadySpoken?: unknown }).voiceAlreadySpoken === true
}

function normalizeHarnessOutput(output: unknown): string {
  if (typeof output === 'object' && output !== null) {
    const result = output as { ok?: unknown; text?: unknown; error?: unknown; cancelled?: unknown }
    if (result.ok === true && typeof result.text === 'string' && result.text.trim() !== '') return result.text
    if (result.cancelled === true) return 'Uppgiften avbröts.'
    if (typeof result.error === 'string' && result.error.trim() !== '') return `Harness kunde inte slutföra uppgiften: ${result.error}`
  }
  return typeof output === 'string' ? output : JSON.stringify(output)
}
