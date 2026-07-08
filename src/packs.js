import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './yaml.js';
import { saveRule, loadRules, uniqueId } from './store.js';

/**
 * Rule packs: curated starter sets shipped with the package. `pack add`
 * copies rules into the repo's .ratchet/rules/ — after that they're the
 * user's files, editable and removable like any other rule.
 */

function packsRoot() {
  return fileURLToPath(new URL('../packs', import.meta.url));
}

export function listPacks() {
  const root = packsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const rules = fs
        .readdirSync(path.join(root, d.name))
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => {
          try {
            return parse(fs.readFileSync(path.join(root, d.name, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return { name: d.name, rules };
    });
}

export function addPack(name, cwd = process.cwd()) {
  const pack = listPacks().find((p) => p.name === name);
  if (!pack) {
    const names = listPacks().map((p) => p.name).join(', ');
    throw new Error(`no pack "${name}" — available: ${names || '(none)'}`);
  }
  const existing = new Set(loadRules(cwd).map((r) => r.id));
  const added = [];
  const skipped = [];
  for (const rule of pack.rules) {
    if (existing.has(rule.id)) {
      skipped.push(rule.id);
      continue;
    }
    rule.id = uniqueId(rule.id, cwd);
    rule.created = new Date().toISOString().slice(0, 10);
    saveRule(rule, cwd);
    added.push(rule.id);
  }
  return { added, skipped };
}
