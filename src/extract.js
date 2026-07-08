/**
 * Pull the human's actual words out of a transcript entry, filtering the
 * machinery: tool results, slash-command envelopes, system reminders,
 * subagent sidechains, continuation summaries, and giant pastes.
 */

const SKIP_PREFIXES = [
  '<command-',
  '<local-command',
  'Caveat:',
  '[Request interrupted',
  'This session is being continued',
  'API Error',
  // dejavu's own distill prompts land in transcripts too — don't mine ourselves
  'A developer has told their coding agent',
];

const MAX_LEN = 4000; // longer than this is almost certainly a paste, not an instruction
const MIN_LEN = 15; // shorter carries no reusable signal for MINING ("yes", "ok", "do it")

/**
 * @param {*} entry
 * @param {{ minLen?: number }} [opts] - Mining wants MIN_LEN's default (a
 *   bare "yes" is noise, not a pattern). Live consent-checking wants the
 *   opposite: "yes"/"ok"/"1" in reply to a permission prompt is exactly the
 *   signal it needs, so callers like readUserMessages() pass minLen: 1.
 */
export function extractUserText(entry, opts = {}) {
  const minLen = opts.minLen ?? MIN_LEN;
  if (!entry) return null;
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
    return cleanText(entry.payload.message || '', minLen);
  }
  if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user') {
    return cleanContent(entry.payload.content, minLen);
  }

  const isClaudeUser = entry.type === 'user';
  const isCursorUser = entry.role === 'user' && entry.message;
  if (!isClaudeUser && !isCursorUser) return null;
  if (entry.isMeta || entry.isSidechain) return null;
  const msg = entry.message;
  if (!msg || (msg.role && msg.role !== 'user')) return null;

  return cleanContent(msg.content, minLen);
}

function cleanContent(content, minLen) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
      if (block && block.type === 'input_text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
      // tool_result / output blocks are the agent's world, not the user's voice.
    }
    text = parts.join('\n');
  } else {
    return null;
  }
  return cleanText(text, minLen);
}

function cleanText(text, minLen) {
  // Strip harness-injected blocks (reminders, IDE context), keep what the human typed.
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, '')
    .replace(/<\/?user_query>/g, '')
    .trim();
  if (!text || text.startsWith('<ide_') || text.startsWith('<environment_context')) return null;

  for (const prefix of SKIP_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }
  if (text.includes('<command-name>')) return null;
  if (text.length < minLen || text.length > MAX_LEN) return null;

  return text;
}
