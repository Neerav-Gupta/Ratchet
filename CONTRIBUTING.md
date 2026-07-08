# Contributing to Ratchet

Ratchet is a zero-dependency Node CLI. There's no build step, no bundler, no compiled output — you're always running the source directly.

## Setup

```sh
git clone https://github.com/Neerav-Gupta/Ratchet.git
cd Ratchet
node bin/ratchet help   # runs from source, nothing to install
```

To exercise it against a real project, point `--dir` at a Claude Code, Cursor, or Codex transcript folder or just `cd` into any repo and run `node /path/to/Ratchet/bin/ratchet init`.

## Running the tests

```sh
npm test
```

`test/run.js` is a single self-contained script (no test framework) that builds fixture transcripts and a scratch git repo under a temp directory, drives the CLI as a real subprocess (`execFileSync`), and asserts on stdout/exit codes/file state. Every new command or rule-engine behavior should get a corresponding check in there. If you add a test block, keep it isolated — several early bugs in this project came from one test's side effects leaking into a later one via the shared scratch directory (see the `undo` tests for the pattern: spin up a fresh temp dir for anything that depends on empty/initial state).

Tests must pass on Linux, macOS, and Windows — CI runs the full matrix. If you're touching path handling, remember `path.relative()` returns backslash-separated paths on Windows; anything feeding into `globMatch` needs forward slashes (see `relativize()` in `src/rules.js`).

## Where things live

| Path | What |
|---|---|
| `src/rules.js` | Rule evaluation (`command`/`file_protect`/`content` checks) and the NL → rule compiler |
| `src/hooks/runtime.js` | `PreToolUse`/`UserPromptSubmit` hook entry points |
| `src/hooks/semantic.js` | `Stop` hook semantic judge |
| `src/mine.js` + `src/cluster.js` | Transcript mining for `ratchet init` |
| `src/history.js` | The `undo` stack |
| `src/store.js` | Rule file I/O, the violation log |
| `packs/` | Bundled rule packs — see below |
| `.claude-plugin/`, `hooks/hooks.json` | Claude Code plugin packaging |
| `hooks/cursor-hooks.json`, `hooks/codex-config.toml` | Example hook config for other agents |

## Adding a rule pack

Packs are just YAML rule files (same schema as anything `ratchet add` produces) grouped in `packs/<pack-name>/`. To add one:

1. Create `packs/<name>/<rule-id>.yaml` — write it by hand, or generate it with `ratchet add "..."` in a scratch dir and copy the resulting file.
2. Every rule needs `id`, `statement`, `tier`, `mode`, `created`, `snooze_until: null`, and a `check` (for deterministic rules).
3. Keep pack rules generally applicable — packs ship to everyone who runs `ratchet pack add <name>`, so avoid anything project-specific.
4. Add a test in `test/run.js`'s pack section asserting the new rule actually blocks what it claims to.

## Rule schema stability

The project is pre-1.0: the YAML rule schema may still change between minor versions if a cleaner design emerges. Breaking schema changes should be called out clearly in `CHANGELOG.md` under the relevant version.

## Commit style

Small, focused commits. Explain *why* in the body when it's not obvious from the diff — the same standard the codebase's own inline comments hold to.

## Reporting issues

Open a GitHub issue with what you ran, what you expected, and (if relevant) the contents of the rule file involved — `ratchet why <id>` is usually the fastest way to grab that.
