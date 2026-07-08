import fs from 'node:fs';
import { listSessionFiles, parseSession, projectLabel } from './transcripts.js';
import { extractUserText } from './extract.js';
import { clusterItems, CORRECTION_RE } from './cluster.js';
import { compile } from './rules.js';
import { slugify, uniqueId } from './store.js';

/**
 * Cold start: mine the user's existing Claude Code transcripts for repeated
 * instructions and corrections, and turn each pattern into a proposed rule
 * with evidence attached. This is the dejavu engine (dedup of session forks
 * and resends, boilerplate-resistant clustering, time-separated episode
 * gating) pointed at rule extraction.
 */

export async function mine(opts = {}) {
  const agent = opts.agent || 'all';
  const claudeDir = opts.dir && (agent === 'claude' || agent === 'all') ? opts.dir : undefined;
  const cursorDir = opts.dir && agent === 'cursor' ? opts.dir : opts.cursorDir;
  const codexDir = opts.dir && agent === 'codex' ? opts.dir : opts.codexDir;
  const files = listSessionFiles({ agent, claudeDir, cursorDir, codexDir });

  const items = [];
  const seenUuids = new Set();
  const seenTexts = new Map();
  const RESEND_WINDOW_MS = 6 * 3600_000;

  for (const f of files) {
    // Cursor's transcripts carry no per-message timestamp at all. Falling
    // back to a shared 0 would make every repeat of the same text anywhere,
    // in any session, look like a resend within the same window — silently
    // collapsing genuine repeated-instruction evidence to a single count.
    // The file's mtime at least gives distinct sessions distinct timestamps.
    let fileTimestamp = null;

    for await (const entry of parseSession(f.path)) {
      const text = extractUserText(entry);
      if (!text) continue;
      if (!entry.timestamp && fileTimestamp === null) {
        fileTimestamp = fileMtimeIso(f.path);
      }
      const effectiveTimestamp = entry.timestamp || fileTimestamp;
      const ts = effectiveTimestamp ? Date.parse(effectiveTimestamp) : 0;

      if (entry.uuid) {
        if (seenUuids.has(entry.uuid)) continue;
        seenUuids.add(entry.uuid);
      }
      const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const kept = seenTexts.get(norm) || [];
      if (kept.some((k) => k.session === f.session || Math.abs(k.ts - ts) < RESEND_WINDOW_MS)) {
        continue;
      }
      kept.push({ ts, session: f.session });
      seenTexts.set(norm, kept);

      items.push({
        text,
        session: f.session,
        project: projectLabel(entry.cwd, f.projectKey),
        ts: effectiveTimestamp || null,
      });
    }
  }

  const clusters = clusterItems(items);
  return { proposals: proposalsFrom(clusters), scanned: items.length, sessions: files.length };
}

function fileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function proposalsFrom(clusters) {
  const proposals = [];
  for (const cluster of clusters) {
    // Rules come from things the user *demands*, not questions they ask.
    if (!cluster.correction && cluster.type === 'memory') continue;

    const source = bestDirective(cluster);
    const rule = compile(source);
    rule.id = uniqueIdIn(proposals, rule.id || slugify(source));
    // Lead the evidence with the correction that states the rule outright.
    const ordered = [...cluster.items].sort(
      (a, b) => (CORRECTION_RE.test(b.text) ? 1 : 0) - (CORRECTION_RE.test(a.text) ? 1 : 0)
    );
    rule.evidence = ordered.slice(0, 4).map((it) => ({
      quote: oneLine(it.text).slice(0, 160),
      session: String(it.session).slice(0, 8),
      date: it.ts ? it.ts.slice(0, 10) : undefined,
    }));
    rule._cluster = {
      count: cluster.count,
      episodes: cluster.episodes,
      projects: cluster.projects,
      correction: cluster.correction,
    };
    proposals.push(rule);
  }

  // Corrections first, then deterministic (enforceable) before reminders.
  proposals.sort((a, b) => {
    const corr = (b._cluster.correction ? 1 : 0) - (a._cluster.correction ? 1 : 0);
    if (corr !== 0) return corr;
    const det = (b.tier === 'deterministic' ? 1 : 0) - (a.tier === 'deterministic' ? 1 : 0);
    if (det !== 0) return det;
    return b._cluster.episodes - a._cluster.episodes;
  });
  return proposals;
}

/**
 * The message that best states the rule: prefer an explicit correction
 * ("from now on…"), else the cluster representative.
 */
function bestDirective(cluster) {
  const corrective = cluster.items
    .map((it) => it.text)
    .filter((t) => CORRECTION_RE.test(t))
    .sort((a, b) => a.length - b.length);
  return oneLine(corrective[0] || cluster.rep);
}

function uniqueIdIn(proposals, base) {
  const taken = new Set(proposals.map((p) => p.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

export { uniqueId };
