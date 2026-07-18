import fs from 'node:fs';
import readline from 'node:readline';
import { loadRules, saveRule, deleteRule, findRule, isActive, readLog, uniqueId, slugify } from './store.js';
import { compile, evaluate, safeRegex } from './rules.js';
import { mine } from './mine.js';
import { check } from './check.js';
import { runHook, candidatesPath, isBareAffirmative } from './hooks/runtime.js';
import { install, uninstall, installPreCommit } from './hooks/install.js';
import { listPacks, addPack } from './packs.js';
import { exportRules } from './export.js';
import { doctor } from './doctor.js';
import { recordCreate, recordDelete, recordUpdate, undo } from './history.js';
import { llmCompile } from './llm-compile.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const noColor = !process.stdout.isTTY || process.env.NO_COLOR;
const c = (code, s) => (noColor ? s : code + s + RESET);

const HELP = `
  ratchet — every correction becomes an enforced check

  Your agent ignored "don't push to github" four times? Ratchet compiles
  what you teach it into rules it physically cannot violate: PreToolUse
  hooks block the call, and the same rules run in pre-commit and CI.

  usage
    ratchet init [--yes]        mine your agent history, propose rules
       --agent claude|cursor|codex|all  which transcripts to mine (default: all)
    ratchet add <statement>     teach a rule in plain language
       --semantic               judge it with a model at Stop instead
    ratchet review [--yes]      accept corrections captured live from sessions
    ratchet install             wire hooks into Claude Code + Cursor + Codex
       --claude                  only .claude/settings.json
       --cursor                  only .cursor/hooks.json
       --codex                   only .codex/config.toml
       --pre-commit             also run \`ratchet check\` before every commit
    ratchet uninstall           remove ratchet's hooks (rules stay)
    ratchet list                show rules and their status
    ratchet why <id>            show the evidence behind a rule
    ratchet test <id> <input>   simulate a rule without a live agent session
    ratchet enforce/observe <id>  set a rule's mode
    ratchet check [--json]      run content/path rules statically (CI, pre-commit)
    ratchet stats               violations blocked, by rule
    ratchet snooze <id> [--hours n]   lift a rule temporarily (default 24h)
    ratchet rm <id>             delete a rule
    ratchet undo                revert the last add/rm/mode/snooze change
    ratchet pack [list|add <name>]    curated starter rule sets
    ratchet export [file]       render rules into CLAUDE.md / AGENTS.md
    ratchet doctor              verify the installation

  rules live in .ratchet/rules/*.yaml — commit them. They are the product.

  run \`ratchet <command> --help\` for details on any command above.
`;

const COMMAND_HELP = {
  init: `
  ratchet init [--yes] [--agent claude|cursor|codex|all] [--dir <path>]

  Mine your local agent transcripts for repeated instructions and
  corrections, and propose rules with evidence attached. Reads:
    ~/.claude/projects                      (Claude Code)
    ~/.cursor/projects/*/agent-transcripts   (Cursor)
    ~/.codex/sessions                       (Codex)

  options
    --yes             accept every proposal without prompting
    --agent <name>    only mine one agent's transcripts (default: all)
    --dir <path>      scan a specific directory instead of the default

  example
    ratchet init --agent claude --yes
`,
  add: `
  ratchet add <statement> [--semantic] [--yes]

  Teach a rule in plain language. Compiles to the strongest enforceable
  form it can: a command/file/content check blocked at PreToolUse, or
  an honest reminder if nothing deterministic applies. If it only
  manages a reminder, you'll be asked to confirm before saving —
  rephrasing to name a specific command or file usually gets a real,
  enforced check instead.

  A consent clause in the statement ("without asking me", "unless I
  say so", "without my permission") makes the rule liftable — say the
  trigger word, or a bare "yes"/"go ahead", in direct reply to the
  block that just happened. Consent is per-action, not a standing
  session-wide unlock: it only counts as your most recent message.
  Without a consent clause, the rule is unconditional.

  options
    --semantic    skip the compiler; judge this rule with a model at
                  the Stop hook instead (for rules that can't be
                  reduced to a regex, e.g. "keep comments minimal")
    --yes         skip the reminder-tier confirmation prompt

  examples
    ratchet add "never push to github unless I tell you to"
    ratchet add "never edit the .env file"
    ratchet add 'never use \`console.log\` in *.ts files'
    ratchet add --semantic "keep pull requests small and focused"
`,
  review: `
  ratchet review [--yes]

  Prompts that read like corrections are captured live during sessions
  into .ratchet/candidates.jsonl (never interrupting you). This walks
  that queue and offers each one as a rule.

  options
    --yes    accept every captured correction without prompting

  example
    ratchet review
`,
  install: `
  ratchet install [--claude] [--cursor] [--codex] [--pre-commit]

  Wire ratchet's hooks into agent configs so rules are enforced live.
  With no flag, installs for Claude Code, Cursor, and Codex at once.

  options
    --claude       only .claude/settings.json
    --cursor       only .cursor/hooks.json
    --codex        only .codex/config.toml
    --pre-commit   also add a git pre-commit hook running \`ratchet check\`

  Safe to re-run — existing hooks are preserved, ratchet's entries are
  only added once. Pass at most one of --claude/--cursor/--codex.
`,
  uninstall: `
  ratchet uninstall [--claude] [--cursor] [--codex]

  Remove ratchet's hooks from agent configs. Rules in .ratchet/rules/
  are untouched — this only stops live enforcement, same flags as
  \`ratchet install\` for scoping to one agent.
`,
  list: `
  ratchet list

  Show every rule and its current status: enforced, observe (logs but
  doesn't block), semantic, reminder, or snoozed.
`,
  why: `
  ratchet why <id>

  Show a rule's full definition, the check it compiles to, the
  original conversation(s) that taught it (if mined or captured live),
  and how many violations it's caught so far.

  example
    ratchet why no-git-push-without-consent
`,
  test: `
  ratchet test <id> <input> [<input2>] [--said <text>] [--file <path>]

  Simulate a rule against a hypothetical command, file, or prompt —
  no live agent session, no real transcript required. Same evaluation
  logic the live hooks use, so the answer matches what would actually
  happen.

  what <input> means depends on the rule's check type
    command        the shell command to test
    file_protect   the file path to test
    content        the content to test (add --file to control which
                   path it's attributed to, for rules scoped by glob;
                   otherwise a plausible filename is guessed from the
                   rule's own file globs)
    reminder       the prompt text to test against the rule's trigger
    semantic       can't be simulated this way — needs a real diff

  options
    --said <text>   pretend this was the user's most recent message,
                    to test whether it would satisfy unless_user_said

  examples
    ratchet test no-npm-command "npm install express"
    ratchet test no-npm-command "npm install" --said "yes go ahead"
    ratchet test protect-env ".env"
    ratchet test no-console-log "console.log(1)"
`,
  enforce: `
  ratchet enforce <id>

  Set a rule to enforce mode — violations are blocked, not just logged.
  Clears any active snooze. Opposite of \`ratchet observe\`.
`,
  observe: `
  ratchet observe <id>

  Set a rule to observe mode — violations are logged (visible in
  \`ratchet stats\`) but not blocked. Use this to try a new rule before
  trusting it to enforce. Clears any active snooze.
`,
  check: `
  ratchet check [--json]

  Statically re-run content and file-protection rules against tracked
  and staged files — the same rules the live hooks enforce, but usable
  in pre-commit hooks or CI where there's no running agent session to
  intercept. Command-type rules are runtime-only and are skipped here.

  options
    --json    machine-readable output; exit code is still 1 on violations

  example
    ratchet check --json
`,
  stats: `
  ratchet stats

  Show every violation ratchet has caught, grouped by rule. Suggests
  promoting an observe-mode rule to enforce once it's fired 3+ times
  without ever being escalated.
`,
  snooze: `
  ratchet snooze <id> [--hours n]

  Temporarily lift a rule — it stops blocking until the snooze expires,
  then resumes automatically. Default is 24 hours.

  example
    ratchet snooze no-npm-command --hours 2
`,
  rm: `
  ratchet rm <id>

  Delete a rule. Reversible with \`ratchet undo\` immediately after.
`,
  undo: `
  ratchet undo

  Revert the most recent rule change: an add, a delete, or a mode/
  snooze change. Call it repeatedly to walk further back — it's a
  LIFO stack, one step per call.
`,
  pack: `
  ratchet pack [list|add <name>]

  Curated starter rule sets you'd probably want anyway. \`pack add\`
  copies the pack's rules into your own .ratchet/rules/ — they're your
  files after that, edit or delete them like anything else.

  packs
    git-hygiene   no force-push, no --no-verify, no hard-reset without consent
    secrets       protect .env/keys, block hardcoded credentials
    deps          no unapproved installs, no hand-edited lockfiles

  examples
    ratchet pack list
    ratchet pack add git-hygiene
`,
  export: `
  ratchet export [file]

  Render all active rules into CLAUDE.md (or another file) between
  auto-managed markers, as a human-readable mirror of what's enforced.
  This does NOT enforce anything by itself — it's documentation, for
  agents without hook support or for anyone browsing the repo.

  Idempotent: re-run after changing rules and the block updates in
  place, without disturbing surrounding content.

  example
    ratchet export AGENTS.md
`,
  doctor: `
  ratchet doctor

  Sanity-check the installation: Node version, whether rules parse
  cleanly, whether hooks are wired in for each agent, whether a
  semantic-judge binary is available if any semantic rules exist, and
  whether .gitignore covers ratchet's local-only state.
`,
};

export async function run(argv) {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.help && COMMAND_HELP[command]) {
    console.log(COMMAND_HELP[command]);
    return;
  }

  switch (command) {
    case 'help':
      console.log(HELP);
      return;
    case 'version': {
      const pkg = JSON.parse(
        fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
      );
      console.log(pkg.version);
      return;
    }

    case 'hook': {
      const stdin = await readStdin();
      const { exitCode, stdout } = await runHook(positional[0], stdin);
      if (stdout) process.stdout.write(stdout);
      process.exitCode = exitCode;
      return;
    }

    case 'init':
      return cmdInit(flags);
    case 'add':
      return cmdAdd(positional.join(' '), flags);
    case 'review':
      return cmdReview(flags);
    case 'enforce':
    case 'observe':
      return cmdMode(positional[0], command);
    case 'install': {
      if (flags['pre-commit']) {
        const { file, action } = installPreCommit();
        console.log(`  pre-commit hook ${action} → ${file}`);
        return;
      }
      const targets = installTargets(flags);
      const files = install(undefined, targets);
      if (files.claude) {
        console.log(`  Claude Code hooks installed → ${files.claude}`);
      }
      if (files.cursor) {
        console.log(`  Cursor hooks installed → ${files.cursor}`);
      }
      if (files.codex) {
        console.log(`  Codex hooks installed → ${files.codex}`);
      }
      console.log(
        c(DIM, '  preToolUse (blocks) + beforeSubmitPrompt (capture) + stop (semantic judge)')
      );
      return;
    }
    case 'pack': {
      const [sub, name] = positional;
      if (sub === 'list' || !sub) {
        for (const p of listPacks()) {
          console.log(`  ${c(BOLD, p.name.padEnd(14))}${c(DIM, p.rules.map((r) => r.id).join(', '))}`);
        }
        console.log(c(DIM, '\n  ratchet pack add <name>'));
        return;
      }
      if (sub === 'add') {
        if (!name) throw new Error('usage: ratchet pack add <name>');
        const { added, skipped } = addPack(name);
        for (const id of added) {
          recordCreate(id);
          console.log(`  ${c(GREEN, '✓')} ${id}`);
        }
        for (const id of skipped) console.log(c(DIM, `  – ${id} (already present)`));
        if (added.length > 0) console.log(`\n  review with ${c(BOLD, 'ratchet list')} — these are your files now.`);
        return;
      }
      throw new Error('usage: ratchet pack [list|add <name>]');
    }
    case 'export': {
      const file = exportRules(flags.file || positional[0] || 'CLAUDE.md');
      console.log(`  rules exported → ${file}`);
      console.log(c(DIM, '  re-run after changing rules; the block updates in place.'));
      return;
    }
    case 'doctor': {
      let bad = 0;
      for (const r of doctor()) {
        console.log(`  ${r.ok ? c(GREEN, '✓') : c(RED, '✗')} ${r.name}${r.detail ? c(DIM, ` — ${r.detail}`) : ''}`);
        if (!r.ok) bad++;
      }
      process.exitCode = bad > 0 ? 1 : 0;
      return;
    }
    case 'uninstall': {
      const targets = installTargets(flags);
      const files = uninstall(undefined, targets);
      if (files.claude) console.log(`  Claude Code hooks removed from ${files.claude}`);
      if (files.cursor) console.log(`  Cursor hooks removed from ${files.cursor}`);
      if (files.codex) console.log(`  Codex hooks removed from ${files.codex}`);
      if (!files.claude && !files.cursor && !files.codex) console.log('  nothing to remove');
      return;
    }
    case 'list':
      return cmdList();
    case 'why':
      return cmdWhy(positional[0]);
    case 'test':
      return cmdTest(positional[0], positional.slice(1), flags);
    case 'check':
      return cmdCheck(flags);
    case 'stats':
      return cmdStats();
    case 'snooze':
      return cmdSnooze(positional[0], flags.hours || 24);
    case 'rm': {
      if (!positional[0]) throw new Error('usage: ratchet rm <id>');
      const rule = findRule(positional[0]);
      if (!rule) throw new Error(`no rule "${positional[0]}"`);
      recordDelete(rule);
      deleteRule(positional[0]);
      console.log(`  removed ${positional[0]}`);
      console.log(c(DIM, `  undo with: ratchet undo`));
      return;
    }
    case 'undo': {
      const result = undo();
      console.log(result ? `  ${result.summary}` : '  nothing to undo');
      return;
    }
    default:
      throw new Error(`unknown command "${command}" — try \`ratchet help\``);
  }
}

async function cmdInit(flags) {
  const agent = flags.agent || 'all';
  console.log(c(DIM, `  mining your ${agent === 'all' ? 'Claude Code + Cursor + Codex' : agent} transcripts…`));
  const { proposals, scanned, sessions } = await mine({ dir: flags.dir, agent });
  console.log(
    c(DIM, `  ${scanned} messages · ${sessions} session files scanned\n`)
  );
  if (proposals.length === 0) {
    console.log('  No repeated instructions found — teach rules as you go with `ratchet add`.');
    return;
  }

  console.log(c(BOLD, `  ${proposals.length} proposed rule${proposals.length === 1 ? '' : 's'} from your own history:\n`));
  let accepted = 0;
  for (const [i, rule] of proposals.entries()) {
    const meta = rule._cluster;
    const tier =
      rule.tier === 'deterministic' ? c(GREEN, '[enforced]') : c(CYAN, '[reminder]');
    console.log(
      `  ${c(BOLD, `${i + 1}.`)} ${tier} ${rule.statement.slice(0, 90)}` +
        (meta.correction ? c(RED, '  ⚠ you corrected this') : '')
    );
    console.log(
      c(DIM, `     said ${meta.count}× on ${meta.episodes} occasions · e.g. "${rule.evidence[0].quote.slice(0, 70)}…"`)
    );
    const yes = flags.yes || (await ask(`     keep as rule ${rule.id}? [y/N] `));
    if (yes) {
      const { _cluster, ...clean } = rule;
      clean.id = uniqueId(clean.id);
      const file = saveRule(clean);
      recordCreate(clean.id);
      console.log(c(GREEN, `     ✓ ${file}`));
      accepted++;
    }
    console.log('');
  }
  console.log(
    accepted > 0
      ? `  ${accepted} rule${accepted === 1 ? '' : 's'} saved. Run ${c(BOLD, 'ratchet install')} to enforce them.`
      : '  nothing saved.'
  );
}

async function cmdAdd(statement, flags = {}) {
  if (!statement) throw new Error('usage: ratchet add "never push without asking"');
  let rule = flags.semantic ? null : compile(statement);

  // The regex compiler only recognizes a fixed set of phrasings. When it
  // can't find a deterministic form, try a model before giving up and
  // saving an unenforceable reminder — it can often see the specific
  // command/file/content the regex templates missed.
  if (rule && rule.tier === 'reminder' && !flags.semantic && !flags['no-llm']) {
    const check = llmCompile(statement);
    if (check) {
      rule = {
        id: slugify(statement),
        statement,
        mode: 'enforce',
        created: new Date().toISOString().slice(0, 10),
        snooze_until: null,
        tier: 'deterministic',
        check,
      };
      console.log(`  ${c(CYAN, '[llm-compiled]')} the built-in compiler couldn't find a deterministic form — a model proposed one:`);
      console.log(c(DIM, `  check: ${JSON.stringify(rule.check)}`));
      if (!flags.yes) {
        const proceed = await confirmProceed(c(YELLOW, '  Save this LLM-compiled rule? [Y/n] '));
        if (!proceed) {
          console.log(c(DIM, '  not saved — try rephrasing.'));
          return;
        }
      }
    }
  }

  // A reminder never blocks anything — this is exactly the failure mode
  // that bit real usage repeatedly this session (an "an"/"any" in the
  // statement silently produced an unenforceable rule). Give a chance to
  // rephrase before saving, rather than finding out later it never fired.
  if (rule && rule.tier === 'reminder' && !flags.semantic) {
    console.log(`  ${c(CYAN, '[reminder]')} ${rule.id}`);
    console.log(
      c(DIM, '  not deterministically checkable — injected as context when relevant, never blocks anything.')
    );
    console.log(c(DIM, '  Rephrase to name a specific command/file, or add --semantic to have a model enforce it.'));
    if (!flags.yes) {
      const proceed = await confirmProceed(c(YELLOW, '  Save as a reminder anyway? [Y/n] '));
      if (!proceed) {
        console.log(c(DIM, '  not saved — try rephrasing.'));
        return;
      }
    }
  }

  if (flags.semantic) {
    rule = {
      id: slugify(statement),
      statement,
      tier: 'semantic',
      mode: 'enforce',
      created: new Date().toISOString().slice(0, 10),
      snooze_until: null,
    };
  }
  rule.id = uniqueId(rule.id || slugify(statement));
  const file = saveRule(rule);
  recordCreate(rule.id);
  if (rule.tier === 'deterministic') {
    console.log(`  ${c(GREEN, '[enforced]')} ${rule.id} → ${file}`);
    console.log(c(DIM, `  check: ${JSON.stringify(rule.check)}`));
  } else if (rule.tier === 'semantic') {
    console.log(`  ${c(YELLOW, '[semantic]')} ${rule.id} → ${file}`);
    console.log(
      c(DIM, '  judged by a model at Stop — the agent cannot finish while this is violated')
    );
  } else {
    console.log(`  ${c(GREEN, '✓')} saved → ${file}`);
  }
}

async function cmdReview(flags) {
  const file = candidatesPath(process.cwd());
  if (!fs.existsSync(file)) {
    console.log('  no captured corrections — ratchet notices them as you work.');
    return;
  }
  const candidates = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (candidates.length === 0) {
    console.log('  no captured corrections.');
    return;
  }

  console.log(c(BOLD, `\n  ${candidates.length} correction${candidates.length === 1 ? '' : 's'} captured from your sessions:\n`));
  let kept = 0;
  for (const [i, cand] of candidates.entries()) {
    const rule = compile(cand.prompt);
    const tier = rule.tier === 'deterministic' ? c(GREEN, '[enforced]') : c(CYAN, '[reminder]');
    console.log(`  ${c(BOLD, `${i + 1}.`)} ${tier} "${cand.prompt.slice(0, 90)}"`);
    const yes = flags.yes || (await ask(`     keep as rule ${rule.id}? [y/N] `));
    if (yes) {
      rule.id = uniqueId(rule.id);
      rule.evidence = [{ quote: cand.prompt.slice(0, 160), date: (cand.ts || '').slice(0, 10) }];
      console.log(c(GREEN, `     ✓ ${saveRule(rule)}`));
      recordCreate(rule.id);
      kept++;
    }
  }
  fs.unlinkSync(file);
  console.log(`\n  ${kept} rule${kept === 1 ? '' : 's'} saved, queue cleared.`);
}

function cmdMode(id, mode) {
  if (!id) throw new Error(`usage: ratchet ${mode} <id>`);
  const rule = findRule(id);
  if (!rule) throw new Error(`no rule "${id}"`);
  recordUpdate(rule);
  rule.mode = mode === 'enforce' ? 'enforce' : 'observe';
  rule.snooze_until = null;
  saveRule(rule);
  console.log(`  ${id} → mode: ${rule.mode}`);
}

function cmdList() {
  const rules = loadRules();
  if (rules.length === 0) {
    console.log('  no rules yet — `ratchet init` or `ratchet add "…"`');
    return;
  }
  for (const r of rules) {
    const state = !isActive(r)
      ? c(YELLOW, 'snoozed ')
      : r.mode === 'observe'
        ? c(DIM, 'observe ')
        : r.tier === 'deterministic'
          ? c(GREEN, 'enforced')
          : r.tier === 'semantic'
            ? c(YELLOW, 'semantic')
            : c(CYAN, 'reminder');
    console.log(`  ${state}  ${c(BOLD, r.id)}  ${c(DIM, r.statement.slice(0, 70))}`);
  }
}

function cmdWhy(id) {
  if (!id) throw new Error('usage: ratchet why <id>');
  const rule = findRule(id);
  if (!rule) throw new Error(`no rule "${id}"`);
  console.log(`\n  ${c(BOLD, rule.id)} — ${rule.statement}`);
  console.log(c(DIM, `  tier: ${rule.tier} · mode: ${rule.mode} · created: ${rule.created}`));
  if (rule.check) console.log(c(DIM, `  check: ${JSON.stringify(rule.check)}`));
  const evidence = rule.evidence || [];
  if (evidence.length > 0) {
    console.log(`\n  you taught this rule:`);
    for (const e of evidence) {
      console.log(`   ${c(DIM, `${e.date || '?'} · session ${e.session || '?'}`)}`);
      console.log(`   "${e.quote}"`);
    }
  }
  const blocks = readLog().filter((l) => l.rule === rule.id);
  console.log(`\n  ${blocks.length} violation${blocks.length === 1 ? '' : 's'} caught so far.\n`);
}

function cmdTest(id, inputs, flags = {}) {
  if (!id) throw new Error('usage: ratchet test <id> <input> [<input2>]');
  const rule = findRule(id);
  if (!rule) throw new Error(`no rule "${id}"`);

  // Mirrors hooks/runtime.js's userSaid exactly: the trigger word, or a
  // bare affirmative, in --said's text (standing in for "the most recent
  // user message").
  const userSaid = (pattern) =>
    flags.said !== undefined && (safeRegex(pattern).test(flags.said) || isBareAffirmative(flags.said));

  if (rule.tier === 'semantic') {
    console.log(c(YELLOW, '  semantic rules are judged by a model against a real diff — cannot be simulated here.'));
    console.log(c(DIM, '  make a real change and run the agent normally to exercise this one.'));
    return;
  }

  if (rule.tier === 'reminder') {
    const prompt = inputs[0];
    if (!prompt) throw new Error('usage: ratchet test <id> "<prompt text>"');
    const matches = rule.when && safeRegex(rule.when).test(prompt);
    if (matches) console.log(c(CYAN, `  ↳ would inject as a reminder — prompt matches /${rule.when}/`));
    else console.log(c(DIM, `  would not trigger — prompt does not match /${rule.when}/`));
    return;
  }

  const check = rule.check;
  let event;
  if (check.type === 'command') {
    const command = inputs[0];
    if (!command) throw new Error('usage: ratchet test <id> "<command>"');
    event = { tool_name: check.tool || 'Bash', tool_input: { command }, cwd: process.cwd() };
  } else if (check.type === 'file_protect') {
    const file = inputs[0];
    if (!file) throw new Error('usage: ratchet test <id> "<file-path>"');
    event = { tool_name: 'Edit', tool_input: { file_path: file }, cwd: process.cwd() };
  } else if (check.type === 'content') {
    let file = flags.file;
    let content = inputs[0];
    if (inputs.length > 1) {
      file = inputs[0];
      content = inputs[1];
    }
    if (!content) throw new Error('usage: ratchet test <id> "<content>" (or <file> <content>)');
    if (!file) file = guessFileFromGlobs(check.files);
    event = { tool_name: 'Write', tool_input: { file_path: file, content }, cwd: process.cwd() };
  } else {
    throw new Error(`don't know how to simulate check type "${check.type}"`);
  }

  const result = evaluate(rule, event, { userSaid });
  if (result.violated) {
    console.log(c(RED, '  ⛔ would BLOCK'));
    console.log(c(DIM, `  reason: ${result.reason}`));
  } else {
    console.log(c(GREEN, '  ✓ would ALLOW'));
  }
}

function guessFileFromGlobs(globs) {
  const g = Array.isArray(globs) ? globs[0] : globs;
  if (!g) return 'test.txt';
  const ext = g.match(/\.[a-zA-Z0-9]+$/);
  if (ext) return `test${ext[0]}`;
  return g.includes('*') ? g.replace(/\*+/g, 'test') : g;
}

function cmdCheck(flags = {}) {
  const { violations, checked, skipped } = check();
  if (flags.json) {
    console.log(JSON.stringify({ violations, checked, skipped }, null, 2));
    process.exitCode = violations.length > 0 ? 1 : 0;
    return;
  }
  if (skipped > 0) {
    console.log(c(DIM, `  ${skipped} command rule${skipped === 1 ? '' : 's'} are runtime-only (skipped here)`));
  }
  if (violations.length === 0) {
    console.log(`  ${c(GREEN, '✓')} ${checked} rule${checked === 1 ? '' : 's'} checked, no violations`);
    return;
  }
  for (const v of violations) {
    console.log(
      `  ${c(RED, '✗')} ${v.rule}  ${v.file}${v.line ? ':' + v.line : ''}  ${c(DIM, v.text || v.note || '')}`
    );
  }
  process.exitCode = 1;
}

function cmdStats() {
  const log = readLog();
  if (log.length === 0) {
    console.log('  no violations logged yet — that’s either discipline or a fresh install.');
    return;
  }
  const byRule = new Map();
  for (const entry of log) {
    const key = entry.rule;
    const agg = byRule.get(key) || { blocked: 0, observed: 0 };
    if (entry.mode === 'observe') agg.observed++;
    else agg.blocked++;
    byRule.set(key, agg);
  }
  console.log(c(BOLD, `\n  ${log.length} violation${log.length === 1 ? '' : 's'} caught\n`));
  for (const [rule, agg] of [...byRule.entries()].sort((a, b) => b[1].blocked - a[1].blocked)) {
    console.log(
      `  ${c(BOLD, String(agg.blocked + agg.observed).padStart(4))}  ${rule}` +
        (agg.observed ? c(DIM, `  (${agg.observed} observed)`) : '')
    );
    // Escalation nudge: an observe-mode rule that keeps firing has earned teeth.
    if (agg.observed >= 3 && agg.blocked === 0) {
      const r = findRule(rule);
      if (r && r.mode === 'observe') {
        console.log(c(YELLOW, `        ↳ observed ${agg.observed}× — consider: ratchet enforce ${rule}`));
      }
    }
  }
  console.log('');
}

function cmdSnooze(id, hours) {
  if (!id) throw new Error('usage: ratchet snooze <id> [--hours n]');
  const rule = findRule(id);
  if (!rule) throw new Error(`no rule "${id}"`);
  recordUpdate(rule);
  rule.snooze_until = new Date(Date.now() + hours * 3600_000).toISOString();
  saveRule(rule);
  console.log(`  ${id} snoozed for ${hours}h (until ${rule.snooze_until})`);
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    })
  );
}

/**
 * Opposite default from ask(): proceeds unless explicitly declined. Used
 * for "are you sure" safety nets where the non-interactive/scripted case
 * (CI, tests, another tool piping in `ratchet add`) must keep working
 * exactly as before — only an interactive human typing "n" aborts.
 */
function confirmProceed(question) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(!/^n(o)?$/i.test(answer.trim()));
    })
  );
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000); // hooks must never hang the agent
  });
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Don't short-circuit here — a command may already be captured (e.g.
    // `ratchet add --help`), and it should get that command's specific
    // help, not just the generic overview.
    if (a === '--help' || a === '-h') {
      flags.help = true;
      continue;
    }
    if (a === '--version' || a === '-v') return { command: 'version', positional, flags };
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['yes', 'json', 'semantic', 'no-llm', 'pre-commit', 'claude', 'cursor', 'codex', 'help'].includes(key)) flags[key] = true;
      else {
        const val = argv[++i];
        if (val === undefined) throw new Error(`--${key} needs a value`);
        flags[key] = ['hours', 'agent'].includes(key) ? val : val;
      }
    } else if (!command) command = a;
    else positional.push(a);
  }
  return { command: command || 'help', positional, flags };
}

function installTargets(flags) {
  const selected = ['claude', 'cursor', 'codex'].filter((k) => flags[k]);
  if (selected.length > 1) throw new Error('pass only one of --claude, --cursor, or --codex');
  if (flags.claude) return { claude: true, cursor: false, codex: false };
  if (flags.cursor) return { claude: false, cursor: true, codex: false };
  if (flags.codex) return { claude: false, cursor: false, codex: true };
  return { claude: true, cursor: true, codex: true };
}
