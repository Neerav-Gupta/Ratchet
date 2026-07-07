/**
 * Minimal YAML subset for Ratchet rule files: nested maps, lists of maps or
 * scalars, string/number/boolean/null scalars, 2-space indentation. We always
 * write this subset ourselves; the parser also tolerates hand edits that stay
 * within it. Not a general YAML implementation — by design.
 */

export function parse(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const noTabs = raw.replace(/\t/g, '  ');
    if (noTabs.trim() === '' || noTabs.trim().startsWith('#')) continue;
    lines.push({
      indent: noTabs.length - noTabs.trimStart().length,
      text: noTabs.trim(),
    });
  }
  const [node] = parseBlock(lines, 0, 0);
  return node;
}

/** Parse lines[i..] at the given indent; returns [node, nextIndex]. */
function parseBlock(lines, i, indent) {
  if (i >= lines.length) return [{}, i];
  const isList = lines[i].text.startsWith('- ');
  const node = isList ? [] : {};

  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      throw new Error(`yaml: unexpected indent at: ${line.text}`);
    }

    if (line.text.startsWith('- ')) {
      if (!isList) throw new Error(`yaml: list item in map at: ${line.text}`);
      const rest = line.text.slice(2);
      const kv = splitKey(rest);
      if (kv) {
        // "- key: value" opens an inline map; its siblings are indented past the dash.
        const item = {};
        setKey(item, kv);
        i++;
        while (i < lines.length && lines[i].indent === indent + 2 && !lines[i].text.startsWith('- ')) {
          const skv = splitKey(lines[i].text);
          if (!skv) throw new Error(`yaml: cannot parse line: ${lines[i].text}`);
          if (skv.value === '') {
            const [child, next] = parseBlock(lines, i + 1, indent + 4);
            item[skv.key] = child;
            i = next;
          } else {
            setKey(item, skv);
            i++;
          }
        }
        node.push(item);
      } else {
        node.push(scalar(rest));
        i++;
      }
      continue;
    }

    if (isList) return [node, i];
    const kv = splitKey(line.text);
    if (!kv) throw new Error(`yaml: cannot parse line: ${line.text}`);
    if (kv.value === '') {
      // Container: list vs map decided by the first child line.
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [child, after] = parseBlock(lines, i + 1, next.indent);
        node[kv.key] = child;
        i = after;
      } else {
        node[kv.key] = {};
        i++;
      }
    } else {
      setKey(node, kv);
      i++;
    }
  }
  return [node, i];
}

function splitKey(s) {
  const m = s.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
  if (!m) return null;
  return { key: m[1], value: m[2] === undefined ? '' : m[2] };
}

function setKey(node, kv) {
  node[kv.key] = scalar(kv.value);
}

function scalar(s) {
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return JSON.parse(s);
  }
  return s;
}

export function stringify(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${pad}${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          const entries = Object.entries(item).filter(([, v]) => v !== undefined);
          entries.forEach(([k, v], idx) => {
            const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
            lines.push(`${prefix}${k}: ${scalarOut(v)}`);
          });
        } else {
          lines.push(`${pad}  - ${scalarOut(item)}`);
        }
      }
    } else if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length === 0) continue;
      lines.push(`${pad}${key}:`);
      lines.push(stringify(value, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${scalarOut(value)}`);
    }
  }
  return lines.join('\n');
}

function scalarOut(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote anything that could be misread by our parser or a human.
  if (
    s === '' ||
    /^[\s"'#&*?|>%@`{[\]!,-]/.test(s) ||
    /[:#]\s/.test(s) ||
    s.endsWith(':') ||
    s.includes('\n') ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) ||
    s !== s.trim()
  ) {
    return JSON.stringify(s);
  }
  return s;
}
