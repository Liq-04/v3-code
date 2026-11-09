import { CODEX_FILE_ACTIVITY_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function codexFileActivityInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CODEX_FILE_ACTIVITY_PROMPT }],
  };
}
