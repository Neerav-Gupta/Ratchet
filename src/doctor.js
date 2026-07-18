import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rulesDir, loadRules } from './store.js';
import { settingsPath, cursorHooksPath, codexConfigPath } from './hooks/install.js';
import { findClaudeBinary } from './hooks/semantic.js';
import { fetchLatestVersion, compareVersions } from './selfupdate.js';

/** Sanity-check an installation and explain how to fix what's off. */
export async function doctor(cwd = process.cwd()) {
  const results = [];
  const ok = (name, detail) => results.push({ ok: true, name, detail });
  const bad = (name, detail) => results.push({ ok: false, name, detail });

  const major = parseInt(process.versions.node.split('.')[0], 10);
  major >= 18
    ? ok(`node ${process.versions.node}`)
    : bad(`node ${process.versions.node}`, 'ratchet needs Node 18+');

  const rules = loadRules(cwd);
  if (!fs.existsSync(rulesDir(cwd))) {
    bad('no rules directory', 'run `ratchet init` or `ratchet add "…"` to create rules');
  } else {
    const files = fs.readdirSync(rulesDir(cwd)).filter((f) => /\.ya?ml$/.test(f));
    rules.length === files.length
      ? ok(`${rules.length} rule${rules.length === 1 ? '' : 's'} parse cleanly`)
      : bad(`${files.length - rules.length} rule file(s) failed to parse`, 'see warnings above');
    const unenforceable = rules.filter((r) => r.tier === 'deterministic' && !r.check);
    if (unenforceable.length > 0) {
      bad(`${unenforceable.length} deterministic rule(s) missing a check`, unenforceable.map((r) => r.id).join(', '));
    }
  }

  const hookFiles = [
    { label: 'Claude Code', file: settingsPath(cwd), events: ['PreToolUse', 'UserPromptSubmit', 'Stop'] },
    { label: 'Cursor', file: cursorHooksPath(cwd), events: ['preToolUse', 'beforeSubmitPrompt', 'stop'] },
    { label: 'Codex', file: codexConfigPath(cwd), events: ['pre-tool-use', 'user-prompt-submit', 'stop'] },
  ];
  const installed = hookFiles.filter((h) => fs.existsSync(h.file) && fs.readFileSync(h.file, 'utf8').includes('ratchet'));
  if (installed.length > 0) {
    for (const h of installed) {
      const text = fs.readFileSync(h.file, 'utf8');
      const events = h.events.filter((e) => text.includes(e));
      ok(`${h.label} hooks wired in ${path.relative(cwd, h.file)} (${events.join(', ')})`);
    }
  } else {
    bad('hooks not installed', 'run `ratchet install` in this project');
  }

  const hasSemantic = rules.some((r) => r.tier === 'semantic');
  const claude = findClaudeBinary();
  if (hasSemantic) {
    claude
      ? ok(`claude binary found for semantic judge (${claude === 'claude' ? 'on PATH' : claude})`)
      : bad('semantic rules exist but no claude binary found', 'semantic rules will fail open');
  }

  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });
    ok('git repository (semantic diffs + `check` staged-file scanning available)');
    const gi = path.join(cwd, '.gitignore');
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/\.ratchet\/(log|state|candidates)/.test(giText)) {
      bad('.gitignore missing ratchet locals', 'add: .ratchet/log.jsonl, .ratchet/state/, .ratchet/candidates.jsonl');
    }
  } catch {
    bad('not a git repository', 'semantic judging and staged-file checks are disabled');
  }

  const currentVersion = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ).version;
  const latestVersion = await fetchLatestVersion();
  if (latestVersion) {
    compareVersions(currentVersion, latestVersion) < 0
      ? bad(`ratchet v${currentVersion} installed`, `v${latestVersion} is available — run \`ratchet selfupdate\``)
      : ok(`ratchet v${currentVersion} (up to date)`);
  }
  // No result pushed when the check itself fails (offline, registry
  // unreachable) — that's not something to flag as broken.

  return results;
}
