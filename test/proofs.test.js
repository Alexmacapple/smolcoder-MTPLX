// Verdicts structurés et preuves d'acceptation protégées (ticket #9, H04) :
// la grammaire du stockage hôte et les briques pures (statut d'un contrôle,
// zéro test, identité du vérificateur), sans processus ni modèle. Le câblage
// dans la boucle de l'agent et les tests « H04 ACn » arrivent avec lui.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code.
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "smol-proofs-home-")));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const proofs = require("../dist/harness/proofs");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const PKG = (scripts) => JSON.stringify({ name: "fixture", version: "1.0.0", scripts }) + "\n";

function write(ws, files) {
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(ws, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

// ---- grammaire et briques --------------------------------------------------------------

test("H04 store: contract checks are validated and optional — without them the canonical form, hence every existing fingerprint, is unchanged", () => {
  const ws = tmp("smol-proofs-grammar-");
  const base = { schema: "smolcoder/contract/v1", id: "g", title: "t", problem: "p", outcome: "o", acceptance: ["a", "b"], budgets: { maxSteps: 5 } };
  const plain = store.parseContractSource(base, ws);
  assert.equal("checks" in plain, false);
  const checked = store.parseContractSource({ ...base, checks: [{ command: " npm test ", covers: [1, 2], timeoutSeconds: 30 }] }, ws);
  assert.deepEqual(checked.checks, [{ command: "npm test", covers: [1, 2], timeoutSeconds: 30 }]);
  assert.notEqual(store.contractFingerprint(checked), store.contractFingerprint(plain));
  for (const [bad, why] of [
    [[{ command: "npm test", covers: [3] }], /acceptance has 2/],
    [[{ command: "a", covers: [1] }, { command: "b", covers: [1] }], /already covered/],
    [[{ command: "a", covers: [1], by: "model" }], /unknown field/],
    [[{ command: "", covers: [1] }], /command/],
    [[{ command: "a", covers: [1], timeoutSeconds: 0 }], /timeoutSeconds/],
    [[], /1 to/],
  ]) assert.throws(() => store.parseContractSource({ ...base, checks: bad }, ws), why);
});

test("H04 store: verdict events have closed fields; approval events carry the frozen verifier fingerprint", () => {
  const dir = tmp("smol-proofs-journal-");
  const fp = "a".repeat(64);
  const ok = { type: "verdict", fingerprint: fp, criteria: ["acceptance-1"], command: "npm test", owner: "contract", status: "passed", cause: null, attempt: 1, exit: { status: "exited", code: 0, signal: null, durationMs: 12 }, tests: 3, verifiers: "b".repeat(64), files: "c".repeat(64) };
  store.appendProof(dir, ok);
  store.appendProof(dir, { type: "approval", fingerprint: fp, by: "headless-flag", verifiers: "d".repeat(64) });
  for (const bad of [
    { ...ok, status: "green" },
    { ...ok, cause: "exit-code" },
    { ...ok, status: "failed", cause: null },
    { ...ok, extra: 1 },
    { ...ok, criteria: [] },
    { ...ok, exit: { status: "exited", code: 0, signal: null, durationMs: 1, output: "x" } },
    { ...ok, fingerprint: "nope" },
    { type: "approval", fingerprint: fp, by: "headless-flag", verifiers: "short" },
  ]) assert.throws(() => store.appendProof(dir, bad), /verdict is invalid|unknown field|must be|fingerprint/, JSON.stringify(bad));
  const read = store.readProofs(dir);
  assert.equal(read.state, "ok");
  assert.deepEqual(read.events.map((e) => e.type), ["verdict", "approval"]);
});

test("H04 zero tests: recognized runner summaries count the tests actually executed; output text can only take a pass away, never give one", () => {
  const cases = [
    ["\x1b[34mℹ tests 0\x1b[39m\nℹ pass 0\nℹ fail 0\n", 0],
    ["ℹ tests 2\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n", 0],
    ["ℹ tests 3\nℹ pass 2\nℹ fail 1\n", 3],
    ["TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n", 0],
    ["Tests:       0 total\n", 0],
    ["Tests:       2 skipped, 2 total\n", 0],
    ["Tests:       1 failed, 2 passed, 3 total\n", 3],
    ["No tests found, exiting with code 1\n", 0],
    ["  0 passing (2ms)\n  2 pending\n", 0],
    ["  3 passing (5ms)\n  1 failing\n", 4],
    [" Tests  3 passed (3)\n", 3],
    [" Tests  3 skipped (3)\n", 0],
    ["No test files found, exiting with code 1\n", 0],
    ["collected 0 items\n\n==== no tests ran in 0.01s ====\n", 0],
    ["==== 1 failed, 2 passed in 0.10s ====\n", 3],
    ["all good\n", null],
  ];
  for (const [out, executed] of cases) assert.equal(proofs.countTests(out).executed, executed, JSON.stringify(out));
  const res = (fields) => ({ started: true, status: "exited", exitCode: 0, signal: null, durationMs: 1, output: "", ...fields });
  assert.deepEqual(proofs.classify(res({ output: "ℹ tests 0\n" })), { status: "not_run", cause: "zero-tests", tests: 0 });
  assert.deepEqual(proofs.classify(res({ exitCode: 1, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0\n" })), { status: "failed", cause: "exit-code", tests: 3 });
  assert.deepEqual(proofs.classify(res({ exitCode: 137 })), { status: "error", cause: "crashed", tests: null });
  assert.deepEqual(proofs.classify(res({ status: "signaled", exitCode: null, signal: "SIGSEGV" })), { status: "error", cause: "crashed", tests: null });
  assert.deepEqual(proofs.classify(res({ status: "timeout", exitCode: null })), { status: "error", cause: "timeout", tests: null });
  assert.deepEqual(proofs.classify(res({ status: "spawn_error", started: false, exitCode: null })), { status: "error", cause: "spawn-error", tests: null });
  assert.deepEqual(proofs.classify(res({ output: "Error: 0 problems\n" })), { status: "passed", cause: null, tests: null });
});

test("H04 verifier identity: the scripts a check runs are named from the command and the npm scripts it reaches, redirections excluded", () => {
  const ws = tmp("smol-proofs-named-");
  write(ws, { "package.json": PKG({ pretest: "sh scripts/prep.sh", test: "node scripts/run.cjs --flag > out.txt && jest --ci", posttest: "npm run report", report: "node -r ./setup.cjs report.js 2>&1 | tee log.txt", dev: "node server.js" }) });
  // `tee` compte aussi : npm met node_modules/.bin en tête du PATH, un fichier
  // déposé là masquerait l'outil du système.
  assert.deepEqual(proofs.namedVerifierInputs(ws, ["npm test"]), ["node_modules/.bin/jest", "node_modules/.bin/tee", "report.js", "scripts/prep.sh", "scripts/run.cjs", "setup.cjs"]);
  assert.deepEqual(proofs.namedVerifierInputs(ws, ["sh -c 'node verify.cjs' > check.out", "./bin/check --x", 'node -e "require(\'fs\')"']), ["bin/check", "verify.cjs"]);
  assert.deepEqual(proofs.namedVerifierInputs(ws, ["2> err.log node x.js", "node y.js >> out.log"]), ["x.js", "y.js"], "a redirection target is never a script");
  assert.equal(proofs.isConventionalVerifierInput("packages/a/__tests__/x.js"), true);
  assert.equal(proofs.isConventionalVerifierInput("src/app.test.ts"), true);
  assert.equal(proofs.isConventionalVerifierInput("vitest.config.mts"), true);
  assert.equal(proofs.isConventionalVerifierInput("src/app.ts"), false, "the code under test stays free to change");
  assert.equal(proofs.isConventionalVerifierInput("dist/app.test.js"), false, "build outputs are regenerated by the checks themselves");
  assert.equal(proofs.isConventionalVerifierInput("test/tmp/run.log"), false);
  assert.equal(proofs.countsWhenAdded("test/out.json"), false, "data a test writes is not an alteration");
  assert.equal(proofs.countsWhenAdded("test/helper.js"), true, "new code under a test folder is");
  assert.equal(proofs.countsWhenAdded("__mocks__/fs.js"), true);
  assert.equal(proofs.countsWhenAdded("src/__snapshots__/a.snap"), true);
});
