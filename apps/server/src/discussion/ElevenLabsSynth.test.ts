import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import * as SecretResolver from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  DiscussionSynth,
  ELEVENLABS_CLOSE_MESSAGE,
  elevenLabsOpenMessage,
  elevenLabsSayMessage,
  elevenLabsStreamUrl,
  layerElevenLabs,
  parseElevenLabsFrame,
} from "./ElevenLabsSynth.ts";

/** Like a browser WebSocket: it exists only once the client starts reading, and records sends. */
class FakeWebSocket extends EventTarget {
  static created: Array<FakeWebSocket> = [];
  readonly readyState = 1;
  binaryType = "blob";
  readonly sent: Array<unknown> = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.created.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {}
}

it.effect("opening a voice session connects and sends the key before any line", () =>
  Effect.gen(function* () {
    FakeWebSocket.created = [];
    const synth = yield* DiscussionSynth;
    const session = yield* synth.open();
    yield* session.say("Running the tests.");
    const [socket] = FakeWebSocket.created;
    assert.deepEqual(socket?.sent, [
      elevenLabsOpenMessage("key"),
      elevenLabsSayMessage("Running the tests."),
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerElevenLabs.pipe(
        Layer.provide(SecretResolver.layer),
        Layer.provideMerge(
          ServerSettings.layerTest({ voiceSynthesis: { elevenlabs: "key", voiceId: "" } }),
        ),
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (url) => new FakeWebSocket(url) as unknown as globalThis.WebSocket,
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it("frames the stream-input protocol: flash model, 24 kHz PCM, flushed lines, explicit close", () => {
  const url = new URL(elevenLabsStreamUrl("EST9Ui6982FZPSi7gCHi"));
  assert.equal(url.pathname, "/v1/text-to-speech/EST9Ui6982FZPSi7gCHi/stream-input");
  assert.equal(url.searchParams.get("model_id"), "eleven_flash_v2_5");
  assert.equal(url.searchParams.get("output_format"), "pcm_24000");
  assert.deepEqual(JSON.parse(elevenLabsOpenMessage("secret")), {
    text: " ",
    xi_api_key: "secret",
  });
  assert.deepEqual(JSON.parse(elevenLabsSayMessage("Running the tests.")), {
    text: "Running the tests. ",
    flush: true,
  });
  assert.deepEqual(JSON.parse(ELEVENLABS_CLOSE_MESSAGE), { text: "" });
});

it.effect("decodes audio chunks, the final marker and provider errors", () =>
  Effect.gen(function* () {
    const audio = yield* parseElevenLabsFrame(
      JSON.stringify({ audio: Buffer.from([1, 2, 3]).toString("base64"), isFinal: null }),
    );
    assert.deepEqual(audio, { type: "audio", pcm: new Uint8Array([1, 2, 3]) });
    assert.deepEqual(yield* parseElevenLabsFrame(JSON.stringify({ audio: null, isFinal: true })), {
      type: "final",
    });
    assert.deepEqual(yield* parseElevenLabsFrame(JSON.stringify({ alignment: {} })), {
      type: "none",
    });
    const failure = yield* Effect.flip(
      parseElevenLabsFrame(JSON.stringify({ error: "quota_exceeded", message: "No credits." })),
    );
    assert.equal(failure.reason, "provider");
    const garbage = yield* Effect.flip(parseElevenLabsFrame("not json"));
    assert.equal(garbage.reason, "protocol");
  }),
);
