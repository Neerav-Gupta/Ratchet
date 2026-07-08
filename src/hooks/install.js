import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wire ratchet into .claude/settings.json (project-level) so Claude Code
 * calls us on PreToolUse and UserPromptSubmit. Existing hooks are preserved;
 * we only append our own entries, and uninstall removes exactly those.
 */

const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';

function binPath() {
  return fileURLToPath(new URL('../../bin/ratchet.js', import.meta.url));
}

function hookCommand(event) {
  return `node ${JSON.stringify(binPath())} hook ${event}`;
}

export function settingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'settings.json');
}

export function install(cwd = process.cwd()) {
  const file = settingsPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON — fix it before installing hooks`);
    }
  }
  settings.hooks = settings.hooks || {};

  addEntry(settings.hooks, 'PreToolUse', MATCHER, hookCommand('pre-tool-use'));
  addEntry(settings.hooks, 'UserPromptSubmit', null, hookCommand('user-prompt-submit'));
  addEntry(settings.hooks, 'Stop', null, hookCommand('stop'));

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

export function uninstall(cwd = process.cwd()) {
  const file = settingsPath(cwd);
  if (!fs.existsSync(file)) return null;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!settings.hooks) return file;

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || [])
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter((h) => !isOurs(h)),
      }))
      .filter((group) => (group.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function isOurs(hook) {
  return hook.type === 'command' && /ratchet\.js["' ]+hook /.test(hook.command || '');
}

/** Write a git pre-commit hook that runs `ratchet check`. */
export function installPreCommit(cwd = process.cwd()) {
  const gitDir = path.join(cwd, '.git');
  if (!fs.existsSync(gitDir)) throw new Error('not a git repository');
  const hookFile = path.join(gitDir, 'hooks', 'pre-commit');
  const script = `#!/bin/sh\n# installed by ratchet — https://github.com/Neerav-Gupta/Ratchet\nnode ${JSON.stringify(binPath())} check || exit 1\n`;

  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, 'utf8');
    if (existing.includes('ratchet')) return { file: hookFile, action: 'already installed' };
    throw new Error(
      `a pre-commit hook already exists — add this line to it manually:\n  node ${JSON.stringify(binPath())} check || exit 1`
    );
  }
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, script, { mode: 0o755 });
  return { file: hookFile, action: 'installed' };
}

function addEntry(hooks, event, matcher, command) {
  hooks[event] = hooks[event] || [];
  const already = hooks[event].some((group) => (group.hooks || []).some(isOurs));
  if (already) return;
  const group = { hooks: [{ type: 'command', command }] };
  if (matcher) group.matcher = matcher;
  hooks[event].push(group);
}
