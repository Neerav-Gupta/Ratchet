import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { parse, stringify } from '../src/yaml.js';
import { compile, evaluate, globMatch } from '../src/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'ratchet');

let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${name}`);
  if (!cond) failures++;
};

// --- yaml round-trip --------------------------------------------------------
{
  const rule = {
    id: 'no-git-push',
    statement: "Never git push unless I say so: it's my call",
    tier: 'deterministic',
    mode: 'enforce',
    created: '2026-07-07',
    snooze_until: null,
    check: { type: 'command', tool: 'Bash', pattern: '\\bgit\\s+push\\b', unless_user_said: '\\bpush\\b' },
    evidence: [
      { quote: 'From now on don\'t push to github untill I tell you to', session: '8129dc80', date: '2026-06-14' },
      { quote: 'push the changes to the github', session: '8129dc80', date: '2026-06-20' },
    ],
  };
  const text = stringify(rule);
  const back = parse(text);
  check('yaml round-trips a full rule', JSON.stringify(back) === JSON.stringify(rule));
  check('yaml quotes risky scalars', text.includes('"') && parse(stringify({ x: 'a: b' })).x === 'a: b');
  check('yaml parses lists of scalars', JSON.stringify(parse('paths:\n  - .env\n  - "prod/**"').paths) === JSON.stringify(['.env', 'prod/**']));
}

// --- glob -------------------------------------------------------------------
check('glob ** matches deep paths', globMatch('prod/**', 'prod/a/b.txt'));
check('glob * stays in segment', globMatch('*.env', 'x.env') && !globMatch('*.env', 'a/b.envx'));
check('glob bare name matches anywhere', globMatch('.env', 'packages/api/.env'));
check('glob does not overmatch', !globMatch('.env', 'src/env.ts'));

// --- compiler ---------------------------------------------------------------
{
  const push = compile("From now on don't push to github untill I tell you to");
  check('compiles push correction to command rule', push.check?.type === 'command' && /git/.test(push.check.pattern));
  check('detects consent clause', push.check?.unless_user_said === '\\bpush\\b');

  const env = compile("never edit the .env file or anything in prod/");
  check('compiles path protection', env.check?.type === 'file_protect' && env.check.paths.includes('.env'));

  const any = compile('never use `: any` in *.ts files');
  check('compiles content ban with file scope', any.check?.type === 'content' && (any.check.files || []).includes('*.ts'));

  const vague = compile('keep comments minimal and code clean');
  check('vague statement falls back to reminder', vague.tier === 'reminder' && typeof vague.when === 'string');

  const cmd = compile("don't run npm in this repo");
  check('compiles command ban', cmd.check?.type === 'command' && evaluateCmd(cmd, 'npm install').violated);
}

function evaluateCmd(rule, command) {
  return evaluate(rule, { tool_name: 'Bash', tool_input: { command }, cwd: '/x' });
}

// --- evaluate ---------------------------------------------------------------
{
  const rule = compile("never push unless I ask");
  check('blocks git push', evaluateCmd(rule, 'git add . && git push origin main').violated);
  check('allows git status', !evaluateCmd(rule, 'git status').violated);
  check(
    'consent lifts the block',
    !evaluate(rule, { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/x' }, { userSaid: () => true }).violated
  );

  const prot = { check: { type: 'file_protect', paths: ['.env', 'secrets/**'] } };
  check(
    'file_protect blocks Edit on protected path',
    evaluate(prot, { tool_name: 'Edit', tool_input: { file_path: '/repo/.env' }, cwd: '/repo' }).violated
  );
  check(
    'file_protect ignores other files',
    !evaluate(prot, { tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.ts' }, cwd: '/repo' }).violated
  );

  const content = { check: { type: 'content', pattern: ':\\s*any\\b', files: ['*.ts'] } };
  check(
    'content rule catches banned pattern in scope',
    evaluate(content, { tool_name: 'Write', tool_input: { file_path: '/r/a.ts', content: 'const x: any = 1' }, cwd: '/r' }).violated
  );
  check(
    'content rule respects file scope',
    !evaluate(content, { tool_name: 'Write', tool_input: { file_path: '/r/a.py', content: 'x: any' }, cwd: '/r' }).violated
  );
}

// --- hook end-to-end over stdin ----------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-test-'));
execSync('git init -q', { cwd: work });

function cli(args, { input, cwd = work } = {}) {
  try {
    const out = execFileSync('node', [bin, ...args], { encoding: 'utf8', cwd, input });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

cli(['add', "never push to github unless I tell you to"]);
cli(['add', 'never edit the .env file']);
cli(['add', 'never use `console.log` in *.ts files']);
cli(['add', 'prefer small focused diffs when refactoring']);

check('add created 4 rule files', fs.readdirSync(path.join(work, '.ratchet', 'rules')).length === 4);

const hookEvent = (tool, input, extra = {}) =>
  JSON.stringify({ session_id: 's', transcript_path: extra.transcript || '/nonexistent', cwd: work, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });

{
  const r = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push origin main' }) });
  const parsed = JSON.parse(r.out);
  check('hook denies git push with reason', parsed.hookSpecificOutput.permissionDecision === 'deny' && /taught/.test(parsed.hookSpecificOutput.permissionDecisionReason));

  const ok = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git status' }) });
  check('hook allows innocent command silently', ok.out.trim() === '' && ok.code === 0);

  // consent: transcript where user asked to push
  const transcript = path.join(work, 't.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'looks good, please push it' }] } }) + '\n'
  );
  const consent = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }, { transcript }) });
  check('hook lifts block when user asked this session', consent.out.trim() === '');

  const env = cli(['hook', 'pre-tool-use'], { input: hookEvent('Edit', { file_path: path.join(work, '.env') }) });
  check('hook denies protected file edit', /deny/.test(env.out));

  const log = cli(['hook', 'pre-tool-use'], { input: hookEvent('Write', { file_path: path.join(work, 'a.ts'), content: 'console.log(1)' }) });
  check('hook denies banned content', /deny/.test(log.out));

  const garbage = cli(['hook', 'pre-tool-use'], { input: 'not json{{' });
  check('hook fails open on garbage input', garbage.code === 0 && garbage.out.trim() === '');

  const reminder = cli(['hook', 'user-prompt-submit'], {
    input: JSON.stringify({ cwd: work, prompt: 'refactoring the auth module now' }),
  });
  check('reminder injected on matching prompt', /small focused diffs/.test(reminder.out));
  const noReminder = cli(['hook', 'user-prompt-submit'], {
    input: JSON.stringify({ cwd: work, prompt: 'what time is it' }),
  });
  check('no reminder on unrelated prompt', noReminder.out.trim() === '');
}

// --- observe mode + snooze ---------------------------------------------------
{
  const ruleFile = path.join(work, '.ratchet', 'rules');
  const pushRule = fs.readdirSync(ruleFile).find((f) => f.includes('push'));
  const p = path.join(ruleFile, pushRule);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('mode: enforce', 'mode: observe'));
  const r = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('observe mode logs but allows', r.out.trim() === '');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('mode: observe', 'mode: enforce'));

  cli(['snooze', pushRule.replace('.yaml', ''), '--hours', '1']);
  const snoozed = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('snoozed rule does not block', snoozed.out.trim() === '');
}

// --- check (static) -----------------------------------------------------------
{
  fs.writeFileSync(path.join(work, 'bad.ts'), 'console.log("oops")\n');
  execSync('git add bad.ts', { cwd: work });
  const r = cli(['check']);
  check('static check finds content violation', r.code === 1 && /bad\.ts:1/.test(r.out));
  fs.writeFileSync(path.join(work, 'bad.ts'), 'export {}\n');
  execSync('git add bad.ts', { cwd: work });
  const clean = cli(['check']);
  check('static check passes after fix', clean.code === 0);
}

// --- stats + why ---------------------------------------------------------------
{
  const stats = cli(['stats']);
  check('stats reports caught violations', /violations caught/.test(stats.out));
  const why = cli(['why', 'no-git-push-without-consent']);
  check('why shows rule provenance', why.code === 0 ? /taught|violation/.test(why.out) : true);
}

// --- install / uninstall -------------------------------------------------------
{
  cli(['install']);
  const settings = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  check('install writes PreToolUse hook', JSON.stringify(settings.hooks.PreToolUse).includes('ratchet'));
  check('install writes UserPromptSubmit hook', !!settings.hooks.UserPromptSubmit);
  cli(['install']);
  check('install is idempotent', settings.hooks.PreToolUse.length === JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length);
  cli(['uninstall']);
  const after = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  check('uninstall removes our hooks', !JSON.stringify(after).includes('ratchet'));
}

// --- init mining end-to-end ------------------------------------------------------
{
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mine-'));
  const proj = path.join(claudeDir, '-Users-t-proj');
  fs.mkdirSync(proj, { recursive: true });
  const T0 = Date.parse('2026-06-01T10:00:00Z');
  const entry = (text, session, days) =>
    JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text }] },
      sessionId: session,
      cwd: '/Users/t/proj',
      timestamp: new Date(T0 + days * 86400_000).toISOString(),
    });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), [
    entry("From now on don't push to github untill I tell you to", 'a', 0),
    entry('please commit and push the changes to github', 'a', 2),
  ].join('\n'));
  fs.writeFileSync(path.join(proj, 'b.jsonl'), [
    entry('commit and push changes to the github repo now', 'b', 4),
    entry("I already said don't push to github without asking", 'b', 6),
  ].join('\n'));

  const initWork = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-init-'));
  const r = cli(['init', '--yes', '--dir', claudeDir], { cwd: initWork });
  const saved = fs.existsSync(path.join(initWork, '.ratchet', 'rules'))
    ? fs.readdirSync(path.join(initWork, '.ratchet', 'rules'))
    : [];
  check('init mines history into at least one rule', saved.length >= 1 && /install/.test(r.out));
  const pushRules = saved.filter((f) => /push/.test(f));
  check('mined push correction became a rule with evidence', pushRules.length >= 1 &&
    fs.readFileSync(path.join(initWork, '.ratchet', 'rules', pushRules[0]), 'utf8').includes('evidence'));
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(initWork, { recursive: true, force: true });
}

// --- v0.2: semantic judge via Stop hook ---------------------------------------
{
  cli(['add', '--semantic', 'keep code comments minimal']);
  const semFile = fs
    .readdirSync(path.join(work, '.ratchet', 'rules'))
    .find((f) => f.includes('comments'));
  check('add --semantic creates a semantic rule', !!semFile &&
    fs.readFileSync(path.join(work, '.ratchet', 'rules', semFile), 'utf8').includes('tier: semantic'));

  // Fake judges via the RATCHET_JUDGE_CMD escape hatch.
  const failJudge = path.join(work, 'judge-fail.sh');
  fs.writeFileSync(
    failJudge,
    `#!/bin/sh\ncat > /dev/null\necho '{"violations":[{"rule_id":"keep-code-comments-minimal","reason":"every line is commented"}]}'\n`,
    { mode: 0o755 }
  );
  const passJudge = path.join(work, 'judge-pass.sh');
  fs.writeFileSync(passJudge, `#!/bin/sh\ncat > /dev/null\necho '{"violations":[]}'\n`, { mode: 0o755 });

  // Need a dirty working tree for the judge to look at.
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm base', { cwd: work });
  fs.writeFileSync(path.join(work, 'dirty.ts'), '// c\nexport {}\n');
  execSync('git add dirty.ts', { cwd: work });

  const stopEvent = JSON.stringify({ session_id: 'sem1', cwd: work, stop_hook_active: false });
  const blocked = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: failJudge },
  });
  check('stop hook blocks on judged violation', /"decision":"block"/.test(blocked) && /every line is commented/.test(blocked));

  const looped = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: JSON.stringify({ session_id: 'sem1', cwd: work, stop_hook_active: true }),
    env: { ...process.env, RATCHET_JUDGE_CMD: failJudge },
  });
  check('stop hook never blocks twice in a row (loop guard)', looped.trim() === '');

  const passed = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: passJudge },
  });
  check('stop hook passes clean verdict silently', passed.trim() === '');

  const cached = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: failJudge }, // would fail, but cache says pass
  });
  check('verdict cache skips re-judging an unchanged diff', cached.trim() === '');

  const broken = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work,
    input: JSON.stringify({ session_id: 'sem2', cwd: work, stop_hook_active: false }),
    env: { ...process.env, RATCHET_JUDGE_CMD: '/nonexistent-judge' },
  });
  check('stop hook fails open when judge is missing', broken.trim() === '');
  cli(['rm', semFile.replace('.yaml', '')]);
}

// --- v0.2: live capture + review ------------------------------------------------
{
  const prompt = JSON.stringify({ cwd: work, prompt: 'From now on stop adding semicolons everywhere' });
  cli(['hook', 'user-prompt-submit'], { input: prompt });
  cli(['hook', 'user-prompt-submit'], { input: prompt }); // duplicate must not double-log
  const candFile = path.join(work, '.ratchet', 'candidates.jsonl');
  check('correction prompt captured once', fs.existsSync(candFile) &&
    fs.readFileSync(candFile, 'utf8').trim().split('\n').length === 1);

  cli(['hook', 'user-prompt-submit'], { input: JSON.stringify({ cwd: work, prompt: 'what does this function do exactly?' }) });
  check('non-correction prompt not captured',
    fs.readFileSync(candFile, 'utf8').trim().split('\n').length === 1);

  const before = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  cli(['review', '--yes']);
  const after = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  check('review --yes converts candidates to rules', after === before + 1 && !fs.existsSync(candFile));
}

// --- v0.2: mode toggles -----------------------------------------------------------
{
  cli(['observe', 'no-git-push-without-consent']);
  const r = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('ratchet observe downgrades to logging', r.out.trim() === '');
  cli(['enforce', 'no-git-push-without-consent']);
  const r2 = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('ratchet enforce restores blocking', /deny/.test(r2.out));
}

// --- v0.3: packs ---------------------------------------------------------------
{
  const list = cli(['pack', 'list']);
  check('pack list shows bundled packs', /git-hygiene/.test(list.out) && /secrets/.test(list.out) && /deps/.test(list.out));
  cli(['pack', 'add', 'git-hygiene']);
  const force = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push --force origin main' }) });
  check('pack rule blocks force-push', /no-force-push/.test(force.out));
  const again = cli(['pack', 'add', 'git-hygiene']);
  check('pack add is idempotent', /already present/.test(again.out));
  const missing = cli(['pack', 'add', 'nonsense']);
  check('unknown pack errors helpfully', missing.code === 1 && /available/.test(missing.out));
}

// --- v0.3: export ----------------------------------------------------------------
{
  cli(['export', 'CLAUDE.md']);
  const md = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  check('export writes rules block with markers', /ratchet:rules:start/.test(md) && /no-force-push/.test(md));
  fs.appendFileSync(path.join(work, 'CLAUDE.md'), '\nUser content below the block.\n');
  cli(['export', 'CLAUDE.md']);
  const md2 = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  check('export is idempotent and preserves user content',
    md2.match(/ratchet:rules:start/g).length === 1 && /User content below/.test(md2));
}

// --- v0.3: doctor + pre-commit + check --json ---------------------------------------
{
  const d = cli(['doctor']);
  check('doctor reports rule and hook status', /rule/.test(d.out) && /hooks/.test(d.out));

  const pc = cli(['install', '--pre-commit']);
  const hookFile = path.join(work, '.git', 'hooks', 'pre-commit');
  check('pre-commit hook installed', /installed/.test(pc.out) && fs.existsSync(hookFile));

  fs.writeFileSync(path.join(work, 'leak.ts'), 'const k = "AKIAABCDEFGHIJKLMNOP"\n');
  execSync('git add leak.ts', { cwd: work });
  cli(['pack', 'add', 'secrets']);
  const j = cli(['check', '--json']);
  const parsed = JSON.parse(j.out);
  check('check --json reports violations machine-readably',
    j.code === 1 && parsed.violations.some((v) => v.rule === 'no-hardcoded-keys' && v.file === 'leak.ts'));
  fs.rmSync(path.join(work, 'leak.ts'));
  execSync('git rm -q --cached leak.ts', { cwd: work });
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? '\n  all tests passed\n' : `\n  ${failures} test(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
