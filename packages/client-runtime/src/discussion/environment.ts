import { DISCUSSION_STREAM_PATH, type DiscussionId } from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { getEnvironmentMediaStreamUrl } from "../voice-input/environment.ts";

export const getEnvironmentDiscussionStreamUrl = (
  prepared: PreparedConnection,
  discussionId: DiscussionId,
) => getEnvironmentMediaStreamUrl(prepared, DISCUSSION_STREAM_PATH, { discussionId });
