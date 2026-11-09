import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ELEVENLABS_CLOSE_MESSAGE,
  elevenLabsOpenMessage,
  elevenLabsSayMessage,
  elevenLabsStreamUrl,
  parseElevenLabsFrame,
} from "./ElevenLabsSynth.ts";

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
