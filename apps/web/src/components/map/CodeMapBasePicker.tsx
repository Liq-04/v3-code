import { useAtomSet } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { BranchPicker, BranchPickerRefItem } from "~/components/BranchPicker";
import { sanitizeNewRefName } from "~/components/BranchToolbar.logic";
import { Button } from "~/components/ui/button";
import { ComboboxTrigger } from "~/components/ui/combobox";
import { codeMapBasesAtom } from "~/state/codeMap";
import { usePaginatedBranches } from "~/state/queries";

/** Picks the branch the whole map is measured against, for every thread on the repository. */
export function CodeMapBasePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly baseKey: string;
  readonly baseRef: string;
  readonly treeSha: string;
  readonly defaultBaseRef: string | null;
  readonly chosenBaseRef: string | null;
}) {
  const { environmentId, cwd, baseKey, baseRef, defaultBaseRef, chosenBaseRef } = props;
  const setBase = useAtomSet(codeMapBasesAtom);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const branches = usePaginatedBranches({
    environmentId,
    cwd: open ? cwd : null,
    query: sanitizeNewRefName(query.trim()),
  });
  const branchByName = new Map(branches.refs.map((branch) => [branch.name, branch]));
  const items = [...branchByName.keys()];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    branches.error ??
    (branches.isPending && branches.data === null
      ? "Loading refs..."
      : branches.isFetchingNextPage
        ? "Loading more refs..."
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const choose = (name: string) => {
    setBase({ baseKey, baseRef: name === defaultBaseRef ? null : name });
    handleOpenChange(false);
  };
  return (
    <>
      <BranchPicker
        items={items}
        filteredItems={items}
        value={baseRef}
        query={query}
        onQueryChange={setQuery}
        open={open}
        onOpenChange={handleOpenChange}
        onSelectItem={choose}
        hasNextPage={hasNextPage}
        isFetchingNextPage={branches.isFetchingNextPage}
        onLoadNext={branches.loadNext}
        statusText={statusText}
        popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
        renderItem={(name, index) => {
          const branch = branchByName.get(name);
          return branch ? (
            <BranchPickerRefItem
              branch={branch}
              projectCwd={cwd}
              index={index}
              onClick={() => choose(branch.name)}
            />
          ) : null;
        }}
      >
        <ComboboxTrigger
          aria-label="Map base branch"
          disabled={cwd === null}
          render={<Button variant="ghost-muted" size="xs" />}
          className="min-w-0"
        >
          <GitBranchIcon />
          <span className="truncate font-mono">
            {baseRef} · {props.treeSha.slice(0, 7)}
          </span>
        </ComboboxTrigger>
      </BranchPicker>
      {chosenBaseRef !== null && defaultBaseRef !== null ? (
        <Button variant="ghost-muted" size="xs" onClick={() => setBase({ baseKey, baseRef: null })}>
          Reset to {defaultBaseRef}
        </Button>
      ) : null}
    </>
  );
}
