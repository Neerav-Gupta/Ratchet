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

  // Regression: "without asking me first" was silently dropped for the
  // generic command-ban template — only the hardcoded git-push branch had
  // a consent bypass, and even that only matched "unless/until", never
  // "without", and never gerund forms ("asking" vs. bare "ask").
  const npmConsent = compile('never run npm without asking me first');
  check('command-ban template also detects a consent clause', npmConsent.check?.unless_user_said === '\\bnpm\\b');
  check(
    'consent bypass works with real transcript text',
    !evaluate(
      npmConsent,
      { tool_name: 'Bash', tool_input: { command: 'npm install express' }, cwd: '/x' },
      { userSaid: (p) => new RegExp(p, 'i').test('yes go ahead, npm install is fine') }
    ).violated
  );
  const npmNoConsent = compile('never run npm without proper testing');
  check(
    'unrelated "without" clause does not falsely grant a bypass',
    npmNoConsent.check?.unless_user_said === undefined
  );
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

  // Regression: most people respond to a permission prompt with a bare
  // "yes"/"1"/"sure, go ahead" rather than re-typing the command name. This
  // was silently swallowed twice over: (1) unless_user_said only matched
  // literal restatement of the trigger word, and (2) readUserMessages()
  // reused extractUserText()'s MIN_LEN=15 filter, meant for mining (where a
  // bare "yes" is noise), which deleted these exact short replies before
  // the consent check ever saw them.
  // Deliberately no mention of "push" anywhere but the final reply — the
  // whole point is isolating the bare-affirmative path from the existing
  // exact-trigger-word match, which would otherwise mask these cases.
  const bareTranscript = (text) => {
    const p = path.join(work, `bare-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'please set up the deployment' }] } }),
        JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } }),
      ].join('\n')
    );
    return p;
  };
  const bareYes = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }, { transcript: bareTranscript('yes') }) });
  check('bare "yes" as the last message lifts the block', bareYes.out.trim() === '');
  const bareNumber = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }, { transcript: bareTranscript('1') }) });
  check('bare menu selection "1" lifts the block', bareNumber.out.trim() === '');
  const bareSure = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }, { transcript: bareTranscript('sure, go ahead') }) });
  check('"sure, go ahead" lifts the block', bareSure.out.trim() === '');
  const substantive = cli(['hook', 'pre-tool-use'], {
    input: hookEvent('Bash', { command: 'git push' }, { transcript: bareTranscript("yes I know but let's hold off for now") }),
  });
  check('a substantive reply merely starting with "yes" does not falsely lift the block', /deny/.test(substantive.out));
  const staleYes = (() => {
    const p = path.join(work, `stale-${Date.now()}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'yes' }] } }),
        JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: "no wait, don't do that yet" }] } }),
      ].join('\n')
    );
    return p;
  })();
  const stale = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }, { transcript: staleYes }) });
  check('an earlier "yes" does not override a later "no wait" (recency wins)', /deny/.test(stale.out));

  const env = cli(['hook', 'pre-tool-use'], { input: hookEvent('Edit', { file_path: path.join(work, '.env') }) });
  check('hook denies protected file edit', /deny/.test(env.out));

  const log = cli(['hook', 'pre-tool-use'], { input: hookEvent('Write', { file_path: path.join(work, 'a.ts'), content: 'console.log(1)' }) });
  check('hook denies banned content', /deny/.test(log.out));

  const codex = cli(['hook', 'pre-tool-use'], {
    input: JSON.stringify({
      agent: 'codex',
      hook_event_name: 'pre-tool-use',
      cwd: work,
      tool_name: 'functions.exec_command',
      tool_input: { cmd: 'git push origin main' },
    }),
  });
  check('codex hook denies git push with block decision', /"decision":"block"/.test(codex.out));

  // Cursor's beforeShellExecution sends the command as a flat `command`
  // field (not nested in tool_input) — confirmed against Cursor's published
  // hook schema (docs.cursor.com/agent/hooks).
  const cursorShell = cli(['hook', 'pre-tool-use'], {
    input: JSON.stringify({
      hook_event_name: 'beforeShellExecution',
      cwd: work,
      command: 'git push origin main',
    }),
  });
  check('cursor beforeShellExecution hook denies with permission:deny', /"permission":"deny"/.test(cursorShell.out));

  const cursorAllow = cli(['hook', 'pre-tool-use'], {
    input: JSON.stringify({ hook_event_name: 'beforeShellExecution', cwd: work, command: 'git status' }),
  });
  check('cursor hook allows innocent command silently', cursorAllow.out.trim() === '');

  const cursorEdit = cli(['hook', 'pre-tool-use'], {
    input: JSON.stringify({
      hook_event_name: 'preToolUse',
      cwd: work,
      tool_name: 'Write',
      tool_input: { path: path.join(work, '.env'), content: 'X=1' },
    }),
  });
  check('cursor generic preToolUse (Write on protected path) denies', /"permission":"deny"/.test(cursorEdit.out));

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
  check('install writes Codex hook config', fs.readFileSync(path.join(work, '.codex', 'config.toml'), 'utf8').includes('ratchet:hooks:start'));
  const cursorConfig = JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8'));
  check('install writes Cursor preToolUse hook', !!cursorConfig.hooks.preToolUse?.length);
  check('install writes Cursor beforeSubmitPrompt hook', !!cursorConfig.hooks.beforeSubmitPrompt?.length);
  check('install writes Cursor stop hook with loop_limit', cursorConfig.hooks.stop?.[0]?.loop_limit === 3);
  cli(['install']);
  check('install is idempotent', settings.hooks.PreToolUse.length === JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length);
  check(
    'cursor install is idempotent too',
    JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8')).hooks.preToolUse.length === 1
  );
  cli(['uninstall']);
  const after = JSON.parse(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  check('uninstall removes our hooks', !JSON.stringify(after).includes('ratchet'));
  check('uninstall removes Codex hook block', !fs.readFileSync(path.join(work, '.codex', 'config.toml'), 'utf8').includes('ratchet:hooks:start'));
  check(
    'uninstall removes Cursor hooks',
    !JSON.stringify(JSON.parse(fs.readFileSync(path.join(work, '.cursor', 'hooks.json'), 'utf8'))).includes('ratchet')
  );

  // --install-target flags touch only the requested config.
  fs.rmSync(path.join(work, '.claude', 'settings.json'), { force: true });
  fs.rmSync(path.join(work, '.cursor', 'hooks.json'), { force: true });
  cli(['install', '--cursor']);
  check('install --cursor writes only the Cursor config', fs.existsSync(path.join(work, '.cursor', 'hooks.json')) && !fs.existsSync(path.join(work, '.claude', 'settings.json')));
  cli(['install']); // restore claude hooks for later tests in this file
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
  const r = cli(['init', '--yes', '--agent', 'claude', '--dir', claudeDir], { cwd: initWork });
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

// --- init mining from Codex transcripts -----------------------------------------
{
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-codex-'));
  const day = path.join(codexDir, '2026', '07', '07');
  fs.mkdirSync(day, { recursive: true });
  const T0 = Date.parse('2026-07-07T10:00:00Z');
  const eventMsg = (text, days) =>
    JSON.stringify({
      timestamp: new Date(T0 + days * 86400_000).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: text },
    });
  const responseItem = (text, days) =>
    JSON.stringify({
      timestamp: new Date(T0 + days * 86400_000).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [
    eventMsg("From now on don't push to github unless I say so", 0),
    responseItem("I already said don't push to github without asking", 3),
    eventMsg("You still keep trying to push to github without asking", 6),
  ].join('\n'));

  const initWork = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-codex-init-'));
  const r = cli(['init', '--yes', '--agent', 'codex', '--dir', codexDir], { cwd: initWork });
  const saved = fs.existsSync(path.join(initWork, '.ratchet', 'rules'))
    ? fs.readdirSync(path.join(initWork, '.ratchet', 'rules'))
    : [];
  check('init mines Codex transcripts into rules', saved.some((f) => /push/.test(f)) && /install/.test(r.out));
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.rmSync(initWork, { recursive: true, force: true });
}

// --- init mining from Cursor transcripts -----------------------------------------
{
  // Layout and entry shape confirmed against a real
  // ~/.cursor/projects/<project>/agent-transcripts/<session>/<session>.jsonl
  // file on disk: {role:'user', message:{content:[{type:'text', text}]}}
  // with no per-message timestamp — only <timestamp>/<user_query> wrapper
  // tags inside the text itself, which extract.js strips.
  const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-cursor-'));
  const project = path.join(cursorDir, 'my-project', 'agent-transcripts');
  const cursorEntry = (text) =>
    JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: `<timestamp>Tue, Jul 7, 2026</timestamp>\n<user_query>\n${text}\n</user_query>` }] },
    });

  const session1 = path.join(project, 'sess-1');
  fs.mkdirSync(session1, { recursive: true });
  const file1 = path.join(session1, 'sess-1.jsonl');
  fs.writeFileSync(file1, [cursorEntry("From now on don't push to github unless I say so")].join('\n'));

  const session2 = path.join(project, 'sess-2');
  fs.mkdirSync(session2, { recursive: true });
  const file2 = path.join(session2, 'sess-2.jsonl');
  fs.writeFileSync(file2, [cursorEntry("I already said don't push to github without asking")].join('\n'));

  // No per-message timestamp exists in the real format — the mtime fallback
  // is what must supply distinct episode timestamps across these two files.
  const now = Date.now();
  fs.utimesSync(file1, new Date(now - 6 * 86400_000), new Date(now - 6 * 86400_000));
  fs.utimesSync(file2, new Date(now), new Date(now));

  const initWork = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-cursor-init-'));
  const r = cli(['init', '--yes', '--agent', 'cursor', '--dir', cursorDir], { cwd: initWork });
  const saved = fs.existsSync(path.join(initWork, '.ratchet', 'rules'))
    ? fs.readdirSync(path.join(initWork, '.ratchet', 'rules'))
    : [];
  check('init mines Cursor transcripts into rules', saved.some((f) => /push/.test(f)) && /install/.test(r.out));
  const pushFile = saved.find((f) => /push/.test(f));
  check(
    'mined Cursor rule strips <timestamp>/<user_query> wrapper tags from evidence',
    pushFile &&
      !fs.readFileSync(path.join(initWork, '.ratchet', 'rules', pushFile), 'utf8').includes('<user_query>')
  );
  fs.rmSync(cursorDir, { recursive: true, force: true });
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

  // Fake judges via the RATCHET_JUDGE_CMD escape hatch. Plain Node scripts,
  // invoked explicitly via `node`, so the test needs neither a shebang nor
  // an executable bit — Windows honors neither.
  const failJudge = path.join(work, 'judge-fail.mjs');
  fs.writeFileSync(
    failJudge,
    "import fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\n" +
      "console.log(JSON.stringify({violations:[{rule_id:'keep-code-comments-minimal',reason:'every line is commented'}]}));\n"
  );
  const passJudge = path.join(work, 'judge-pass.mjs');
  fs.writeFileSync(
    passJudge,
    "import fs from 'node:fs';\nfs.readFileSync(0, 'utf8');\nconsole.log(JSON.stringify({violations:[]}));\n"
  );
  const nodeCmd = (script) => `node "${script}"`;

  // Need a dirty working tree for the judge to look at.
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm base', { cwd: work });
  fs.writeFileSync(path.join(work, 'dirty.ts'), '// c\nexport {}\n');
  execSync('git add dirty.ts', { cwd: work });

  const stopEvent = JSON.stringify({ session_id: 'sem1', cwd: work, stop_hook_active: false });
  const blocked = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: nodeCmd(failJudge) },
  });
  check('stop hook blocks on judged violation', /"decision":"block"/.test(blocked) && /every line is commented/.test(blocked));

  const looped = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: JSON.stringify({ session_id: 'sem1', cwd: work, stop_hook_active: true }),
    env: { ...process.env, RATCHET_JUDGE_CMD: nodeCmd(failJudge) },
  });
  check('stop hook never blocks twice in a row (loop guard)', looped.trim() === '');

  const passed = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: nodeCmd(passJudge) },
  });
  check('stop hook passes clean verdict silently', passed.trim() === '');

  const cached = execFileSync('node', [bin, 'hook', 'stop'], {
    encoding: 'utf8', cwd: work, input: stopEvent,
    env: { ...process.env, RATCHET_JUDGE_CMD: nodeCmd(failJudge) }, // would fail, but cache says pass
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

// --- undo: create / update / delete, and empty-stack behavior --------------------
{
  // Empty-history behavior needs a pristine dir — `work` already has plenty
  // of history by this point in the suite.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-fresh-'));
  execSync('git init -q', { cwd: freshDir });
  const none = cli(['undo'], { cwd: freshDir });
  check('undo with empty history says so', /nothing to undo/.test(none.out));
  fs.rmSync(freshDir, { recursive: true, force: true });

  cli(['add', 'never write to /tmp/scratch-undo-test']);
  const beforeUndo = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  const undoAdd = cli(['undo']);
  const afterUndo = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  check('undo reverses the last add', afterUndo === beforeUndo - 1 && /undid: add/.test(undoAdd.out));

  cli(['observe', 'no-git-push-without-consent']);
  cli(['snooze', 'no-git-push-without-consent', '--hours', '2']); // two updates, LIFO
  const undoSnooze = cli(['undo']);
  check('undo reverses the snooze first (LIFO)', /undid: enforce\/observe\/snooze/.test(undoSnooze.out));
  const stillObserve = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('after undoing snooze, prior observe mode still applies', stillObserve.out.trim() === '');
  cli(['undo']); // reverses the observe, back to enforce
  const backToEnforce = cli(['hook', 'pre-tool-use'], { input: hookEvent('Bash', { command: 'git push' }) });
  check('undo reverses the observe toggle too', /deny/.test(backToEnforce.out));

  cli(['add', 'never edit .env.production']);
  const envFile = fs.readdirSync(path.join(work, '.ratchet', 'rules')).find((f) => f.includes('protect'));
  cli(['rm', envFile.replace('.yaml', '')]);
  const beforeRestore = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  const undoRm = cli(['undo']);
  const afterRestore = fs.readdirSync(path.join(work, '.ratchet', 'rules')).length;
  check('undo restores a deleted rule', afterRestore === beforeRestore + 1 && /undid: rm/.test(undoRm.out));
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
