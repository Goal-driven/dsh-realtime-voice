export const OPENAI_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
export function openAiRealtimeSession(options) {
    return {
        type: 'realtime',
        ...(options.model === undefined ? {} : { model: options.model }),
        instructions: options.instructions,
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
            output: { voice: options.voice ?? 'marin' },
        },
    };
}
