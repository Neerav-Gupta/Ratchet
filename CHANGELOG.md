# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); this project has not yet reached v1.0, so minor versions may include breaking changes to the rule schema.

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
