import type { VoicePrefs } from './prefs.ts';
import { type ToolCall } from './protocol.ts';
import { type VoiceTelemetrySnapshot } from './telemetry.ts';
export interface TranscriptMeta {
    capturedWhileBusy?: boolean;
    voiceprint?: 'approved' | 'rejected' | 'unavailable';
}
export interface RealtimeCallbacks {
    onState(state: 'connecting' | 'listening' | 'speaking' | 'error', detail?: string): void;
    onToolCall(call: ToolCall): Promise<unknown>;
    onSpeechStart?(): void;
    onSpeechEnd?(): void;
    onTranscript?(text: string, meta?: TranscriptMeta): Promise<void>;
    onTelemetry?(snapshot: VoiceTelemetrySnapshot): void;
}
export declare class RealtimeConnection {
    private readonly prefs;
    private readonly callbacks;
    private peer?;
    private channel?;
    private inboundChannel?;
    private microphone?;
    private microphoneTrack?;
    private audioSender?;
    private audio?;
    private seenCalls;
    private sessionCreated;
    private updateSent;
    private responseActive;
    private readonly echoGuard;
    private speechSequence;
    private readonly speechWaiters;
    private readonly speechIdleWaiters;
    private readonly cancelledSpeech;
    private speechMuteHolds;
    private readonly telemetry;
    constructor(prefs: VoicePrefs, callbacks: RealtimeCallbacks);
    connect(): Promise<void>;
    speak(text: string): Promise<void>;
    waitForSpeechIdle(): Promise<void>;
    cancelSpeech(): void;
    disconnect(): void;
    private handleEvent;
    private recordToolSpeech;
    private captureSpeechResponse;
    private settleSpeechResponse;
    private resolveSpeechIdle;
    private rejectSpeech;
    private trackCancelledSpeech;
    private send;
    private sendRequired;
    private maybeSendSessionUpdate;
    private publishTelemetry;
}
export declare class RealtimeEchoGuard {
    private recentSpeech;
    private recordedAt;
    recordSpeech(text: string, now?: number): void;
    shouldSuppress(task: string, now?: number): boolean;
}
