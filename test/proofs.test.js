// Verdicts structurés et preuves d'acceptation protégées (ticket #9, H04), sous
// le profil mission, avec un fournisseur simulé (aucun MTPLX) et un faux
// dossier personnel (ni le vrai ~/.smolcoder, ni ~/.npm). Les noms « H04 ACn »
// renvoient aux six critères d'acceptation du ticket. L'exécuteur injecté est
// l'adaptateur hôte, qui tient lieu du backend isolé : le bac réel est éprouvé
// par test/os/e2e.os.test.js (npm run test:os).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Isole ~/.smolcoder, ~/.smolcoder.json et ~/.npm avant de charger le code.
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "smol-proofs-home-")));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");
process.env.npm_config_update_notifier = "false";

const store = require("../dist/harness/store");
const proofs = require("../dist/harness/proofs");
const { Mission } = require("../dist/harness/mission");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { hostExecutor } = require("../dist/harness/executor");
const { unavailableExecutor } = require("../dist/harness/sandbox-executor");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_1 = "module.exports = () => 1;\n";
const APP_2 = "module.exports = () => 2;\n";
const TEST_2 = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('app returns 2', () => assert.equal(require('../app.js')(), 2));\n";
const TEST_1 = TEST_2.replace(/2/g, "1");
const ALWAYS = "const test = require('node:test');\ntest('always', () => {});\n";
const SKIPPED = "const test = require('node:test');\ntest.skip('app returns 2', () => {});\ntest('later', { skip: true }, () => {});\n";
const PKG = (scripts) => JSON.stringify({ name: "fixture", version: "1.0.0", scripts }) + "\n";

function write(ws, files) {
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(ws, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** Un workspace, un contrat hors du workspace, une politique qui laisse passer
 * les commandes du workspace, et l'approbation de l'hôte (qui fige les
 * entrées du vérificateur telles qu'elles sont à cet instant). */
function setup({ files = {}, acceptance = ["la fonction rend 2"], checks = [{ command: "node --test", covers: [1] }], approve = true, commands = [] } = {}) {
  const ws = tmp("smol-proofs-ws-");
  write(ws, files);
  const src = path.join(tmp("smol-proofs-src-"), "contract.json");
  fs.writeFileSync(src, JSON.stringify({
    schema: "smolcoder/contract/v1", id: "proofs", title: "Preuves protégées", problem: "La fonction rend 1.", outcome: "Elle rend 2.",
    acceptance, budgets: { maxSteps: 500 }, ...(checks ? { checks } : {}),
  }));
  const m = Mission.prepare({ source: src, workspace: ws, dataDir: tmp("smol-proofs-data-") });
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, env: ["npm_config_update_notifier"] });
  if (approve) m.approve("terminal-human", m.fingerprint, { commands });
  return { ws, m, src };
}

function scripted(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 32000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = replies[Math.min(i++, replies.length - 1)];
      const reply = typeof r === "function" ? await r(messages) : r;
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...reply };
    },
  };
}
const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });
const DONE = { content: "Terminé : la fonction rend 2 et tous les tests passent." };

function fakeUi() {
  const lines = [];
  return {
    lines,
    token() {}, thinking() {}, toolCall() {}, println() {},
    toolResult(s) { lines.push(String(s)); }, status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd(l) { lines.push("END " + l); }, planUpdated() {},
  };
}

function agentFor(s, provider, { verification, executor = hostExecutor, maxSteps = 80 } = {}) {
  const ui = fakeUi();
  const toolCtx = { workspace: s.ws, taskManager: new TaskManager(s.ws, executor ?? undefined), plan: new Plan(), filesTouched: new Set(), commandsRun: [], ...(executor ? { executor } : {}) };
  const bus = new EventBus();
  const agent = new Agent(provider, "edit", "sys", toolCtx, new ContextManager(32000, 2000), bus, ui, false, maxSteps, verification, s.m);
  return { agent, ui, bus, toolCtx };
}

const run = (agent, text = "fais passer le critère") => agent.runTurn(text).then(() => null, (e) => e);
const verdicts = (m) => {
  const r = store.readProofs(m.dir);
  assert.equal(r.state, "ok");
  return r.events.filter((e) => e.type === "verdict");
};
const reportOf = (m) => JSON.parse(fs.readFileSync(path.join(m.dir, "report.json"), "utf8"));
const markdownOf = (m) => fs.readFileSync(path.join(m.dir, "report.md"), "utf8");
const criterion = (report, id) => report.criteria.find((c) => c.id === id);
/** Le rapport tel que l'hôte le constaterait maintenant, sans rien relancer. */
function reportNow(s, run = { outcome: "completed", suspended: false, error: null, attempts: 1 }) {
  return proofs.buildReport({
    mission: s.m,
    criteria: proofs.missionCriteria(s.m.contract, proofs.callerChecks(s.m.contract)),
    verifier: s.m.verifierState(),
    scan: s.m.scan(),
    run,
    plan: null,
  });
}

// ---- AC1 : « terminé » ne vaut rien sans verdict --------------------------------

test("H04 AC1: Qwen says it is done and checks its whole plan, but a required criterion fails: the task is not verified, the report written outside the workspace says so, and a headless run exits non-zero", async () => {
  const s = setup({ files: { "app.js": APP_1, "test/app.test.js": TEST_2 }, acceptance: ["la fonction rend 2", "le README décrit la fonction"] });
  const provider = scripted([
    call("p1", "plan", { action: "set", steps: "Corriger app.js\nVérifier les tests" }),
    call("p2", "plan", { action: "done" }),
    call("p3", "plan", { action: "done" }),
    DONE,
  ]);
  const { agent } = agentFor(s, provider, { verification: { command: "node --test", maxAttempts: 2 } });
  const err = await run(agent);
  assert.match(String(err?.message), /Acceptance checks still fail after 2 attempts/, "the claim of completion does not end the turn");
  const { report, files } = agent.missionVerdict;
  assert.equal(report.task.state, "incomplete");
  assert.deepEqual(report.claims, { plan: "2/2", note: "Declared by the model — a checked plan is never evidence." });
  const c1 = criterion(report, "acceptance-1");
  assert.deepEqual([c1.status, c1.cause, c1.verdict.exit.code, c1.verdict.tests], ["failed", "exit-code", 1, 1]);
  assert.deepEqual([criterion(report, "acceptance-2").status, criterion(report, "acceptance-2").cause], ["not_run", "not-covered"]);
  assert.deepEqual(report.uncovered, ["acceptance-2"], "the criteria no check covers are shown");
  assert.equal(report.decision.state, "pending", "accepting stays a human decision");
  assert.equal(proofs.verdictExitCode(report), proofs.VERDICT_EXIT_CODE, "a headless run exits non-zero");
  assert.equal(proofs.VERDICT_EXIT_CODE, 5);
  // Hors du workspace : dans le stockage hôte, les deux rendus du même objet.
  assert.deepEqual(files, { json: path.join(s.m.dir, "report.json"), markdown: path.join(s.m.dir, "report.md") });
  assert.deepEqual(fs.readdirSync(s.ws).sort(), ["app.js", "test"], "nothing is written into the workspace");
  assert.deepEqual(reportOf(s.m), JSON.parse(JSON.stringify(report)));
  const md = markdownOf(s.m);
  assert.equal(md, proofs.renderReportMarkdown(report), "report.md is rendered from the same result");
  assert.match(md, /État de la tâche : \*\*incomplete\*\*/);
  assert.match(md, /## Critères non couverts\n\n- acceptance-2 : le README décrit la fonction/);
  assert.match(md, /Un plan coché n'est jamais une preuve/);
  assert.doesNotMatch(md, /^- `passed`/m);
  // Chaque tentative laisse un verdict daté au journal.
  const vs = verdicts(s.m);
  assert.deepEqual(vs.map((v) => [v.attempt, v.status, v.cause, v.exit.status, v.exit.code]), [[1, "failed", "exit-code", "exited", 1], [2, "failed", "exit-code", "exited", 1]]);
  for (const v of vs) {
    assert.equal(v.fingerprint, s.m.fingerprint);
    assert.deepEqual(v.criteria, ["acceptance-1", "verify"]);
    assert.equal(v.verifiers, s.m.verifierState().frozen);
    assert.match(v.files, /^[0-9a-f]{64}$/);
  }
});

// ---- AC2 : zéro test, sauté, délai, plantage : jamais passed ---------------------

test("H04 AC2: zero tests — no test file, or every test skipped — exits 0 and is never passed (not_run, zero-tests)", async () => {
  for (const [label, files] of [["no test file", { "app.js": APP_2 }], ["all skipped", { "app.js": APP_2, "test/app.test.js": SKIPPED }]]) {
    const s = setup({ files });
    const { agent } = agentFor(s, scripted([DONE]), { verification: { command: "node --test", maxAttempts: 1 } });
    const err = await run(agent);
    assert.match(String(err?.message), /still fail after 1/, label);
    const r = agent.missionVerdict.report;
    assert.deepEqual([criterion(r, "acceptance-1").status, criterion(r, "acceptance-1").cause], ["not_run", "zero-tests"], label);
    const v = verdicts(s.m).at(-1);
    assert.deepEqual([v.status, v.cause, v.exit.code, v.tests], ["not_run", "zero-tests", 0, 0], `${label}: the real exit code was 0`);
    assert.notEqual(r.task.state, "verified", label);
  }
});

test("H04 AC2: a required npm script that is missing, or npm's placeholder, is not run and never passed", async () => {
  const cases = [
    ["missing", PKG({ build: "node -e 0" }), "npm test", "missing-script"],
    ["empty", PKG({ test: " " }), "npm run test", "missing-script"],
    ["if-present", PKG({}), "npm run test:e2e --if-present", "missing-script"],
    ["placeholder", PKG({ test: 'echo "Error: no test specified" && exit 1' }), "npm test", "zero-tests"],
  ];
  for (const [label, pkg, command, cause] of cases) {
    const s = setup({ files: { "package.json": pkg }, checks: [{ command, covers: [1] }] });
    const { agent, ui } = agentFor(s, scripted([DONE]), { verification: { command, maxAttempts: 1 } });
    await run(agent);
    const v = verdicts(s.m).at(-1);
    assert.deepEqual([v.status, v.cause, v.exit], ["not_run", cause, null], `${label}: judged before running, nothing launched`);
    assert.ok(ui.lines.some((l) => /not run: /.test(l)), label);
    assert.equal(agent.missionVerdict.report.counts.passed, 0, label);
  }
});

test("H04 AC2: a required check that is skipped — after an earlier failure, or never reached because the turn stopped — is not_run, never passed", async () => {
  const fail = 'node -e "process.exit(1)"';
  const s = setup({ acceptance: ["le premier contrôle passe", "le second contrôle passe"], checks: [{ command: fail, covers: [1] }, { command: 'node -e "process.exit(0)"', covers: [2] }] });
  const { agent } = agentFor(s, scripted([DONE]), { verification: { command: fail, maxAttempts: 1 } });
  await run(agent);
  const r = agent.missionVerdict.report;
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status, c.cause]), [["acceptance-1", "failed", "exit-code"], ["acceptance-2", "not_run", "not-run"], ["verify", "failed", "exit-code"]]);
  assert.deepEqual(verdicts(s.m).map((v) => v.criteria), [["acceptance-1", "verify"]], "the skipped check left no verdict");
  // Le tour s'arrête (budget de pas) avant toute vérification.
  const t = setup({ files: { "app.js": APP_2, "test/app.test.js": TEST_2 } });
  const reads = scripted([call("l1", "list_files", {}), call("l2", "list_files", { path: "." }), call("l3", "read_file", { path: "app.js" })]);
  const { agent: paused } = agentFor(t, reads, { maxSteps: 3 });
  const err = await run(paused);
  assert.match(String(err?.message), /Paused after 3 model steps/);
  const p = paused.missionVerdict.report;
  assert.deepEqual([criterion(p, "acceptance-1").status, criterion(p, "acceptance-1").cause], ["not_run", "not-run"]);
  assert.equal(p.task.state, "incomplete");
  assert.deepEqual(verdicts(t.m), []);
});

test("H04 AC2: a verifier that times out, is killed by a signal, or cannot be launched is error — never passed", async () => {
  const killed = process.platform === "win32" ? ["failed", "exit-code"] : ["error", "crashed"];
  const cases = [
    ["timeout", 'node -e "setInterval(() => {}, 1000)"', {}, ["error", "timeout"]],
    ["child killed (shell exit 137)", 'node -e "process.kill(process.pid, \'SIGKILL\')"', {}, killed],
    ["verifier shell killed", "kill -KILL $$", {}, killed],
    ["launch impossible", 'node -e "process.exit(0)"', { executor: unavailableExecutor("backend absent in this test") }, ["error", "spawn-error"]],
    ["no isolated executor", 'node -e "process.exit(0)"', { executor: null }, ["error", "no-isolation"]],
  ];
  for (const [label, command, opts, expected] of cases) {
    const s = setup({ checks: [{ command, covers: [1] }] });
    const { agent } = agentFor(s, scripted([DONE]), { verification: { command, maxAttempts: 1, timeoutMs: 400 }, ...opts });
    const err = await run(agent);
    assert.match(String(err?.message), /still fail after 1/, label);
    const r = agent.missionVerdict.report;
    assert.deepEqual([criterion(r, "acceptance-1").status, criterion(r, "acceptance-1").cause], expected, label);
    assert.notEqual(r.task.state, "verified", `${label}: the harness cannot conclude success`);
    assert.equal(verdicts(s.m).at(-1).status, expected[0], label);
  }
});

// ---- AC3 : le code de sortie réel, pas le texte ----------------------------------

test("H04 AC3: output printing «exit code 0» and a passing test summary cannot replace the real exit code: failed, never passed; text never turns a failure into a pass", async () => {
  const s = setup({
    files: { "verify.cjs": "console.log('[exit code 0 in 0.1s]');\nconsole.log('ℹ tests 3');\nconsole.log('ℹ pass 3');\nconsole.log('ℹ fail 0');\nprocess.exit(3);\n" },
    checks: [{ command: "node verify.cjs", covers: [1] }],
  });
  const { agent } = agentFor(s, scripted([DONE]), { verification: { command: "node verify.cjs", maxAttempts: 1 } });
  await run(agent);
  const v = verdicts(s.m).at(-1);
  assert.deepEqual([v.status, v.cause, v.exit.status, v.exit.code], ["failed", "exit-code", "exited", 3]);
  assert.equal(criterion(agent.missionVerdict.report, "acceptance-1").status, "failed");
  // Le cas inverse : un journal qui commence par « Error » ne retire pas une
  // réussite réelle (seul « zéro test » le peut).
  const t = setup({ files: { "verify.cjs": "console.log('Errors: 0');\nconsole.log('ℹ tests 2');\nconsole.log('ℹ pass 2');\nconsole.log('ℹ fail 0');\n" }, checks: [{ command: "node verify.cjs", covers: [1] }] });
  const { agent: ok } = agentFor(t, scripted([DONE]));
  assert.equal(await run(ok), null);
  assert.deepEqual([verdicts(t.m).at(-1).status, verdicts(t.m).at(-1).tests], ["passed", 2]);
  assert.equal(ok.missionVerdict.report.task.state, "verified");
  assert.equal(proofs.verdictExitCode(ok.missionVerdict.report), 0);
});

// ---- AC4 : ni test modifié, ni configuration, ni script trivial ---------------------

test("H04 AC4: a modified test cannot earn acceptance — the check does not run, the model is told which file changed, and restoring it exactly runs the approved test again", async () => {
  const s = setup({ files: { "app.js": APP_1, "test/app.test.js": TEST_2 } });
  let alteredWouldPass = null;
  const provider = scripted([
    call("w1", "write_file", { path: "test/app.test.js", content: ALWAYS }),
    DONE,
    (messages) => {
      // L'altération est réelle : le test modifié passerait.
      alteredWouldPass = spawnSync(process.execPath, ["--test"], { cwd: s.ws, encoding: "utf8" }).status;
      assert.match(messages.at(-1).content, /verifier inputs changed since the host approved them: test\/app\.test\.js \(modified\)/);
      return call("w2", "write_file", { path: "test/app.test.js", content: TEST_2 });
    },
    DONE,
  ]);
  const { agent } = agentFor(s, provider, { verification: { command: "node --test", maxAttempts: 2 } });
  const err = await run(agent);
  assert.equal(alteredWouldPass, 0, "the altered test would have passed");
  assert.match(String(err?.message), /still fail after 2/);
  const vs = verdicts(s.m);
  assert.deepEqual(vs.map((v) => [v.status, v.cause]), [["not_run", "verifier-changed"], ["failed", "exit-code"]], "the altered test never ran; the restored, approved one did");
  assert.deepEqual(vs[0].changes, ["test/app.test.js (modified)"]);
  assert.ok(vs.every((v) => v.status !== "passed"));
});

test("H04 AC4: a changed test configuration (.npmrc script-shell) or a test script replaced by a trivial success cannot earn acceptance, though npm itself would now exit 0", async () => {
  const files = { "app.js": APP_1, "test/app.test.js": TEST_2, "package.json": PKG({ test: "node --test" }) };
  const pathKey = process.platform === "win32" ? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") : "PATH";
  const npmTest = (ws) => spawnSync("npm", ["test"], { cwd: ws, env: { [pathKey]: process.env[pathKey], HOME, npm_config_update_notifier: "false" }, encoding: "utf8" }).status;
  const shell = process.platform === "win32" ? ["ok.cmd", "@echo off\r\nexit /b 0\r\n"] : ["ok.sh", "#!/bin/sh\nexit 0\n"];
  const attacks = [
    [".npmrc", [call("w1", "write_file", { path: shell[0], content: shell[1] }), ...(process.platform === "win32" ? [] : [call("c1", "run_command", { command: "chmod +x ok.sh" })]), call("w2", "write_file", { path: ".npmrc", content: `script-shell=./${shell[0]}\n` })], [".npmrc (added)"]],
    ["exit 0", [call("w1", "write_file", { path: "package.json", content: PKG({ test: "exit 0" }) })], ["package.json (modified)"]],
  ];
  for (const [label, steps, changes] of attacks) {
    const s = setup({ files, checks: [{ command: "npm test", covers: [1] }] });
    assert.notEqual(npmTest(s.ws), 0, `${label}: before the attack npm test fails`);
    const { agent } = agentFor(s, scripted([...steps, DONE]), { verification: { command: "npm test", maxAttempts: 1 } });
    await run(agent);
    assert.equal(npmTest(s.ws), 0, `${label}: the attack works on npm itself`);
    const v = verdicts(s.m).at(-1);
    assert.deepEqual([v.status, v.cause, v.changes], ["not_run", "verifier-changed", changes], label);
    const r = agent.missionVerdict.report;
    assert.equal(r.task.state, "blocked", label);
    assert.equal(r.counts.passed, 0, label);
    assert.deepEqual(r.verifiers.changes, changes, label);
  }
  assert.deepEqual(fs.readdirSync(HOME).filter((f) => f !== ".npm"), [], "npm ran with the fake home folder only");
});

test("H04 AC4: a test file added by the model, or a verifier input rewritten during the check itself (same content), cannot earn acceptance", async () => {
  // Le test approuvé passe ; un fichier de test ajouté suffit à tout bloquer.
  const s = setup({ files: { "app.js": APP_2, "test/app.test.js": TEST_2 } });
  const { agent } = agentFor(s, scripted([call("w1", "write_file", { path: "test/aaa.test.js", content: "process.on('exit', () => { process.exitCode = 0; });\n" }), DONE]), { verification: { command: "node --test", maxAttempts: 1 } });
  await run(agent);
  assert.deepEqual([verdicts(s.m).at(-1).status, verdicts(s.m).at(-1).changes], ["not_run", ["test/aaa.test.js (added)"]]);
  // Écrit pendant le contrôle, même à l'identique : le noyau le voit.
  const rewrite = "const fs = require('fs');\nconst f = 'test/app.test.js';\nfs.writeFileSync(f, fs.readFileSync(f));\n";
  const t = setup({ files: { "app.js": APP_2, "test/app.test.js": TEST_2, "check.cjs": rewrite }, checks: [{ command: "node check.cjs", covers: [1] }] });
  const { agent: during } = agentFor(t, scripted([DONE]), { verification: { command: "node check.cjs", maxAttempts: 1 } });
  await run(during);
  const v = verdicts(t.m).at(-1);
  assert.deepEqual([v.status, v.cause, v.exit.code, v.changes], ["error", "verifier-changed-during-check", 0, ["test/app.test.js (written during the check)"]], "exit 0, but not a pass");
  assert.equal(fs.readFileSync(path.join(t.ws, "test/app.test.js"), "utf8"), TEST_2, "the content is identical");
});

test("H04 AC4 (no false alarm): build outputs regenerated by a check and data a test writes under test/ never block an honest project, turn after turn", async () => {
  const build = "const fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.copyFileSync('test/app.test.js', 'dist/app.test.js');\nfs.writeFileSync('dist/package.json', JSON.stringify({ built: Date.now() }));\n";
  const writes = "const test = require('node:test');\nconst fs = require('fs');\ntest('writes its output', () => { fs.mkdirSync('test/tmp', { recursive: true }); fs.writeFileSync('test/out.json', String(Date.now())); fs.writeFileSync('test/tmp/run.log', 'x'); });\n";
  const s = setup({
    files: { "package.json": PKG({ build: "node build.cjs", test: "node --test test/app.test.js" }), "build.cjs": build, "test/app.test.js": writes },
    acceptance: ["le projet se construit", "les tests passent"],
    checks: [{ command: "npm run build", covers: [1] }, { command: "npm test", covers: [2] }],
  });
  for (const turn of [1, 2]) {
    const { agent } = agentFor(s, scripted([DONE]));
    assert.equal(await run(agent), null, `turn ${turn}`);
    const r = agent.missionVerdict.report;
    assert.equal(r.task.state, "verified", `turn ${turn}: ${r.task.reason}`);
    assert.deepEqual(r.criteria.map((c) => c.status), ["passed", "passed"]);
  }
  assert.ok(fs.existsSync(path.join(s.ws, "dist/app.test.js")) && fs.existsSync(path.join(s.ws, "test/out.json")));
});

test("H04 AC4: only a new human approval of the verifier inputs, naming their exact fingerprint, lets a changed test count", async () => {
  const s = setup({ files: { "app.js": APP_1, "test/app.test.js": TEST_2 } });
  // L'humain corrige le test (il attendait 2, la bonne valeur est 1).
  fs.writeFileSync(path.join(s.ws, "test/app.test.js"), TEST_1);
  const first = agentFor(s, scripted([DONE]), { verification: { command: "node --test", maxAttempts: 1 } }).agent;
  await run(first);
  assert.equal(first.missionVerdict.report.task.state, "blocked");
  const state = s.m.verifierState();
  assert.deepEqual([state.state, state.changes], ["changed", ["test/app.test.js (modified)"]]);
  assert.throws(() => s.m.approveVerifiers("terminal-human", "0".repeat(64)), /does not match the current verifier inputs/);
  assert.throws(() => s.m.approveVerifiers("the-model", state.current), /by/);
  const after = s.m.approveVerifiers("terminal-human", state.current);
  assert.deepEqual([after.state, after.frozen], ["frozen", state.current]);
  const approvals = store.readProofs(s.m.dir).events.filter((e) => e.type === "approval");
  assert.deepEqual(approvals.map((e) => [e.by, e.verifiers]), [["terminal-human", state.frozen], ["terminal-human", state.current]]);
  const second = agentFor(s, scripted([DONE])).agent;
  assert.equal(await run(second), null);
  assert.equal(second.missionVerdict.report.task.state, "verified");
});

test("H04 AC4: under --mission the decisive checks go only through the host's isolated executor, with the access decision's environment", async () => {
  const s = setup({ files: { "app.js": APP_2, "test/app.test.js": TEST_2 } });
  const requests = [];
  const recording = { start(req) { requests.push(req); return hostExecutor.start(req); } };
  const { agent } = agentFor(s, scripted([DONE]), { executor: recording });
  assert.equal(await run(agent), null);
  assert.deepEqual(requests.map((r) => [r.surface, r.command, r.login]), [["check", "node --test", false]]);
  const names = ["PATH", "HOME", "TERM", "LANG", ...(process.platform === "win32" ? ["SystemRoot", "ComSpec", "PATHEXT"] : []), "npm_config_update_notifier"];
  const expected = names.map((name) => process.platform === "win32" ? Object.keys(process.env).find((key) => key.toUpperCase() === name.toUpperCase()) : name).filter((key) => key !== undefined && process.env[key] !== undefined).sort();
  assert.deepEqual(Object.keys(requests[0].env).sort(), expected, "the minimal environment of the policy");
  assert.equal(agent.missionVerdict.report.task.state, "verified");
});

// ---- AC5 : preuve périmée, jamais de vert périmé -------------------------------------

test("H04 AC5: an edit after the verification makes the proof stale — the next report shows no green: not_run (stale), task uncertain, exit code non-zero; a new turn starts from «running»", async () => {
  const s = setup({ files: { "app.js": APP_2, "test/app.test.js": TEST_2 } });
  const { agent } = agentFor(s, scripted([DONE]));
  assert.equal(await run(agent), null);
  assert.equal(agent.missionVerdict.report.task.state, "verified");
  assert.match(markdownOf(s.m), /^- `passed` — acceptance-1/m);
  // Une édition après le verdict, hors de tout contrôle.
  fs.writeFileSync(path.join(s.ws, "app.js"), APP_1);
  const r = reportNow(s);
  const c = criterion(r, "acceptance-1");
  assert.deepEqual([c.status, c.cause, c.stale, c.verdict.status], ["not_run", "stale", true, "passed"]);
  assert.equal(r.task.state, "uncertain");
  assert.equal(r.stale, true);
  assert.equal(r.counts.passed, 0);
  assert.equal(proofs.verdictExitCode(r), proofs.VERDICT_EXIT_CODE);
  const md = proofs.renderReportMarkdown(r);
  assert.doesNotMatch(md, /`passed`/, "no stale green in the summary");
  assert.match(md, /preuve périmée/);
  // Au début du tour suivant, le rapport sur disque n'est plus vert.
  let during = null;
  const next = agentFor(s, scripted([() => { during = reportOf(s.m); return DONE; }]), { verification: { command: "node --test", maxAttempts: 1 } }).agent;
  await run(next);
  assert.equal(during.task.state, "running");
  assert.equal(criterion(during, "acceptance-1").status, "not_run");
  assert.equal(next.missionVerdict.report.task.state, "incomplete", "re-verified on the edited file: it fails");
  // Une nouvelle approbation des vérificateurs périme aussi les verdicts.
  fs.writeFileSync(path.join(s.ws, "app.js"), APP_2);
  fs.writeFileSync(path.join(s.ws, "test/app.test.js"), TEST_2 + "// relu par l'humain\n");
  s.m.approveVerifiers("terminal-human", s.m.verifierState().current);
  assert.equal(criterion(reportNow(s), "acceptance-1").status, "not_run");
});

// ---- AC6 : budget d'essais, annulation, contrôles progressifs --------------------------

test("H04 AC6: under --mission the attempt budget holds — one recorded verdict per attempt, and the turn stops at maxAttempts", async () => {
  const s = setup({ files: { "app.js": APP_1, "test/app.test.js": TEST_2 } });
  const { agent } = agentFor(s, scripted([DONE]), { verification: { command: "node --test", maxAttempts: 3 } });
  const err = await run(agent);
  assert.match(String(err?.message), /Acceptance checks still fail after 3 attempts/);
  assert.deepEqual(verdicts(s.m).map((v) => v.attempt), [1, 2, 3]);
  assert.equal(agent.verificationResult.attempts, 3);
});

test("H04 AC6: cancelling during a decisive check kills it, records no verdict for it, and the task is cancelled", async () => {
  const command = "node -e \"setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 1500)\"";
  const s = setup({ checks: [{ command, covers: [1] }] });
  const { agent } = agentFor(s, scripted([DONE]));
  const timer = setTimeout(() => agent.cancel(), 300);
  try {
    assert.equal(await run(agent), null);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(agent.outcome, "cancelled");
  assert.equal(agent.missionVerdict.report.task.state, "cancelled");
  assert.deepEqual(verdicts(s.m), []);
  await sleep(1800);
  assert.ok(!fs.existsSync(path.join(s.ws, "late.txt")), "the check was killed");
});

test("H04 AC6: progressive project checks keep running under --mission and stay non-decisive (no verdict); discovered project checks decide, one verdict each, and never cover the contract by themselves", async () => {
  const check = "if (!require('fs').existsSync('ready.txt')) { console.error('not ready'); process.exit(42); }\n";
  const s = setup({ files: { "package.json": PKG({ test: "node check.cjs" }), "check.cjs": check }, checks: null });
  let progress = 0;
  const provider = scripted([
    { toolCalls: Array.from({ length: 24 }, (_, i) => ({ id: "w" + i, name: "write_file", args: { path: "app.txt", content: "revision " + i } })) },
    (messages) => {
      assert.match(messages.at(-1).content, /Progress checks failed/);
      return call("fix", "write_file", { path: "ready.txt", content: "ready" });
    },
    DONE,
  ]);
  const { agent, bus } = agentFor(s, provider);
  bus.on("post_progress_check", (r) => { progress++; assert.equal(r.passed, false); });
  await run(agent);
  assert.equal(progress, 1, "the progressive check ran");
  assert.deepEqual(verdicts(s.m).map((v) => [v.criteria, v.command, v.owner, v.status]), [[["project-test"], "npm run test", "project", "passed"]], "only the decisive check left a verdict");
  const r = agent.missionVerdict.report;
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status, c.cause]), [["acceptance-1", "not_run", "not-covered"], ["project-test", "passed", null]]);
  assert.equal(r.task.state, "incomplete", "a discovered test alone never accepts the contract");
});

test("H04 AC6: outside --mission nothing changes — no verdict, no report, no host store, the same repair loop", async () => {
  const ws = tmp("smol-proofs-plain-");
  write(ws, { "verify.cjs": "if (!require('fs').existsSync('ready.txt')) process.exit(1);\n" });
  let calls = 0;
  const provider = scripted([() => (++calls === 1 ? DONE : calls === 2 ? call("w", "write_file", { path: "ready.txt", content: "x" }) : DONE)]);
  const agent = new Agent(provider, "edit", "sys", { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] }, new ContextManager(32000, 2000), new EventBus(), fakeUi(), false, 30, { command: "node verify.cjs" });
  await agent.runTurn("build");
  assert.equal(agent.outcome, "completed");
  assert.deepEqual([agent.verificationResult.attempts, agent.verificationResult.passed], [2, true]);
  assert.equal(agent.missionVerdict, null);
  assert.ok(!fs.existsSync(store.harnessDir(ws)), "the host store is untouched");
  assert.deepEqual(fs.readdirSync(ws).sort(), ["ready.txt", "verify.cjs"]);
});

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
