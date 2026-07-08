import path from 'node:path';
import { slugify } from './store.js';

/**
 * Rule schema (v0.1):
 *   id, statement, tier: deterministic|reminder, mode: enforce|observe|off,
 *   created, snooze_until, evidence: [{quote, session, date}],
 *   check (deterministic only):
 *     type: command      — regex on Bash commands, optional unless_user_said
 *     type: file_protect — glob paths no tool may write/edit
 *     type: content      — regex that must not appear in written content,
 *                          optional files globs
 *   when (reminder only): regex; the statement is injected as context when a
 *     prompt matches.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Evaluate one rule against a PreToolUse event.
 * Returns { violated: boolean, reason?: string }.
 */
export function evaluate(rule, event, { userSaid } = {}) {
  const check = rule.check;
  if (!check) return { violated: false };
  const { tool_name: tool, tool_input: input = {} } = event;

  switch (check.type) {
    case 'command': {
      if (tool !== (check.tool || 'Bash')) return { violated: false };
      const command = String(input.command || '');
      if (!safeRegex(check.pattern).test(command)) return { violated: false };
      if (check.unless_user_said && userSaid && userSaid(check.unless_user_said)) {
        return { violated: false };
      }
      return {
        violated: true,
        reason: `command matches /${check.pattern}/` +
          (check.unless_user_said
            ? ` and the user has not said /${check.unless_user_said}/ this session`
            : ''),
      };
    }

    case 'file_protect': {
      const file = fileTouched(tool, input);
      if (!file) return { violated: false };
      const rel = relativize(file, event.cwd);
      const globs = asList(check.paths);
      const hit = globs.find((g) => globMatch(g, rel));
      if (!hit) return { violated: false };
      return { violated: true, reason: `${rel} is protected by ${hit}` };
    }

    case 'content': {
      if (!EDIT_TOOLS.has(tool)) return { violated: false };
      const file = fileTouched(tool, input);
      if (check.files) {
        const rel = relativize(file || '', event.cwd);
        if (!asList(check.files).some((g) => globMatch(g, rel))) {
          return { violated: false };
        }
      }
      const text = writtenContent(tool, input);
      if (!text || !safeRegex(check.pattern).test(text)) return { violated: false };
      return { violated: true, reason: `written content matches /${check.pattern}/` };
    }

    default:
      return { violated: false };
  }
}

export function fileTouched(tool, input) {
  if (EDIT_TOOLS.has(tool)) return input.file_path || input.notebook_path || null;
  return null;
}

function writtenContent(tool, input) {
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit') {
    return (input.edits || []).map((e) => e.new_string || '').join('\n');
  }
  if (tool === 'NotebookEdit') return input.new_source || '';
  return '';
}

/**
 * Resolve to a path relative to cwd, normalized to forward slashes — our
 * globs (and the regex globMatch compiles) are written with '/' regardless
 * of platform, but path.relative() returns '\'-separated paths on Windows.
 */
function relativize(file, cwd) {
  if (!file) return '';
  if (!cwd || !path.isAbsolute(file)) return toPosix(file);
  const rel = path.relative(cwd, file);
  return toPosix(rel.startsWith('..') ? file : rel);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function asList(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

export function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // A broken pattern must fail open with a warning, never crash the hook.
    process.stderr.write(`ratchet: invalid pattern /${pattern}/\n`);
    return /$^/;
  }
}

/** Glob subset: ** (any depth), * (within segment), ? (one char). */
export function globMatch(glob, target) {
  const pattern = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.split('?').map(escapeRe).join('[^/]'))
        .join('[^/]*')
    )
    .join('(?:.*)?');
  return new RegExp(`^${pattern}$`).test(target) || new RegExp(`(^|/)${pattern}$`).test(target);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- NL statement → rule compiler (template-based, honest about limits) -----

const NEG = "(?:never|don'?t|do not|stop|no)";

export function compile(statement) {
  const s = statement.trim();
  const base = {
    statement: s,
    mode: 'enforce',
    created: new Date().toISOString().slice(0, 10),
    snooze_until: null,
  };

  // "never git push [unless/until I say/ask/tell/approve]"
  let m = s.match(new RegExp(`${NEG}\\b[\\s\\S]{0,40}?\\b(?:git\\s+)?push\\b`, 'i'));
  if (m) {
    // "untill" appears verbatim in real corrections — match the typo too.
    const consent = /\b(unless|untill?|till)\b.{0,30}\b(i|me)\b.{0,20}\b(say|ask|tell|approve|want)/i.test(s);
    return {
      id: slugify('no git push' + (consent ? ' without consent' : '')),
      ...base,
      tier: 'deterministic',
      check: {
        type: 'command',
        tool: 'Bash',
        pattern: '\\bgit\\s+push\\b',
        ...(consent ? { unless_user_said: '\\bpush\\b' } : {}),
      },
    };
  }

  // "never use/add `X` in *.ts files" — a quoted token plus a file glob is a
  // content ban; check this before the command template so backticked code
  // snippets aren't misread as commands.
  m = s.match(new RegExp(`${NEG}\\s+(?:use|add|write|include)\\s+[\`"']([^\`"']{1,60})[\`"']`, 'i'));
  if (m && extractGlobs(s).length > 0) {
    const banned = m[1];
    const files = extractGlobs(s).filter((t) => t !== banned && !banned.includes(t));
    return {
      id: slugify(`no ${banned}`),
      ...base,
      tier: 'deterministic',
      check: {
        type: 'content',
        pattern: escapeRe(banned),
        ...(files.length ? { files } : {}),
      },
    };
  }

  // "never run <cmd>" / "don't use <cmd>" for a recognizable command word
  m = s.match(new RegExp(`${NEG}\\s+(?:run|use|execute|call)\\s+\`?([a-z][a-z0-9_-]{1,30})\`?`, 'i'));
  if (m && !/^(the|a|an|any|it|this|that)$/i.test(m[1])) {
    return {
      id: slugify(`no ${m[1]} command`),
      ...base,
      tier: 'deterministic',
      check: { type: 'command', tool: 'Bash', pattern: `(^|[\\s;&|])${escapeRe(m[1])}\\b` },
    };
  }

  // "never edit/touch/modify <path-ish tokens>"
  m = s.match(new RegExp(`${NEG}\\s+(?:edit|touch|modify|change|write to|overwrite|delete)\\b`, 'i'));
  if (m) {
    const paths = extractPaths(s);
    if (paths.length > 0) {
      return {
        id: slugify(`protect ${paths[0]}`),
        ...base,
        tier: 'deterministic',
        check: { type: 'file_protect', paths },
      };
    }
  }

  // "never use/add `X`" (quoted, no file scope) → content ban everywhere,
  // unless X reads like a shell command, which the template above handles.
  m = s.match(new RegExp(`${NEG}\\s+(?:add|write|include)\\s+[\`"']([^\`"']{1,60})[\`"']`, 'i'));
  if (m) {
    return {
      id: slugify(`no ${m[1]}`),
      ...base,
      tier: 'deterministic',
      check: { type: 'content', pattern: escapeRe(m[1]) },
    };
  }

  // Everything else: honest fallback — a targeted reminder, not a fake check.
  return {
    id: slugify(s),
    ...base,
    tier: 'reminder',
    when: keywordPattern(s),
  };
}

/** Path-looking tokens: contain / or a leading dot or a file extension. */
function extractPaths(s) {
  const tokens = s.match(/[\w./*-]+/g) || [];
  return tokens.filter(
    (t) =>
      (t.includes('/') || t.startsWith('.') || /\.[a-z]{1,6}$/i.test(t) || t.includes('*')) &&
      !/^\d+(\.\d+)*$/.test(t) &&
      t.length > 1
  );
}

function extractGlobs(s) {
  return extractPaths(s).filter((t) => t.includes('*') || /\.[a-z]{1,6}$/i.test(t));
}

const STOP = new Set(
  'a an the and or but never don not do dont stop no always to of in on for with unless until i you it this that is are be when'.split(' ')
);

function keywordPattern(s) {
  const words = (s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])
    .filter((w) => !STOP.has(w))
    .slice(0, 6);
  if (words.length === 0) return '.';
  return words.map(escapeRe).join('|');
}
