import { spawnSync } from 'node:child_process';
import { findClaudeBinary } from './hooks/semantic.js';

/**
 * Fallback for statements the regex-based compiler in rules.js can't turn
 * into a deterministic check — asks the local `claude` CLI to do it
 * instead. Every step here fails open to null: no binary, a timeout, a
 * non-JSON response, or output that doesn't pass validate() all just mean
 * "couldn't compile this one," same as the regex compiler falling back to
 * a reminder. The caller decides what null means; this module never
 * throws for an ordinary compile failure.
 */

const VALID_TYPES = new Set(['command', 'file_protect', 'content']);
const MAX_PATTERN_LEN = 200;
const MAX_LIST_LEN = 20;
const MAX_ITEM_LEN = 200;
// Patterns a model might produce that would match everything, defeating
// the point of an enforced check — reject these rather than compile a
// rule that blocks every command/file/write unconditionally.
const TRIVIALLY_BROAD_RE = [/^\.\*\$?$/, /^\.\+\$?$/, /^\^?\.\*\$?$/, /^\s*$/, /^\^?\.\?\*?\$?$/];

function buildPrompt(statement) {
  return [
    `A developer wants to teach their coding agent this rule: "${statement}"`,
    '',
    'Compile it into ONE JSON check object using exactly one of these shapes:',
    '{"type":"command","pattern":"<JS regex source matching a Bash command>"}',
    '{"type":"file_protect","paths":["<glob>", "..."]}',
    '{"type":"content","pattern":"<JS regex source matching written file content>","files":["<glob>", "..."]}',
    '',
    'Only produce a check if the rule genuinely names a specific command, file, or content pattern.',
    'If it is too vague or subjective to check deterministically (e.g. "write good code", "be careful", "keep it clean"), respond {"type":"none"}.',
    'Patterns must be valid JavaScript regex source, no leading/trailing slashes, and must be SPECIFIC — never a pattern that matches everything.',
    'The pattern is always matched case-insensitively by the caller, so never include inline flag syntax like (?i) or (?i:...) — that is PCRE/Python syntax, not valid JavaScript, and is also redundant here.',
    'Respond with ONLY the JSON object. No prose, no markdown code fences.',
  ].join('\n');
}

// Models sometimes reach for PCRE/Python-style inline flags despite being
// told the pattern is JS regex matched case-insensitively already — strip
// a leading (?i) or (?i:...) wrapper rather than reject an otherwise-good
// pattern outright.
function stripInlineFlags(pattern) {
  let out = pattern.trim();
  const wrapped = out.match(/^\(\?i:(.*)\)$/s);
  if (wrapped) return wrapped[1];
  return out.replace(/^\(\?i\)/, '');
}

function isReasonablePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) return false;
  if (TRIVIALLY_BROAD_RE.some((re) => re.test(pattern.trim()))) return false;
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch {
    return false;
  }
  return true;
}

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ITEM_LEN).slice(0, MAX_LIST_LEN);
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.type === 'none') return null;
  if (!VALID_TYPES.has(parsed.type)) return null;

  if (parsed.type === 'command') {
    const pattern = typeof parsed.pattern === 'string' ? stripInlineFlags(parsed.pattern) : parsed.pattern;
    if (!isReasonablePattern(pattern)) return null;
    return { type: 'command', tool: 'Bash', pattern };
  }
  if (parsed.type === 'file_protect') {
    const paths = cleanList(parsed.paths);
    return paths.length > 0 ? { type: 'file_protect', paths } : null;
  }
  if (parsed.type === 'content') {
    const pattern = typeof parsed.pattern === 'string' ? stripInlineFlags(parsed.pattern) : parsed.pattern;
    if (!isReasonablePattern(pattern)) return null;
    const check = { type: 'content', pattern };
    const files = cleanList(parsed.files);
    if (files.length > 0) check.files = files;
    return check;
  }
  return null;
}

/**
 * Pulled out from llmCompile so it can be unit-tested against canned model
 * output — spawning a real `claude` process in the test suite would make
 * results depend on model availability and behavior, not this module's code.
 * @param {string} stdout raw output from the model
 * @returns {object|null} a validated check object, or null
 */
export function parseCompileOutput(stdout) {
  const match = (stdout || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return validate(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

/**
 * @param {string} statement
 * @returns {object|null} a validated check object, or null if compilation
 *   wasn't possible for any reason (no binary, call failed, bad output).
 */
export function llmCompile(statement) {
  const bin = findClaudeBinary();
  if (!bin) return null;

  const model = process.env.RATCHET_JUDGE_MODEL || 'haiku';
  let res;
  try {
    res = spawnSync(bin, ['-p', buildPrompt(statement), '--output-format', 'text', '--model', model], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (res.error || res.status !== 0) return null;

  return parseCompileOutput(res.stdout);
}
