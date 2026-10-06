const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('the Git-only fork has a distinct package identity', () => {
  assert.equal(pkg.name, 'smolcoder');
  assert.equal(pkg.version, '0.7.1-mtplx.1');
  assert.equal(pkg.private, true);
  assert.match(pkg.description, /Qwen.*MTPLX.*harness/i);
  assert.match(pkg.homepage, /Alexmacapple\/smolcoder-MTPLX/);
  assert.match(pkg.repository.url, /Alexmacapple\/smolcoder-MTPLX/);
  assert.match(pkg.bugs.url, /Alexmacapple\/smolcoder-MTPLX/);
  assert.equal(pkg.author, 'Leon van Zyl');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the distribution decision keeps upstream credit and retires the inherited npm task', () => {
  const readme = read('README.md');
  const todo = read('TODO.md');

  assert.match(readme, /distribution[^.\n]*par Git uniquement/i);
  assert.match(readme, /0\.7\.1-mtplx\.N/);
  assert.match(readme, /Crédit original[^]*leonvanzyl\/smolcoder/);
  assert.match(todo, /npm publish[^\n]*héritée de l'amont/i);
});
