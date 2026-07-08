/**
 * Normalize hook events from Claude Code and Cursor into one internal shape,
 * and format responses back into each agent's native schema.
 */

const CURSOR_EVENTS = new Set(['preToolUse', 'beforeSubmitPrompt', 'beforeShellExecution', 'stop']);
const CLAUDE_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop']);
const CODEX_EVENTS = new Set(['pre-tool-use', 'user-prompt-submit', 'pre_tool_use', 'user_prompt_submit']);

const TOOL_TO_INTERNAL = {
  Shell: 'Bash',
  Bash: 'Bash',
  shell: 'Bash',
  exec_command: 'Bash',
  'functions.exec_command': 'Bash',
  Write: 'Write',
  // Edit must stay distinct from Write: rules.js reads new_string for Edit
  // but content for Write. Remapping Edit -> Write here (an earlier version
  // of this table did) silently disabled content rules on every real Claude
  // Code Edit call, since Claude's Edit input has no `content` field.
  Edit: 'Edit',
  StrReplace: 'Edit', // Cursor's edit tool
  MultiEdit: 'MultiEdit',
  NotebookEdit: 'NotebookEdit',
};

/** @returns {'cursor' | 'claude' | 'codex' | 'unknown'} */
export function detectAgent(event) {
  const name = event.hook_event_name || '';
  if (CURSOR_EVENTS.has(name)) return 'cursor';
  if (CLAUDE_EVENTS.has(name)) return 'claude';
  if (CODEX_EVENTS.has(name) || event.agent === 'codex') return 'codex';
  if (event.tool_name === 'Shell') return 'cursor';
  if (event.tool_name === 'Bash') return 'claude';
  if (String(event.tool_name || '').startsWith('functions.')) return 'codex';
  return 'unknown';
}

/** Map an incoming hook payload to the Claude-shaped event `evaluate()` expects. */
export function normalizeEvent(event) {
  const agent = detectAgent(event);
  const cwd = event.cwd || event.workspace_roots?.[0] || process.cwd();
  // Cursor identifies a conversation via `conversation_id`, not `session_id` —
  // without this, the Stop hook's verdict cache would key every Cursor
  // conversation in a repo to the same 'unknown' bucket.
  const sessionId = event.session_id || event.conversation_id;
  const base = { ...event, cwd, session_id: sessionId, _agent: agent };

  if (agent === 'cursor') {
    return normalizeCursorEvent(base);
  }
  if (agent === 'codex') {
    return normalizeCodexEvent(base);
  }
  return { ...base, tool_name: TOOL_TO_INTERNAL[event.tool_name] || event.tool_name };
}

function normalizeCursorEvent(event) {
  const out = { ...event };

  if (event.hook_event_name === 'beforeShellExecution') {
    out.tool_name = 'Bash';
    out.tool_input = { command: event.command || '' };
    return out;
  }

  if (event.hook_event_name === 'beforeSubmitPrompt') {
    return out;
  }

  if (event.hook_event_name === 'stop') {
    out.stop_hook_active = (event.loop_count || 0) > 0;
    return out;
  }

  const tool = TOOL_TO_INTERNAL[event.tool_name] || event.tool_name;
  out.tool_name = tool;
  out.tool_input = normalizeToolInput(tool, event.tool_input || {});
  return out;
}

function normalizeCodexEvent(event) {
  const out = { ...event };
  const hook = event.hook_event_name || event.event || '';
  if (hook === 'user-prompt-submit' || hook === 'user_prompt_submit') {
    out.prompt = event.prompt || event.message || event.user_message || '';
    return out;
  }
  if (hook === 'stop') {
    out.stop_hook_active = Boolean(event.stop_hook_active || event.loop_count > 0);
    return out;
  }

  const tool = TOOL_TO_INTERNAL[event.tool_name] || TOOL_TO_INTERNAL[event.tool] || event.tool_name || event.tool;
  out.tool_name = tool;
  out.tool_input = normalizeToolInput(tool, event.tool_input || event.input || event.arguments || {});
  if (tool === 'Bash' && !out.tool_input.command) {
    out.tool_input.command = event.command || event.cmd || '';
  }
  return out;
}

function normalizeToolInput(tool, input) {
  if (tool === 'Bash') {
    return { command: input.command || input.cmd || '' };
  }
  if (tool === 'Write') {
    return {
      file_path: input.file_path || input.path || '',
      content: input.content ?? input.contents ?? input.new_string ?? '',
      new_string: input.new_string || input.content || input.contents || '',
    };
  }
  if (tool === 'Edit') {
    // Cursor's StrReplace sends {path, old_string, new_string} — same
    // shape as Claude's native Edit modulo the path/file_path field name.
    return {
      file_path: input.file_path || input.path || '',
      old_string: input.old_string || '',
      new_string: input.new_string || '',
    };
  }
  if (tool === 'MultiEdit') {
    const file = input.file_path || input.path || '';
    const edits = input.edits || [];
    return { file_path: file, edits };
  }
  return input;
}

export function formatPreToolUseDeny(rule, result, agent) {
  const reason =
    `Blocked by ratchet rule "${rule.id}": ${rule.statement}\n` +
    `(${result.reason}. The user taught this rule — do not retry the same call; ` +
    `either satisfy the rule's condition or ask the user. ` +
    `They can run \`ratchet snooze ${rule.id}\` to lift it temporarily.)`;

  if (agent === 'cursor') {
    return JSON.stringify({
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
    });
  }

  if (agent === 'codex') {
    return JSON.stringify({
      decision: 'block',
      reason,
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/** Reminder injection: Claude accepts plain text; Cursor only supports capture today. */
export function formatUserPromptSubmit(reminderText, agent) {
  if (!reminderText) return '';
  if (agent === 'cursor') {
    // beforeSubmitPrompt cannot inject context yet — still capture corrections.
    // Export rules to AGENTS.md / .cursor/rules for standing guidance in Cursor.
    return '';
  }
  if (agent === 'codex') {
    return reminderText;
  }
  return reminderText;
}

export function formatStopBlock(reason, agent) {
  if (agent === 'cursor') {
    return JSON.stringify({ followup_message: reason });
  }
  return JSON.stringify({ decision: 'block', reason });
}
