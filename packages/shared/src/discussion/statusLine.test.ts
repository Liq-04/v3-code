import { describe, expect, it } from "vite-plus/test";

import {
  startStatusTimer,
  statusLine,
  type StatusTimerInput,
  type StatusToolCall,
  stepStatusTimer,
} from "./statusLine.ts";

describe("statusLine", () => {
  it.each<[StatusToolCall, string]>([
    [
      { action: "read", targets: ["apps/web/src/components/chat/ChatComposer.tsx"] },
      "Reading ChatComposer",
    ],
    [{ action: "read", targets: ["a.ts", "b.ts", "a.ts"] }, "Reading two files"],
    [{ action: "read", targets: [".env"] }, "Reading .env"],
    [{ action: "file_change", targets: ["a.ts", "b.ts", "c.ts"] }, "Editing three files"],
    [{ action: "file_change", targets: ["src\\Main.cs"] }, "Editing Main"],
    [{ action: "file_change", targets: [] }, "Editing files"],
    [{ action: "search", targets: ["useTheme"] }, "Searching the code"],
    [
      { action: "command", targets: ["cd apps/server && vp test run src/ws.test.ts"] },
      "Running the tests",
    ],
    [{ action: "command", targets: ["CI=1 cargo test"] }, "Running the tests"],
    [{ action: "command", targets: ["vp run typecheck"] }, "Running the type checker"],
    [{ action: "command", targets: ["npm run lint"] }, "Running the linter"],
    [{ action: "command", targets: ["vp i"] }, "Installing dependencies"],
    [{ action: "command", targets: ["pnpm build"] }, "Building"],
    [{ action: "command", targets: ["rg useTheme | head -20"] }, "Searching the code"],
    [{ action: "command", targets: ["git commit -m wip"] }, "Committing"],
    [{ action: "command", targets: ["git status"] }, "Checking git"],
    [{ action: "command", targets: ["node scripts/check.ts"] }, "Running node"],
    [{ action: "command", targets: ["./scripts/run-everything.sh"] }, "Running a command"],
    [{ action: "other", targets: [] }, "Working on it"],
  ])("%o says %s", (call, line) => {
    expect(statusLine(call)).toBe(line);
  });
});

describe("stepStatusTimer", () => {
  const tests: StatusToolCall = { action: "command", targets: ["vp test run"] };
  const read: StatusToolCall = { action: "read", targets: ["ChatComposer.tsx"] };
  const tick = (at: number, call: StatusToolCall | null = tests, run = "running" as const) => ({
    type: "tick" as const,
    at,
    run,
    call,
  });

  it.each<[string, ReadonlyArray<StatusTimerInput>, ReadonlyArray<string | null>]>([
    [
      "speaks only after 4 s of agent silence",
      [tick(3_999), tick(4_000)],
      [null, "Running the tests"],
    ],
    [
      "speaks at most once every 8 s, and not the same line twice in a row",
      [tick(4_000), tick(8_000, read), tick(12_000, read), tick(20_000, read), tick(20_000, tests)],
      ["Running the tests", null, "Reading ChatComposer", null, "Running the tests"],
    ],
    [
      "restarts the silence when agent text arrives",
      [{ type: "agentText", at: 3_000 }, tick(6_000), tick(7_000)],
      [null, null, "Running the tests"],
    ],
    [
      "restarts the silence when the user sends a line",
      [{ type: "line", at: 10_000 }, tick(13_000), tick(14_000)],
      [null, null, "Running the tests"],
    ],
    [
      "stays quiet without a running turn or a tool call",
      [
        { type: "tick", at: 10_000, run: "needsApproval", call: tests },
        { type: "tick", at: 10_000, run: "idle", call: tests },
        tick(10_000, null),
      ],
      [null, null, null],
    ],
  ])("%s", (_name, inputs, said) => {
    let state = startStatusTimer(0);
    const out = inputs.map((input) => {
      const step = stepStatusTimer(state, input);
      state = step.state;
      return step.say;
    });
    expect(out).toEqual(said);
  });

  it("drops an unplayed status line when agent text arrives", () => {
    expect(stepStatusTimer(startStatusTimer(0), { type: "agentText", at: 1 }).drop).toBe(true);
  });
});
