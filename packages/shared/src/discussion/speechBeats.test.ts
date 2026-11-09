import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  captionText,
  emptySpeechBeats,
  type SpeechBeatsInput,
  startSpeechBeats,
  stepSpeechBeats,
} from "./speechBeats.ts";

const A = MessageId.make("message-a");
const B = MessageId.make("message-b");

const text = (messageId: MessageId, value: string, at = 0, complete = false): SpeechBeatsInput => ({
  type: "text",
  messageId,
  text: value,
  complete,
  at,
});
const done = (messageId: MessageId, value: string, at = 0) => text(messageId, value, at, true);
const fromRun = (
  runId: RunId,
  messageId: MessageId,
  value: string,
  complete = false,
): SpeechBeatsInput => ({ type: "text", messageId, runId, text: value, complete, at: 0 });

/** The beats each input produced, in order. */
function run(inputs: ReadonlyArray<SpeechBeatsInput>): ReadonlyArray<ReadonlyArray<string>> {
  let state = emptySpeechBeats;
  return inputs.map((input) => {
    const step = stepSpeechBeats(state, input);
    state = step.state;
    return step.beats;
  });
}

describe("stepSpeechBeats", () => {
  it("holds a reply already being written when the call started until the first line", () => {
    const earlier = RunId.make("run-earlier");
    const later = RunId.make("run-later");
    const inputs: ReadonlyArray<SpeechBeatsInput> = [
      fromRun(earlier, A, "I started on the composer. Then the strip."),
      fromRun(later, B, "A typed question gets an answer. Yes"),
      { type: "line" },
      fromRun(
        earlier,
        A,
        "I started on the composer. Then the strip. Checking the tests too.",
        true,
      ),
    ];
    let state = startSpeechBeats([earlier]);
    const beats = inputs.map((input) => {
      const step = stepSpeechBeats(state, input);
      state = step.state;
      return step.beats;
    });
    expect(beats).toEqual([
      [],
      ["A typed question gets an answer."],
      [],
      ["Checking the tests too."],
    ]);
  });

  it.each<[string, ReadonlyArray<SpeechBeatsInput>, ReadonlyArray<ReadonlyArray<string>>]>([
    [
      "speaks a sentence once whitespace confirms its end, and the tail when the message ends",
      [
        text(A, "Hello there. How are"),
        text(A, "Hello there. How are you? Fine"),
        done(A, "Hello there. How are you? Fine"),
      ],
      [["Hello there."], ["How are you?"], ["Fine"]],
    ],
    [
      "does not split at an ellipsis, a decimal or a file extension",
      [done(A, "Well... version 3.14 of index.ts is out. Next")],
      [["Well... version 3.14 of index.ts is out.", "Next"]],
    ],
    [
      "strips markdown and splits at lines",
      [
        done(
          A,
          "## Plan\n- **Read** `ChatComposer.tsx`\n- Run [the tests](https://x.test)\n1. First step\n2) _Second_ step\n---\n",
        ),
      ],
      [["Plan", "Read ChatComposer.tsx", "Run the tests", "First step", "Second step"]],
    ],
    [
      "turns a code fence into one beat, even when its markers arrive in pieces",
      [
        text(A, "Here it is:\n``"),
        text(A, "Here it is:\n```ts\nconst a = 1;"),
        text(A, "Here it is:\n```ts\nconst a = 1;\n``"),
        text(A, "Here it is:\n```ts\nconst a = 1;\n```\n```sh\nvp test\n```\nThat's all"),
        done(A, "Here it is:\n```ts\nconst a = 1;\n```\n```sh\nvp test\n```\nThat's all"),
      ],
      [["Here it is:"], ["the code is in the thread"], [], [], ["That's all"]],
    ],
    [
      "never speaks text written before the user's latest line",
      [
        text(A, "First sentence. Second part"),
        { type: "line" },
        done(A, "First sentence. Second part"),
        done(B, "Answer to your line."),
      ],
      [["First sentence."], [], [], ["Answer to your line."]],
    ],
    [
      "keeps a fence that opens across the watermark out of speech",
      [text(A, "Look\n``"), { type: "line" }, done(A, "Look\n```ts\nsecret();\n```\nOk.")],
      [["Look"], [], ["the code is in the thread", "Ok."]],
    ],
    [
      "cuts a long run-on at its last clause after 1.2 s",
      [
        text(A, "This is a long sentence without an end, and it keeps going on", 0),
        { type: "tick", at: 1_199 },
        { type: "tick", at: 1_200 },
        { type: "tick", at: 2_000 },
        done(A, "This is a long sentence without an end, and it keeps going on", 2_100),
      ],
      [[], [], ["This is a long sentence without an end,"], [], ["and it keeps going on"]],
    ],
    [
      "cuts at a word when a long run-on has no clause",
      [
        text(A, "Looking through every single file in this directory right now", 0),
        { type: "tick", at: 1_200 },
      ],
      [[], ["Looking through every single file in this directory right"]],
    ],
    [
      "points to a table once instead of reading its rows, even as rows arrive",
      [
        text(A, "Here are the results.\n\n| Step | Re"),
        text(
          A,
          "Here are the results.\n\n| Step | Result |\n| --- | --- |\n| Test | 12 passed |\n",
        ),
        done(
          A,
          "Here are the results.\n\n| Step | Result |\n| --- | --- |\n| Test | 12 passed |\n\nAll good.",
        ),
      ],
      [["Here are the results."], ["the table is in the thread"], ["All good."]],
    ],
    [
      "waits for a sentence end when fewer than 40 characters are unspoken",
      [text(A, "Okay, so", 0), { type: "tick", at: 60_000 }],
      [[], []],
    ],
    [
      "restarts the wait once a sentence is spoken",
      [
        text(A, "Sure", 0),
        text(A, "Sure. Now the long part, which goes on for quite a while", 1_000),
        { type: "tick", at: 1_300 },
        { type: "tick", at: 2_200 },
      ],
      [[], ["Sure."], [], ["Now the long part,"]],
    ],
  ])("%s", (_name, inputs, beats) => {
    expect(run(inputs)).toEqual(beats);
  });
});

describe("captionText", () => {
  it("drops audio tags the voice performs and keeps the words", () => {
    expect(captionText("[chuckles] Okay... I'll run it NOW. [thoughtful]")).toBe(
      "Okay... I'll run it NOW.",
    );
    expect(captionText("[sighs]")).toBe("");
  });
});
