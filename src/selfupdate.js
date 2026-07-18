import https from 'node:https';
import { spawnSync } from 'node:child_process';

/**
 * Version-staleness check for `ratchet doctor` and the `ratchet selfupdate`
 * command. The network call always fails open to null — offline, a
 * registry outage, or a slow connection should never break `doctor` or
 * make `selfupdate` do something surprising, just mean "couldn't check."
 */

const REGISTRY_URL = 'https://registry.npmjs.org/ratchet-cc/latest';

/** @param {string} json raw registry response body */
export function parseLatestVersion(json) {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Compares two `x.y.z` version strings. Returns -1, 0, or 1 (a < b, a === b, a > b). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<string|null>} the latest published version, or null if
 *   the check couldn't be completed for any reason.
 */
export function fetchLatestVersion({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(REGISTRY_URL, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(parseLatestVersion(body)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Actually runs the global npm install. Inherits stdio so the user sees npm's own output. */
export function runSelfUpdate() {
  const res = spawnSync('npm', ['install', '-g', 'ratchet-cc@latest'], { stdio: 'inherit' });
  return res.status === 0;
}
