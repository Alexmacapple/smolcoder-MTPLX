// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'test', f));
// Un dossier temporaire propre à la passe, supprimé à la fin (#44) : les tests
// y créent leurs dossiers (os.tmpdir() suit TMPDIR sous POSIX et TEMP/TMP sous
// Windows) sans avoir à les nettoyer un par un. npm y range aussi son cache et
// ses journaux, hors de ~/.npm (#41).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-tests-'));
const npmCache = path.join(tmpRoot, 'npm-cache');
fs.mkdirSync(npmCache);
// Les arguments passés après `npm test --` (rapporteurs de la campagne OS) vont à node --test.
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot, npm_config_cache: npmCache } });
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
