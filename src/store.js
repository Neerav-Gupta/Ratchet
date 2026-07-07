import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from './yaml.js';

/**
 * Rules live as individual YAML files in .ratchet/rules/ — committed to the
 * repo, diffable, PR-reviewable. The violation log stays local (gitignored).
 */

export function ratchetDir(cwd = process.cwd()) {
  return path.join(cwd, '.ratchet');
}

export function rulesDir(cwd = process.cwd()) {
  return path.join(ratchetDir(cwd), 'rules');
}

export function loadRules(cwd = process.cwd()) {
  const dir = rulesDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const rules = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const file = path.join(dir, name);
    try {
      const rule = parse(fs.readFileSync(file, 'utf8'));
      rule._file = file;
      rules.push(rule);
    } catch (err) {
      process.stderr.write(`ratchet: skipping unparseable rule ${name}: ${err.message}\n`);
    }
  }
  return rules;
}

export function saveRule(rule, cwd = process.cwd()) {
  const dir = rulesDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const { _file, ...clean } = rule;
  const file = _file || path.join(dir, `${rule.id}.yaml`);
  fs.writeFileSync(file, stringify(clean) + '\n');
  return file;
}

export function deleteRule(id, cwd = process.cwd()) {
  const rule = loadRules(cwd).find((r) => r.id === id);
  if (!rule) return false;
  fs.unlinkSync(rule._file);
  return true;
}

export function findRule(id, cwd = process.cwd()) {
  return loadRules(cwd).find((r) => r.id === id) || null;
}

/** A rule is live unless snoozed into the future or explicitly off. */
export function isActive(rule, now = Date.now()) {
  if (rule.mode === 'off') return false;
  if (rule.snooze_until && Date.parse(rule.snooze_until) > now) return false;
  return true;
}

// --- violation log (local only, powers `ratchet stats`) ---------------------

export function logPath(cwd = process.cwd()) {
  return path.join(ratchetDir(cwd), 'log.jsonl');
}

export function appendLog(entry, cwd = process.cwd()) {
  fs.mkdirSync(ratchetDir(cwd), { recursive: true });
  fs.appendFileSync(
    logPath(cwd),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  );
}

export function readLog(cwd = process.cwd()) {
  const p = logPath(cwd);
  if (!fs.existsSync(p)) return [];
  const entries = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines
    }
  }
  return entries;
}

export function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join('-') || 'rule'
  );
}

export function uniqueId(base, cwd = process.cwd()) {
  const existing = new Set(loadRules(cwd).map((r) => r.id));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
