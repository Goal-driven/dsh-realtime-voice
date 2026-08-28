export const VOICE_SETTINGS_NAMESPACE = 'dsh-realtime-voice';
/**
 * Register both keyed and list identifiers so the settings card loads on the
 * current Harness keyed slot and on older list-slot hosts.
 */
export function voiceSettingsSlotRegistration() {
    return {
        name: 'settings.plugin.item',
        key: VOICE_SETTINGS_NAMESPACE,
        id: 'realtime-voice-settings',
        order: 25,
    };
}
