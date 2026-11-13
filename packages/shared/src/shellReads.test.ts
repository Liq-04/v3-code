import { describe, expect, it } from "vite-plus/test";

import { searchOutputPaths, shellCommandReadPaths } from "./shellReads.ts";

describe("shellCommandReadPaths", () => {
  it("names the files a command reads", () => {
    const cases: ReadonlyArray<
      readonly [command: string, expected: ReadonlyArray<string>, output?: string]
    > = [
      ["cat src/a.ts /repo/b.ts", ["src/a.ts", "/repo/b.ts"]],
      ["/bin/cat ./src/a.ts", ["src/a.ts"]],
      ["cat 'my file.ts' \"src/b c.ts\" src/d\\ e.ts", ["my file.ts", "src/b c.ts", "src/d e.ts"]],
      ["bat -l ts src/a.ts", ["src/a.ts"]],
      ["head -n 20 a.ts", ["a.ts"]],
      ["head -20 a.ts b.ts", ["a.ts", "b.ts"]],
      ["tail -n20 a.ts", ["a.ts"]],
      ["tail -c 100 a.ts", ["a.ts"]],
      ["less a.ts; more b.ts; nl -ba c.ts; wc -l d.ts", ["a.ts", "b.ts", "c.ts", "d.ts"]],
      ["sed -n 1,80p a.ts", ["a.ts"]],
      ["sed -n '10,20p;30q' a.ts b.ts", ["a.ts", "b.ts"]],
      ["sed -E -e 's/a/b/' -e 's/c/d/' a.ts", ["a.ts"]],
      ["sed -ne 5p a.ts", ["a.ts"]],
      ["sed -i '' 's/a/b/' a.ts", ["a.ts"]],
      ["awk -F, '{print $1}' data.csv", ["data.csv"]],
      ["awk -f prog.awk data.csv", ["data.csv"]],
      ["jq -r '.scripts' package.json", ["package.json"]],
      ["jq --arg name value '.[$name]' a.json", ["a.json"]],
      ["diff -u a.ts b.ts", ["a.ts", "b.ts"]],
      ["cmp a.bin b.bin", ["a.bin", "b.bin"]],
      ["git show HEAD:src/a.ts", ["src/a.ts"]],
      ["git --no-pager show abc123 -- src/a.ts", ["src/a.ts"]],
      ["git show HEAD", []],
      ["git -C packages/shared show HEAD:src/a.ts", ["packages/shared/src/a.ts"]],

      ["FOO=1 BAR=2 cat a.ts", ["a.ts"]],
      ["time env -i sudo cat a.ts", ["a.ts"]],
      [
        "(cat a.ts) && { cat b.ts; } || cat c.ts & cat d.ts\ncat e.ts",
        ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      ],
      ["cat a.ts | head -5", ["a.ts"]],
      ["cat a.ts a.ts ./a.ts", ["a.ts"]],
      ["x=$(cat a.ts)", ["a.ts"]],

      ["cd /repo && cat src/a.ts /abs/b.ts", ["/repo/src/a.ts", "/abs/b.ts"]],
      ["cd apps/web; cat src/a.ts; cd ..; cat b.ts", ["apps/web/src/a.ts", "apps/b.ts"]],
      ["pushd /repo/apps; cat ../a.ts", ["/repo/a.ts"]],
      ["cd $DIR; cat a.ts /abs/b.ts", ["/abs/b.ts"]],

      ["sort < in.txt", ["in.txt"]],
      ["cat a.ts > out.ts 2> err.log", ["a.ts"]],
      ["cat a.ts >> out.ts 2>&1", ["a.ts"]],
      ["cat a.ts &> out.ts", ["a.ts"]],
      ["cat a.ts>out.ts", ["a.ts"]],
      ["cat <<< a.ts", []],

      ["cat src/*.ts a?.ts [ab].ts {a,b}.ts", []],
      ['cat ~/a.ts $HOME/b.ts "$FILE" `pwd`/c.ts - /dev/null', []],
      ["cat <<EOF > out.ts\ncat inside.ts\nEOF\ncat after.ts", ["after.ts"]],
      ["cat <<'EOF'\nsed -n 1p inside.ts\nEOF", []],
      ["cat a.ts # cat b.ts", ["a.ts"]],
      ["echo 'cat a.ts; cat b.ts'", []],
      ["ls src; find . -name a.ts; rm a.ts", []],

      ["grep -n foo a.ts b.ts", ["a.ts", "b.ts"]],
      ["grep -e foo -e bar a.ts", ["a.ts"]],
      ["grep --regexp=foo a.ts", ["a.ts"]],
      ["egrep -A 2 -m 1 'a|b' a.ts", ["a.ts"]],
      ["grep foo Makefile", ["Makefile"]],
      ["cat a.ts | grep foo", ["a.ts"]],
      ["ps aux | grep -v node | fgrep foo", []],
      ["grep foo < a.ts", ["a.ts"]],

      ["grep -rn foo src", []],
      ["grep -rn --include='*.ts' foo src lib/a.ts", ["lib/a.ts"]],
      [
        "grep -rn foo src",
        ["src/a.ts", "src/b.ts"],
        "src/a.ts:1:foo\nsrc/a.ts:9:foo\nsrc/b.ts:2:foo\n",
      ],
      ["grep -rl foo .", ["src/a.ts", "b.ts"], "./src/a.ts\n./b.ts\n"],
      ["rg foo", ["src/a.ts"], "src/a.ts:foo()\n"],
      [
        "rg -n -g '*.ts' -t ts foo apps",
        ["apps/a.ts"],
        "apps/a.ts:3:foo\napps/a.ts-4-context\n--\n",
      ],
      ["rg -l foo apps", ["apps/a.ts", "apps/b.tsx"], "apps/a.ts\napps/b.tsx\n"],
      ["rg foo src/a.ts", ["src/a.ts"], "12:foo\n"],
      ["rg foo src/a.ts", ["src/a.ts"]],
      ["rg -e foo src/a.ts src", ["src/a.ts"]],
      [
        "cd /repo && rg foo src",
        ["/repo/src/a.ts", "/abs/b.ts"],
        "src/a.ts:1:foo\n/abs/b.ts:2:foo\n",
      ],
      ["ag foo src", ["src/a.ts"], "src/a.ts:1:foo\n"],
      ["git grep -n foo -- src", ["src/a.ts"], "src/a.ts:1:foo\n"],
      ["git grep -l foo", ["src/a.ts"], "src/a.ts\n"],
      ["cat a.ts | rg foo", ["a.ts"], "src/b.ts:1:foo\n"],
      ["rg --files src", [], "src/a.ts\nsrc/b.ts\n"],
      ["rg foo src; rg bar lib/a.ts", ["lib/a.ts"], "src/a.ts:1:foo\n"],
      [
        "rg foo src",
        [],
        "const x = y ? a : b;\nhttps://example.com/a.ts:1\nBinary file src/a.bin matches\nfoo.bar();\ndefault:\n",
      ],
    ];
    for (const [command, expected, output] of cases) {
      expect(shellCommandReadPaths(command, output), command).toEqual(expected);
    }
  });

  it("reads the files a chained read and search name, as agents write them", () => {
    expect(
      shellCommandReadPaths(
        'cd /Users/x/repo; sed -n 1,80p apps/web/src/a.ts; git grep -n "foo" -- apps/web/src packages | grep -v test | head',
        [
          "export const foo = 1;",
          "apps/web/src/b.ts:12:foo",
          "apps/web/src/b.ts:40:  foo();",
          "packages/shared/src/c.ts:3:import { foo } from './foo';",
        ].join("\n"),
      ),
    ).toEqual([
      "/Users/x/repo/apps/web/src/a.ts",
      "/Users/x/repo/apps/web/src/b.ts",
      "/Users/x/repo/packages/shared/src/c.ts",
    ]);
  });

  it("caps how many files one command names", () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/${index}.ts`);
    expect(shellCommandReadPaths(`cat ${files.join(" ")}`)).toEqual(files.slice(0, 50));
    expect(searchOutputPaths(files.join("\n"), true)).toEqual(files.slice(0, 50));
  });
});
