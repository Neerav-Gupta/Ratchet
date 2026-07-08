import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { loadRules, isActive, appendLog, ratchetDir } from '../store.js';

/**
 * Semantic tier: rules that can't be reduced to a regex ("keep comments
 * minimal", "prefer small focused diffs") are judged by a model at the Stop
 * hook — the moment the agent declares itself done. A failed judgment blocks
 * the stop and sends the agent back with the reasons.
 *
 * Cost discipline: the judge only runs when the working tree actually
 * changed since the last verdict, uses haiku by default, and is skipped
 * entirely when stop_hook_active is set (never loop the agent).
 */

const MAX_DIFF_CHARS = 24_000;

export function stopHook(event, cwd) {
  if (event.stop_hook_active) return { exitCode: 0, stdout: '' };

  const rules = loadRules(cwd).filter(
    (r) => isActive(r) && r.tier === 'semantic' && r.mode !== 'observe'
  );
  if (rules.length === 0) return { exitCode: 0, stdout: '' };

  const diff = workingDiff(cwd);
  if (!diff.trim()) return { exitCode: 0, stdout: '' };

  const fingerprint = hash(diff + rules.map((r) => r.id + r.statement).join('|'));
  const state = readState(cwd, event.session_id);
  if (state.lastPassHash === fingerprint) return { exitCode: 0, stdout: '' };

  const verdict = judge(rules, diff, cwd);
  if (verdict === null) return { exitCode: 0, stdout: '' }; // fail open

  if (verdict.violations.length === 0) {
    writeState(cwd, event.session_id, { lastPassHash: fingerprint });
    return { exitCode: 0, stdout: '' };
  }

  for (const v of verdict.violations) {
    appendLog({ rule: v.rule_id, mode: 'enforce', tool: 'Stop', reason: v.reason }, cwd);
  }
  const reasons = verdict.violations
    .map((v) => `- ${v.rule_id}: ${v.reason}`)
    .join('\n');
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      decision: 'block',
      reason:
        `Ratchet semantic rules are not yet satisfied:\n${reasons}\n` +
        `Fix these before finishing. These rules were taught by the user ` +
        `(see \`ratchet why <id>\`); they can snooze a rule if it should not apply here.`,
    }),
  };
}

function judge(rules, diff, cwd) {
  const numbered = rules
    .map((r) => `${r.id}: ${r.statement}${r.judge ? ` (guidance: ${r.judge})` : ''}`)
    .join('\n');
  const prompt =
    `You are a strict reviewer. The user taught their coding agent these standing rules:\n\n${numbered}\n\n` +
    `Below is the diff the agent produced this session. For each rule, decide whether the diff violates it. ` +
    `Judge only what the diff shows; do not invent violations. Respond with ONLY this JSON, no prose:\n` +
    `{"violations":[{"rule_id":"<id>","reason":"<one sentence citing the diff>"}]}\n` +
    `Use an empty array when nothing is violated.\n\n--- DIFF ---\n${diff}`;

  const custom = process.env.RATCHET_JUDGE_CMD;
  let raw;
  try {
    if (custom) {
      // Test/CI escape hatch: any command that reads the prompt on stdin
      // and prints the verdict JSON.
      raw = execFileSync(custom, [], { input: prompt, encoding: 'utf8', timeout: 60_000 });
    } else {
      const bin = findClaudeBinary();
      if (!bin) {
        process.stderr.write('ratchet: no claude binary for semantic judge (failing open)\n');
        return null;
      }
      const model = process.env.RATCHET_JUDGE_MODEL || 'haiku';
      const res = spawnSync(bin, ['-p', prompt, '--output-format', 'text', '--model', model], {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd,
      });
      if (res.error || res.status !== 0) {
        process.stderr.write(`ratchet: judge failed (failing open): ${(res.stderr || '').slice(0, 200)}\n`);
        return null;
      }
      raw = res.stdout;
    }
  } catch (err) {
    process.stderr.write(`ratchet: judge error (failing open): ${err.message}\n`);
    return null;
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const known = new Set(rules.map((r) => r.id));
    return {
      violations: (parsed.violations || []).filter(
        (v) => v && known.has(v.rule_id) && typeof v.reason === 'string'
      ),
    };
  } catch {
    return null;
  }
}

function workingDiff(cwd) {
  try {
    const diff = execFileSync('git', ['diff', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.length > MAX_DIFF_CHARS) {
      return diff.slice(0, MAX_DIFF_CHARS) + '\n[diff truncated by ratchet]';
    }
    return diff;
  } catch {
    return ''; // not a repo, or fresh repo without HEAD — nothing to judge
  }
}

// --- per-session verdict cache (local, gitignored) ---------------------------

function statePath(cwd, sessionId) {
  return path.join(ratchetDir(cwd), 'state', `${sanitize(sessionId || 'unknown')}.json`);
}

function readState(cwd, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(cwd, sessionId), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(cwd, sessionId, state) {
  const p = statePath(cwd, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...state, ts: new Date().toISOString() }));
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64);
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** PATH first, then the local installer, then the newest desktop-app bundle. */
export function findClaudeBinary() {
  const onPath = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (!onPath.error && onPath.status === 0) return 'claude';

  const home = os.homedir();
  const candidates = [path.join(home, '.claude', 'local', 'claude')];
  const bundleRoot = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  if (process.platform === 'darwin' && fs.existsSync(bundleRoot)) {
    const versions = fs
      .readdirSync(bundleRoot)
      .filter((v) => /^\d+\./.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      candidates.push(path.join(bundleRoot, v, 'claude.app', 'Contents', 'MacOS', 'claude'));
    }
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return null;
}
