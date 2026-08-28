import type { VoiceController } from './controller.ts';
export declare function microphoneButtonPresentation(active: boolean, provider: 'qwen' | 'openai'): {
    ariaLabel: string;
    title: string;
    style: {
        readonly width: 38;
        readonly height: 38;
        readonly border: "1px solid var(--dsw-alias-border-l2)";
        readonly borderRadius: 999;
        readonly cursor: "pointer";
        readonly display: "grid";
        readonly placeItems: "center";
        readonly color: "var(--dsw-alias-label-primary)" | "#fff";
        readonly background: "var(--dsw-alias-bg-base)" | "#2563eb";
        readonly boxShadow: "0 0 0 3px color-mix(in srgb, #2563eb 22%, transparent)" | "0 1px 2px rgb(0 0 0 / 10%)";
        readonly flex: "0 0 auto";
    };
};
export declare function MicButton({ controller }: {
    controller: VoiceController;
}): import("react").JSX.Element;
interface NativeInputProps {
    input: {
        readonly draft: string;
        readonly draftRev: number;
        readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    };
    inputActions: {
        setDraft(text: string): void;
        submit(): void;
    };
}
export declare function VoiceStatus({ controller, input, inputActions }: {
    controller: VoiceController;
} & NativeInputProps): import("react").JSX.Element | null;
export declare function SettingsCard(): import("react").JSX.Element;
export {};
