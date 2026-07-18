# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); this project has not yet reached v1.0, so minor versions may include breaking changes to the rule schema.

## [0.6.4] — 2026-07-17

### Added
- `ratchet pack add <owner>/<repo>[/<path>]` — community rule packs. Fetches every `.yaml` file directly from a public GitHub repo via its contents API (no registry, no clone, zero dependencies), validates each one's schema and check pattern before it's ever shown, then walks through accepting each rule individually — the same per-rule preview flow as `ratchet init`. Bundled pack names never contain a slash, so `pack add <name>` and `pack add <owner>/<repo>` share one command with no ambiguity. Defaults to declining every rule when run non-interactively (no `--yes`), same as every other pack/rule-acceptance flow in this project — a rule pack from someone else's repo shouldn't install itself silently.

## [0.6.3] — 2026-07-17

### Added
- `ratchet doctor` now checks the npm registry for the latest published `ratchet-cc` version and flags a stale global install (with `ratchet selfupdate` as the fix), motivated directly by this session's own global npm install being stuck on an old version for hours despite newer releases existing.
- `ratchet selfupdate [--check]` — runs `npm install -g ratchet-cc@latest` when a newer version is available; `--check` reports without installing. Both the version check and the installer fail open: no network, a registry outage, or npm itself failing all report cleanly rather than hanging or crashing `doctor`/`selfupdate`.

## [0.6.2] — 2026-07-17

### Added
- `ratchet add` now falls back to an LLM-assisted compile when the regex-based compiler can only produce an unenforceable reminder (e.g. "block any command that tries to delete the database" — no specific command name the templates recognize). Calls the local `claude` CLI, validates the result (valid JS regex, not trivially broad, right shape), and only ever produces `command`/`file_protect`/`content` checks — never a semantic rule. Every failure mode (no binary, timeout, bad JSON, invalid pattern) fails open to the existing reminder-preview flow, so this can never make `add` worse, only sometimes better. Shown as `[llm-compiled]` and confirmed before saving, same as a reminder preview. `--no-llm` opts out.

### Fixed
- The model reliably proposed sound checks in substance but sometimes reached for `(?i)`/`(?i:...)` inline case-insensitivity flags — valid in PCRE/Python, not in JavaScript — which made `new RegExp()` throw and the whole compile attempt fail even though the underlying pattern was fine. Since `safeRegex()` in `rules.js` already matches every check case-insensitively, the flag was always redundant; it's now stripped rather than treated as a reason to reject the pattern.

## [0.6.1] — 2026-07-08

### Added
- `ratchet test <id> <input>` — simulate a rule against a hypothetical command, file, or prompt without a live agent session or a real transcript. Uses the exact same `evaluate()` logic (and, via `--said`, the exact same consent logic) the live hooks use, so the answer matches what would actually happen. Supports every deterministic check type plus reminders; semantic rules explain why they can't be simulated this way (they need a real diff). This packages the manual `echo '{...}' | ratchet hook pre-tool-use` workflow used throughout this project's own development into a real command.

## [0.6.0] — 2026-07-08

### Added
- `ratchet add` now previews a reminder-tier compile result and asks for confirmation before saving, since a silently-saved, unenforceable reminder was the exact failure mode behind several bugs found this session (an "an"/"any" in the statement, missing consent words, etc.) — better to catch it immediately and rephrase than discover later it never fired. Only pauses when actually interactive; `--yes` or a non-interactive/scripted caller (CI, another tool, this test suite) saves immediately, unchanged from before.

### Fixed
- Two doc references (README, `add --help`) still described consent as lasting "for the session" — stale since 0.5.7 made it per-invocation. Corrected.

### Fixed
- **Consent was session-wide, not per-invocation.** Found via real user report: saying "npm" once early in a session silently authorized every later, unrelated npm command for the rest of that session, because the exact-trigger-word half of `unless_user_said` scanned the *entire* transcript with no expiry — while the bare-affirmative half (added in 0.5.3) was already correctly scoped to only the most recent message. Both checks now only look at the single most recent user message. "Ask me before you run npm" means every time, not once ever — a tool whose whole premise is enforced law shouldn't quietly become a one-time unlock.

## [0.5.6] — 2026-07-08

### Added
- Per-command help: `ratchet <command> --help` (or `-h`) now shows that command's own usage, options, and examples, instead of just the generic overview. Takes priority over argument validation, so it works even when a required argument is missing.

### Fixed
- An automated secret scanner flagged an AWS-key-shaped string in `test/run.js` as an exposed credential. It was always test fixture data — used to verify the bundled `no-hardcoded-keys` pack rule detects this exact pattern, written to a throwaway file and deleted within the same test run, never a real credential. Swapped it for AWS's own documented placeholder key (`AKIAIOSFODNN7EXAMPLE`, used throughout their SDK docs specifically as a non-secret example), which scanners are already tuned to ignore.

## [0.5.5] — 2026-07-08

### Fixed
Found by inspecting a real, live transcript where consent still wasn't being recognized despite 0.5.2–0.5.4: replying to Claude Code's own `AskUserQuestion` tool ("Yes, run it (Recommended)") is delivered as a `tool_result` content block, not a text chat message — so it never reached the consent-checking code at all. `cleanContent()` correctly ignores generic `tool_result` blocks (a Bash command's stdout isn't the user talking), but this one specific case *is* genuine user consent. `extractUserText()` now also checks the entry's top-level `toolUseResult.answers` field, which is where Claude Code actually writes the selected answer text.

## [0.5.4] — 2026-07-08

### Fixed
Found immediately after 0.5.3 shipped, from `ratchet add "never run an npm command without my approval"` compiling to an unenforceable reminder:
- The command-ban capture regex grabbed the word right after "run"/"use"/etc. as the command name — but a natural article ("run **an** npm command") sat in that position instead, so it captured "an" (rejected as a stopword) and fell through to the reminder tier. An optional `a`/`an`/`the` is now skipped before capturing.
- The consent-clause detector's pronoun list only recognized "i"/"me" — "my" (as in "without **my** approval") is a distinct word, not a suffix of "me", and needed its own entry.
- Its action-word list only matched verb forms ("approve") — "approval" (the noun form) doesn't share a matchable prefix with the full word "approve". Action words are now matched as truncated stems ("approv") so `\w*` completes both inflections and noun forms.
- Added "permission"/"consent"/"go ahead" as standalone strong consent nouns — "without permission" is unambiguous about needing consent on its own, without also requiring a nearby pronoun the way weaker verbs like "want" do.

## [0.5.3] — 2026-07-08

### Fixed
Found immediately after 0.5.2 shipped: even with the consent clause correctly detected, replying to a permission prompt with a bare "yes", a menu pick like "1", or "sure, go ahead" — how people actually respond — still didn't lift the block.
- `unless_user_said` only matched literal restatement of the trigger word (e.g. the user typing "npm" again). A bare affirmative is now recognized too, but only as the single most recent user message, and only when it's short and free of contrastive/negating language ("but", "hold off", "wait", "not yet", ...) — so a stale "yes" from earlier in the session, a substantive reply that merely starts with "yes", and a later "no wait" are all still correctly treated as no consent.
- Separately, `readUserMessages()` (the live consent-check path) was reusing `extractUserText()`'s `MIN_LEN=15` filter, which exists for *mining* — where a bare "yes" is noise, not a pattern. That filter was silently deleting exactly the short replies the consent check needs to see, before the check ever ran. `extractUserText()` now takes a `minLen` option; mining keeps its default, the live hook path passes `1`.

## [0.5.2] — 2026-07-08

### Fixed
Found by live dogfooding: taught a real project the rule "never run npm without asking me first" and it hard-blocked every npm command with no way to grant consent in-session, even after explicitly saying yes.
- The consent-clause detector powering `unless_user_said` only recognized `unless`/`until`/`till` as trigger words — `without` (a very natural way to phrase this) wasn't one of them.
- It also required an exact word match (`\bask\b`), so gerund/plural/past forms like "asking", "tells", "approved" never matched the bare verb.
- It assumed a fixed word order (pronoun before action word, matching "unless I say"), but "without asking me" has the action word first — the reverse order silently failed to match.
- The fix generalizes consent detection to any of the deterministic command templates (previously hardcoded to the git-push rule only), checking for a pronoun and a permission-action word near the trigger word in either order, rather than one fixed sequence.

## [0.5.1] — 2026-07-08

### Added
- `README.npm.md`: a separate, npm-registry-facing readme (no relative links, no raw GitHub Actions badge SVG — npmjs.com's markdown sanitizer doesn't allowlist that host) automatically swapped in for `README.md` on `npm pack`/`npm publish` via new `prepack`/`postpack` scripts, then restored from git afterward.

### Removed
- README's Roadmap checklist — duplicated CHANGELOG.md and was almost entirely checked off.

## [0.5.0] — 2026-07-08

### Added
- Codex support: `ratchet init --agent codex` mines `~/.codex/sessions`, `ratchet install --codex` writes a managed block to `.codex/config.toml`, and the hook adapter normalizes Codex-shaped command/prompt/stop events.
- Cursor support: `ratchet init --agent cursor` mines `~/.cursor/projects/*/agent-transcripts`, `ratchet install --cursor` writes `.cursor/hooks.json`, and the hook adapter normalizes Cursor's `preToolUse`/`beforeShellExecution`/`beforeSubmitPrompt`/`stop` events. Verified against real transcript and hook-schema data, not just the published docs.

### Fixed
Found by validating the cross-agent adapter against real Claude/Cursor/Codex data on a live machine rather than synthetic fixtures alone:
- **Regression affecting Claude Code itself**: the tool-name normalizer remapped `Edit` → `Write` internally, but `rules.js` reads different input fields for each (`new_string` vs `content`) — so every real Claude Code `Edit` call silently bypassed `content`-tier rules. Only `Write` calls were ever checked.
- Cursor's edit tool (`StrReplace`) wasn't mapped at all, and its input shape (`path`/`old_string`/`new_string`) didn't match what the rule engine expects even where names overlapped.
- `isOurs()` (used by both idempotency checks and `uninstall`) required a Claude-shaped `{type: 'command'}` field that Cursor's real hook entries never have — silently duplicating entries on repeat `install --cursor` and making `uninstall --cursor` a no-op.
- Codex injects `<environment_context>` blocks as user-role messages; these were being mined as if the human had typed them.
- Cursor transcript entries carry no per-message timestamp. `ratchet init`'s resend/episode-gating logic defaulted to `0` for all of them, which would silently collapse genuinely repeated instructions across unrelated sessions into a single occurrence. Now falls back to the session file's mtime, so distinct sessions get distinct timestamps.
- The Stop-hook semantic judge's verdict cache keyed on `event.session_id`, but Cursor's common hook fields use `conversation_id` — every Cursor conversation in a repo would have shared one cache bucket.

## [0.4.0] — 2026-07-08

### Added
- Claude Code plugin packaging: `.claude-plugin/plugin.json` + `marketplace.json` (self-hosted, `source: "./"`) and `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`. Install with `/plugin marketplace add Neerav-Gupta/Ratchet` then `/plugin install ratchet@ratchet`.
- `ratchet undo` — a LIFO safety valve that reverses the last `add`, `rm`, `enforce`/`observe`, or `snooze`. Backed by `.ratchet/history.jsonl` (local, not committed).
- CI workflow: test matrix across Ubuntu/macOS/Windows × Node 18/20/22, plugin manifest validation, and an `npm pack` sanity check.

### Fixed
- `bin/ratchet.js` renamed to `bin/ratchet` so the plugin's `bin/` PATH exposure gives a bare `ratchet` command instead of `ratchet.js`.
- Windows: `file_protect` and `content` rules now normalize `path.relative()` output to forward slashes before glob matching. Previously, Windows' backslash-separated paths would never match glob patterns like `prod/**` or `*.ts`, silently disabling those rule types on Windows.
- `.gitignore` was only excluding `.ratchet/log.jsonl` — `candidates.jsonl` and `state/` (both local-only) could have been accidentally committed. All local `.ratchet/` state is now covered.

## [0.3.0] — 2026-07-07

### Added
- Rule packs (`ratchet pack list|add <name>`): `git-hygiene`, `secrets`, `deps` — curated starter rules copied into the project's own `.ratchet/rules/`.
- `ratchet export [file]` — renders active rules into `CLAUDE.md`/`AGENTS.md` between idempotent markers, for agents without hook support.
- `ratchet doctor` — checks Node version, rule parse health, hook installation, semantic-judge binary availability, and `.gitignore` hygiene.
- `ratchet install --pre-commit` and `examples/github-action.yml` — the same rules enforced in commits and CI, not just live sessions.
- `ratchet check --json` for machine-readable violations.

## [0.2.0] — 2026-07-07

### Added
- Semantic tier (`ratchet add --semantic`): rules judged by a model against the session's working-tree diff at the `Stop` hook, blocking completion until satisfied. Cost-disciplined (haiku by default, diff-hash verdict cache, `stop_hook_active` loop guard, fails open without a `claude` binary).
- Live correction capture: prompts that read like corrections are queued in `.ratchet/candidates.jsonl`; `ratchet review` turns them into rules.
- `ratchet enforce <id>` / `ratchet observe <id>` mode toggles; `ratchet stats` now suggests escalating observe-mode rules that keep firing.

## [0.1.0] — 2026-07-07

### Added
- Initial release: rule engine (`command`, `file_protect`, `content`, `reminder` tiers), NL statement compiler, `PreToolUse`/`UserPromptSubmit` hook runtime with fail-open error handling.
- `ratchet init` mines local Claude Code transcripts for repeated instructions and corrections (deduplicated across session forks/resends, gated by time-separated occasions) and proposes rules with evidence.
- Rules stored as individual YAML files in `.ratchet/rules/`, meant to be committed.
- CLI: `add`, `install`/`uninstall`, `list`, `why`, `check`, `stats`, `snooze`, `rm`.
