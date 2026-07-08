// Runs as the npm "prepack" lifecycle script (npm pack / npm publish), so the
// tarball ships README.npm.md's content as README.md. GitHub always renders
// the repo's actual README.md, so the two can differ: this one is written
// for npmjs.com's stricter markdown sanitizing (no raw GitHub Actions badge
// SVGs, no relative links). package.json's "postpack" script restores the
// committed README.md afterward via `git checkout -- README.md`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.url is .../Ratchet/scripts/use-npm-readme.mjs; '..' from there
// resolves to the repo root, .../Ratchet/ — no extra path.dirname() needed.
const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'README.npm.md');
const dest = path.join(root, 'README.md');

fs.copyFileSync(src, dest);
console.log('prepack: using README.npm.md as README.md for this package');
