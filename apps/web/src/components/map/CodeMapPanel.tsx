import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadColor, type CodeMapSprite } from "@t3tools/client-runtime/state/code-map";
import type { ScopedProjectRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { MapIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { Toggle } from "~/components/ui/toggle";
import { Toggle as ScopeToggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { observeResize } from "~/lib/observeResize";
import { projectIconColorValue } from "~/projectIconColors";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  codeMapBasesAtom,
  codeMapSnapshotAtom,
  codeMapViewAtom,
  type CodeMapView,
} from "~/state/codeMap";
import { useProject, useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { CodeMapBasePicker } from "./CodeMapBasePicker";
import { CodeMapCanvas, MapScope, markView } from "./CodeMapCanvas";
import { CodeMapSpriteCard, spriteStatus, threadChanges } from "./CodeMapSpriteCard";
import { CodeMapSprites, type SpriteHover, type SpriteInput } from "./CodeMapSprites";
import {
  hoverCodeMapPath,
  useCodeMapFocusStore,
  useSelectedCodeMapPath,
} from "./codeMapFocusStore";
import { cameraForRect, createCameraStore, fitCamera, HOME_CAMERA, type Size } from "./mapCamera";
import { buildWorldTree, layoutWorld, rectOf, type World, type WorldTree } from "./mapWorld";

type ReadyView = Extract<CodeMapView, { status: "ready" }>;

const MAP_SCOPE_STORAGE_KEY = "t3code:code-map-scope:v1";
const LOADING_VIEW = Atom.make<CodeMapView>({ status: "loading" });
const NO_SIZE: Size = { width: 0, height: 0 };
const NO_PATHS: ReadonlyMap<ThreadId, string> = new Map();
const RELAYOUT_DEBOUNCE_MS = 120;

const colorOf = (threadId: ThreadId) => projectIconColorValue(threadColor(threadId));

export function CodeMapPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const shell = useThreadShell(threadRef);
  const projectRef = shell ? scopeProjectRef(threadRef.environmentId, shell.projectId) : null;
  const viewAtom = projectRef ? codeMapViewAtom(projectRef) : LOADING_VIEW;
  const view = useAtomValue(viewAtom);

  if (view.status === "loading" || projectRef === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (view.status === "error") {
    return <CodeMapUnavailable projectRef={projectRef} view={view} />;
  }
  return <CodeMapStage threadRef={threadRef} projectRef={projectRef} view={view} />;
}

function CodeMapUnavailable(props: {
  readonly projectRef: ScopedProjectRef;
  readonly view: Extract<CodeMapView, { status: "error" }>;
}) {
  const { baseKey, chosenBaseRef, message } = props.view;
  const refresh = useAtomRefresh(codeMapSnapshotAtom(props.projectRef, chosenBaseRef));
  const setBase = useAtomSet(codeMapBasesAtom);
  return (
    <Empty size="compact" className="min-h-0">
      <EmptyMedia variant="icon">
        <MapIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Map unavailable</EmptyTitle>
        <EmptyDescription>
          {chosenBaseRef === null ? message : `${message} The map's base is ${chosenBaseRef}.`}
        </EmptyDescription>
      </EmptyHeader>
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={refresh}
      >
        Try again
      </button>
      {chosenBaseRef === null ? null : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setBase({ baseKey, baseRef: null })}
        >
          Use the default branch
        </button>
      )}
    </Empty>
  );
}

interface WorldCache {
  readonly treeKey: string;
  readonly tree: WorldTree;
  readonly worldKey: string;
  readonly world: World;
}

const verbOf = (op: CodeMapSprite["op"]) =>
  op === "read" ? "Read" : op === "edit" ? "Edit" : null;

function toSpriteInput(
  sprite: CodeMapSprite,
  threadId: ThreadId,
  scope: MapScope,
  titleOf: (threadId: ThreadId) => string,
): SpriteInput {
  return {
    threadId: sprite.threadId,
    path: sprite.path,
    home: sprite.home,
    verb: verbOf(sprite.op),
    kind: sprite.kind,
    parentThreadId: sprite.parentThreadId,
    color: colorOf(sprite.colorThreadId),
    quiet: scope === "thread" && sprite.threadId !== threadId && sprite.colorThreadId !== threadId,
    title: titleOf(sprite.threadId),
    state: sprite.state,
    idleSince: sprite.idleSince,
  };
}

function standingPaths(
  previous: ReadonlyMap<ThreadId, string>,
  sprites: ReadonlyArray<CodeMapSprite>,
): ReadonlyMap<ThreadId, string> {
  let next: Map<ThreadId, string> | null = null;
  for (const sprite of sprites) {
    if (sprite.path !== null && previous.get(sprite.threadId) !== sprite.path) {
      next ??= new Map(previous);
      next.set(sprite.threadId, sprite.path);
    }
  }
  return next ?? previous;
}

const sameSize = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

function CodeMapStage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectRef: ScopedProjectRef;
  readonly view: ReadyView;
}) {
  const { threadRef, view } = props;
  const { model } = view;
  const router = useRouter();
  const project = useProject(props.projectRef);
  const selectedPath = useSelectedCodeMapPath(threadRef);
  const hoveredPath = useCodeMapFocusStore((state) => state.hoveredPath);
  const [scope, setScope] = useLocalStorage(MAP_SCOPE_STORAGE_KEY, "thread", MapScope);
  const [follow, setFollow] = useState(false);
  const [camera] = useState(() => createCameraStore(HOME_CAMERA));
  const [box, setBox] = useState(NO_SIZE);
  const [layoutBox, setLayoutBox] = useState(NO_SIZE);
  const [cache, setCache] = useState<WorldCache | null>(null);
  const [standingByThread, setStandingByThread] = useState(NO_PATHS);
  const [spriteHover, setSpriteHover] = useState<SpriteHover | null>(null);

  const titleOf = (threadId: ThreadId) => view.threadTitles.get(threadId) || "Untitled thread";

  const observeBox = (element: HTMLDivElement | null) => {
    if (!element) return;
    let last = { width: element.clientWidth, height: element.clientHeight };
    setBox((prev) => (sameSize(prev, last) ? prev : last));
    setLayoutBox((prev) => (sameSize(prev, last) ? prev : last));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = observeResize(element, ([entry]) => {
      if (!entry) return;
      const next = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      if (sameSize(next, last)) return;
      last = next;
      setBox(next);
      clearTimeout(timer);
      timer = setTimeout(() => setLayoutBox(next), RELAYOUT_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  };

  const unlistedPaths = model.marks.filter((mark) => mark.lines === null).map((mark) => mark.path);
  const treeKey = `${view.treeSha}\n${unlistedPaths.join("\n")}`;
  const worldKey = `${treeKey}\n${layoutBox.width}x${layoutBox.height}`;
  let world = cache?.worldKey === worldKey ? cache.world : null;
  if (world === null && layoutBox.width > 0 && layoutBox.height > 0) {
    const tree =
      cache?.treeKey === treeKey ? cache.tree : buildWorldTree(view.files, unlistedPaths);
    world = layoutWorld(tree, layoutBox.width, layoutBox.height);
    setCache({ treeKey, tree, worldKey, world });
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new layout invalidates every rect the camera framed
  useEffect(() => {
    if (world) camera.jumpTo(HOME_CAMERA);
  }, [camera, world]);

  const nextStanding = standingPaths(standingByThread, model.sprites);
  if (nextStanding !== standingByThread) setStandingByThread(nextStanding);

  const myPath = nextStanding.get(threadRef.threadId) ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follow flies the camera whenever this thread's sprite lands somewhere new
  useEffect(() => {
    if (!follow || !world || myPath === null) return;
    const rect = rectOf(world, myPath);
    if (rect) camera.fly(cameraForRect(rect, world));
  }, [follow, world, myPath, camera]);

  const finished = new Set(model.threads.filter((t) => t.finished).map((t) => t.threadId));
  const marks = model.marks.map((mark) =>
    markView(mark, threadRef.threadId, scope, finished, titleOf),
  );
  const marksByPath = new Map(marks.map((mark) => [mark.path, mark]));
  const reads = model.reads.map((read) => ({
    ...read,
    strong: scope === "all" || read.threadIds.includes(threadRef.threadId),
  }));
  const sprites = model.sprites.map((sprite) =>
    toSpriteInput(sprite, threadRef.threadId, scope, titleOf),
  );
  const standing = model.sprites.flatMap((sprite) => {
    const path = nextStanding.get(sprite.threadId);
    return path ? [{ path, threadId: sprite.colorThreadId }] : [];
  });

  const hoveredSprite = spriteHover
    ? model.sprites.find((sprite) => sprite.threadId === spriteHover.threadId)
    : undefined;

  const openThread = (threadId: ThreadId) => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
    });
  };

  const open = (path: string) => {
    const mark = marksByPath.get(path);
    if (mark && mark.kind === "other") {
      openThread(mark.threadId);
      return;
    }
    useRightPanelStore.getState().openFile(threadRef, path);
  };

  const fit = () => {
    setFollow(false);
    if (world) camera.fly(fitCamera(world, box));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5 text-2xs">
        <CodeMapBasePicker
          environmentId={threadRef.environmentId}
          cwd={project?.workspaceRoot ?? null}
          baseKey={view.baseKey}
          baseRef={view.baseRef}
          treeSha={view.treeSha}
          defaultBaseRef={view.defaultBaseRef}
          chosenBaseRef={view.chosenBaseRef}
        />
        <Button variant="ghost-muted" size="xs" className="ml-auto" onClick={fit}>
          Fit
        </Button>
        <Toggle
          variant="ghost"
          pressed={follow}
          onPressedChange={setFollow}
          aria-label="Follow this thread"
        >
          Follow
        </Toggle>
        <ToggleGroup
          aria-label="Map scope"
          value={[scope]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "thread" || value === "all") setScope(value);
          }}
        >
          <ScopeToggle value="thread">This thread</ScopeToggle>
          <ScopeToggle value="all">All</ScopeToggle>
        </ToggleGroup>
      </div>
      <div
        ref={observeBox}
        className="relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted"
        data-testid="code-map"
      >
        <CodeMapCanvas
          world={world}
          size={box}
          camera={camera}
          reads={reads}
          marks={marks}
          standing={standing}
          hoveredPath={hoveredPath}
          selectedPath={selectedPath}
          onOpen={open}
          onHover={hoverCodeMapPath}
          onManualPanZoom={() => setFollow(false)}
        />
        <CodeMapSprites
          sprites={sprites}
          world={world}
          camera={camera}
          onHover={setSpriteHover}
          onOpen={openThread}
        />
        {spriteHover && hoveredSprite ? (
          <CodeMapSpriteCard
            anchor={spriteHover.rect}
            bounds={box}
            title={titleOf(hoveredSprite.threadId)}
            projectName={view.threadProjectNames.get(hoveredSprite.threadId) ?? null}
            status={spriteStatus(hoveredSprite)}
            changes={threadChanges(model.marks, hoveredSprite.threadId)}
            parentTitle={
              hoveredSprite.parentThreadId === null ? null : titleOf(hoveredSprite.parentThreadId)
            }
          />
        ) : null}
      </div>
    </div>
  );
}
