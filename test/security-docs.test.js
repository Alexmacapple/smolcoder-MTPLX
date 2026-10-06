const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('current mission documentation presents the measured security chronology and its limits', () => {
  const readme = read('README.md');
  const profile = read('docs/profil-mission.md');

  for (const text of [readme, profile]) {
    assert.match(text, /mesure-securite-mission-2026-09-27\.md/);
    assert.match(text, /mesure-securite-mission-revalidation-2026-09-28\.md/);
    assert.match(text, /NON PROTÉGÉ/);
    assert.match(text, /PROTÉGÉ/);
    assert.match(text, /modèle[^\n]*machine[^\n]*politique[^\n]*échantillon/i);
    assert.match(text, /interpréteur|programme arbitraire/i);
  }
  assert.match(profile, /test\/security-docs\.test\.js/);

  assert.match(readme, /issues du fork/);
  assert.doesNotMatch(readme, /correctif de la suppression|étude de confirmation de `copie-figee`/);
  assert.doesNotMatch(readme, /Ce qui est implémenté \(au 27 septembre 2026\)/);
  assert.match(readme, /injection[^\n]*AGENTS\.md|AGENTS\.md[^\n]*injection/i);
});

test('the agent instructions describe the current fork surface', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /src\/harness\//);
  assert.doesNotMatch(agents, /Surface du fork sur l'amont[^\n]*src\/detect\.ts/);
});
