// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'test', f));
// Les arguments passés après `npm test --` (rapporteurs de la campagne OS) vont à node --test.
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
