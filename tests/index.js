// Lets `node --test tests/` run every *.test.mjs file in this folder:
// Node resolves the directory to this file, which imports the test files.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(join(here, f));
}
