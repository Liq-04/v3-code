import type { CodeMapPathMark, CodeMapSprite } from "@t3tools/client-runtime/state/code-map";
import type { ThreadId } from "@t3tools/contracts";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";

import type { SpriteHover } from "./CodeMapSprites";
import type { Size } from "./mapCamera";

const CARD_WIDTH = 224;
const CARD_GAP = 6;
const EDGE = 4;

export interface SpriteCardChanges {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export function spriteStatus(sprite: Pick<CodeMapSprite, "state" | "op" | "path">): string {
  if (sprite.state === "waiting") return "Needs your input";
  if (sprite.path === null) return sprite.state === "thinking" ? "Thinking" : "Working";
  const name = sprite.path.slice(sprite.path.lastIndexOf("/") + 1);
  if (sprite.state === "idle") return `Idle · last at ${name}`;
  if (sprite.state === "thinking") return `Thinking · last at ${name}`;
  return `Working · ${sprite.op === "edit" ? "Editing" : "Reading"} ${name}`;
}

/** What the thread's checkout changed since the map's base, or null when nothing did. */
export function threadChanges(
  marks: ReadonlyArray<CodeMapPathMark>,
  threadId: ThreadId,
): SpriteCardChanges | null {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const mark of marks) {
    for (const set of mark.sets) {
      if (!set.threadIds.includes(threadId)) continue;
      files++;
      insertions += set.insertions;
      deletions += set.deletions;
    }
  }
  return files === 0 ? null : { files, insertions, deletions };
}

export function CodeMapSpriteCard(props: {
  readonly anchor: SpriteHover["rect"];
  /** The map container's inner size: the card stays inside it. */
  readonly bounds: Size;
  readonly title: string;
  readonly projectName: string | null;
  readonly status: string;
  readonly changes: SpriteCardChanges | null;
  readonly parentTitle: string | null;
}) {
  const { anchor, bounds, changes } = props;
  const width = Math.min(CARD_WIDTH, bounds.width - EDGE * 2);
  const left = Math.max(
    EDGE,
    Math.min(anchor.x + anchor.w / 2 - width / 2, bounds.width - width - EDGE),
  );
  // Opens toward the larger half, so its unmeasured height always has room.
  const vertical =
    anchor.y > bounds.height / 2
      ? { bottom: bounds.height - anchor.y + CARD_GAP }
      : { top: anchor.y + anchor.h + CARD_GAP };
  return (
    <div
      role="tooltip"
      data-testid="code-map-sprite-card"
      className="pointer-events-none absolute z-20 flex flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
      style={{ left, width, ...vertical }}
    >
      <div className="truncate font-medium">{props.title}</div>
      {props.parentTitle === null ? null : (
        <div className="truncate text-muted-foreground">Subagent of {props.parentTitle}</div>
      )}
      {props.projectName === null ? null : (
        <div className="truncate text-muted-foreground">{props.projectName}</div>
      )}
      <div className="truncate">{props.status}</div>
      {changes === null ? null : (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span>
            {changes.files} {changes.files === 1 ? "file" : "files"} changed
          </span>
          <DiffStatLabel
            additions={changes.insertions}
            deletions={changes.deletions}
            layout="inline"
          />
        </div>
      )}
    </div>
  );
}
