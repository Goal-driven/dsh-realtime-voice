import { useEffect, useState, useSyncExternalStore } from 'react'
import type { VoiceController } from './controller.ts'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import { deleteVoiceprint, getVoiceprintStatus, type VoiceprintStatus } from './voiceprint.ts'

const styles = {
  dock: { margin: '0 auto 4px', maxWidth: 760, padding: '5px 12px', borderRadius: '10px 10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-specific-tip)' },
  continueDock: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' },
  continueTitle: { flex: 'none', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  card: { listStyle: 'none', padding: '14px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  row: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, alignItems: 'center', marginTop: 10 },
  input: { minWidth: 0, padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
} as const

export function microphoneButtonPresentation(active: boolean, provider: 'qwen' | 'openai') {
  const providerLabel = provider === 'qwen' ? 'Qwen' : 'GPT-Realtime 2.1 Mini'
  return {
    ariaLabel: active ? 'Stoppa realtidsröst' : 'Starta realtidsröst',
    title: `${active ? 'Stoppa' : 'Starta'} realtidsröst (${providerLabel})`,
    style: {
      width: 38,
      height: 38,
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 999,
      cursor: 'pointer',
      display: 'grid',
      placeItems: 'center',
      color: active ? '#fff' : 'var(--dsw-alias-label-primary)',
      background: active ? '#2563eb' : 'var(--dsw-alias-bg-base)',
      boxShadow: active ? '0 0 0 3px color-mix(in srgb, #2563eb 22%, transparent)' : '0 1px 2px rgb(0 0 0 / 10%)',
      flex: '0 0 auto',
    } as const,
  }
}

export function MicButton({ controller }: { controller: VoiceController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = snapshot.state !== 'idle' && snapshot.state !== 'error'
  const presentation = microphoneButtonPresentation(active, snapshot.provider)
  return <button
    type="button"
    aria-label={presentation.ariaLabel}
    aria-pressed={active}
    title={presentation.title}
    style={presentation.style}
    onClick={() => { void controller.toggle() }}
  >
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z" /></svg>
  </button>
}

interface NativeInputProps {
  input: {
    readonly draft: string
    readonly draftRev: number
    readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  }
  inputActions: { setDraft(text: string): void; submit(): void }
}

export function VoiceStatus({ controller, input, inputActions }: { controller: VoiceController } & NativeInputProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.bindDraft({
    getDraft: () => input.draft,
    getDraftRev: () => input.draftRev,
    getPhase: () => input.phase,
    setDraft: text => inputActions.setDraft(text),
    submit: () => inputActions.submit(),
  }), [controller, input.draft, input.draftRev, input.phase, inputActions])
  if (snapshot.state === 'idle') return null
  const labels: Record<string, string> = { connecting: 'Ansluter', listening: 'Lyssnar', speaking: 'Talar', working: 'Harness arbetar', error: 'Röst är inte tillgänglig' }
  const continuePrefix = 'Fortsatt uppgift: '
  if (snapshot.detail.startsWith(continuePrefix)) return <div role="status" data-voice-continue-task="" style={{ ...styles.dock, ...styles.continueDock }}>
    <span aria-hidden="true">↪</span>
    <span style={styles.continueTitle}>Fortsatt uppgift</span>
    <span>{snapshot.detail.slice(continuePrefix.length)}</span>
  </div>
  return <div role={snapshot.state === 'error' ? 'alert' : 'status'} style={styles.dock}>
    {snapshot.provider === 'qwen' ? 'Qwen' : 'GPT'} · {labels[snapshot.state]}{snapshot.detail ? `: ${snapshot.detail}` : ''}
  </div>
}

export function SettingsCard() {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, loadPrefs)
  const [open, setOpen] = useState(false)
  const [voiceprint, setVoiceprint] = useState<VoiceprintStatus>({ configured: false, enrolled: false })
  const [voiceprintMessage, setVoiceprintMessage] = useState('')
  useEffect(() => {
    if (!open || prefs.provider !== 'qwen') return
    void getVoiceprintStatus().then(setVoiceprint)
  }, [open, prefs.provider, prefs.voiceprintEnabled])
  return <li style={styles.card}>
    <button type="button" onClick={() => setOpen(!open)} style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
      <strong>Realtidsröst (Qwen / GPT)</strong>
      <div style={{ opacity: .66, marginTop: 4 }}>Taligenkänning → Harness resonemang och plugins → talsyntes. Röstmodellen svarar aldrig direkt.</div>
    </button>
    {open && <div>
      <Field label="Leverantör"><select style={styles.input} value={prefs.provider} onChange={e => updatePrefs({ provider: e.currentTarget.value === 'qwen' ? 'qwen' : 'openai' })}><option value="openai">OpenAI GPT Realtime (standard)</option><option value="qwen">Qwen ASR / TTS</option></select></Field>
      {prefs.provider === 'qwen' ? <>
        <Field label="Workspace-ID"><input style={styles.input} value={prefs.qwenWorkspaceId} placeholder="Alibaba Cloud Bailian Workspace-ID" onChange={e => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })} /></Field>
        <Field label="Region"><select style={styles.input} value={prefs.qwenRegion} onChange={e => updatePrefs({ qwenRegion: e.currentTarget.value === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing' })}><option value="cn-beijing">Peking</option><option value="ap-southeast-1">Singapore</option></select></Field>
        <Field label="ASR-modell"><input style={styles.input} value={prefs.qwenAsrModel} onChange={e => updatePrefs({ qwenAsrModel: e.currentTarget.value })} /></Field>
        <Field label="TTS-modell"><input style={styles.input} value={prefs.qwenTtsModel} onChange={e => updatePrefs({ qwenTtsModel: e.currentTarget.value })} /></Field>
        <Field label="TTS-röst"><select style={styles.input} value={prefs.qwenTtsVoice} onChange={e => updatePrefs({ qwenTtsVoice: e.currentTarget.value })}><option value="Chelsie">Chelsie (mjuk)</option><option value="Cherry">Cherry (ljus)</option><option value="Serena">Serena (varm)</option><option value="Ethan">Ethan (manlig)</option></select></Field>
        <Field label="Rösttröskel"><input style={styles.input} type="number" min={-1} max={1} step={0.05} value={prefs.qwenVadThreshold} onChange={e => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="Tystnad (ms)"><input style={styles.input} type="number" min={200} max={6000} step={100} value={prefs.qwenSilenceMs} onChange={e => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="Sammanfoga tal (ms)"><input style={styles.input} type="number" min={100} max={5000} step={100} value={prefs.qwenMergeMs} onChange={e => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="Skicka följdtal automatiskt"><input type="checkbox" checked={prefs.voiceDraftAutoSend} onChange={e => updatePrefs({ voiceDraftAutoSend: e.currentTarget.checked })} /></Field>
        {prefs.voiceDraftAutoSend && <>
          <Field label={`Väntetid i utkast (ms, ≥${Math.max(500, prefs.qwenMergeMs)})`}><input style={styles.input} type="number" min={Math.max(500, prefs.qwenMergeMs)} max={6000} step={100} value={prefs.voiceDraftDwellMs} onChange={e => updatePrefs({ voiceDraftDwellMs: e.currentTarget.valueAsNumber })} /></Field>
          <Field label="Tillåt utan röstavtryck"><input type="checkbox" checked={prefs.voiceDraftAllowWithoutVoiceprint} onChange={e => updatePrefs({ voiceDraftAllowWithoutVoiceprint: e.currentTarget.checked })} /></Field>
          <Field label="Bekräfta känsliga instruktioner"><input type="checkbox" checked={prefs.voiceDraftSensitiveDeny} onChange={e => updatePrefs({ voiceDraftSensitiveDeny: e.currentTarget.checked })} /></Field>
        </>}
        <Field label="Kontroll med röstavtryck"><input type="checkbox" checked={prefs.voiceprintEnabled} onChange={e => updatePrefs({ voiceprintEnabled: e.currentTarget.checked })} /></Field>
        {prefs.voiceprintEnabled && <>
          <Field label="Godkänd poäng"><input style={styles.input} type="number" min={0} max={100} step={1} value={prefs.voiceprintThreshold} onChange={e => updatePrefs({ voiceprintThreshold: e.currentTarget.valueAsNumber })} /></Field>
          <Field label="Röstavtrycksstatus"><div>
            <span>{!voiceprint.configured ? 'Tencent Cloud-uppgifter saknas' : voiceprint.enrolled ? 'Registrerat' : 'Inte registrerat: öppna rösten igen och tala minst en sekund'}</span>
            {voiceprint.enrolled && <button type="button" style={{ ...styles.input, marginLeft: 8, cursor: 'pointer' }} onClick={() => {
              setVoiceprintMessage('Tar bort…')
              void deleteVoiceprint().then(result => {
                if (result.ok) { setVoiceprint({ ...voiceprint, enrolled: false }); setVoiceprintMessage('Borttaget') }
                else setVoiceprintMessage(result.error)
              })
            }}>Ta bort röstavtryck</button>}
            {voiceprintMessage && <div style={{ opacity: .66, fontSize: 12, marginTop: 4 }}>{voiceprintMessage}</div>}
          </div></Field>
        </>}
      </> : <>
        <Field label="Modell"><select style={styles.input} value={prefs.openaiModel} disabled><option value="gpt-realtime-2.1-mini">GPT-Realtime 2.1 Mini</option></select></Field>
        <Field label="Röst"><input style={styles.input} value={prefs.openaiVoice} onChange={e => updatePrefs({ openaiVoice: e.currentTarget.value })} /></Field>
      </>}
      <Field label="Väntan före tal (ms)"><input style={styles.input} type="number" min={400} max={3000} step={100} value={prefs.floorDelayMs} onChange={e => updatePrefs({ floorDelayMs: e.currentTarget.valueAsNumber })} /></Field>
      <Field label="Dynamisk väntfras"><input type="checkbox" checked={prefs.floorComposerEnabled} onChange={e => updatePrefs({ floorComposerEnabled: e.currentTarget.checked })} /></Field>
      {prefs.floorComposerEnabled && <Field label="Modell för väntfras"><input style={styles.input} value={prefs.provider === 'qwen' ? prefs.qwenFloorModel : prefs.openaiFloorModel} onChange={e => prefs.provider === 'qwen' ? updatePrefs({ qwenFloorModel: e.currentTarget.value }) : updatePrefs({ openaiFloorModel: e.currentTarget.value })} /></Field>}
      <Field label="Talstil"><textarea style={{ ...styles.input, minHeight: 84, resize: 'vertical' }} value={prefs.instructions} onChange={e => updatePrefs({ instructions: e.currentTarget.value })} /></Field>
      <p style={{ opacity: .66, fontSize: 12, lineHeight: 1.55 }}>Nycklar sparas aldrig i webbläsaren eller plugininställningarna. Harness tillhandahåller {prefs.provider === 'qwen' ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY'} via sin credential-tjänst. GPT-Realtime 2.1 Mini är standard; cacheträff, svarslatens och beräknad kostnad visas i GenUI Canvas. Text som fångas under pågående arbete läggs i utkastet och känsliga instruktioner kräver manuell bekräftelse.</p>
    </div>}
  </li>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={styles.row}><span>{label}</span>{children}</label>
}
