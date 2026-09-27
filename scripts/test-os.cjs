// Tests OS lourds (#16, #18) : macOS réel, hors de `npm test`, qui doit
// tourner partout. Découverte explicite de test/os/*.os.test.js, fichiers
// joués l'un après l'autre : les mesures de délai, d'arbre de processus et
// d'écoute ne se partagent pas la machine. Les arguments passés après
// `npm run test:os --` (les rapporteurs de la campagne, bench/campagne-os/)
// vont à node --test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'test', 'os');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.os.test.js')).sort().map(f => path.join(dir, f));
// Un dossier temporaire propre à la passe, supprimé à la fin (#44), comme pour
// npm test ; le cache npm reste celui que chaque test choisit.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-tests-os-'));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: tmpRoot } });
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
