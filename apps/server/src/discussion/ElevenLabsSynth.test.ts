import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as SecretResolver from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DiscussionSynth, layerElevenLabs } from "./ElevenLabsSynth.ts";

interface SentRequest {
  readonly url: URL;
  readonly key: string | undefined;
  readonly body: Record<string, unknown>;
}

/** ElevenLabs as seen over HTTP: records each request and streams back the given chunks. */
const fakeElevenLabs = (reply: (body: Record<string, unknown>) => Response) => {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
        : {};
    sent.push({ url: new URL(request.url), key: request.headers["xi-api-key"], body });
    return Effect.succeed(HttpClientResponse.fromWeb(request, reply(body)));
  });
  return { sent, client };
};

const chunked = (...chunks: ReadonlyArray<ReadonlyArray<number>>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        controller.close();
      },
    }),
  );

const withSynth = (client: HttpClient.HttpClient) =>
  Effect.provide(
    layerElevenLabs.pipe(
      Layer.provide(SecretResolver.layer),
      Layer.provideMerge(
        ServerSettings.layerTest({ voiceSynthesis: { elevenlabs: "key", voiceId: "" } }),
      ),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

it.effect("speaks each sentence as its own request, in order, carrying the one before", () => {
  const elevenLabs = fakeElevenLabs((body) =>
    body.text === "Running the tests." ? chunked([1, 2, 3], [4]) : chunked([5, 6]),
  );
  return Effect.gen(function* () {
    const session = yield* (yield* DiscussionSynth).open();
    yield* session.say("Running the tests.");
    yield* session.say("Back in a second.");
    yield* session.finish;
    const audio = yield* Stream.runCollect(session.audio);

    assert.deepEqual(
      audio.map((pcm) => [...pcm]),
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    );
    assert.deepEqual(
      elevenLabs.sent.map(({ url, key, body }) => ({
        path: url.pathname,
        format: url.searchParams.get("output_format"),
        key,
        body,
      })),
      [
        {
          path: "/v1/text-to-speech/EST9Ui6982FZPSi7gCHi/stream",
          format: "pcm_24000",
          key: "key",
          body: {
            text: "Running the tests.",
            model_id: "eleven_v4_turbo",
            voice_settings: { stability: 0.4 },
          },
        },
        {
          path: "/v1/text-to-speech/EST9Ui6982FZPSi7gCHi/stream",
          format: "pcm_24000",
          key: "key",
          body: {
            text: "Back in a second.",
            model_id: "eleven_v4_turbo",
            voice_settings: { stability: 0.4 },
            previous_text: "Running the tests.",
          },
        },
      ],
    );
  }).pipe(Effect.scoped, withSynth(elevenLabs.client));
});

it.effect("a refused key ends the audio with a configuration error", () => {
  const elevenLabs = fakeElevenLabs(() => new Response("unauthorized", { status: 401 }));
  return Effect.gen(function* () {
    const session = yield* (yield* DiscussionSynth).open();
    yield* session.say("Running the tests.");
    const failure = yield* Effect.flip(Stream.runCollect(session.audio));
    assert.equal(failure.reason, "not_configured");
  }).pipe(Effect.scoped, withSynth(elevenLabs.client));
});
