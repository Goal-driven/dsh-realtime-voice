export interface VoiceTelemetrySnapshot {
    model: string;
    responses: number;
    cacheHitPercent: number;
    firstAudioLatencyMs?: number;
    totalCostUsd: number;
    lastResponseCostUsd: number;
}
export declare class VoiceTelemetryTracker {
    private readonly model;
    private responses;
    private totalInputTokens;
    private totalCachedTokens;
    private totalCostUsd;
    private lastResponseCostUsd;
    private speechStoppedAt?;
    private firstAudioLatencyMs?;
    constructor(model: string);
    consume(event: unknown, nowMs: number): VoiceTelemetrySnapshot | undefined;
    private snapshot;
}
