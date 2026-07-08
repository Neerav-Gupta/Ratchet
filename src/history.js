import fs from 'node:fs';
import path from 'node:path';
import { ratchetDir, saveRule, deleteRule, findRule } from './store.js';

/**
 * A small LIFO undo stack for rule mutations — the safety valve for an
 * enforcement tool: one command to take back the last `add`, `rm`,
 * `snooze`, or `enforce`/`observe` toggle. Local only, not committed.
 */

export function historyPath(cwd = process.cwd()) {
  return path.join(ratchetDir(cwd), 'history.jsonl');
}

function push(entry, cwd) {
  fs.mkdirSync(ratchetDir(cwd), { recursive: true });
  fs.appendFileSync(historyPath(cwd), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

/** Call right after a brand-new rule file is saved. */
export function recordCreate(id, cwd = process.cwd()) {
  push({ action: 'create', id }, cwd);
}

/** Call right before deleting a rule, passing its current in-memory state. */
export function recordDelete(rule, cwd = process.cwd()) {
  const { _file, ...clean } = rule;
  push({ action: 'delete', id: rule.id, rule: clean }, cwd);
}

/** Call right before mutating mode/snooze_until, passing the pre-change rule. */
export function recordUpdate(prevRule, cwd = process.cwd()) {
  push(
    { action: 'update', id: prevRule.id, prev: { mode: prevRule.mode, snooze_until: prevRule.snooze_until ?? null } },
    cwd
  );
}

function pop(cwd) {
  const p = historyPath(cwd);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines.pop();
  fs.writeFileSync(p, lines.length ? lines.join('\n') + '\n' : '');
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * Reverse the most recent recorded action. Returns a description of what
 * happened, or null if there was nothing to undo.
 */
export function undo(cwd = process.cwd()) {
  const entry = pop(cwd);
  if (!entry) return null;

  if (entry.action === 'create') {
    const existed = deleteRule(entry.id, cwd);
    return { summary: existed ? `removed rule ${entry.id} (undid: add)` : `${entry.id} was already gone`, id: entry.id };
  }

  if (entry.action === 'delete') {
    saveRule(entry.rule, cwd);
    return { summary: `restored rule ${entry.id} (undid: rm)`, id: entry.id };
  }

  if (entry.action === 'update') {
    const rule = findRule(entry.id, cwd);
    if (!rule) return { summary: `${entry.id} no longer exists — nothing to restore`, id: entry.id };
    rule.mode = entry.prev.mode;
    rule.snooze_until = entry.prev.snooze_until;
    saveRule(rule, cwd);
    return { summary: `restored ${entry.id} to mode: ${rule.mode} (undid: enforce/observe/snooze)`, id: entry.id };
  }

  return { summary: `unknown action "${entry.action}" for ${entry.id} — skipped`, id: entry.id };
}
