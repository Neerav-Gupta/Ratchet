/**
 * Group user messages that say the same thing in different words.
 * Zero-dependency approach: stopword-filtered, suffix-stemmed word sets,
 * document-frequency filtering so conversational boilerplate ("make",
 * "change", "fix") can't glue unrelated messages together, and an
 * inverted index so we never do a full O(n²) sweep.
 */

const STOPWORDS = new Set(
  (
    'a an the and or but if then else for to of in on at by with from as is are was were be been being ' +
    'do does did done can could should would will shall may might must have has had this that these those ' +
    'it its i you we they he she me my your our their them him her us am not no yes so just also too very ' +
    'there here what which who whom when where why how all any both each few more most other some such ' +
    'only own same than s t now ok okay please thanks thank want need like get got make made let lets give ' +
    'up out about into over after before again once'
  ).split(/\s+/)
);

// Only agent-directed pushback counts as a correction — "some links don't
// work" is a bug report, not the user correcting the agent's behavior.
const CORRECTION_RE =
  /\b(i (already|just) (said|told|asked)|you (keep|still|again|didn'?t)|why (did|are|do) you|stop (doing|using|adding|pushing)|from now on|still (not|isn'?t|doesn'?t|persists?)|(is|are) still not|don'?t .{0,40}(until|unless) i (say|tell))\b|^(no|nope|wrong)[,.! ]/i;

const HOOK_RE =
  /\b(before|after|every time|each time|whenever) (you |every |each |i )?(commit|push|pr\b|pull request|merge|edit|write|save|deploy|finish|stop|start)/i;

const RULE_RE =
  /\b(always|never|do not|don'?t (use|add|push|commit|create|write|touch|modify|change)|stop (using|doing|adding)|instead of|use .{1,40} (instead|not)|prefer|from now on|no need to)\b/i;

const SKILL_RE = /\b(first .{5,80} then|steps?:|workflow|process is|checklist|1\.\s|routine)\b/i;

// A representative that opens with a task verb reads as a repeated job → skill.
const TASK_RE =
  /^\W*(can you |could you |please |now )?(create|update|write|render|build|clean|generate|publish|deploy|read|scan|convert|compile)\b/i;

// Occurrences closer together than this are one working episode, not a repeat.
const EPISODE_GAP_MS = 2 * 3600_000;

export function signature(text) {
  const cleaned = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // fenced code: structure noise, not vocabulary
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^a-z0-9\s'/._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = new Set();
  for (const w of cleaned.split(' ')) {
    const word = w.replace(/^[-'./_]+|[-'./_]+$/g, '');
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    words.add(stem(word));
  }
  return words;
}

/** Light suffix stripper so commit/committing/commits land on the same token. */
function stem(w) {
  if (w.length <= 4) return w;
  w = w.replace(/'(s|re|ve|ll|d|t)$/, '');
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  for (const suf of ['ing', 'ed']) {
    if (w.endsWith(suf) && w.length > suf.length + 3) {
      w = w.slice(0, -suf.length);
      if (/(.)\1$/.test(w)) w = w.slice(0, -1); // committ → commit
      return w;
    }
  }
  if (w.endsWith('es') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Scale-aware similarity. Short instructions ("commit and push") match via
 * overlap coefficient, with a containment guard so two shared words inside an
 * unrelated wall of text don't count. When both messages are long, word
 * co-occurrence is coincidence, not repetition — only near-duplicates
 * (high Jaccard) may match. And when the evidence is exactly two shared
 * words, they must be a pair that recurs together across the corpus (PMI):
 * "push github" is a phrase, "create project" is two words that happen to
 * be popular independently.
 */
function makeSimilarity({ df, co, n }) {
  return function similarity(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    const shared = [];
    for (const w of small) if (large.has(w)) shared.push(w);
    const inter = shared.length;
    if (inter < 2) return 0;
    if (inter === 2) {
      const pairs = (n * (co.get(pairKey(shared[0], shared[1])) || 0)) /
        ((df.get(shared[0]) || 1) * (df.get(shared[1]) || 1));
      if (pairs < 3) return 0;
    }
    if (small.size <= 8) {
      if (inter / large.size < 0.15) return 0;
      return inter / small.size;
    }
    return inter / (a.size + b.size - inter);
  };
}

function pairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}


/**
 * items: [{ text, session, project, ts }]
 * Returns clusters sorted by how loudly they demand to become permanent config.
 */
export function clusterItems(items, { threshold = 0.5, min = 2 } = {}) {
  const fullSigs = items.map((it) => signature(it.text));

  // Words appearing in a large share of all messages are how this user talks,
  // not what they're talking about — drop them from the matching signatures.
  // The cutoff is generous: a genuinely repeated instruction makes its own
  // vocabulary frequent, and it must not censor itself.
  const df = new Map();
  for (const sig of fullSigs) for (const w of sig) df.set(w, (df.get(w) || 0) + 1);
  const dfCutoff = Math.max(8, Math.ceil(items.length * 0.15));
  const sigs = fullSigs.map((sig) => {
    const core = new Set();
    for (const w of sig) if (df.get(w) <= dfCutoff) core.add(w);
    return core;
  });

  // Pair co-occurrence counts back the PMI test in similarity().
  const co = new Map();
  for (const sig of sigs) {
    const ws = [...sig];
    for (let x = 0; x < ws.length; x++) {
      for (let y = x + 1; y < ws.length; y++) {
        const k = pairKey(ws[x], ws[y]);
        co.set(k, (co.get(k) || 0) + 1);
      }
    }
  }
  const similarity = makeSimilarity({ df, co, n: items.length });

  const clusters = []; // { memberIdx: [], sigs: [] }
  const wordIndex = new Map(); // word -> Set of cluster indexes

  for (let i = 0; i < items.length; i++) {
    const sig = sigs[i];
    if (sig.size < 2) continue; // too little distinctive vocabulary to match

    // Find candidate clusters sharing at least 2 informative words.
    const shared = new Map();
    for (const w of sig) {
      const set = wordIndex.get(w);
      if (!set) continue;
      for (const ci of set) shared.set(ci, (shared.get(ci) || 0) + 1);
    }

    let best = -1;
    let bestSim = 0;
    for (const [ci, count] of shared) {
      if (count < 2) continue;
      // Compare against up to 3 members to tolerate centroid drift.
      const probe = clusters[ci].sigs;
      let sim = 0;
      for (let k = 0; k < Math.min(3, probe.length); k++) {
        sim = Math.max(sim, similarity(sig, probe[k]));
      }
      if (sim >= threshold && sim > bestSim) {
        best = ci;
        bestSim = sim;
      }
    }

    let ci = best;
    if (ci === -1) {
      ci = clusters.length;
      clusters.push({ memberIdx: [], sigs: [] });
    }
    clusters[ci].memberIdx.push(i);
    clusters[ci].sigs.push(sig);
    for (const w of sig) {
      let set = wordIndex.get(w);
      if (!set) wordIndex.set(w, (set = new Set()));
      set.add(ci);
    }
  }

  // Greedy clustering can split one pattern in two; merge groups whose
  // combined vocabularies overlap.
  let groups = clusters.map((c) => c.memberIdx).filter((g) => g.length >= min);
  groups = mergeSimilarGroups(groups, sigs, threshold, similarity);

  const results = [];
  for (const idxs of groups) {
    const members = idxs.map((i) => items[i]);
    // A pattern is something said on separate occasions — iterating on the
    // same problem for an hour, or a resumed conversation, is one occasion.
    const episodes = countEpisodes(members);
    if (episodes < 2) continue;
    // A pair inside a single session is thin evidence; demand a third strike.
    const sessions = new Set(members.map((m) => m.session));
    if (sessions.size === 1 && members.length < 3) continue;
    results.push(buildCluster(members, episodes));
  }

  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => (r.id = i + 1));
  return results;
}

function mergeSimilarGroups(groups, sigs, threshold, similarity) {
  // Single-link at member level: if any message in one group matches any
  // message in another, they're the same pattern greedy clustering split.
  const merged = [];
  for (const g of groups) {
    let target = -1;
    outer: for (let j = 0; j < merged.length; j++) {
      for (const i of g) {
        for (const k of merged[j]) {
          if (similarity(sigs[i], sigs[k]) >= threshold) {
            target = j;
            break outer;
          }
        }
      }
    }
    if (target === -1) merged.push([...g]);
    else merged[target].push(...g);
  }
  return merged;
}

function countEpisodes(members) {
  const known = members
    .filter((m) => m.ts)
    .map((m) => Date.parse(m.ts))
    .sort((a, b) => a - b);
  let episodes = members.length - known.length; // undated items count individually
  let prev = -Infinity;
  for (const t of known) {
    if (t - prev >= EPISODE_GAP_MS) episodes++;
    prev = t;
  }
  return episodes;
}

function buildCluster(members, episodes) {
  const sessions = new Set(members.map((m) => m.session));
  const projects = new Set(members.map((m) => m.project));
  const rep = pickRepresentative(members);
  const correction = members.some((m) => CORRECTION_RE.test(m.text));
  return {
    items: members.map((m) => ({
      text: m.text,
      session: m.session,
      project: m.project,
      ts: m.ts,
    })),
    count: members.length,
    episodes,
    sessions: sessions.size,
    projects: [...projects],
    rep,
    correction,
    type: classify(rep, members),
    score:
      episodes * 3 +
      members.length +
      (correction ? 4 : 0) +
      (projects.size > 1 ? 2 : 0),
  };
}

function pickRepresentative(members) {
  // Prefer a concise-but-complete phrasing: shortest text over 30 chars, else shortest.
  const sorted = [...members].sort((a, b) => a.text.length - b.text.length);
  return (sorted.find((m) => m.text.length >= 30) || sorted[0]).text;
}

function classify(rep, members) {
  const joined = members.map((m) => m.text).join('\n');
  // Rule outranks hook: an explicit directive beats an incidental
  // "after every push" buried in a complaint.
  if (RULE_RE.test(joined)) return 'rule';
  if (HOOK_RE.test(joined)) return 'hook';
  if (SKILL_RE.test(rep) || TASK_RE.test(rep) || rep.length > 300) return 'skill';
  return 'memory';
}

export { CORRECTION_RE };
