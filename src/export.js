import fs from 'node:fs';
import path from 'node:path';
import { loadRules, isActive } from './store.js';

/**
 * Render the rulebook into CLAUDE.md / AGENTS.md between markers, so agents
 * without hook support (and human readers) still see the law. Idempotent:
 * re-running replaces the block in place.
 */

const START = '<!-- ratchet:rules:start -->';
const END = '<!-- ratchet:rules:end -->';

export function renderRules(cwd = process.cwd()) {
  const rules = loadRules(cwd).filter((r) => isActive(r));
  if (rules.length === 0) return null;

  const lines = [START, '', '## Rules enforced by Ratchet', ''];
  const enforced = rules.filter((r) => r.tier !== 'reminder' && r.mode === 'enforce');
  const advisory = rules.filter((r) => r.tier === 'reminder' || r.mode !== 'enforce');

  if (enforced.length > 0) {
    lines.push(
      'These are enforced by hooks — violating tool calls are blocked, and semantic rules are judged before you may finish:',
      ''
    );
    for (const r of enforced) lines.push(`- **${r.id}**: ${r.statement}`);
    lines.push('');
  }
  if (advisory.length > 0) {
    lines.push('Standing guidance the user has taught:', '');
    for (const r of advisory) lines.push(`- ${r.statement}`);
    lines.push('');
  }
  lines.push(
    `_Managed by [ratchet](https://github.com/Neerav-Gupta/Ratchet) — edit rules in .ratchet/rules/, then re-run \`ratchet export\`._`,
    '',
    END
  );
  return lines.join('\n');
}

export function exportRules(file, cwd = process.cwd()) {
  const block = renderRules(cwd);
  if (!block) throw new Error('no active rules to export');
  const target = path.resolve(cwd, file);

  let text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const start = text.indexOf(START);
  const end = text.indexOf(END);

  if (start !== -1 && end !== -1) {
    text = text.slice(0, start) + block + text.slice(end + END.length);
  } else {
    const sep = text && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
    text = text + sep + block + '\n';
  }
  fs.writeFileSync(target, text);
  return target;
}
