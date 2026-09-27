// #41 — la suite ne doit rien écrire chez l'utilisateur. Les tests font
// lancer des commandes npm par le harnais (`npm run build`, `npm run test`…)
// et npm dépose un journal par invocation dans son cache : sans précaution,
// dans le vrai ~/.npm/_logs. Le lanceur (scripts/test.cjs) donne donc à toute
// la suite un cache npm temporaire, supprimé à la fin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('#41: the suite runs npm with a temporary cache, never the one in the home folder', () => {
  const cache = process.env.npm_config_cache;
  assert.ok(cache, 'npm_config_cache is not set: run the suite through npm test (scripts/test.cjs)');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const real = fs.realpathSync.native(cache);
  assert.ok(real.startsWith(tmp + path.sep), `the npm cache lies outside the temporary folder: ${real}`);
});
