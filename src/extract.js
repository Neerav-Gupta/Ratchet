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
const MIN_LEN = 15; // shorter carries no reusable signal ("yes", "ok", "do it")

export function extractUserText(entry) {
  if (!entry || entry.type !== 'user') return null;
  if (entry.isMeta || entry.isSidechain) return null;
  const msg = entry.message;
  if (!msg || msg.role !== 'user') return null;

  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const parts = [];
    for (const block of msg.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
      // tool_result blocks are the agent's world, not the user's voice — skip
    }
    text = parts.join('\n');
  } else {
    return null;
  }

  // Strip harness-injected blocks (reminders, IDE context), keep what the human typed.
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
  if (!text || text.startsWith('<ide_')) return null;

  for (const prefix of SKIP_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }
  if (text.includes('<command-name>')) return null;
  if (text.length < MIN_LEN || text.length > MAX_LEN) return null;

  return text;
}
