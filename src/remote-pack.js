import https from 'node:https';
import { parse } from './yaml.js';

/**
 * Community packs: `ratchet pack add <owner>/<repo>[/<path>]` fetches
 * .yaml rule files straight from a GitHub repo via its contents API — no
 * hosted registry, no git clone, no dependencies. Every fetched rule is
 * validated the same way llm-compile validates a model's output before
 * cmdPackAddRemote() ever shows it to the user: this module never saves
 * anything itself, only returns what it found so the caller can preview
 * and confirm, same as `ratchet init`'s per-rule accept flow.
 */

const MAX_FILES = 30;
const MAX_FILE_BYTES = 20_000;
const REQUEST_TIMEOUT_MS = 8000;
const VALID_TIERS = new Set(['deterministic', 'reminder', 'semantic']);
const VALID_MODES = new Set(['enforce', 'observe']);
const VALID_CHECK_TYPES = new Set(['command', 'file_protect', 'content']);

/**
 * Recognizes `owner/repo` or `owner/repo/path/to/dir` as a GitHub-hosted
 * community pack source. Bundled pack names (e.g. "git-hygiene") never
 * contain a slash, so there's no ambiguity with the local pack lookup.
 * @returns {{owner: string, repo: string, path: string}|null}
 */
export function parseGithubSource(name) {
  const m = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(String(name).trim());
  if (!m) return null;
  const [, owner, repo, dirPath] = m;
  return { owner, repo, path: dirPath || '' };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'ratchet-cc', Accept: 'application/vnd.github+json' }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`responded ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** Same spirit as llm-compile's validate(): a rule must be well-formed before it's ever shown as installable. */
export function isValidRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (typeof rule.id !== 'string' || !rule.id) return false;
  if (typeof rule.statement !== 'string' || !rule.statement) return false;
  if (!VALID_TIERS.has(rule.tier)) return false;
  if (rule.mode !== undefined && !VALID_MODES.has(rule.mode)) return false;
  if (rule.tier === 'deterministic') {
    const check = rule.check;
    if (!check || !VALID_CHECK_TYPES.has(check.type)) return false;
    if (check.type === 'command' || check.type === 'content') {
      if (typeof check.pattern !== 'string') return false;
      try {
        // eslint-disable-next-line no-new
        new RegExp(check.pattern);
      } catch {
        return false;
      }
    }
    if (check.type === 'file_protect' && !Array.isArray(check.paths)) return false;
  }
  return true;
}

/**
 * Fetches every .yaml/.yml file directly inside a GitHub repo path and
 * validates each into a rule or a rejection reason. Throws only when the
 * source itself can't be read at all (bad owner/repo, network down,
 * empty directory) — individual bad files are rejected, not fatal.
 * @param {{owner: string, repo: string, path: string}} source
 */
export async function fetchRemotePack({ owner, repo, path }) {
  const label = `${owner}/${repo}${path ? '/' + path : ''}`;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  let entries;
  try {
    entries = JSON.parse(await fetchText(apiUrl));
  } catch (err) {
    throw new Error(`couldn't reach ${label} on GitHub (${err.message})`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${label} is not a directory of rule files`);
  }
  const yamlFiles = entries
    .filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name) && e.size <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);
  if (yamlFiles.length === 0) {
    throw new Error(`no .yaml rule files found in ${label}`);
  }

  const rules = [];
  const rejected = [];
  for (const file of yamlFiles) {
    let text;
    try {
      text = await fetchText(file.download_url);
    } catch {
      rejected.push({ name: file.name, reason: 'download failed' });
      continue;
    }
    let rule;
    try {
      rule = parse(text);
    } catch {
      rejected.push({ name: file.name, reason: 'invalid YAML' });
      continue;
    }
    if (!isValidRule(rule)) {
      rejected.push({ name: file.name, reason: 'not a well-formed rule' });
      continue;
    }
    rules.push(rule);
  }
  return { rules, rejected, source: label };
}
