import fs from 'node:fs';
import { loadRules, isActive, appendLog } from '../store.js';
import { evaluate, safeRegex } from '../rules.js';

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
  } catch (err) {
    process.stderr.write(`ratchet: hook error (failing open): ${err.message}\n`);
  }
  return { exitCode: 0, stdout: '' };
}

function preToolUse(event, cwd) {
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

    const reason =
      `Blocked by ratchet rule "${rule.id}": ${rule.statement}\n` +
      `(${result.reason}. The user taught this rule — do not retry the same call; ` +
      `either satisfy the rule's condition or ask the user. ` +
      `They can run \`ratchet snooze ${rule.id}\` to lift it temporarily.)`;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    };
  }
  return { exitCode: 0, stdout: '' };
}

function userPromptSubmit(event, cwd) {
  const rules = loadRules(cwd).filter((r) => isActive(r) && r.tier === 'reminder');
  if (rules.length === 0) return { exitCode: 0, stdout: '' };

  const prompt = String(event.prompt || '');
  const hits = rules.filter((r) => r.when && safeRegex(r.when).test(prompt)).slice(0, 3);
  if (hits.length === 0) return { exitCode: 0, stdout: '' };

  const lines = hits.map((r) => `- ${r.statement} (ratchet rule ${r.id})`);
  return {
    exitCode: 0,
    stdout:
      `Standing instructions from the user, previously taught and relevant to this request:\n` +
      lines.join('\n'),
  };
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
    if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) continue;
    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
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
