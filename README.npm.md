# Ratchet

[![npm](https://img.shields.io/npm/v/ratchet-cc)](https://www.npmjs.com/package/ratchet-cc)
[![CI](https://img.shields.io/github/actions/workflow/status/Neerav-Gupta/Ratchet/ci.yml?label=CI)](https://github.com/Neerav-Gupta/Ratchet/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Neerav-Gupta/Ratchet/blob/main/LICENSE)

**Every correction you give your coding agent becomes an enforced check it can never violate again.**

You told Claude *"don't push to github until I say so."* It pushed anyway — four times over three weeks. You wrote it in CLAUDE.md. It pushed again. That's because CLAUDE.md is **advice**: prose the model reads and sometimes ignores.

Ratchet is **law**: it compiles what you teach your agent into deterministic checks wired into agent hook systems (Claude Code, Cursor, Codex). A blocked call is blocked — even in `--dangerously-skip-permissions` mode.

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

## Install

```sh
npm i -g ratchet-cc
cd your-project
ratchet init        # mine your agent history → proposed rules with evidence
ratchet install     # wire hooks into Claude Code, Cursor, and Codex configs
```

Requires Node 18+. Zero dependencies. Everything runs locally.

Using Claude Code? Install as a plugin instead — the hooks wire themselves up:

```
/plugin marketplace add Neerav-Gupta/Ratchet
/plugin install ratchet@ratchet
```

## Quick usage

```sh
ratchet add "never push to github unless I tell you to"
ratchet add "never edit the .env file"
ratchet add 'never use `console.log` in *.ts files'

ratchet pack add git-hygiene   # curated starter rules: no force-push, no --no-verify, ...
ratchet check                  # enforce statically, for pre-commit / CI
ratchet why <rule-id>           # see the conversation that created a rule
ratchet undo                    # revert the last add/rm/mode change
```

Statements compile to the strongest enforceable form: a `command` or `file_protect` or `content` check blocked at the `PreToolUse` hook, a `semantic` rule judged by a model at the `Stop` hook, or an honest `reminder` when nothing deterministic applies.

Rules live as YAML files in `.ratchet/rules/` — committed to your repo, diffable, PR-reviewable. Your agent's memory shouldn't live in a vendor's database.

## Learn more

Full documentation, the rule schema, the enforcement design, and the CLI reference: **[github.com/Neerav-Gupta/Ratchet](https://github.com/Neerav-Gupta/Ratchet)**

- [CHANGELOG](https://github.com/Neerav-Gupta/Ratchet/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/Neerav-Gupta/Ratchet/blob/main/CONTRIBUTING.md)

## License

MIT
