import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wire ratchet into agent hook configs:
 *   Claude Code → .claude/settings.json
 *   Cursor      → .cursor/hooks.json
 *   Codex       → .codex/config.toml
 *
 * Existing hooks are preserved; we only append our entries, and uninstall
 * removes exactly those.
 */

const CLAUDE_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const CURSOR_MATCHER = 'Shell|Write';
const CODEX_MATCHER = 'Bash|Shell|Edit|Write|MultiEdit|NotebookEdit';
const CODEX_START = '# ratchet:hooks:start';
const CODEX_END = '# ratchet:hooks:end';

function binPath() {
  return fileURLToPath(new URL('../../bin/ratchet', import.meta.url));
}

function hookCommand(event) {
  return `node ${JSON.stringify(binPath())} hook ${event}`;
}

export function settingsPath(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'settings.json');
}

export function cursorHooksPath(cwd = process.cwd()) {
  return path.join(cwd, '.cursor', 'hooks.json');
}

export function codexConfigPath(cwd = process.cwd()) {
  return path.join(cwd, '.codex', 'config.toml');
}

/**
 * @param {{ claude?: boolean, cursor?: boolean, codex?: boolean }} targets
 * @returns {{ claude?: string, cursor?: string, codex?: string }}
 */
export function install(cwd = process.cwd(), targets = { claude: true, cursor: true, codex: true }) {
  const out = {};
  if (targets.claude !== false) out.claude = installClaude(cwd);
  if (targets.cursor !== false) out.cursor = installCursor(cwd);
  if (targets.codex !== false) out.codex = installCodex(cwd);
  return out;
}

function installClaude(cwd) {
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

  addClaudeEntry(settings.hooks, 'PreToolUse', CLAUDE_MATCHER, hookCommand('pre-tool-use'));
  addClaudeEntry(settings.hooks, 'UserPromptSubmit', null, hookCommand('user-prompt-submit'));
  addClaudeEntry(settings.hooks, 'Stop', null, hookCommand('stop'));

  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function installCursor(cwd) {
  const file = cursorHooksPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let config = { version: 1, hooks: {} };
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON — fix it before installing hooks`);
    }
  }
  config.version = config.version || 1;
  config.hooks = config.hooks || {};

  addCursorEntry(config.hooks, 'preToolUse', CURSOR_MATCHER, hookCommand('pre-tool-use'));
  addCursorEntry(config.hooks, 'beforeSubmitPrompt', null, hookCommand('user-prompt-submit'));
  addCursorEntry(config.hooks, 'stop', null, hookCommand('stop'), { loop_limit: 3 });

  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

function installCodex(cwd) {
  const file = codexConfigPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = codexBlock();
  const next = replaceManagedBlock(existing, block);
  fs.writeFileSync(file, next);
  return file;
}

/**
 * @param {{ claude?: boolean, cursor?: boolean, codex?: boolean }} targets
 * @returns {{ claude?: string | null, cursor?: string | null, codex?: string | null }}
 */
export function uninstall(cwd = process.cwd(), targets = { claude: true, cursor: true, codex: true }) {
  const out = {};
  if (targets.claude !== false) out.claude = uninstallClaude(cwd);
  if (targets.cursor !== false) out.cursor = uninstallCursor(cwd);
  if (targets.codex !== false) out.codex = uninstallCodex(cwd);
  return out;
}

function uninstallClaude(cwd) {
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

function uninstallCursor(cwd) {
  const file = cursorHooksPath(cwd);
  if (!fs.existsSync(file)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!config.hooks) return file;

  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = (config.hooks[event] || []).filter((h) => !isOurs(h));
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) {
    config.hooks = {};
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

function uninstallCodex(cwd) {
  const file = codexConfigPath(cwd);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const next = removeManagedBlock(text);
  fs.writeFileSync(file, next);
  return file;
}

// Claude Code hook entries carry {type:'command', command}; Cursor's real
// schema has no `type` field at all, just {command, matcher?}. Requiring
// type==='command' unconditionally made every Cursor idempotency check and
// uninstall silently no-op, since Cursor entries never satisfy it. The
// command string itself is a specific enough signature on its own.
function isOurs(hook) {
  return /ratchet["' ]+hook /.test(hook.command || '');
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

function addClaudeEntry(hooks, event, matcher, command) {
  hooks[event] = hooks[event] || [];
  const already = hooks[event].some((group) => (group.hooks || []).some(isOurs));
  if (already) return;
  const group = { hooks: [{ type: 'command', command }] };
  if (matcher) group.matcher = matcher;
  hooks[event].push(group);
}

function addCursorEntry(hooks, event, matcher, command, extra = {}) {
  hooks[event] = hooks[event] || [];
  const already = hooks[event].some((h) => isOurs(h));
  if (already) return;
  const entry = { command, ...extra };
  if (matcher) entry.matcher = matcher;
  hooks[event].push(entry);
}

function codexBlock() {
  const entries = [
    { event: 'pre-tool-use', matcher: CODEX_MATCHER, command: hookCommand('pre-tool-use') },
    { event: 'user-prompt-submit', command: hookCommand('user-prompt-submit') },
    { event: 'stop', command: hookCommand('stop') },
  ];
  const lines = [
    CODEX_START,
    '# Managed by ratchet. Edit .ratchet/rules/*.yaml, then rerun `ratchet install --codex`.',
  ];
  for (const entry of entries) {
    lines.push('[[hooks]]');
    lines.push(`event = ${JSON.stringify(entry.event)}`);
    if (entry.matcher) lines.push(`matcher = ${JSON.stringify(entry.matcher)}`);
    lines.push(`command = ${JSON.stringify(entry.command)}`);
    lines.push('');
  }
  lines.push(CODEX_END, '');
  return lines.join('\n');
}

function replaceManagedBlock(text, block) {
  const clean = removeManagedBlock(text).replace(/\s*$/, '');
  return (clean ? clean + '\n\n' : '') + block;
}

function removeManagedBlock(text) {
  const start = text.indexOf(CODEX_START);
  const end = text.indexOf(CODEX_END);
  if (start === -1 || end === -1 || end < start) return text;
  const after = end + CODEX_END.length;
  return (text.slice(0, start) + text.slice(after)).replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

export function isOursCommand(command) {
  return /ratchet["' ]+hook /.test(command || '');
}
