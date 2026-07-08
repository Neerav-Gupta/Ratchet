import fs from 'node:fs';
import readline from 'node:readline';
import { loadRules, saveRule, deleteRule, findRule, isActive, readLog, uniqueId, slugify } from './store.js';
import { compile } from './rules.js';
import { mine } from './mine.js';
import { check } from './check.js';
import { runHook, candidatesPath } from './hooks/runtime.js';
import { install, uninstall } from './hooks/install.js';

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
    ratchet init [--yes]        mine your Claude Code history, propose rules
    ratchet add <statement>     teach a rule in plain language
    ratchet install             wire hooks into ./.claude/settings.json
    ratchet uninstall           remove ratchet's hooks (rules stay)
    ratchet list                show rules and their status
    ratchet why <id>            show the evidence behind a rule
    ratchet check               run content/path rules statically (CI, pre-commit)
    ratchet stats               violations blocked, by rule
    ratchet snooze <id> [--hours n]   lift a rule temporarily (default 24h)
    ratchet rm <id>             delete a rule

  rules live in .ratchet/rules/*.yaml — commit them. They are the product.
`;

export async function run(argv) {
  const { command, positional, flags } = parseArgs(argv);

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
      const file = install();
      console.log(`  hooks installed → ${file}`);
      console.log(c(DIM, '  PreToolUse (deterministic rules) + UserPromptSubmit (reminders)'));
      return;
    }
    case 'uninstall': {
      const file = uninstall();
      console.log(file ? `  ratchet hooks removed from ${file}` : '  nothing to remove');
      return;
    }
    case 'list':
      return cmdList();
    case 'why':
      return cmdWhy(positional[0]);
    case 'check':
      return cmdCheck();
    case 'stats':
      return cmdStats();
    case 'snooze':
      return cmdSnooze(positional[0], flags.hours || 24);
    case 'rm': {
      if (!positional[0]) throw new Error('usage: ratchet rm <id>');
      if (!deleteRule(positional[0])) throw new Error(`no rule "${positional[0]}"`);
      console.log(`  removed ${positional[0]}`);
      return;
    }
    default:
      throw new Error(`unknown command "${command}" — try \`ratchet help\``);
  }
}

async function cmdInit(flags) {
  console.log(c(DIM, '  mining your Claude Code transcripts…'));
  const { proposals, scanned, sessions } = await mine({ dir: flags.dir });
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

function cmdAdd(statement, flags = {}) {
  if (!statement) throw new Error('usage: ratchet add "never push without asking"');
  let rule;
  if (flags.semantic) {
    rule = {
      id: slugify(statement),
      statement,
      tier: 'semantic',
      mode: 'enforce',
      created: new Date().toISOString().slice(0, 10),
      snooze_until: null,
    };
  } else {
    rule = compile(statement);
  }
  rule.id = uniqueId(rule.id || slugify(statement));
  const file = saveRule(rule);
  if (rule.tier === 'deterministic') {
    console.log(`  ${c(GREEN, '[enforced]')} ${rule.id} → ${file}`);
    console.log(c(DIM, `  check: ${JSON.stringify(rule.check)}`));
  } else if (rule.tier === 'semantic') {
    console.log(`  ${c(YELLOW, '[semantic]')} ${rule.id} → ${file}`);
    console.log(
      c(DIM, '  judged by a model at Stop — the agent cannot finish while this is violated')
    );
  } else {
    console.log(`  ${c(CYAN, '[reminder]')} ${rule.id} → ${file}`);
    console.log(
      c(DIM, '  not deterministically checkable — injected as context when relevant.') +
        c(DIM, ' Use --semantic to have a model enforce it at Stop instead.')
    );
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

function cmdCheck() {
  const { violations, checked, skipped } = check();
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
    if (a === '--help' || a === '-h') return { command: 'help', positional, flags };
    if (a === '--version' || a === '-v') return { command: 'version', positional, flags };
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['yes', 'json'].includes(key)) flags[key] = true;
      else {
        const val = argv[++i];
        if (val === undefined) throw new Error(`--${key} needs a value`);
        flags[key] = ['hours'].includes(key) ? parseFloat(val) : val;
      }
    } else if (!command) command = a;
    else positional.push(a);
  }
  return { command: command || 'help', positional, flags };
}
