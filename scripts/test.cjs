// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'test', f));
// Les tests font lancer des commandes npm, et npm dépose un journal par
// commande dans son cache : un cache jetable les garde hors de ~/.npm (#41).
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-tests-npm-'));
// Les arguments passés après `npm test --` (rapporteurs de la campagne OS) vont à node --test.
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, npm_config_cache: npmCache } });
fs.rmSync(npmCache, { recursive: true, force: true });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
