export declare const VOICE_SETTINGS_NAMESPACE = "dsh-realtime-voice";
/**
 * Register both keyed and list identifiers so the settings card loads on the
 * current Harness keyed slot and on older list-slot hosts.
 */
export declare function voiceSettingsSlotRegistration(): {
    name: "settings.plugin.item";
    key: string;
    id: string;
    order: number;
};
