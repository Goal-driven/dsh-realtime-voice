export declare const OPENAI_REALTIME_MODEL = "gpt-realtime-2.1-mini";
interface OpenAiSessionOptions {
    instructions?: string;
    model?: string;
    voice?: string;
}
export declare function openAiRealtimeSession(options: OpenAiSessionOptions): Record<string, unknown>;
export {};
