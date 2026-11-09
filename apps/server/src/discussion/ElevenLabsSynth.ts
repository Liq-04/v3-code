import type { VoiceSynthesisSettings } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Speech synthesis for a discussion: one session per agent reply, a sentence at a time in,
 * 24 kHz Int16 mono PCM out. `DiscussionSynth` is the port; `layerElevenLabs` sends each sentence
 * as its own streaming HTTP request, in order, because Eleven v4 has no text-to-speech WebSocket.
 */

const ELEVENLABS_MODEL_ID = "eleven_v4_turbo";
const ELEVENLABS_DEFAULT_VOICE_ID = "EST9Ui6982FZPSi7gCHi";
const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";

export class SynthError extends Schema.TaggedError<SynthError>()("SynthError", {
  reason: Schema.Literals(["not_configured", "connect", "provider"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "No voice synthesis key is configured.";
      case "connect":
        return "Could not connect to the voice synthesizer.";
      case "provider":
        return "The voice synthesizer rejected the request.";
    }
  }
}

export interface SynthSession {
  /** Queue a spoken line; its audio arrives on `audio`. */
  readonly say: (text: string) => Effect.Effect<void, SynthError>;
  /** No more text: remaining audio drains, then `audio` ends. */
  readonly finish: Effect.Effect<void, SynthError>;
  /** 24 kHz Int16 mono PCM frames. Ends after `finish` drains or the session closes. */
  readonly audio: Stream.Stream<Uint8Array, SynthError>;
}

export class DiscussionSynth extends Context.Service<
  DiscussionSynth,
  {
    /** Closing the scope cuts the session: the request in flight stops and `audio` ends. */
    readonly open: () => Effect.Effect<SynthSession, SynthError, Scope.Scope>;
  }
>()("t3/discussion/ElevenLabsSynth/DiscussionSynth") {}

/** A sentence's request; `previous` is the sentence before it, so intonation carries over. */
function elevenLabsSpeechRequest(input: {
  readonly voiceId: string;
  readonly apiKey: string;
  readonly text: string;
  readonly previous: string | null;
  readonly voice: Pick<VoiceSynthesisSettings, "stability" | "similarity" | "cloneStrength">;
}): HttpClientRequest.HttpClientRequest {
  return HttpClientRequest.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
  ).pipe(
    HttpClientRequest.setHeader("xi-api-key", input.apiKey),
    HttpClientRequest.bodyJsonUnsafe({
      text: input.text,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: {
        stability: input.voice.stability / 100,
        similarity_boost: input.voice.similarity / 100,
        clone_strength: input.voice.cloneStrength / 100,
      },
      ...(input.previous === null ? {} : { previous_text: input.previous }),
    }),
  );
}

/** Splits a byte stream into whole Int16 samples; HTTP chunks can end mid-sample. */
function makeSampleAligner() {
  let carry: number | null = null;
  return (chunk: Uint8Array): Uint8Array => {
    const bytes = carry === null ? chunk : Uint8Array.of(carry, ...chunk);
    const whole = bytes.length - (bytes.length % 2);
    carry = whole === bytes.length ? null : (bytes[whole] ?? null);
    return bytes.subarray(0, whole);
  };
}

export const layerElevenLabs: Layer.Layer<
  DiscussionSynth,
  never,
  ServerSettings.ServerSettingsService | SecretResolver.SecretResolver | HttpClient.HttpClient
> = Layer.effect(
  DiscussionSynth,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const httpClient = yield* HttpClient.HttpClient;

    const open: DiscussionSynth["Service"]["open"] = Effect.fn("ElevenLabsSynth.open")(
      function* () {
        const voice = (yield* settings.getSettings.pipe(
          Effect.mapError((cause) => new SynthError({ reason: "not_configured", cause })),
        )).voiceSynthesis;
        if (voice.elevenlabs === "") return yield* new SynthError({ reason: "not_configured" });
        const apiKey = yield* requireSettingsSecret(resolver, voice.elevenlabs).pipe(
          Effect.mapError((cause) => new SynthError({ reason: "not_configured", cause })),
        );
        const voiceId = voice.voiceId === "" ? ELEVENLABS_DEFAULT_VOICE_ID : voice.voiceId;

        const lines = yield* Queue.unbounded<string, Cause.Done>();
        const frames = yield* Queue.unbounded<Uint8Array, SynthError | Cause.Done>();
        const speakLine = Effect.fn("ElevenLabsSynth.speakLine")(function* (
          text: string,
          previous: string | null,
        ) {
          const response = yield* httpClient
            .execute(elevenLabsSpeechRequest({ voiceId, apiKey, text, previous, voice }))
            .pipe(Effect.mapError((cause) => new SynthError({ reason: "connect", cause })));
          if (response.status < 200 || response.status >= 300) {
            return yield* new SynthError({
              reason: response.status === 401 ? "not_configured" : "provider",
              cause: new Error(`ElevenLabs answered ${response.status}`),
            });
          }
          const align = makeSampleAligner();
          yield* response.stream.pipe(
            Stream.map(align),
            Stream.filter((pcm) => pcm.length > 0),
            Stream.runForEach((pcm) => Queue.offer(frames, pcm)),
            Effect.mapError((cause) => new SynthError({ reason: "connect", cause })),
          );
        });
        yield* Effect.gen(function* () {
          let previous: string | null = null;
          while (true) {
            const text = yield* Queue.take(lines);
            yield* speakLine(text, previous);
            previous = text;
          }
        }).pipe(
          Effect.catch((error) =>
            Cause.isDone(error) ? Queue.end(frames) : Queue.fail(frames, error),
          ),
          Effect.forkScoped,
        );

        return {
          say: (text) => Queue.offer(lines, text).pipe(Effect.asVoid),
          finish: Queue.end(lines).pipe(Effect.asVoid),
          audio: Stream.fromQueue(frames),
        } satisfies SynthSession;
      },
    );

    return DiscussionSynth.of({ open });
  }),
);
