# Ratchet 🔒

**Every correction you give your coding agent becomes an enforced check it can never violate again.**

You told Claude *"don't push to github until I say so."* It pushed anyway — four times over three weeks. You wrote it in CLAUDE.md. It pushed again. That's because CLAUDE.md is **advice**: prose the model reads and sometimes ignores.

Ratchet is **law**: it compiles what you teach your agent into deterministic checks wired into Claude Code's hook system. A blocked call is blocked — even in `--dangerously-skip-permissions` mode. Like a ratchet, rules only tighten: every correction becomes permanent, with the receipts attached.

```
$ ratchet init

  3 proposed rules from your own history:

  1. [enforced] From now on don't push to github untill I tell you to  ⚠ you corrected this
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

```sh
npm i -g ratchet-cc
cd your-project
ratchet init        # mine your Claude Code history → proposed rules with evidence
ratchet install     # wire hooks into ./.claude/settings.json
```

Requires Node 18+. Zero dependencies. Everything runs locally.

## How it works

**1. Capture.** `ratchet init` mines your local `~/.claude/projects` transcripts for repeated instructions and corrections (deduping session forks and re-sends, gating by time-separated occasions — not raw string counts). Or teach rules directly:

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
| `reminder` | anything not deterministically checkable — injected as context only when the prompt is relevant | UserPromptSubmit hook |

Ratchet is honest about the boundary: what it can't check deterministically becomes a *targeted* reminder, not a fake guarantee.

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

## Commands

```
ratchet init [--yes]      mine history, propose rules with evidence
ratchet add <statement>   teach a rule in plain language
ratchet install/uninstall wire/remove hooks in .claude/settings.json
ratchet list              rules and status
ratchet why <id>          the conversations that created a rule
ratchet check             static enforcement for pre-commit / CI
ratchet stats             violations caught, per rule
ratchet snooze <id>       lift a rule temporarily (default 24h)
ratchet rm <id>           delete a rule
```

## Design principles

- **Fail open.** A broken guardrail must never brick your agent: unparseable rules are skipped with a warning, hook errors allow the call, stdin hangs time out.
- **Escalate, don't ambush.** Set `mode: observe` on a new rule to log would-be blocks before enforcing.
- **Every block explains itself.** The deny reason tells the agent what the user taught, and tells you how to snooze it. `ratchet why` shows the original conversation.

## Roadmap

- [ ] `Stop`-hook semantic tier: LLM-judged rules ("keep comments minimal") that block "done" until satisfied
- [ ] Live capture: detect a correction the moment you type it, propose the rule in-session
- [ ] Cursor / Codex hook adapters — same rules, every agent
- [ ] Rule packs: shareable starter sets (git hygiene, secrets, dependency discipline)

## License

MIT
