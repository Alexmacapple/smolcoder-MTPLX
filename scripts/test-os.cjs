// Tests OS lourds (#16, #18) : macOS réel, hors de `npm test`, qui doit
// tourner partout. Découverte explicite de test/os/*.os.test.js, fichiers
// joués l'un après l'autre : les mesures de délai, d'arbre de processus et
// d'écoute ne se partagent pas la machine. Les arguments passés après
// `npm run test:os --` (les rapporteurs de la campagne, bench/campagne-os/)
// vont à node --test.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'test', 'os');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.os.test.js')).sort().map(f => path.join(dir, f));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
