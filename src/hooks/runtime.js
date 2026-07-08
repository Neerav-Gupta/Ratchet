import fs from 'node:fs';
import path from 'node:path';
import { loadRules, isActive, appendLog, ratchetDir } from '../store.js';
import { evaluate, safeRegex } from '../rules.js';
import { extractUserText } from '../extract.js';
import { CORRECTION_RE } from '../cluster.js';
import { stopHook } from './semantic.js';
import {
  normalizeEvent,
  formatPreToolUseDeny,
  formatUserPromptSubmit,
} from './adapters.js';

/**
 * Hook entry points. Claude Code pipes a JSON event on stdin; we answer with
 * hook JSON on stdout. Fail-open on any internal error: a broken guardrail
 * must never brick the user's agent.
 */

export async function runHook(eventName, stdinText) {
  let event;
  try {
    event = JSON.parse(stdinText);
  } catch {
    return { exitCode: 0, stdout: '' };
  }
  const cwd = event.cwd || process.cwd();

  try {
    if (eventName === 'pre-tool-use') return preToolUse(event, cwd);
    if (eventName === 'user-prompt-submit') return userPromptSubmit(event, cwd);
    if (eventName === 'stop') return stopHook(event, cwd);
  } catch (err) {
    process.stderr.write(`ratchet: hook error (failing open): ${err.message}\n`);
  }
  return { exitCode: 0, stdout: '' };
}

function preToolUse(rawEvent, cwd) {
  const event = normalizeEvent(rawEvent);
  const rules = loadRules(cwd).filter((r) => isActive(r) && r.tier === 'deterministic');
  if (rules.length === 0) return { exitCode: 0, stdout: '' };

  // Lazy + cached: only rules with unless_user_said pay the transcript read.
  let userMessages = null;
  const userSaid = (pattern) => {
    if (userMessages === null) {
      userMessages = readUserMessages(event.transcript_path);
    }
    const re = safeRegex(pattern);
    return userMessages.some((m) => re.test(m));
  };

  for (const rule of rules) {
    const result = evaluate(rule, event, { userSaid });
    if (!result.violated) continue;

    appendLog(
      {
        rule: rule.id,
        mode: rule.mode,
        tool: event.tool_name,
        detail: excerpt(event),
        reason: result.reason,
      },
      cwd
    );

    if (rule.mode === 'observe') {
      process.stderr.write(`ratchet(observe): would block — ${rule.id}: ${result.reason}\n`);
      continue;
    }

    return {
      exitCode: 0,
      stdout: formatPreToolUseDeny(rule, result, event._agent),
    };
  }
  return { exitCode: 0, stdout: '' };
}

function userPromptSubmit(rawEvent, cwd) {
  const event = normalizeEvent(rawEvent);
  const prompt = String(event.prompt || '');
  captureCandidate(prompt, cwd);

  const rules = loadRules(cwd).filter((r) => isActive(r) && r.tier === 'reminder');
  if (rules.length === 0) return { exitCode: 0, stdout: '' };

  const hits = rules.filter((r) => r.when && safeRegex(r.when).test(prompt)).slice(0, 3);
  if (hits.length === 0) return { exitCode: 0, stdout: '' };

  const lines = hits.map((r) => `- ${r.statement} (ratchet rule ${r.id})`);
  const reminder =
    `Standing instructions from the user, previously taught and relevant to this request:\n` +
    lines.join('\n');
  const stdout = formatUserPromptSubmit(reminder, event._agent);
  return { exitCode: 0, stdout };
}

/**
 * Live capture: when a prompt reads like a correction, remember it so
 * `ratchet review` can offer to make it a rule. Never interrupts the session.
 */
export function candidatesPath(cwd) {
  return path.join(ratchetDir(cwd), 'candidates.jsonl');
}

function captureCandidate(prompt, cwd) {
  if (prompt.length < 15 || prompt.length > 600) return;
  if (!CORRECTION_RE.test(prompt)) return;
  // Only bother in repos that already use ratchet.
  if (!fs.existsSync(ratchetDir(cwd))) return;

  const norm = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  const file = candidatesPath(cwd);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing.includes(JSON.stringify(norm))) return;
  }
  fs.appendFileSync(
    file,
    JSON.stringify({ ts: new Date().toISOString(), prompt: prompt.trim(), norm }) + '\n'
  );
}

/** Scan the session transcript for what the human actually typed. */
export function readUserMessages(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const messages = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractUserText(entry);
    if (text && !text.startsWith('<command-') && !text.startsWith('Caveat:')) {
      messages.push(text);
    }
  }
  return messages;
}

function excerpt(event) {
  const input = event.tool_input || {};
  const s = input.command || input.file_path || input.notebook_path || '';
  return String(s).slice(0, 200);
}
