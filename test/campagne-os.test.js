// H03-4 (#18) : contrôle déterministe du harnais de la campagne OS
// (bench/campagne-os/), sans jouer la campagne réelle : le rapporteur de
// node:test, le classement des critères du chapeau #12 en statuts du banc
// (#13), la correspondance des critères avec les tests OS qui existent, le
// verrou de campagne et la chaîne complète avec un faux npm. La campagne
// réelle se lance à la main sur le Mac (docs/campagne-os-2026-09-27.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const B = path.join(ROOT, "bench", "campagne-os");
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const posix = process.platform === "win32" ? "bash scripts" : false;
const manifest = () => require(path.join(B, "manifeste.cjs"));
const criteria = () => JSON.parse(fs.readFileSync(path.join(B, "criteres.json"), "utf8"));
const STATUSES = ["succes", "echec_test", "refus_securite_attendu", "mtplx_indisponible", "blocage_harnais"];

/** Les noms des tests déclarés dans test/os/*.os.test.js, lus dans leur source. */
function osTestNames() {
  const dir = path.join(ROOT, "test", "os");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".os.test.js")).flatMap((f) =>
    [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(/^test\("([^"]+)"/gm)].map((m) => ({ name: m[1], file: `test/os/${f}` })));
}
/** Un résultat synthétique par test OS déclaré, au format du rapporteur. */
const passing = () => osTestNames().map((t) => ({ name: t.name, file: t.file, status: "pass", duration_ms: 100 }));

test("H03-4 campaign: the six criteria of #12 are listed with their text and kind, and each names OS tests that exist — one test per prefix", () => {
  const c = criteria();
  assert.equal(c.format, "campagne-os-criteres/v1");
  assert.deepEqual(c.criteria.map((x) => x.id), ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6"]);
  for (const x of c.criteria) {
    assert.ok(x.text.length > 40, `${x.id}: the criterion's own text`);
    assert.ok(["refus", "fonctionnel"].includes(x.kind), `${x.id}: kind`);
    assert.ok(x.tests.length > 0, `${x.id}: at least one proving test`);
  }
  const names = osTestNames().map((t) => t.name);
  for (const x of c.criteria) for (const prefix of x.tests) {
    assert.equal(names.filter((n) => n.startsWith(prefix)).length, 1, `${x.id}: "${prefix}" names exactly one OS test`);
  }
  assert.match(c.criteria[4].text, /Même frontière pour terminal, web, headless et vérifications automatiques/);
  for (const surface of ["headless", "web", "terminal"]) assert.ok(c.criteria[4].tests.some((p) => p.includes(`(${surface})`)), `AC5 names the ${surface} end-to-end test`);
});

test("H03-4 campaign: criteria and the campaign get the bench statuses — refusal criteria refus_securite_attendu, functional ones succes; a failure echec_test; a missing, skipped or ambiguous test blocage_harnais; a harness block wins", () => {
  const { buildManifest } = manifest();
  const context = { runId: "r", startedAt: "2026-09-27T00:00:00Z", finishedAt: "2026-09-27T00:01:00Z", unit: { exitCode: 0, durationSeconds: 8 }, os: { exitCode: 0, durationSeconds: 60 } };
  const unit = [{ name: "u", file: "test/x.test.js", status: "pass", duration_ms: 1 }];
  const ok = buildManifest({ context, criteria: criteria(), unitTests: unit, osTests: passing() });
  assert.equal(ok.format, "campagne-os/v1");
  assert.equal(ok.status, "succes", ok.status_reason);
  assert.deepEqual(ok.criteria.map((x) => [x.id, x.status]), [["AC1", "refus_securite_attendu"], ["AC2", "refus_securite_attendu"], ["AC3", "succes"], ["AC4", "succes"], ["AC5", "refus_securite_attendu"], ["AC6", "refus_securite_attendu"]]);
  for (const x of ok.criteria) {
    assert.ok(STATUSES.includes(x.status));
    assert.equal(x.duration_ms, x.tests.length * 100, `${x.id}: its tests' durations add up`);
  }
  assert.deepEqual([ok.suites.unit.tests, ok.suites.unit.pass, ok.suites.os.tests, ok.suites.os.pass], [1, 1, passing().length, passing().length]);
  assert.ok(ok.other_tests.length > 0 && ok.other_tests.every((t) => !ok.criteria.some((x) => x.tests.some((u) => u.name === t.name))), "the OS tests of no criterion are listed apart");

  const withStatus = (prefix, status) => passing().map((t) => (t.name.startsWith(prefix) ? { ...t, status } : t));
  const failed = buildManifest({ context: { ...context, os: { exitCode: 1, durationSeconds: 60 } }, criteria: criteria(), unitTests: unit, osTests: withStatus("H03-2 OS AC1:", "fail") });
  assert.equal(failed.criteria[0].status, "echec_test");
  assert.equal(failed.status, "echec_test");
  const skipped = buildManifest({ context, criteria: criteria(), unitTests: unit, osTests: withStatus("H03-2 OS AC6:", "skip") });
  assert.equal(skipped.criteria[5].status, "blocage_harnais", "a skipped test proves nothing");
  assert.equal(skipped.status, "blocage_harnais");
  const missing = buildManifest({ context, criteria: criteria(), unitTests: unit, osTests: passing().filter((t) => !t.name.startsWith("H03-4 OS AC5 (web)")) });
  assert.equal(missing.criteria[4].status, "blocage_harnais");
  assert.match(missing.criteria[4].status_reason, /H03-4 OS AC5 \(web\)/);
  const twice = buildManifest({ context, criteria: criteria(), unitTests: unit, osTests: [...passing(), passing().find((t) => t.name.startsWith("H03-2 OS AC4:"))] });
  assert.equal(twice.criteria[3].status, "blocage_harnais", "an ambiguous match proves nothing");
  const unitFail = buildManifest({ context: { ...context, unit: { exitCode: 1, durationSeconds: 8 } }, criteria: criteria(), unitTests: [{ ...unit[0], status: "fail" }], osTests: passing() });
  assert.equal(unitFail.status, "echec_test", "a unit regression fails the campaign");
  const blocked = buildManifest({ context: { ...context, harnessBlock: "Une campagne est déjà active (PID 1)" }, criteria: criteria(), unitTests: [], osTests: [] });
  assert.deepEqual([blocked.status, blocked.status_reason], ["blocage_harnais", "Une campagne est déjà active (PID 1)"]);
  assert.ok(blocked.criteria.every((x) => x.status === "blocage_harnais"));
});

test("H03-4 campaign: the node:test reporter writes one JSON line per top-level test — pass, fail with its error, skip — with its duration", () => {
  const dir = tmp("smol-campaign-rep-");
  const file = path.join(dir, "fixture.test.js");
  fs.writeFileSync(file, 'const test = require("node:test");\ntest("A passes", () => {});\ntest("B fails", () => { throw new Error("boom"); });\ntest("C is skipped", { skip: "no reason" }, () => {});\ntest("D has subtests", async (t) => { await t.test("inner", () => {}); });\n');
  const out = path.join(dir, "out.jsonl");
  // Sans NODE_TEST_CONTEXT : sinon ce node --test imbriqué se croit
  // sous-processus du lanceur de npm test et lui renvoie ses résultats.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
  const r = spawnSync(process.execPath, ["--test", `--test-reporter=${path.join(B, "rapporteur.mjs")}`, `--test-reporter-destination=${out}`, file], { encoding: "utf8", env });
  assert.equal(r.status, 1, "the fixture has a failing test");
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.name, l.status]), [["A passes", "pass"], ["B fails", "fail"], ["C is skipped", "skip"], ["D has subtests", "pass"]], "top-level tests only");
  assert.match(lines[1].error, /boom/);
  assert.ok(lines.every((l) => typeof l.duration_ms === "number" && l.file.endsWith("fixture.test.js")));
});

/** Un faux npm : il écrit, pour le rapporteur de chaque suite, un résultat
 * synthétique par test OS déclaré (ou un seul test unitaire), puis sort 0. */
function fakeNpm(dir, calls) {
  const tests = JSON.stringify(passing());
  const file = path.join(dir, "npm");
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0-fake"); process.exit(0); }
const dest = args.map((a, i) => [a, args[i + 1]]).filter(([a]) => a.startsWith("--test-reporter-destination=")).map(([a]) => a.split("=")[1]).find((d) => d.endsWith(".jsonl"));
const os = args.includes("test:os");
const rows = os ? ${tests} : [{ name: "unit", file: "test/x.test.js", status: "pass", duration_ms: 1 }];
fs.writeFileSync(dest, rows.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
console.log("fake " + (os ? "npm run test:os" : "npm test"));
`, { mode: 0o755 });
  return file;
}

test("H03-4 campaign: under a held campaign lock nothing runs — the run still gets its timestamped folder and a blocage_harnais manifest, and the lock is left alone", { skip: posix }, () => {
  const results = tmp("smol-campaign-res-");
  const calls = path.join(tmp("smol-campaign-calls-"), "calls.txt");
  const npm = fakeNpm(tmp("smol-campaign-bin-"), calls);
  const lock = path.join(results, ".verrou-campagne");
  fs.writeFileSync(lock, `${process.pid}\n`); // un propriétaire vivant : ce processus
  const r = spawnSync("/bin/bash", [path.join(B, "campagne.sh")], { encoding: "utf8", env: { ...process.env, HOME: tmp("smol-campaign-home-"), CAMPAGNE_OS_RESULTS_DIR: results, CAMPAGNE_OS_NPM: npm } });
  assert.equal(r.status, 4, r.stderr);
  const runs = fs.readdirSync(results).filter((d) => /^\d{8}T\d{6}Z-campagne-os\.\w+$/.test(d));
  assert.equal(runs.length, 1, "one timestamped folder");
  const m = JSON.parse(fs.readFileSync(path.join(results, runs[0], "manifeste.json"), "utf8"));
  assert.equal(m.status, "blocage_harnais");
  assert.match(m.status_reason, new RegExp(`Une campagne est déjà active \\(PID ${process.pid}\\)`));
  assert.ok(!fs.existsSync(calls), "npm was never called");
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`, "the active lock is untouched");
});

test("H03-4 campaign: the whole chain with a fake npm — npm test then npm run test:os with the reporters, npm logs kept in the run folder, a campagne-os/v1 manifest with the harness SHA, macOS version, sandbox-exec, statuses per criterion and durations; the lock is released", { skip: process.platform === "darwin" ? false : "the campaign runs on macOS only" }, () => {
  const results = tmp("smol-campaign-res-");
  const calls = path.join(tmp("smol-campaign-calls-"), "calls.txt");
  const npm = fakeNpm(tmp("smol-campaign-bin-"), calls);
  const home = tmp("smol-campaign-home-");
  fs.mkdirSync(path.join(home, ".npm", "_logs"), { recursive: true });
  const r = spawnSync("/bin/bash", [path.join(B, "campagne.sh")], { encoding: "utf8", env: { ...process.env, HOME: home, CAMPAGNE_OS_RESULTS_DIR: results, CAMPAGNE_OS_NPM: npm } });
  assert.equal(r.status, 0, r.stderr);
  const [run] = fs.readdirSync(results).filter((d) => d.includes("-campagne-os."));
  const out = path.join(results, run);
  const m = JSON.parse(fs.readFileSync(path.join(out, "manifeste.json"), "utf8"));
  assert.equal(m.format, "campagne-os/v1");
  assert.equal(m.status, "succes", m.status_reason);
  assert.equal(m.run.id, run);
  assert.match(m.harness.repository_sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof m.harness.working_tree_dirty, "boolean");
  assert.match(m.machine.macos_version, /^\d+(\.\d+)*$/);
  assert.deepEqual(m.machine.sandbox_exec, { path: "/usr/bin/sandbox-exec", present: true });
  assert.deepEqual(m.criteria.map((x) => x.status), ["refus_securite_attendu", "refus_securite_attendu", "succes", "succes", "refus_securite_attendu", "refus_securite_attendu"]);
  assert.ok(Number.isInteger(m.suites.unit.duration_seconds) && Number.isInteger(m.suites.os.duration_seconds));
  assert.deepEqual([m.suites.unit.exit_code, m.suites.os.exit_code], [0, 0]);
  const invoked = fs.readFileSync(calls, "utf8").trim().split("\n").filter((l) => l !== "--version");
  assert.equal(invoked.length, 2);
  assert.match(invoked[0], /^test -- --test-reporter=spec --test-reporter-destination=stdout --test-reporter=.*rapporteur\.mjs --test-reporter-destination=.*tests-unitaires\.jsonl$/);
  assert.match(invoked[1], /^run test:os -- --test-reporter=spec .*tests-os\.jsonl$/);
  assert.match(fs.readFileSync(path.join(out, "test-os.txt"), "utf8"), /fake npm run test:os/);
  assert.deepEqual(m.home_untouched, { npm_entries_before: 2, npm_entries_after: 2, smolcoder_entries_before: 0, smolcoder_entries_after: 0 }, "the real home's npm and smolcoder folders are counted before and after");
  assert.ok(!fs.existsSync(path.join(results, ".verrou-campagne")), "the lock is released");
});
