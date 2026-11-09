import * as NodeBuffer from "node:buffer";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Speech synthesis for a discussion: one session per agent reply, text in as it is written,
 * 24 kHz Int16 mono PCM out. `DiscussionSynth` is the port; `layerElevenLabs` speaks ElevenLabs'
 * `stream-input` protocol over a WebSocket, opened when the user's line is sent so the connect
 * overlaps the model's first token.
 */

const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const ELEVENLABS_DEFAULT_VOICE_ID = "EST9Ui6982FZPSi7gCHi";
const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";
/** Seconds the socket may wait for text; the model's first sentence can take a while. */
const ELEVENLABS_INACTIVITY_TIMEOUT_S = 180;

export class SynthError extends Schema.TaggedError<SynthError>()("SynthError", {
  reason: Schema.Literals(["not_configured", "connect", "protocol", "provider"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "No voice synthesis key is configured.";
      case "connect":
        return "Could not connect to the voice synthesizer.";
      case "protocol":
        return "The voice synthesizer sent an unexpected message.";
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
    /** Closing the scope cuts the session: the socket closes and `audio` ends. */
    readonly open: () => Effect.Effect<SynthSession, SynthError, Scope.Scope>;
  }
>()("t3/discussion/ElevenLabsSynth/DiscussionSynth") {}

// The stream-input protocol, kept as data so tests check framing without a socket.

export function elevenLabsStreamUrl(voiceId: string): string {
  const query = new URLSearchParams({
    model_id: ELEVENLABS_MODEL_ID,
    output_format: ELEVENLABS_OUTPUT_FORMAT,
    inactivity_timeout: String(ELEVENLABS_INACTIVITY_TIMEOUT_S),
  });
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`;
}

/** The first message authenticates and tunes the stream; a single space primes the voice. */
export const elevenLabsOpenMessage = (apiKey: string) =>
  JSON.stringify({ text: " ", xi_api_key: apiKey });

/** A spoken line, flushed so its audio is generated now rather than batched with the next. */
export const elevenLabsSayMessage = (text: string) =>
  JSON.stringify({ text: text.endsWith(" ") ? text : `${text} `, flush: true });

export const ELEVENLABS_CLOSE_MESSAGE = JSON.stringify({ text: "" });

const ElevenLabsServerMessage = Schema.Struct({
  audio: Schema.optional(Schema.NullOr(Schema.String)),
  isFinal: Schema.optional(Schema.NullOr(Schema.Boolean)),
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeServerMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ElevenLabsServerMessage),
);

export type ElevenLabsFrame =
  | { readonly type: "audio"; readonly pcm: Uint8Array }
  | { readonly type: "final" }
  | { readonly type: "none" };

export const parseElevenLabsFrame = Effect.fn("ElevenLabsSynth.parseFrame")(function* (
  data: string | Uint8Array,
): Effect.fn.Return<ElevenLabsFrame, SynthError> {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const message = yield* decodeServerMessage(text).pipe(
    Effect.mapError((cause) => new SynthError({ reason: "protocol", cause })),
  );
  if (message.error !== undefined) {
    return yield* new SynthError({ reason: "provider", cause: new Error(message.error) });
  }
  if (message.isFinal === true) return { type: "final" };
  if (typeof message.audio === "string" && message.audio.length > 0) {
    return {
      type: "audio",
      pcm: new Uint8Array(NodeBuffer.Buffer.from(message.audio, "base64")),
    };
  }
  return { type: "none" };
});

const isSynthError = Schema.is(SynthError);
const isSocketClose = (error: Socket.SocketError) => error.reason._tag === "SocketCloseError";

export const layerElevenLabs: Layer.Layer<
  DiscussionSynth,
  never,
  ServerSettings.ServerSettingsService | SecretResolver.SecretResolver | Socket.WebSocketConstructor
> = Layer.effect(
  DiscussionSynth,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const makeWebSocket = yield* Socket.WebSocketConstructor;

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
        const socket = yield* Socket.makeWebSocket(elevenLabsStreamUrl(voiceId), {
          openTimeout: "10 seconds",
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, makeWebSocket));
        const writer = yield* socket.writer;
        const write = (message: string) =>
          writer
            .write(message)
            .pipe(Effect.mapError((cause) => new SynthError({ reason: "connect", cause })));
        yield* write(elevenLabsOpenMessage(apiKey));

        const frames = yield* Queue.unbounded<Uint8Array, SynthError | Cause.Done>();
        const reader = yield* socket.reader.pipe(
          Effect.mapError((cause) => new SynthError({ reason: "connect", cause })),
        );
        yield* Effect.gen(function* () {
          while (true) {
            const chunk = yield* reader.pull;
            for (const data of chunk) {
              const frame = yield* parseElevenLabsFrame(data);
              if (frame.type === "audio") yield* Queue.offer(frames, frame.pcm);
              if (frame.type === "final") return yield* Queue.end(frames);
            }
          }
        }).pipe(
          Effect.catch((error) =>
            isSynthError(error)
              ? Queue.fail(frames, error)
              : isSocketClose(error)
                ? Queue.end(frames)
                : Queue.fail(frames, new SynthError({ reason: "connect", cause: error })),
          ),
          Effect.forkScoped,
        );

        return {
          say: (text) => write(elevenLabsSayMessage(text)),
          finish: write(ELEVENLABS_CLOSE_MESSAGE),
          audio: Stream.fromQueue(frames),
        } satisfies SynthSession;
      },
    );

    return DiscussionSynth.of({ open });
  }),
);
