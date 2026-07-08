#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31mratchet: ${err.message}\x1b[0m`);
  process.exit(1);
});
