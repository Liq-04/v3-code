import type { ToolActivityAction } from "../toolActivity.ts";
import type { CallRun } from "./callPhase.ts";

const QUIET_BEFORE_STATUS_MS = 4_000;
const STATUS_INTERVAL_MS = 8_000;
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

export interface StatusToolCall {
  readonly action: ToolActivityAction;
  /** File paths for reads and edits, the command line for a command. */
  readonly targets: ReadonlyArray<string>;
}

/** A short spoken line for the agent's newest tool call, such as "Reading ChatComposer". */
export function statusLine({ action, targets }: StatusToolCall): string {
  switch (action) {
    case "read":
      return `Reading ${filesLabel(targets)}`;
    case "file_change":
      return `Editing ${filesLabel(targets)}`;
    case "search":
      return "Searching the code";
    case "command":
      return commandLine(targets[0] ?? "");
    case "other":
      return "Working on it";
  }
}

function filesLabel(paths: ReadonlyArray<string>) {
  const distinct = [...new Set(paths)];
  if (distinct.length === 0) return "files";
  if (distinct.length > 1) return `${NUMBER_WORDS[distinct.length] ?? distinct.length} files`;
  const [path = ""] = distinct;
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return name.replace(/(?<=.)\.[^.]+$/, "") || "a file";
}

function commandLine(command: string) {
  const segment =
    command
      .split(/&&|\|\||;|\|/)
      .map((part) => part.trim().replace(/^(?:\w+=\S*\s+)+/, ""))
      .find((part) => part !== "" && !/^cd\b/.test(part)) ?? "";
  const [program = "", subcommand = ""] = segment.split(/\s+/);
  const name = program.split("/").pop() ?? "";
  if (["rg", "grep", "find", "fd", "ag"].includes(name)) return "Searching the code";
  if (["cat", "head", "tail", "less", "bat"].includes(name)) return "Reading a file";
  if (["ls", "tree"].includes(name)) return "Looking around the project";
  if (name === "git") {
    if (subcommand === "commit") return "Committing";
    if (subcommand === "push") return "Pushing";
    return "Checking git";
  }
  if (name === "gh") return "Checking GitHub";
  if (["curl", "wget"].includes(name)) return "Making a request";
  if (/\b(?:test|tests|vitest|jest|pytest|mocha|rspec)\b/.test(segment)) return "Running the tests";
  if (/\b(?:typecheck|tsc|tsgo|mypy|pyright)\b/.test(segment)) return "Running the type checker";
  if (/\b(?:lint|eslint|oxlint|clippy|ruff)\b/.test(segment)) return "Running the linter";
  if (/\b(?:fmt|format|prettier)\b/.test(segment)) return "Formatting the code";
  if (/^(?:npm|pnpm|yarn|bun|vp|pip|cargo|brew)\s+(?:i|install|add)\b/.test(segment))
    return "Installing dependencies";
  if (/\bbuild\b/.test(segment)) return "Building";
  return /^[a-z][\w-]{0,15}$/i.test(name) ? `Running ${name}` : "Running a command";
}

/**
 * Fills long tool silences: a status line only after 4 s without agent text during a running
 * turn, at most one every 8 s, and not the same line twice in a row.
 */
export interface StatusTimer {
  readonly quietSince: number;
  readonly lastSaidAt: number | null;
  readonly lastLine: string | null;
}

export const startStatusTimer = (at: number): StatusTimer => ({
  quietSince: at,
  lastSaidAt: null,
  lastLine: null,
});

export type StatusTimerInput =
  | { readonly type: "agentText"; readonly at: number }
  | { readonly type: "line"; readonly at: number }
  | {
      readonly type: "tick";
      readonly at: number;
      readonly run: CallRun;
      readonly call: StatusToolCall | null;
    };

export interface StatusTimerStep {
  readonly state: StatusTimer;
  readonly say: string | null;
  /** Agent text arrived: drop any status line not yet played. */
  readonly drop: boolean;
}

export function stepStatusTimer(state: StatusTimer, input: StatusTimerInput): StatusTimerStep {
  if (input.type !== "tick") {
    return {
      state: { ...state, quietSince: input.at, lastLine: null },
      say: null,
      drop: input.type === "agentText",
    };
  }
  const line = input.run === "running" && input.call !== null ? statusLine(input.call) : null;
  const due =
    line !== null &&
    line !== state.lastLine &&
    input.at - state.quietSince >= QUIET_BEFORE_STATUS_MS &&
    (state.lastSaidAt === null || input.at - state.lastSaidAt >= STATUS_INTERVAL_MS);
  return due
    ? { state: { ...state, lastSaidAt: input.at, lastLine: line }, say: line, drop: false }
    : { state, say: null, drop: false };
}
