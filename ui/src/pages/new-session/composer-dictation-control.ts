import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  renderComposerVoiceButton,
  renderMicrophonePicker,
} from "../chat/components/chat-composer-controls.ts";
import { ComposerDictationController } from "../chat/composer-dictation.ts";
import { ComposerMicrophonePicker } from "../chat/composer-microphone-picker.ts";
import type { NewSessionComposerTextareaController } from "./composer.ts";

type NewSessionDictationOptions = {
  textarea: NewSessionComposerTextareaController;
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  requestUpdate: () => void;
};

/**
 * Dictation for the new-session draft: hold the microphone, speak, release, and
 * the transcript lands at the caret.
 *
 * Deliberately dictation only. The chat composer's microphone doubles as a Talk
 * toggle, but Talk needs a live session and this composer exists precisely
 * because there is not one yet, so a plain tap has nothing to start and says so
 * instead of silently doing nothing.
 */
export class NewSessionDictationControl {
  private readonly devicePicker: ComposerMicrophonePicker;
  private dictation: ComposerDictationController | null = null;

  constructor(private readonly options: NewSessionDictationOptions) {
    this.devicePicker = new ComposerMicrophonePicker(options.requestUpdate);
  }

  dispose(): void {
    this.dictation?.dispose();
    this.dictation = null;
    this.devicePicker.dispose();
  }

  render() {
    const client = this.options.getClient();
    const connected = this.options.isConnected() && client !== null;
    const dictationOptions = {
      client,
      connected,
      enabled: true,
      realtimeTalkActive: false,
      onCommit: (transcript: string) => {
        const next = this.options.textarea.insertTranscript(transcript);
        if (next !== null) {
          this.options.onMessage(next);
        }
        this.options.requestUpdate();
      },
      onError: this.options.onError,
      onStateChange: this.options.requestUpdate,
      onTap: () => this.options.onError(t("newSession.dictationHoldToSpeak")),
    };
    this.dictation ??= new ComposerDictationController(dictationOptions);
    this.dictation.update(dictationOptions);
    const dictation = this.dictation;

    return renderComposerVoiceButton({
      connected,
      sending: false,
      isBusy: false,
      dictation,
      idleLabel: t("newSession.dictate"),
      microphonePicker: renderMicrophonePicker({
        devices: this.devicePicker.devices,
        loading: this.devicePicker.loading,
        open: this.devicePicker.open,
        selectedDeviceId: loadSettings().realtimeTalkInputDeviceId?.trim() ?? "",
        voiceActive: false,
        issue: this.devicePicker.issue,
        onOpen: this.devicePicker.handleOpen,
        onClose: this.devicePicker.handleClose,
        onSelect: (deviceId: string) => {
          patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
          this.devicePicker.handleClose();
        },
      }),
      onDictationPointerDown: (event: PointerEvent) => {
        this.options.textarea.captureSelection();
        dictation.handlePointerDown(event);
      },
    });
  }
}
