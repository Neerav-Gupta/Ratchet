import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * List every session transcript (.jsonl) under the Claude Code projects dir.
 * Each subdirectory is one project (path encoded with dashes).
 */
export function listSessionFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `no Claude Code transcripts found at ${dir}\n` +
        `  (pass --dir <path> if your projects directory lives elsewhere)`
    );
  }
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
      });
    }
  }
  return files;
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
