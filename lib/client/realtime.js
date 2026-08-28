import { parseToolCall, sessionUpdate, toolOutput } from "./protocol.js";
import { VoiceTelemetryTracker } from "./telemetry.js";
export class RealtimeConnection {
    prefs;
    callbacks;
    peer;
    channel;
    inboundChannel;
    microphone;
    microphoneTrack;
    audioSender;
    audio;
    seenCalls = new Set();
    sessionCreated = false;
    updateSent = false;
    responseActive = false;
    telemetry;
    constructor(prefs, callbacks) {
        this.prefs = prefs;
        this.callbacks = callbacks;
        this.telemetry = new VoiceTelemetryTracker(prefs.openaiModel);
    }
    async connect() {
        this.callbacks.onState('connecting');
        if (this.prefs.provider === 'qwen' && this.prefs.qwenWorkspaceId.trim() === '') {
            throw new Error('Fyll i Alibaba Cloud Bailian Workspace-ID i plugininställningarna');
        }
        if (navigator.mediaDevices?.getUserMedia === undefined)
            throw new Error('Sidan kan inte komma åt mikrofonen. Öppna Harness-adressen i Chrome.');
        this.microphone = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        const peer = new RTCPeerConnection({ iceServers: [] });
        this.peer = peer;
        const track = this.microphone.getAudioTracks()[0];
        if (track === undefined)
            throw new Error('Ingen mikrofonkanal är tillgänglig');
        this.microphoneTrack = track;
        this.audioSender = peer.addTrack(track, this.microphone);
        await this.audioSender.replaceTrack(null);
        this.audio = document.createElement('audio');
        this.audio.autoplay = true;
        this.audio.style.display = 'none';
        document.body.appendChild(this.audio);
        peer.ontrack = event => { if (this.audio !== undefined)
            this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); };
        peer.onconnectionstatechange = () => {
            if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
                this.callbacks.onState('error', `WebRTC ${peer.connectionState}`);
            }
        };
        peer.ondatachannel = event => {
            this.inboundChannel = event.channel;
            event.channel.onmessage = message => { void this.handleEvent(message.data); };
        };
        const channel = peer.createDataChannel('oai-events');
        this.channel = channel;
        channel.onmessage = event => { void this.handleEvent(event.data); };
        channel.onopen = () => { this.maybeSendSessionUpdate(); };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer, 3_000);
        const localSdp = peer.localDescription?.sdp;
        if (localSdp === undefined)
            throw new Error('Det gick inte att skapa WebRTC SDP');
        const payload = {
            sdp: localSdp,
            instructions: this.prefs.instructions,
        };
        if (this.prefs.provider === 'openai') {
            payload.model = this.prefs.openaiModel;
            payload.voice = this.prefs.openaiVoice;
        }
        else {
            payload.model = this.prefs.qwenModel;
            payload.voice = this.prefs.qwenVoice;
            payload.workspaceId = this.prefs.qwenWorkspaceId;
            payload.region = this.prefs.qwenRegion;
        }
        const response = await fetch(`/dsh-realtime-voice/signaling/${this.prefs.provider}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(error.error ?? `Signaleringen misslyckades: ${response.status}`);
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: normalizeSdp(await response.text()) });
    }
    disconnect() {
        try {
            this.send({ type: 'response.cancel' });
        }
        catch { /* channel may already be closed */ }
        this.channel?.close();
        this.inboundChannel?.close();
        this.peer?.close();
        this.microphone?.getTracks().forEach(track => track.stop());
        this.audio?.remove();
        this.channel = undefined;
        this.inboundChannel = undefined;
        this.peer = undefined;
        this.microphone = undefined;
        this.microphoneTrack = undefined;
        this.audioSender = undefined;
        this.audio = undefined;
        this.seenCalls.clear();
        this.sessionCreated = false;
        this.updateSent = false;
        this.responseActive = false;
    }
    async handleEvent(raw) {
        let event;
        try {
            event = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
        catch {
            return;
        }
        const type = typeof event === 'object' && event !== null ? event.type : undefined;
        const telemetry = this.telemetry.consume(event, globalThis.performance?.now() ?? Date.now());
        if (telemetry !== undefined)
            this.publishTelemetry(telemetry);
        if (type === 'session.created') {
            this.sessionCreated = true;
            this.maybeSendSessionUpdate();
        }
        if (type === 'session.updated') {
            if (this.audioSender !== undefined && this.microphoneTrack !== undefined) {
                await this.audioSender.replaceTrack(this.microphoneTrack);
            }
            this.callbacks.onState('listening');
        }
        if (type === 'input_audio_buffer.speech_started') {
            this.callbacks.onSpeechStart?.();
            if (this.responseActive)
                this.send({ type: 'response.cancel' });
            this.callbacks.onState('listening');
        }
        if (type === 'input_audio_buffer.speech_stopped')
            this.callbacks.onSpeechEnd?.();
        if (type === 'response.created')
            this.responseActive = true;
        if (type === 'response.audio.delta' || type === 'response.output_audio.delta' || type === 'response.audio_transcript.delta')
            this.callbacks.onState('speaking');
        if (type === 'response.done') {
            this.responseActive = false;
            this.callbacks.onState('listening');
        }
        if (type === 'error') {
            const detail = JSON.stringify(event.error ?? event).slice(0, 500);
            this.callbacks.onState('error', detail);
        }
        const call = parseToolCall(event);
        if (call === undefined || this.seenCalls.has(call.callId))
            return;
        this.seenCalls.add(call.callId);
        try {
            const output = await this.callbacks.onToolCall(call);
            for (const outbound of toolOutput(call.callId, output))
                this.send(outbound);
        }
        catch (error) {
            for (const outbound of toolOutput(call.callId, { ok: false, error: error instanceof Error ? error.message : String(error) }))
                this.send(outbound);
        }
    }
    send(event) {
        if (this.channel?.readyState !== 'open')
            return;
        this.channel.send(JSON.stringify(event));
    }
    maybeSendSessionUpdate() {
        if (!this.sessionCreated || this.updateSent || this.channel?.readyState !== 'open')
            return;
        this.updateSent = true;
        this.send(sessionUpdate(this.prefs));
    }
    publishTelemetry(snapshot) {
        this.callbacks.onTelemetry?.(snapshot);
        if (typeof window === 'undefined')
            return;
        const target = window;
        target.__VALUEHUB_VOICE_TELEMETRY__ = snapshot;
        window.dispatchEvent(new CustomEvent('valuehub:voice-telemetry', { detail: snapshot }));
    }
}
function normalizeSdp(sdp) {
    return sdp.replace(/\r?\n/g, '\r\n').replace(/(?:\r\n)*$/, '\r\n');
}
async function waitForIce(peer, timeoutMs) {
    if (peer.iceGatheringState === 'complete')
        return;
    await new Promise(resolve => {
        const timer = setTimeout(done, timeoutMs);
        function done() {
            clearTimeout(timer);
            peer.removeEventListener('icegatheringstatechange', changed);
            resolve();
        }
        function changed() { if (peer.iceGatheringState === 'complete')
            done(); }
        peer.addEventListener('icegatheringstatechange', changed);
    });
}
