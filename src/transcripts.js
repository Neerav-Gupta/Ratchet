import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export function defaultClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function defaultCursorProjectsDir() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

export function defaultCodexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** @deprecated use defaultClaudeProjectsDir */
export function defaultProjectsDir() {
  return defaultClaudeProjectsDir();
}

/**
 * List session transcript files for one or more agent backends.
 * @param {{ claudeDir?: string, cursorDir?: string, codexDir?: string, agent?: 'claude'|'cursor'|'codex'|'all' }} opts
 */
export function listSessionFiles(opts = {}) {
  const agent = opts.agent || 'all';
  const files = [];
  if (agent === 'claude' || agent === 'all') {
    const dir = opts.claudeDir || defaultClaudeProjectsDir();
    if (fs.existsSync(dir)) files.push(...listClaudeSessionFiles(dir));
  }
  if (agent === 'cursor' || agent === 'all') {
    const dir = opts.cursorDir || defaultCursorProjectsDir();
    if (fs.existsSync(dir)) files.push(...listCursorSessionFiles(dir));
  }
  if (agent === 'codex' || agent === 'all') {
    const dir = opts.codexDir || defaultCodexSessionsDir();
    if (fs.existsSync(dir)) files.push(...listCodexSessionFiles(dir));
  }
  if (files.length === 0) {
    const tried = [];
    if (agent === 'claude' || agent === 'all') tried.push(defaultClaudeProjectsDir());
    if (agent === 'cursor' || agent === 'all') tried.push(defaultCursorProjectsDir());
    if (agent === 'codex' || agent === 'all') tried.push(defaultCodexSessionsDir());
    throw new Error(
      `no agent transcripts found at ${tried.join(' or ')}\n` +
        `  (pass --dir <path> or --agent claude|cursor|codex to narrow the search)`
    );
  }
  return files;
}

/**
 * List every Claude Code session transcript (.jsonl) under ~/.claude/projects.
 * Each subdirectory is one project (path encoded with dashes).
 */
function listClaudeSessionFiles(dir) {
  const files = [];
  for (const projectDir of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = path.join(dir, projectDir.name);
    let entries;
    try {
      entries = fs.readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      files.push({
        path: path.join(projectPath, name),
        projectKey: projectDir.name,
        session: name.replace(/\.jsonl$/, ''),
        agent: 'claude',
      });
    }
  }
  return files;
}

/**
 * List Cursor agent transcripts under ~/.cursor/projects/<project>/agent-transcripts/.
 */
function listCursorSessionFiles(dir) {
  const files = [];
  for (const projectDir of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const transcriptRoot = path.join(dir, projectDir.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptRoot)) continue;
    for (const sessionDir of fs.readdirSync(transcriptRoot, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = path.join(transcriptRoot, sessionDir.name);
      for (const name of fs.readdirSync(sessionPath)) {
        if (!name.endsWith('.jsonl')) continue;
        files.push({
          path: path.join(sessionPath, name),
          projectKey: projectDir.name,
          session: sessionDir.name,
          agent: 'cursor',
        });
      }
    }
  }
  return files;
}

/**
 * List Codex session transcripts under ~/.codex/sessions/YYYY/MM/DD/.
 */
function listCodexSessionFiles(dir) {
  const files = [];
  walkSessionTree(dir, (file) => {
    if (!file.endsWith('.jsonl')) return;
    const session = path.basename(file).replace(/\.jsonl$/, '');
    files.push({
      path: file,
      projectKey: path.relative(dir, path.dirname(file)) || 'codex',
      session,
      agent: 'codex',
    });
  });
  return files;
}

function walkSessionTree(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSessionTree(p, visit);
    else visit(p);
  }
}

/**
 * Stream-parse one session transcript, yielding parsed JSONL entries.
 * Malformed lines are skipped silently — transcripts in the wild have them.
 */
export async function* parseSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip malformed line
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Human-readable project name from a transcript entry's cwd, or the encoded dir key. */
export function projectLabel(cwd, projectKey) {
  if (cwd) return path.basename(cwd) || cwd;
  const parts = projectKey.split('-').filter(Boolean);
  return parts.slice(-2).join('-') || projectKey;
}
