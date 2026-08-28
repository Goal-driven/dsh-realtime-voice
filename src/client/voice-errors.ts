const MISSING_CREDENTIALS: ReadonlyArray<[RegExp, string]> = [
  [
    /OPENAI_API_KEY\s+is\s+not\s+configured/i,
    'OpenAI API-nyckel saknas. Öppna Inställningar → Modeller → OpenAI och spara nyckeln.',
  ],
  [
    /DASHSCOPE_API_KEY\s+is\s+not\s+configured/i,
    'DashScope API-nyckel saknas. Öppna Inställningar → Modeller → Alibaba Cloud och spara nyckeln.',
  ],
]

/** Keep provider errors useful without exposing raw English setup messages. */
export function localizeVoiceError(detail: string): string {
  for (const [pattern, message] of MISSING_CREDENTIALS) {
    if (pattern.test(detail)) return message
  }
  return detail
}
