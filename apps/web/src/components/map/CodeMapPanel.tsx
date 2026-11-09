import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadColor,
  type CodeMap,
  type CodeMapPathMark,
  type CodeMapSprite,
} from "@t3tools/client-runtime/state/code-map";
import type { ScopedProjectRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { MapIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { projectIconColorValue } from "~/projectIconColors";
import { useRightPanelStore } from "~/rightPanelStore";
import { codeMapSnapshotAtom, codeMapViewAtom, type CodeMapView } from "~/state/codeMap";
import { useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { layoutCodeMap, slotForPath, type MapCell, type MapLayout } from "./mapLayout";

type Scope = "thread" | "all";

interface SpritePlacement {
  readonly path: string;
  readonly op: CodeMapSprite["op"];
  readonly moveId: number;
  readonly facing: -1 | 0 | 1;
}

type SpritePlacements = ReadonlyMap<ThreadId, SpritePlacement>;

const NO_PLACEMENTS: SpritePlacements = new Map();
const LOADING_VIEW = Atom.make<CodeMapView>({ status: "loading" });
const SPRITE_WIDTH = 18;
const SPRITE_SPACING = 20;

function reconcileSprites(
  previous: SpritePlacements,
  sprites: ReadonlyArray<CodeMapSprite>,
  layout: MapLayout,
): SpritePlacements {
  const next = new Map<ThreadId, SpritePlacement>();
  let changed = false;
  for (const { threadId, path, op } of sprites) {
    const before = previous.get(threadId);
    const cell = path === null ? null : slotForPath(layout, path);
    if (path === null || cell === null || (before?.path === path && before.op === op)) {
      if (before) next.set(threadId, before);
      continue;
    }
    const from = before ? slotForPath(layout, before.path) : null;
    const facing = from ? (Math.sign(cell.rect.x - from.rect.x) as -1 | 0 | 1) : 0;
    next.set(threadId, { path, op, moveId: (before?.moveId ?? 0) + 1, facing });
    changed = true;
  }
  return !changed && next.size === previous.size ? previous : next;
}

const tint = (color: string, percent: number) =>
  `color-mix(in srgb, ${color} ${percent}%, var(--card))`;

const colorOf = (threadId: ThreadId) => projectIconColorValue(threadColor(threadId));

function markStyle(mark: CodeMapPathMark, isNew: boolean, strong: boolean): CSSProperties {
  const colors = mark.sets.map((set) => colorOf(set.threadIds[0]!));
  if (colors.length > 1) {
    return {
      background: `repeating-linear-gradient(135deg, ${tint(colors[0]!, 34)} 0 5px, ${tint(colors[1]!, 34)} 5px 10px)`,
    };
  }
  const color = colors[0]!;
  if (isNew) {
    return {
      border: `1.5px dashed ${strong ? color : tint(color, 50)}`,
      color: strong ? color : tint(color, 60),
    };
  }
  return {
    background: tint(color, strong ? 22 : 9),
    borderLeft: `3px solid ${strong ? color : tint(color, 45)}`,
  };
}

export function CodeMapPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const shell = useThreadShell(threadRef);
  const projectRef = shell ? scopeProjectRef(threadRef.environmentId, shell.projectId) : null;
  const viewAtom = projectRef ? codeMapViewAtom(projectRef) : LOADING_VIEW;
  const view = useAtomValue(viewAtom);
  const [scope, setScope] = useState<Scope>("thread");

  if (view.status === "loading" || projectRef === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (view.status === "error") {
    return <CodeMapUnavailable projectRef={projectRef} message={view.message} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1.5 text-2xs">
        <span className="truncate font-mono text-muted-foreground">
          {view.baseRef} · {view.treeSha.slice(0, 7)}
        </span>
        <ToggleGroup
          className="ml-auto"
          aria-label="Map scope"
          value={[scope]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "thread" || value === "all") setScope(value);
          }}
        >
          <Toggle value="thread">This thread</Toggle>
          <Toggle value="all">All</Toggle>
        </ToggleGroup>
      </div>
      <CodeMapCanvas
        threadRef={threadRef}
        projectRef={projectRef}
        model={view.model}
        markedPaths={view.markedPaths}
        scope={scope}
      />
    </div>
  );
}

function CodeMapUnavailable(props: {
  readonly projectRef: ScopedProjectRef;
  readonly message: string;
}) {
  const refresh = useAtomRefresh(codeMapSnapshotAtom(props.projectRef));
  return (
    <Empty size="compact" className="min-h-0">
      <EmptyMedia variant="icon">
        <MapIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Map unavailable</EmptyTitle>
        <EmptyDescription>{props.message}</EmptyDescription>
      </EmptyHeader>
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={refresh}
      >
        Try again
      </button>
    </Empty>
  );
}

function CodeMapCanvas(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectRef: ScopedProjectRef;
  readonly model: CodeMap;
  readonly markedPaths: ReadonlyArray<string>;
  readonly scope: Scope;
}) {
  const { threadRef, model, scope } = props;
  const router = useRouter();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const shells = useThreadShellsForProjectRefs([props.projectRef]);
  const titleOf = (threadId: ThreadId) =>
    shells.find((shell) => shell.id === threadId)?.title || "Untitled thread";

  const observeBox = (element: HTMLDivElement | null) => {
    if (!element) return;
    setBox({ width: element.clientWidth, height: element.clientHeight });
    return observeResize(element, ([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  };

  const layout =
    box.width > 0 && box.height > 0
      ? layoutCodeMap(model.folders, props.markedPaths, box.width, box.height)
      : null;

  const [placements, setPlacements] = useState(NO_PLACEMENTS);
  const nextPlacements = layout ? reconcileSprites(placements, model.sprites, layout) : placements;
  if (nextPlacements !== placements) setPlacements(nextPlacements);

  const marksByPath = new Map(model.marks.map((mark) => [mark.path, mark]));
  const finished = new Set(model.threads.filter((t) => t.finished).map((t) => t.threadId));
  const isMine = (mark: CodeMapPathMark) =>
    mark.sets.some((set) => set.threadIds.includes(threadRef.threadId));
  const livePaths = new Map<string, ThreadId>();
  for (const [threadId, placement] of nextPlacements) livePaths.set(placement.path, threadId);

  const openCell = (cell: MapCell) => {
    const panels = useRightPanelStore.getState();
    if (cell.kind === "more") {
      if (cell.folder !== null) panels.openFile(threadRef, cell.folder || ".");
      return;
    }
    const mark = marksByPath.get(cell.path);
    if (mark && !isMine(mark)) {
      const other = scopeThreadRef(threadRef.environmentId, mark.sets[0]!.threadIds[0]!);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(other),
      });
      return;
    }
    panels.openFile(threadRef, cell.path);
  };

  const spriteSlots = new Map<ThreadId, { cell: MapCell; lane: number }>();
  if (layout) {
    const lanes = new Map<MapCell, number>();
    for (const [threadId, placement] of nextPlacements) {
      const cell = slotForPath(layout, placement.path);
      if (!cell) continue;
      const lane = lanes.get(cell) ?? 0;
      lanes.set(cell, lane + 1);
      spriteSlots.set(threadId, { cell, lane });
    }
  }

  return (
    <div
      ref={observeBox}
      className="relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted"
      data-testid="code-map"
    >
      {layout?.regions.map((region) => {
        const present = new Set<ThreadId>();
        for (const cell of region.cells) {
          if (cell.kind !== "file") continue;
          for (const set of marksByPath.get(cell.path)?.sets ?? []) {
            for (const threadId of set.threadIds) present.add(threadId);
          }
        }
        return (
          <div
            key={region.path ?? "more-folders"}
            className="absolute rounded-md border border-border bg-card"
            style={{
              left: region.rect.x,
              top: region.rect.y,
              width: region.rect.width,
              height: region.rect.height,
            }}
          >
            <div className="absolute top-[3px] right-1 left-1.5 flex h-[13px] items-center gap-1 overflow-hidden font-mono text-3xs whitespace-nowrap">
              <b className="truncate font-semibold">{region.label}</b>
              {[...present].map((threadId) => (
                <i
                  key={threadId}
                  aria-hidden
                  className={cn(
                    "size-[5px] shrink-0 rounded-full",
                    finished.has(threadId) && "opacity-45",
                  )}
                  style={{ background: colorOf(threadId) }}
                />
              ))}
              <span className="ml-auto text-muted-foreground">{region.fileCount}</span>
            </div>
            {region.cells.map((cell) => {
              const key = cell.kind === "file" ? `file:${cell.path}` : "more";
              const rect = cell.rect;
              const position = {
                left: rect.x - region.rect.x,
                top: rect.y - region.rect.y,
                width: rect.width,
                height: rect.height,
              };
              if (cell.kind === "more") {
                return (
                  <button
                    key={key}
                    type="button"
                    className="absolute flex items-center justify-center overflow-hidden rounded-xs border border-dashed border-border text-3xs text-muted-foreground"
                    style={position}
                    onClick={() => openCell(cell)}
                    disabled={cell.folder === null}
                  >
                    {rect.width > 30 && rect.height > 13 ? `+${cell.count} more` : null}
                  </button>
                );
              }
              const mark = marksByPath.get(cell.path);
              const mine = mark ? isMine(mark) : false;
              const live = livePaths.get(cell.path);
              const strong =
                mark !== undefined &&
                (scope === "all" || mine || mark.sets.length > 1) &&
                !mark.sets.every((set) => set.threadIds.every((id) => finished.has(id)));
              const style: CSSProperties = {
                ...position,
                ...(mark ? markStyle(mark, mark.isNew, strong) : {}),
                ...(live ? { boxShadow: `0 0 0 2px ${colorOf(live)}` } : {}),
              };
              const showName = rect.width > 30 && rect.height > 13;
              const showLines = rect.height > 30;
              return (
                <button
                  key={key}
                  type="button"
                  data-path={cell.path}
                  data-marked={
                    mark ? (mark.sets.length > 1 ? "overlap" : mine ? "mine" : "other") : undefined
                  }
                  data-strength={mark ? (strong ? "strong" : "faint") : undefined}
                  aria-label={
                    mark
                      ? `${cell.path}, changed in ${mark.sets
                          .flatMap((set) => set.threadIds)
                          .map(titleOf)
                          .join(", ")}`
                      : cell.path
                  }
                  className={cn(
                    "code-map-cell absolute overflow-hidden rounded-xs px-1 py-0.5 text-left text-3xs leading-tight text-muted-foreground transition-opacity duration-200",
                    mark && mark.isNew && "bg-transparent",
                    mark && (strong || mark.sets.length > 1) && "text-foreground",
                    !mark && scope === "thread" && "opacity-55",
                    live && "z-[2]",
                  )}
                  style={style}
                  onClick={() => openCell(cell)}
                >
                  {showName ? (
                    <div className={cn("truncate font-mono", mark && strong && "font-semibold")}>
                      {cell.name}
                    </div>
                  ) : null}
                  {showName && showLines ? (
                    <div className="text-4xs opacity-75">
                      {cell.lines === null ? "new" : `${cell.lines.toLocaleString()} lines`}
                    </div>
                  ) : null}
                  {mark && mark.sets.length > 1 ? (
                    <span
                      aria-label="Changed in two threads"
                      className="absolute top-0.5 right-0.5 flex size-3 items-center justify-center rounded-full bg-(--warning) text-4xs font-bold text-(--warning-foreground)"
                    >
                      !
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
      {layout
        ? [...nextPlacements].map(([threadId, placement]) => {
            const slot = spriteSlots.get(threadId);
            if (!slot) return null;
            const mine = threadId === threadRef.threadId;
            const quiet = scope === "thread" && !mine;
            const x = Math.min(
              slot.cell.rect.x + 4 + slot.lane * SPRITE_SPACING,
              box.width - SPRITE_WIDTH - 2,
            );
            const y = Math.max(slot.cell.rect.y - 8, 0);
            const verb = placement.op === "read" ? "Read" : placement.op === "edit" ? "Edit" : null;
            const name = placement.path.slice(placement.path.lastIndexOf("/") + 1);
            return (
              <div
                key={threadId}
                data-testid="code-map-sprite"
                data-thread-id={threadId}
                data-path={placement.path}
                aria-label={`${titleOf(threadId)} at ${placement.path}`}
                className={cn(
                  "code-map-sprite pointer-events-none absolute top-0 left-0 z-10",
                  quiet && "opacity-50",
                )}
                style={{ transform: `translate(${x}px, ${y}px)` }}
              >
                <div
                  key={placement.moveId}
                  className="code-map-hop flex h-[15px] w-[18px] origin-bottom items-center justify-center gap-0.75 rounded-t-md rounded-b-sm shadow-md"
                  style={{ background: colorOf(threadId) }}
                >
                  {[0, 1].map((eye) => (
                    <i
                      key={eye}
                      aria-hidden
                      className="h-1 w-[3px] rounded-xs bg-white transition-transform duration-250"
                      style={{ transform: `translateX(${placement.facing * 1.5}px)` }}
                    />
                  ))}
                </div>
                {quiet ? null : (
                  <div
                    key={`say-${placement.moveId}`}
                    data-testid="code-map-say"
                    className="code-map-say absolute top-[-1px] left-[22px] rounded-sm border border-border bg-popover px-1.5 py-px text-3xs whitespace-nowrap text-popover-foreground"
                  >
                    {verb ? `${verb} ${name}` : name}
                  </div>
                )}
              </div>
            );
          })
        : null}
    </div>
  );
}
