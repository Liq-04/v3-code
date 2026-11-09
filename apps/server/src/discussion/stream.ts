import {
  AuthOrchestrationOperateScope,
  DISCUSSION_STREAM_PATH,
  DiscussionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DiscussionService from "./DiscussionService.ts";

const decodeDiscussionId = Schema.decodeUnknownOption(DiscussionId);

/** The call's media socket: audio both ways, framed like /ws/voice and authenticated the same. */
export const discussionStreamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const discussions = yield* DiscussionService.DiscussionService;
    return HttpRouter.add(
      "GET",
      DISCUSSION_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const discussionId = decodeDiscussionId(
          new URL(request.url, "http://localhost").searchParams.get("discussionId"),
        );
        if (Option.isNone(discussionId)) return HttpServerResponse.empty({ status: 400 });
        const socket = yield* request.upgrade;
        yield* discussions.attach(discussionId.value, socket);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
