import {
  AuthSettingsWriteScope,
  DEFAULT_DISCUSSION_END_OF_SPEECH_MS,
  type DiscussionMicMode,
  type EnvironmentId,
  isSecretReference,
  type SecretReference,
} from "@t3tools/contracts";
import type { CSSProperties } from "react";

import {
  updateClientSettings,
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const MIC_MODE_LABELS: Record<DiscussionMicMode, string> = {
  open: "Open mic",
  push: "Push to talk",
};
const MIN_END_OF_SPEECH_MS = 300;
const MAX_END_OF_SPEECH_MS = 1_500;

function ElevenLabsKeyControl({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceSynthesis.elevenlabs,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const sources = useSecretSources(environmentId);
  const save = (elevenlabs: string | SecretReference) =>
    updateSettings({ voiceSynthesis: { elevenlabs } });
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-80">
      <SecretSourceInput
        aria-label="ElevenLabs API key"
        className="min-w-0 flex-1"
        value={isSecretReference(saved) ? saved : ""}
        sources={sources}
        configured={typeof saved === "string" && saved !== ""}
        disabled={!canManage}
        placeholder="Enter API key"
        onCommit={(next) => {
          if (next.trim()) save(next.trim());
        }}
        onSecretChange={(secret) => save(secret ?? "")}
      />
      {saved !== "" && canManage ? (
        <Button size="xs" variant="ghost-destructive" onClick={() => save("")}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function VoiceIdControl({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const voiceId = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceSynthesis.voiceId,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return (
    <DraftInput
      aria-label="ElevenLabs voice ID"
      className="w-full sm:w-56"
      size="sm"
      font="mono"
      value={voiceId}
      placeholder="Default voice"
      disabled={!canManage}
      spellCheck={false}
      autoComplete="off"
      onCommit={(next) => {
        const trimmed = next.trim();
        if (trimmed !== voiceId) updateSettings({ voiceSynthesis: { voiceId: trimmed } });
      }}
    />
  );
}

/** Settings → Voice → Discussions: the voice the agent answers in, and how the mic takes turns. */
export function DiscussionSettings() {
  const micMode = useClientSettings((settings) => settings.discussionMicMode);
  const endOfSpeechMs = useClientSettings((settings) => settings.discussionEndOfSpeechMs);
  const environment = useOptionalSettingsScope()?.environment ?? null;
  const ratio =
    (endOfSpeechMs - MIN_END_OF_SPEECH_MS) / (MAX_END_OF_SPEECH_MS - MIN_END_OF_SPEECH_MS);
  const sliderStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;

  return (
    <SettingsSection id={searchableSetting("voice-discussions").id} title="Discussions">
      <SettingsRow
        {...searchableSetting("discussion-elevenlabs-key")}
        title="ElevenLabs API key"
        description={
          environment
            ? `The agent answers in an ElevenLabs voice. The key stays on ${environment.label}, and anyone who can start a discussion there uses it.`
            : "Connect an environment to add the ElevenLabs key its discussions speak with."
        }
        control={
          environment ? <ElevenLabsKeyControl environmentId={environment.environmentId} /> : null
        }
      />
      {environment ? (
        <SettingsRow
          {...searchableSetting("discussion-voice-id")}
          title="Voice ID"
          description="An ElevenLabs voice ID, from the voice's page in ElevenLabs. Leave blank for the default voice."
          control={<VoiceIdControl environmentId={environment.environmentId} />}
        />
      ) : null}
      <SettingsRow
        {...searchableSetting("discussion-mic-mode")}
        title="Microphone"
        description="Open mic hears when you start and stop talking, and talking over the agent cuts it off; use headphones. Push to talk listens only while you hold the dictation shortcut or the strip's button."
        control={
          <Select
            value={micMode}
            onValueChange={(value) => {
              if (value) void updateClientSettings({ discussionMicMode: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Discussion microphone mode" className="max-w-48">
              <SelectValue>{MIC_MODE_LABELS[micMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MIC_MODE_LABELS) as DiscussionMicMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {MIC_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("discussion-end-of-speech")}
        title="End of speech"
        description="On open mic, how long a pause ends what you are saying. Shorter answers sooner; longer lets you pause to think."
        resetAction={
          endOfSpeechMs !== DEFAULT_DISCUSSION_END_OF_SPEECH_MS ? (
            <SettingResetButton
              label="end of speech"
              onClick={() =>
                void updateClientSettings({
                  discussionEndOfSpeechMs: DEFAULT_DISCUSSION_END_OF_SPEECH_MS,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="discussion-end-of-speech"
            >
              {endOfSpeechMs} ms
            </output>
            <input
              aria-label="End of speech"
              className="settings-slider min-w-0 flex-1"
              id="discussion-end-of-speech"
              min={MIN_END_OF_SPEECH_MS}
              max={MAX_END_OF_SPEECH_MS}
              step={100}
              disabled={micMode !== "open"}
              style={sliderStyle}
              type="range"
              value={endOfSpeechMs}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (
                  Number.isInteger(next) &&
                  next >= MIN_END_OF_SPEECH_MS &&
                  next <= MAX_END_OF_SPEECH_MS
                )
                  void updateClientSettings({ discussionEndOfSpeechMs: next });
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
