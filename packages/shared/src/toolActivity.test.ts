import { type OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  dynamicToolSurface,
  isFileTouchingTurnItem,
  mergeToolActivityData,
  turnItemReadPaths,
  turnItemTouchedFile,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("names the file a turn item touches", () => {
    const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const base = {
      id: TurnItemId.make("item"),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    };
    const read = (input: unknown): OrchestrationV2TurnItem => ({
      ...base,
      type: "dynamic_tool",
      toolName: "Read",
      input,
    });
    const cases: ReadonlyArray<
      [OrchestrationV2TurnItem, ReturnType<typeof turnItemTouchedFile>, boolean]
    > = [
      [
        { ...base, type: "file_change", fileName: "/repo/src/a.ts" },
        { path: "/repo/src/a.ts", op: "edit" },
        true,
      ],
      [read({ file_path: "/repo/src/b.ts" }), { path: "/repo/src/b.ts", op: "read" }, true],
      [read({ path: "/repo/src/c.ts", offset: 10 }), { path: "/repo/src/c.ts", op: "read" }, true],
      [read({ filePath: "/repo/src/d.ts" }), { path: "/repo/src/d.ts", op: "read" }, true],
      [read({}), undefined, true],
      [
        read({ path: "/repo/src/g.ts", locations: [{ path: "/repo/src/h.ts" }] }),
        { path: "/repo/src/g.ts", op: "read" },
        true,
      ],
      [
        {
          ...base,
          type: "dynamic_tool",
          toolName: "Bash",
          input: { command: "ls", path: "/repo" },
        },
        undefined,
        false,
      ],
      [{ ...base, type: "command_execution", input: "cat /repo/src/a.ts" }, undefined, false],
      [
        {
          ...base,
          type: "command_execution",
          input: "cat /repo/src/e.ts /repo/src/f.ts",
          readPaths: ["/repo/src/e.ts", "/repo/src/f.ts"],
        },
        { path: "/repo/src/e.ts", op: "read" },
        true,
      ],
      [{ ...base, type: "command_execution", input: "ls", readPaths: [] }, undefined, false],
      [
        {
          ...base,
          type: "dynamic_tool",
          toolName: "Grep",
          input: { pattern: "foo", path: "/repo/src" },
          readPaths: ["src/i.ts", "src/j.ts"],
        },
        { path: "src/i.ts", op: "read" },
        true,
      ],
    ];
    for (const [item, touched, touching] of cases) {
      expect(turnItemTouchedFile(item)).toEqual(touched);
      expect(isFileTouchingTurnItem(item)).toBe(touching);
    }
    expect(
      cases.map(([item]) => turnItemReadPaths(item)).filter((paths) => paths.length > 0),
    ).toEqual([
      ["/repo/src/b.ts"],
      ["/repo/src/c.ts"],
      ["/repo/src/d.ts"],
      ["/repo/src/g.ts", "/repo/src/h.ts"],
      ["/repo/src/e.ts", "/repo/src/f.ts"],
      ["src/i.ts", "src/j.ts"],
    ]);
  });

  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the previous rawInput when a later update is empty and replaces it otherwise", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { startLine: 4 } });
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });
});
