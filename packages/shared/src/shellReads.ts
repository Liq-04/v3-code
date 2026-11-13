const MAX_READ_PATHS = 50;

interface Word {
  readonly text: string;
  /** Holds a glob, an expansion, or a substitution, so its text is not the path the shell uses. */
  readonly dynamic: boolean;
}

type Token =
  | ({ readonly kind: "word" } & Word)
  | { readonly kind: "redirect"; readonly op: "<" | ">" | "<<" | "<<<" }
  | { readonly kind: "separator"; readonly pipe: boolean };

interface Segment {
  readonly words: ReadonlyArray<Word>;
  readonly inputs: ReadonlyArray<Word>;
  readonly piped: boolean;
}

interface Args {
  readonly flags: ReadonlySet<string>;
  readonly positionals: ReadonlyArray<Word>;
  readonly afterDashDash: ReadonlyArray<Word>;
}

interface CommandRule {
  /** Flags that take a value, with how many arguments each consumes. */
  readonly values?: Readonly<Record<string, number>>;
  /** Flags that supply the script or pattern. Without one, the first argument is it. */
  readonly script?: ReadonlyArray<string>;
  /** Picks the file arguments when they are not simply every argument after the script. */
  readonly files?: (args: Args) => ReadonlyArray<Word>;
  readonly search?: {
    /** Flags that print matching file names instead of matching lines. */
    readonly list: ReadonlyArray<string>;
    /** Flags that make it walk directories. Without one, its arguments are the files it reads. */
    readonly recursive?: ReadonlyArray<string>;
  };
}

const takes = (flags: string, count = 1): Record<string, number> =>
  Object.fromEntries(flags.split(" ").map((flag) => [flag, count]));

const HEAD: CommandRule = { values: takes("-n -c --lines --bytes") };

const GREP: CommandRule = {
  values: takes(
    "-A -B -C -m -e -f -d -D --after-context --before-context --context --max-count --regexp --file --include --exclude --exclude-dir",
  ),
  script: ["-e", "-f", "--regexp", "--file"],
  search: {
    list: ["-l", "-L", "--files-with-matches", "--files-without-match"],
    recursive: ["-r", "-R", "--recursive", "--dereference-recursive"],
  },
};

const COMMANDS: Readonly<Record<string, CommandRule>> = {
  cat: {},
  bat: { values: takes("-l --language -r --line-range -H --highlight-line --theme --style") },
  head: HEAD,
  tail: HEAD,
  less: {},
  more: {},
  nl: { values: takes("-b -d -f -h -i -l -n -s -v -w") },
  wc: {},
  diff: { values: takes("-U -C -I -x -X --label") },
  cmp: {},
  sed: {
    values: takes("-e -f -l --expression --file"),
    script: ["-e", "-f", "--expression", "--file"],
  },
  awk: { values: takes("-f -F -v --file"), script: ["-f", "--file"] },
  jq: {
    values: {
      ...takes("-f -L --from-file --indent"),
      ...takes("--arg --argjson --slurpfile --rawfile", 2),
    },
    script: ["-f", "--from-file"],
  },
  "git show": {
    files: (args) => [
      ...args.positionals.flatMap((word) => {
        const colon = word.text.indexOf(":");
        return colon === -1 ? [] : [{ ...word, text: word.text.slice(colon + 1) }];
      }),
      ...args.afterDashDash,
    ],
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    values: takes(
      "-A -B -C -d -e -E -f -g -j -m -M -r -t -T --after-context --before-context --context --max-depth --regexp --encoding --file --glob --iglob --threads --max-count --max-columns --max-filesize --replace --type --type-not --type-add --sort --sortr --color --colors --engine --pre --pre-glob --ignore-file",
    ),
    // --files lists the tree without searching, so nothing after it is a pattern.
    script: ["-e", "-f", "--regexp", "--file", "--files"],
    search: { list: ["-l", "--files-with-matches", "--files-without-match"] },
  },
  ag: {
    values: takes("-A -B -C -g -G -m --after --before --context --depth --ignore --max-count"),
    search: { list: ["-l", "-L", "--files-with-matches", "--files-without-matches"] },
  },
  "git grep": {
    values: takes(
      "-A -B -C -e -f -m -O --after-context --before-context --context --max-count --max-depth --threads",
    ),
    script: ["-e", "-f"],
    search: { list: ["-l", "-L", "--files-with-matches", "--files-without-match", "--name-only"] },
  },
};

const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "{",
  "!",
  "if",
  "then",
  "else",
  "while",
  "do",
  "time",
  "env",
  "command",
  "builtin",
  "exec",
  "sudo",
  "nice",
  "nohup",
]);

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const heredocDelimiters: string[] = [];
  let text = "";
  let dynamic = false;
  let inWord = false;
  const endWord = () => {
    if (!inWord) return;
    const previous = tokens.at(-1);
    if (previous?.kind === "redirect" && previous.op === "<<") heredocDelimiters.push(text);
    tokens.push({ kind: "word", text, dynamic });
    text = "";
    dynamic = false;
    inWord = false;
  };
  // `2>` names a file descriptor, not an argument.
  const endWordBeforeRedirect = () => {
    if (/^\d+$/u.test(text)) {
      text = "";
      inWord = false;
    }
    endWord();
  };
  const skipHeredocBodies = (from: number) => {
    let at = from;
    for (const delimiter of heredocDelimiters.splice(0)) {
      while (at < command.length) {
        const newline = command.indexOf("\n", at);
        const end = newline === -1 ? command.length : newline;
        const line = command.slice(at, end);
        at = end + 1;
        if (line.trim() === delimiter) break;
      }
    }
    return at;
  };

  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    const next = command[i + 1];
    if (char === "\\") {
      if (next !== undefined && next !== "\n") {
        text += next;
        inWord = true;
      }
      i += 2;
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      text += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (char === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i += 1;
        else if (command[i] === "$" || command[i] === "`") dynamic = true;
        text += command[i];
        i += 1;
      }
      inWord = true;
      i += 1;
    } else if (char === "\n") {
      endWord();
      tokens.push({ kind: "separator", pipe: false });
      i = skipHeredocBodies(i + 1);
    } else if (/\s/u.test(char)) {
      endWord();
      i += 1;
    } else if (char === "#" && !inWord) {
      const newline = command.indexOf("\n", i);
      i = newline === -1 ? command.length : newline;
    } else if (char === ";" || char === "(" || char === ")") {
      endWord();
      tokens.push({ kind: "separator", pipe: false });
      i += 1;
    } else if (char === "|") {
      endWord();
      tokens.push({ kind: "separator", pipe: next !== "|" });
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (char === "&" && next === ">") {
      endWord();
      i += 1;
    } else if (char === "&") {
      endWord();
      tokens.push({ kind: "separator", pipe: false });
      i += next === "&" ? 2 : 1;
    } else if (char === ">") {
      endWordBeforeRedirect();
      i += next === ">" ? 2 : 1;
      if (command[i] === "&" || command[i] === "|") i += 1;
      tokens.push({ kind: "redirect", op: ">" });
    } else if (char === "<") {
      endWordBeforeRedirect();
      if (command.startsWith("<<<", i)) {
        tokens.push({ kind: "redirect", op: "<<<" });
        i += 3;
      } else if (next === "<") {
        tokens.push({ kind: "redirect", op: "<<" });
        i += command[i + 2] === "-" ? 3 : 2;
      } else {
        tokens.push({ kind: "redirect", op: "<" });
        i += 1;
      }
    } else {
      if ("*?[{$`".includes(char) || (char === "~" && !inWord)) dynamic = true;
      text += char;
      inWord = true;
      i += 1;
    }
  }
  endWord();
  return tokens;
}

function segmentsOf(tokens: ReadonlyArray<Token>): Segment[] {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let inputs: Word[] = [];
  let piped = false;
  let redirect: Extract<Token, { kind: "redirect" }>["op"] | undefined;
  const end = (pipe: boolean) => {
    if (words.length > 0 || inputs.length > 0) segments.push({ words, inputs, piped });
    words = [];
    inputs = [];
    piped = pipe;
    redirect = undefined;
  };
  for (const token of tokens) {
    if (token.kind === "separator") end(token.pipe);
    else if (token.kind === "redirect") redirect = token.op;
    else if (redirect === undefined) words.push(token);
    else {
      if (redirect === "<") inputs.push(token);
      redirect = undefined;
    }
  }
  end(false);
  return segments;
}

function parseArgs(words: ReadonlyArray<Word>, values: Readonly<Record<string, number>>): Args {
  const flags = new Set<string>();
  const positionals: Word[] = [];
  const afterDashDash: Word[] = [];
  let ended = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const { text } = word;
    if (text === "") continue;
    if (ended) afterDashDash.push(word);
    else if (text === "--") ended = true;
    else if (text.startsWith("--")) {
      const [name = text, inlineValue] = text.split("=", 2);
      flags.add(name);
      if (inlineValue === undefined) i += values[name] ?? 0;
    } else if (text.startsWith("-") && text.length > 1) {
      // getopt clusters: `-rnA 3` ends in a flag taking the next word, `-n20` carries its value.
      for (let at = 1; at < text.length; at += 1) {
        const flag = `-${text[at]}`;
        flags.add(flag);
        const count = values[flag];
        if (count === undefined) continue;
        if (at === text.length - 1) i += count;
        break;
      }
    } else positionals.push(word);
  }
  return { flags, positionals, afterDashDash };
}

/** `base` is null once a `cd` went somewhere the command text does not name. */
function resolvePath(base: string | null, path: string): string | undefined {
  const absolute = path.startsWith("/");
  if (!absolute && base === null) return undefined;
  const parts: string[] = [];
  for (const part of (absolute ? path : `${base}/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return (absolute || base?.startsWith("/") ? "/" : "") + parts.join("/");
}

const isNamedFile = (word: Word) =>
  !word.dynamic && word.text !== "" && word.text !== "-" && !word.text.startsWith("/dev/");

function looksLikeFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name !== "." && name !== ".." && name.includes(".");
}

function looksLikePath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    (candidate.includes("/") || candidate.includes(".")) &&
    !candidate.includes("//") &&
    !candidate.endsWith(".") &&
    !/[\s"'`;=<>{}|&*?!,\\]/u.test(candidate)
  );
}

/**
 * The files a search printed: one path per line when it lists files, otherwise the path that
 * prefixes each matching line (`path:line:text` or `path:text`).
 */
export function searchOutputPaths(output: string, lists: boolean): string[] {
  const paths = new Set<string>();
  let at = 0;
  while (at < output.length && paths.size < MAX_READ_PATHS) {
    const newline = output.indexOf("\n", at);
    const end = newline === -1 ? output.length : newline;
    const line = output.slice(at, end).trimEnd();
    at = end + 1;
    const candidate = lists ? line : line.slice(0, Math.max(line.indexOf(":"), 0));
    if (looksLikePath(candidate)) paths.add(candidate);
  }
  return [...paths];
}

interface SegmentReads {
  readonly paths: ReadonlyArray<string>;
  /** Set when the segment is a search whose matched files only its output names. */
  readonly search?: { readonly base: string | null; readonly lists: boolean };
}

const hasAny = (flags: ReadonlySet<string>, names: ReadonlyArray<string>) =>
  names.some((name) => flags.has(name));

function commandReads(
  rule: CommandRule,
  words: ReadonlyArray<Word>,
  base: string | null,
  piped: boolean,
): SegmentReads {
  const args = parseArgs(words, rule.values ?? {});
  const hasScriptArgument = rule.script !== undefined && !hasAny(args.flags, rule.script);
  const named =
    rule.files?.(args) ??
    [...args.positionals, ...args.afterDashDash].slice(hasScriptArgument ? 1 : 0);
  const paths = named.filter(isNamedFile).flatMap((word) => resolvePath(base, word.text) ?? []);
  const { search } = rule;
  if (search === undefined) return { paths };
  if (search.recursive !== undefined && !hasAny(args.flags, search.recursive)) return { paths };
  if (named.length === 0 && piped) return { paths: [] };
  return {
    paths: paths.filter(looksLikeFile),
    search: { base, lists: hasAny(args.flags, search.list) },
  };
}

/**
 * The files a shell command reads, in the order it names them. A search names directories, so
 * its files come from `output` once the command has printed them. Relative paths stay relative
 * to the directory the command started in.
 */
export function shellCommandReadPaths(command: string, output?: string): string[] {
  let base: string | null = "";
  const reads: SegmentReads[] = [];
  for (const segment of segmentsOf(tokenize(command))) {
    const inputs = segment.inputs
      .filter(isNamedFile)
      .flatMap((word) => resolvePath(base, word.text) ?? []);
    let words = segment.words;
    let start = 0;
    while (
      start < words.length &&
      (COMMAND_PREFIXES.has(words[start]!.text) ||
        /^[A-Za-z_]\w*=/u.test(words[start]!.text) ||
        (start > 0 && words[start]!.text.startsWith("-")))
    ) {
      start += 1;
    }
    words = words.slice(start);
    const first = words[0];
    let name = first === undefined || first.dynamic ? "" : first.text.replace(/^.*\//u, "");
    let segmentBase = base;
    words = words.slice(1);
    if (name === "cd" || name === "pushd") {
      const target = words.find((word) => !word.text.startsWith("-"));
      base =
        target === undefined || !isNamedFile(target)
          ? null
          : (resolvePath(base, target.text) ?? null);
    }
    if (name === "git") {
      while (words[0]?.text.startsWith("-")) {
        const takesValue = words[0].text === "-C" || words[0].text === "-c";
        const value = words[1];
        if (words[0].text === "-C" && value !== undefined) {
          segmentBase = isNamedFile(value) ? (resolvePath(segmentBase, value.text) ?? null) : null;
        }
        words = words.slice(takesValue ? 2 : 1);
      }
      name = `git ${words[0]?.text ?? ""}`;
      words = words.slice(1);
    }
    const found = Object.hasOwn(COMMANDS, name)
      ? commandReads(COMMANDS[name]!, words, segmentBase, segment.piped)
      : { paths: [] };
    reads.push({ ...found, paths: [...found.paths, ...inputs] });
  }

  const searches = reads.filter((read) => read.search !== undefined);
  const paths = new Set<string>();
  for (const read of reads) {
    const { search } = read;
    const printed =
      search !== undefined && searches.length === 1 && output !== undefined
        ? searchOutputPaths(output, search.lists).flatMap(
            (path) => resolvePath(search.base, path) ?? [],
          )
        : [];
    for (const path of printed.length > 0 ? printed : read.paths) {
      if (path !== "") paths.add(path);
    }
  }
  return [...paths].slice(0, MAX_READ_PATHS);
}
