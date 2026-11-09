import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  CODEX_FILE_ACTIVITY_PROMPT,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";

export function assertCodexFileActivityOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CODEX_FILE_ACTIVITY_PROMPT]);

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.lengthOf(commands, 1, "a read command adds no row beside its command item");
  assert.deepEqual(commands[0]?.readPaths, ["/home/replay-user/t3code/apps/server/package.json"]);

  const patches = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(patches, 1, "the running patch and the completed patch share one item");
  assert.equal(patches[0]?.status, "completed");

  const patchStatuses = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.id === patches[0]?.id
      ? [event.payload.status]
      : [],
  );
  assert.deepEqual(patchStatuses, ["running", "completed"]);
}
