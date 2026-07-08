# Ratchet

[![CI](https://github.com/Neerav-Gupta/Ratchet/actions/workflows/ci.yml/badge.svg)](https://github.com/Neerav-Gupta/Ratchet/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ratchet-cc)](https://www.npmjs.com/package/ratchet-cc)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Every correction you give your coding agent becomes an enforced check it can never violate again.**

You told Claude *"don't push to github until I say so."* It pushed anyway — four times over three weeks. You wrote it in CLAUDE.md. It pushed again. That's because CLAUDE.md is **advice**: prose the model reads and sometimes ignores.

Ratchet is **law**: it compiles what you teach your agent into deterministic checks wired into agent hook systems. A blocked call is blocked — even in `--dangerously-skip-permissions` mode. Like a ratchet, rules only tighten: every correction becomes permanent, with the receipts attached.

```
$ ratchet init

  3 proposed rules from your own history:

  1. [enforced] From now on don't push to github until I tell you to  ⚠ you corrected this
     said 6× on 4 occasions · e.g. "Can you commit and push all changes…"
     ✓ .ratchet/rules/no-git-push-without-consent.yaml
```

Then, when the agent tries it anyway:

```
⛔ Blocked by ratchet rule "no-git-push-without-consent":
   From now on don't push to github untill I tell you to
   (command matches /\bgit\s+push\b/ and the user has not said "push" this session)
```

But the moment *you* say "push it" in the session, the same rule steps aside. Consent-aware enforcement, not a blunt firewall.

## Install

**As a Claude Code plugin** (recommended — the hooks wire themselves up, and `ratchet` becomes a bare command Claude can call directly):

```
/plugin marketplace add Neerav-Gupta/Ratchet
/plugin install ratchet@ratchet
```

**Or as a standalone CLI**, if you want it outside Claude Code too (CI, pre-commit, other agents):

```sh
npm i -g ratchet-cc
cd your-project
ratchet init        # mine your Claude Code history → proposed rules with evidence
ratchet install     # wire hooks into Claude Code, Cursor, and Codex configs
```

Requires Node 18+. Zero dependencies. Everything runs locally.

## How it works

**1. Capture.** `ratchet init` mines your local Claude Code, Cursor, and Codex transcripts for repeated instructions and corrections (deduping session forks and re-sends, gating by time-separated occasions — not raw string counts). Or teach rules directly:

```sh
ratchet add "never push to github unless I tell you to"
ratchet add "never edit the .env file"
ratchet add 'never use `console.log` in *.ts files'
```

**2. Compile.** Statements become the strongest form they support:

| Check type | Example | Enforced at |
|---|---|---|
| `command` | git push ban, with `unless_user_said` consent scan of the live session transcript | PreToolUse hook |
| `file_protect` | `.env`, `prod/**` — no tool may write them | PreToolUse hook |
| `content` | banned patterns in written code, scoped by glob | PreToolUse hook + `ratchet check` |
| `semantic` | "keep comments minimal" — a model judges the session's diff at Stop and **blocks "done"** until satisfied | Stop hook |
| `reminder` | anything else — injected as context only when the prompt is relevant | UserPromptSubmit hook |

The semantic judge runs through your own `claude` CLI (haiku by default, `RATCHET_JUDGE_MODEL` to change), only when the working tree actually changed, with a per-session verdict cache and a loop guard — it can nudge the agent back to work, never trap it. Everything else is honest about the boundary: what can't be checked becomes a *targeted* reminder, not a fake guarantee.

**3. Enforce — in three places.** The same rule blocks the agent mid-session (hooks), your commits (`ratchet check` in pre-commit), and your team's PRs (`ratchet check` in CI, exits 1 on violations).

**4. Own your rules.** Rules are individual YAML files in `.ratchet/rules/` — committed, diffable, PR-reviewable, with the evidence embedded:

```yaml
id: no-git-push-without-consent
statement: From now on don't push to github untill I tell you to
tier: deterministic
mode: enforce
check:
  type: command
  pattern: \bgit\s+push\b
  unless_user_said: \bpush\b
evidence:
  - quote: From now on don't push to github untill I tell you to
    session: 8129dc80
    date: 2026-06-29
```

Your agent memory shouldn't live in a vendor's database. It should live in your repo, where it survives model upgrades, tool switches, and teammates joining.

**Or don't wait for history — capture live.** When you type a correction mid-session ("From now on stop adding semicolons everywhere"), ratchet notices and queues it. Later:

```sh
ratchet review      # each captured correction → y/n → rule
```

**Start from a pack.** Curated rules you'd want anyway:

```sh
ratchet pack add git-hygiene   # no force-push, no --no-verify, no hard-reset without consent
ratchet pack add secrets       # protect .env/keys, block hardcoded credentials
ratchet pack add deps          # no unapproved installs, no hand-edited lockfiles
```

Pack rules are copied into *your* `.ratchet/rules/` — edit or delete them like anything else.

## Commands

```
ratchet init [--yes]         mine history, propose rules with evidence
ratchet add <statement>      teach a rule in plain language (--semantic for judged rules)
ratchet review [--yes]       accept corrections captured live from sessions
ratchet install/uninstall    wire/remove hooks for Claude Code, Cursor, and Codex
   install --claude          only .claude/settings.json
   install --cursor          only .cursor/hooks.json
   install --codex           only .codex/config.toml
   install --pre-commit      also run `ratchet check` before every commit
ratchet list / why <id>      rules, status, and the conversations behind them
ratchet enforce/observe <id> set a rule's teeth
ratchet check [--json]       static enforcement for pre-commit / CI
ratchet stats                violations caught, per rule (+ escalation hints)
ratchet snooze <id>          lift a rule temporarily (default 24h)
ratchet rm <id>               delete a rule
ratchet undo                 revert the last add/rm/mode/snooze change
ratchet pack list|add <name> curated starter rule sets
ratchet export [file]        render the rulebook into CLAUDE.md / AGENTS.md
ratchet doctor               verify the installation
```

Every command above has its own detailed help: `ratchet <command> --help` (or `-h`).

Made a rule too aggressive, or deleted the wrong one? `ratchet undo` reverses the last change — it's the safety valve for a tool whose entire job is enforcement.

CI: copy [examples/github-action.yml](examples/github-action.yml) into `.github/workflows/` and violations fail the build.

## Design principles

- **Fail open.** A broken guardrail must never brick your agent: unparseable rules are skipped with a warning, hook errors allow the call, stdin hangs time out.
- **Escalate, don't ambush.** Set `mode: observe` on a new rule to log would-be blocks before enforcing.
- **Every block explains itself.** The deny reason tells the agent what the user taught, and tells you how to snooze it. `ratchet why` shows the original conversation.

## How this differs from the obvious alternatives

**"Isn't this just CLAUDE.md?"** No — that's the whole point. CLAUDE.md is prose the model reads and can choose to ignore; a hook that returns `permissionDecision: "deny"` cannot be talked out of it, even under `--dangerously-skip-permissions`. Ratchet's `export` command *writes to* CLAUDE.md as a human-readable mirror of the enforced rules — it's a side effect, not the mechanism.

**"Doesn't Claude Code's auto-memory / `/insights` already do this?"** Those detect repeated instructions and suggest CLAUDE.md additions — advisory, and Claude-only. Ratchet's `init` does similar mining, but every rule it produces is either a deterministic check, a model-judged gate that blocks completion, or an honest reminder — never just a hope that the model reads its own notes more carefully next time.

**"What about tellonce / other correction-memory tools?"** Closest relative — some, like tellonce, share the "compile corrections into enforcement" idea and are cross-agent memory plugins. The difference is where the rules live: Ratchet's rules are YAML files in `.ratchet/rules/`, committed to the repo, PR-reviewable, and enforced identically in three places — the live agent session, `git commit` (pre-commit), and CI. A memory plugin's state lives in the plugin's own store; if you switch tools, stop paying for the plugin, or just want a teammate to see *why* a rule exists without installing anything, there's nothing to read. A rule in this repo is a rule you own.

See [CHANGELOG.md](CHANGELOG.md) for what shipped in each version. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
