// Profil renforcé « mission » (ticket #8, H01) : contrat de mission tenu par
// l'hôte, parcours préparer → approuver → exécuter, budget de pas persistant.
// Les noms « H01 ACn » renvoient aux critères d'acceptation amendés du ticket.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code : ce
// fichier tourne dans son propre processus.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mission-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const { Mission } = require("../dist/harness/mission");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function contractSource(overrides = {}) {
  return {
    schema: "smolcoder/contract/v1",
    id: "greeting",
    title: "Ajouter un fichier de salutation",
    problem: "Le projet n'a pas de fichier de salutation.",
    outcome: "hello.txt contient une salutation.",
    outOfScope: ["toucher au README"],
    acceptance: ["hello.txt existe"],
    budgets: { maxSteps: 20 },
    ...overrides,
  };
}

/** Un workspace, un contrat hors du workspace et un stockage hôte isolé. */
function setup(overrides = {}) {
  const ws = tmp("smol-mission-ws-");
  const file = path.join(tmp("smol-mission-src-"), "contract.json");
  const data = tmp("smol-mission-data-");
  fs.writeFileSync(file, JSON.stringify(contractSource(overrides)));
  return {
    ws,
    file,
    data,
    prepare: () => Mission.prepare({ source: file, workspace: ws, dataDir: data }),
    rewrite: (o) => fs.writeFileSync(file, JSON.stringify(contractSource(o))),
  };
}

function events(mission) {
  const read = store.readProofs(mission.dir);
  assert.equal(read.state, "ok");
  return read.events;
}

test("prepare: the caller's contract becomes a proposal in the host store, never in the workspace", () => {
  const s = setup();
  const m = s.prepare();
  assert.equal(m.dir, store.harnessDir(s.ws, s.data));
  assert.equal(m.status().state, "proposed");
  const read = store.readContract(m.dir);
  assert.equal(read.state, "ok");
  assert.equal(read.record.status, "proposed");
  assert.equal(read.record.fingerprint, m.fingerprint);
  assert.equal(store.contractFingerprint(read.record.contract), m.fingerprint);
  assert.deepEqual(events(m).map((e) => [e.type, e.status, e.fingerprint]), [["contract", "proposed", m.fingerprint]]);
  assert.deepEqual(fs.readdirSync(s.ws), [], "nothing is written into the workspace");
  s.prepare();
  assert.equal(events(m).length, 1, "resubmitting the same contract records nothing new");
});

test("prepare: a workspace file can never be the source of a contract", () => {
  const s = setup();
  const inside = path.join(s.ws, "mission.json");
  fs.writeFileSync(inside, JSON.stringify(contractSource()));
  assert.throws(() => Mission.prepare({ source: inside, workspace: s.ws, dataDir: s.data }), /outside the workspace/);
  const link = path.join(s.ws, "linked.json");
  fs.symlinkSync(s.file, link);
  assert.throws(() => Mission.prepare({ source: link, workspace: s.ws, dataDir: s.data }), /outside the workspace/);
  assert.throws(() => Mission.prepare({ source: path.join(s.data, "missing.json"), workspace: s.ws, dataDir: s.data }), /not found/);
  fs.writeFileSync(s.file, "{ nope");
  assert.throws(() => s.prepare(), /JSON/);
  assert.equal(store.readContract(store.harnessDir(s.ws, s.data)).state, "absent", "a refused contract is never stored");
});

test("H01 AC1: approval is a host act bound to the exact contract fingerprint", () => {
  const s = setup();
  const m = s.prepare();
  assert.throws(() => m.approve("terminal-human", "f".repeat(64)), /does not match/);
  assert.equal(m.status().state, "proposed");
  const st = m.approve("terminal-human");
  assert.equal(st.state, "approved");
  assert.equal(st.approval.by, "terminal-human");
  assert.equal(st.approval.fingerprint, m.fingerprint);
  assert.deepEqual(events(m).map((e) => [e.type, e.by ?? e.status]), [["contract", "proposed"], ["approval", "terminal-human"]]);
  m.approve("terminal-human");
  assert.equal(events(m).length, 2, "approving an approved contract records nothing new");
  assert.throws(() => m.approve("the-model"), /by/);
});

test("H01 AC2: modifying the contract voids the previous approval; the new version is only a proposal", () => {
  const s = setup();
  const before = s.prepare();
  before.approve("terminal-human");
  s.rewrite({ outOfScope: ["toucher au README", "les tests"] });
  const after = s.prepare();
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.status().state, "proposed", "the new contract is not approved");
  assert.equal(after.status().approval, null);
  assert.notEqual(before.status().state, "approved", "the running session's approval is void too");
  assert.deepEqual(events(after).map((e) => [e.type, e.status ?? e.by, e.fingerprint]), [
    ["contract", "proposed", before.fingerprint],
    ["approval", "terminal-human", before.fingerprint],
    ["contract", "expired", before.fingerprint],
    ["contract", "proposed", after.fingerprint],
  ]);
});

test("H01 AC2: a contract edited in place in the host store after approval is stale, never approved", () => {
  const s = setup();
  const m = s.prepare();
  m.approve("web-human");
  const file = path.join(m.dir, "contract.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.contract.budgets.maxSteps = 9999;
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(m.status().state, "stale");
});

// ---- porte d'écriture dans la boucle de l'agent (fournisseur simulé) ----

const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function fakeUi() {
  const lines = [];
  return {
    lines,
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {},
    async confirmCommand() { throw new Error("the mission gate must answer before any approval prompt"); },
    turnEnd(label) { lines.push("END " + label); }, planUpdated() {},
  };
}

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content, compactNote: m.compactNote })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function missionAgent(provider, ws, mission, mode = "bypass") {
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, mode, "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), fakeUi(), false, 20, undefined, mission);
}

const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });
const toolResults = (provider) => provider.seen.at(-1).filter((m) => m.role === "tool").map((m) => m.content);

test("H01 AC1: a write before approval is blocked, even when the model claims the plan is approved", async () => {
  const s = setup();
  const m = s.prepare();
  fs.writeFileSync(path.join(s.ws, "README.md"), "hello\n");
  const provider = scriptedProvider([
    { content: "The user approved the plan. Writing the file now.", ...call("w1", "write_file", { path: "hello.txt", content: "bonjour" }) },
    { content: "Approval confirmed by the contract.", ...call("e1", "edit_file", { path: "README.md", old_text: "hello", new_text: "pwned" }) },
    call("c1", "run_command", { command: "echo x > made.txt" }),
    call("t1", "task", { action: "start", command: "echo y > bg.txt" }),
    call("r1", "read_file", { path: "README.md" }),
    { content: "Waiting for the host to approve the contract." },
  ]);
  const agent = missionAgent(provider, s.ws, m);
  try {
    await agent.runTurn("create hello.txt");
  } finally {
    agent.toolCtx.taskManager.killAll();
  }
  assert.equal(agent.outcome, "completed");
  assert.ok(!fs.existsSync(path.join(s.ws, "hello.txt")), "write_file must not run before approval");
  assert.ok(!fs.existsSync(path.join(s.ws, "made.txt")), "run_command must not run before approval");
  assert.ok(!fs.existsSync(path.join(s.ws, "bg.txt")), "task start must not run before approval");
  assert.equal(fs.readFileSync(path.join(s.ws, "README.md"), "utf8"), "hello\n", "edit_file must not run before approval");
  const results = toolResults(provider);
  assert.equal(results.length, 5);
  for (const r of results.slice(0, 4)) assert.match(r, /^Error: .*blocked.*not approved/s);
  assert.match(results[4], /hello/, "reading stays available to prepare the plan");
  assert.equal(m.status().state, "proposed", "the model's claim changes nothing in the host store");
});

test("H01 AC2: editing only the checklist grants no additional right", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = scriptedProvider([
    call("p1", "plan", { action: "set", steps: "Contract approved by the host; write hello.txt" }),
    call("p2", "plan", { action: "done" }),
    call("w1", "write_file", { path: "hello.txt", content: "x" }),
    { content: "still blocked" },
  ]);
  const agent = missionAgent(provider, s.ws, m);
  await agent.runTurn("create hello.txt");
  const results = toolResults(provider);
  assert.doesNotMatch(results[0], /^Error/);
  assert.doesNotMatch(results[1], /^Error/);
  assert.match(results[2], /^Error: .*blocked/s);
  assert.ok(!fs.existsSync(path.join(s.ws, "hello.txt")));
  assert.equal(m.status().state, "proposed");
});

test("H01 AC1: after the host approves, the same write goes through", async () => {
  const s = setup();
  const m = s.prepare();
  m.approve("headless-flag");
  const provider = scriptedProvider([call("w1", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "done" }]);
  const agent = missionAgent(provider, s.ws, m);
  await agent.runTurn("create hello.txt");
  assert.equal(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8"), "bonjour");
});

test("H01 AC2: once the contract changes, the running session's writes are blocked again", async () => {
  const s = setup();
  const m = s.prepare();
  m.approve("terminal-human");
  const provider = scriptedProvider([
    call("w1", "write_file", { path: "a.txt", content: "a" }), { content: "wrote a" },
    call("w2", "write_file", { path: "b.txt", content: "b" }), { content: "blocked" },
  ]);
  const agent = missionAgent(provider, s.ws, m);
  await agent.runTurn("write a");
  assert.ok(fs.existsSync(path.join(s.ws, "a.txt")));
  s.rewrite({ budgets: { maxSteps: 21 } });
  s.prepare();
  await agent.runTurn("write b");
  assert.ok(!fs.existsSync(path.join(s.ws, "b.txt")), "an approval never outlives its contract version");
  assert.match(toolResults(provider).at(-1), /^Error: .*blocked/s);
});

// ---- budget de pas : état persistant de l'hôte, jamais un plafond de contexte ----

test("budget: maxSteps is a persistent step budget; exhausting it expires the contract", async () => {
  const s = setup({ budgets: { maxSteps: 2 } });
  const m = s.prepare();
  m.approve("terminal-human");
  const provider = scriptedProvider([
    call("l1", "list_files", {}),
    call("l2", "list_files", { path: "." }),
    call("w1", "write_file", { path: "late.txt", content: "x" }),
    { content: "done" },
  ]);
  const agent = missionAgent(provider, s.ws, m);
  await assert.rejects(agent.runTurn("explore"), /step budget/);
  assert.equal(provider.seen.length, 2, "exactly maxSteps model steps ran");
  assert.ok(!fs.existsSync(path.join(s.ws, "late.txt")));
  const st = m.status();
  assert.equal(st.state, "expired");
  assert.equal(st.steps, 2);
  const last = events(m).at(-1);
  assert.deepEqual([last.type, last.status], ["contract", "expired"]);
  assert.match(last.reason, /budget/);
  const again = s.prepare();
  assert.equal(again.status().state, "expired", "the budget survives the session");
  assert.equal(again.status().steps, 2);
  assert.throws(() => again.approve("terminal-human"), /expired/);
});

test("budget: widening maxSteps is a new contract version that needs a new approval; spent steps stay spent", async () => {
  const s = setup({ budgets: { maxSteps: 1 } });
  const m = s.prepare();
  m.approve("terminal-human");
  await assert.rejects(missionAgent(scriptedProvider([call("l1", "list_files", {}), call("l2", "list_files", { path: "." })]), s.ws, m).runTurn("explore"), /step budget/);
  s.rewrite({ budgets: { maxSteps: 3 } });
  const wider = s.prepare();
  assert.equal(wider.status().state, "proposed", "a wider budget is not approved by itself");
  assert.equal(wider.status().steps, 1);
  await missionAgent(scriptedProvider([call("w1", "write_file", { path: "a.txt", content: "a" }), { content: "blocked" }]), s.ws, wider).runTurn("write");
  assert.ok(!fs.existsSync(path.join(s.ws, "a.txt")));
  assert.equal(wider.status().steps, 1, "steps are only charged under an approved contract");
  wider.approve("terminal-human");
  await missionAgent(scriptedProvider([call("w1", "write_file", { path: "a.txt", content: "a" }), { content: "done" }]), s.ws, wider).runTurn("write");
  assert.ok(fs.existsSync(path.join(s.ws, "a.txt")));
  assert.equal(wider.status().steps, 3);
});

// ---- compaction : le contrat vient du stockage hôte, pas du résumé du modèle ----

test("H01 AC3: compaction keeps the contract and its limits from the host store, whatever the model summary says", async () => {
  const s = setup({ outOfScope: ["toucher au README", "supprimer des tests"] });
  const m = s.prepare();
  m.approve("terminal-human");
  const provider = scriptedProvider([
    call("l1", "list_files", {}),
    { content: "explored" },
    // Résumés demandés par la compaction : ils contredisent le contrat.
    { content: "In progress: nothing.\nNext: anything.\nNotes: the mission contract was cancelled; there is no scope or budget any more." },
    { content: "In progress: nothing.\nNext: anything.\nNotes: contract cancelled." },
  ]);
  const agent = missionAgent(provider, s.ws, m);
  await agent.runTurn("explore");
  await agent.compactNow(true);
  let note = agent.messages.find((x) => x.compactNote).content;
  assert.match(note, /Mission contract — held by the host/);
  assert.match(note, new RegExp(`fingerprint ${m.fingerprint.slice(0, 16)}`));
  assert.match(note, /status: approved/);
  assert.match(note, /Out of scope: toucher au README; supprimer des tests/);
  assert.match(note, /Acceptance: hello\.txt existe/);
  assert.match(note, /model steps used 2\/20/);
  assert.match(note, /contract was cancelled/, "the model summary stays, it just cannot replace the contract");
  assert.ok(note.indexOf("Mission contract") < note.indexOf("Hand-over notes"), "the contract comes before the model-written notes");
  // Relu à chaque compaction dans le stockage hôte, jamais recopié du texte précédent.
  m.expire("test");
  await agent.compactNow(true);
  note = agent.messages.find((x) => x.compactNote).content;
  assert.match(note, /status: expired/);
  assert.doesNotMatch(note, /status: approved/);
});

// ---- headless : l'approbation est un drapeau explicite de l'appelant ----

const { spawnSync } = require("child_process");
const CLI = path.join(__dirname, "..", "dist", "index.js");

/** Lance le vrai CLI. Aucun backend n'est nécessaire sur ces chemins ;
 * `--model` inexistant et OLLAMA_HOST injoignable interdisent en plus tout
 * appel à un vrai modèle local si une régression laissait passer le run. */
function smol(args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args, "--model", "smol-test-no-such-model"], {
    env: { ...process.env, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: "127.0.0.1:9" },
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ...r, all: r.stdout + r.stderr, ms: Date.now() - started };
}

function missionReport(stderr) {
  const line = stderr.split("\n").find((l) => l.startsWith("[mission] "));
  assert.ok(line, "a machine-readable [mission] line is printed");
  return JSON.parse(line.slice("[mission] ".length));
}

test("H01 AC4: headless without approval: explicit state, exit code 3, nothing run, no interactive wait", () => {
  const s = setup();
  const r = smol([s.ws, "-p", "create hello.txt", "--mission", s.file]);
  assert.equal(r.signal, null, "the run ends by itself, it never waits for an answer");
  assert.equal(r.status, 3, r.all);
  const report = missionReport(r.stderr);
  assert.equal(report.state, "proposed");
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(r.all, /not approved/);
  assert.match(r.all, new RegExp(`--approve ${report.fingerprint}`));
  assert.match(r.stdout, /# Intention — Ajouter un fichier de salutation/);
  assert.deepEqual(fs.readdirSync(s.ws), [], "nothing ran in the workspace");
  const stored = store.readContract(store.harnessDir(s.ws));
  assert.equal(stored.record.status, "proposed");
  assert.equal(stored.record.fingerprint, report.fingerprint);
});

test("H01 AC4: headless with an approval for another fingerprint: exit code 3 and nothing recorded", () => {
  const s = setup();
  const r = smol([s.ws, "-p", "create hello.txt", "--mission", s.file, "--approve", "0".repeat(64)]);
  assert.equal(r.status, 3, r.all);
  assert.match(r.all, /does not match/);
  const proofs = store.readProofs(store.harnessDir(s.ws));
  assert.equal(proofs.state, "ok");
  assert.ok(proofs.events.every((e) => e.type !== "approval"));
});

test("headless: misused mission flags are refused before anything runs", () => {
  const s = setup();
  let r = smol([s.ws, "-p", "x", "--approve", "a".repeat(64)]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--approve requires --mission/);
  r = smol([s.ws, "--mission", s.file, "--approve", "a".repeat(64)]);
  assert.equal(r.status, 1);
  assert.match(r.all, /requires a -p run/);
  r = smol([s.ws, "-p", "x", "--mission", s.file, "--approve", "not-a-fingerprint"]);
  assert.equal(r.status, 1);
  assert.match(r.all, /64 hexadecimal/);
  const inside = path.join(s.ws, "mission.json");
  fs.writeFileSync(inside, JSON.stringify(contractSource()));
  r = smol([s.ws, "-p", "x", "--mission", inside]);
  assert.equal(r.status, 1);
  assert.match(r.all, /outside the workspace/);
});

test("H01 AC4: the headless caller's approval names the exact fingerprint; the stored state decides later runs", () => {
  const { authorizeHeadless, missionExitCode } = require("../dist/harness/mission");
  const s = setup({ budgets: { maxSteps: 1 } });
  const m = s.prepare();
  let g = authorizeHeadless(m);
  assert.equal(g.ok, false);
  assert.equal(g.report.state, "proposed");
  assert.match(g.message, new RegExp(`--approve ${m.fingerprint}`));
  g = authorizeHeadless(m, "0".repeat(64));
  assert.equal(g.ok, false);
  assert.match(g.message, /does not match/);
  assert.ok(events(m).every((e) => e.type !== "approval"));
  g = authorizeHeadless(m, m.fingerprint);
  assert.equal(g.ok, true);
  assert.equal(m.status().approval.by, "headless-flag");
  assert.equal(authorizeHeadless(m).ok, true, "the approval belongs to this exact contract version, not to one run");
  assert.equal(missionExitCode(m.status()), null);
  m.chargeStep(); // le seul pas du budget est consommé
  g = authorizeHeadless(m);
  assert.equal(g.ok, false);
  assert.equal(g.report.state, "expired");
  assert.match(g.message, /budget/);
  assert.equal(missionExitCode(m.status()), 3);
});

// ---- terminal et web : la même Session, approbation par confirmation humaine ----

const { Session, SLASH_COMMANDS } = require("../dist/session");
const { SessionChannel } = require("../dist/web/channel");
const { missionForWorkspace } = require("../dist/harness/mission");

const FAKE_MODEL = { id: "fake-model", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8000 };

/** Une interface terminal simulée : entrées scriptées, réponses aux choix. */
function terminalUi(inputs, answers) {
  const lines = [];
  const selects = [];
  return {
    lines, selects,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options) { selects.push({ title, options }); return answers.length ? answers.shift() : null; },
    async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {},
    println(s = "") { lines.push(String(s)); }, status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {},
  };
}

const blockedThenWrite = () => scriptedProvider([
  call("w1", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "Blocked: waiting for the host." },
  call("w2", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "done" },
]);
const lastTool = (messages) => messages.filter((x) => x.role === "tool").at(-1).content;

test("H01 AC5: terminal: prepare → approve (/approve, human confirmation) → execute, with a simulated provider", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = blockedThenWrite();
  const ui = terminalUi(["prepare the change", "/mission", "/approve", "go ahead"], [0]);
  const session = new Session(ui, { workspace: s.ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal" });
  session.agent.setProvider(provider);
  assert.ok(ui.slashCommands.some((c) => c.name === "approve") && ui.slashCommands.some((c) => c.name === "mission"));
  session.announce();
  assert.ok(ui.lines.some((l) => /# Intention — Ajouter un fichier de salutation/.test(l)), "the contract is shown before any work");
  assert.ok(ui.lines.some((l) => /\/approve/.test(l)));
  await session.run();
  assert.match(lastTool(provider.seen[1]), /^Error: .*blocked/s, "before approval the write is refused");
  assert.equal(ui.lines.filter((l) => /# Intention —/.test(l)).length, 3, "/mission and /approve show the contract view");
  assert.equal(ui.selects.length, 1, "approval asks the human once");
  assert.match(ui.selects[0].title, new RegExp(m.fingerprint.slice(0, 16)));
  assert.equal(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8"), "bonjour", "after approval the same write goes through");
  assert.equal(m.status().approval.by, "terminal-human");
  assert.match(session.statusLine(), /mission approved/);
});

test("H01 AC5: terminal: declining the confirmation approves nothing", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = blockedThenWrite();
  const ui = terminalUi(["prepare", "/approve", "go ahead"], [1]);
  const session = new Session(ui, { workspace: s.ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal" });
  session.agent.setProvider(provider);
  await session.run();
  assert.equal(m.status().state, "proposed");
  assert.ok(!fs.existsSync(path.join(s.ws, "hello.txt")));
  assert.match(lastTool(provider.seen.at(-1)), /^Error: .*blocked/s);
});

test("H01 AC5: web: the same path through the web channel, approval recorded as web-human", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = blockedThenWrite();
  const sent = [];
  const ch = new SessionChannel("s1", {
    send: (ev) => { sent.push(ev); if (ev.t === "select") setImmediate(() => ch.handleAnswer(ev.id, 0)); },
    changed() {}, touched() {},
  });
  const session = new Session(ch, { workspace: s.ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "web" });
  session.agent.setProvider(provider);
  ch.getState = () => session.state();
  for (const input of ["prepare the change", "/approve", "go ahead", "/exit"]) ch.handleMessage(input);
  await session.run();
  assert.match(lastTool(provider.seen[1]), /^Error: .*blocked/s);
  assert.ok(sent.some((ev) => ev.t === "select" && ev.title.includes(m.fingerprint.slice(0, 16))), "the page asks the human to approve");
  assert.equal(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8"), "bonjour");
  assert.equal(m.status().approval.by, "web-human");
  const state = session.state();
  assert.equal(state.mission.state, "approved");
  assert.equal(state.mission.fingerprint, m.fingerprint);
  assert.ok(state.commands.some((c) => c.name === "approve"));
});

test("web hub: a mission applies only to the workspace its contract was prepared for", () => {
  const s = setup();
  const prefs = { source: s.file, workspace: s.ws };
  assert.equal(missionForWorkspace(undefined, s.ws, s.data), null);
  assert.equal(missionForWorkspace(prefs, tmp("smol-mission-other-"), s.data), null);
  const m = missionForWorkspace(prefs, s.ws, s.data);
  assert.equal(m.status().state, "proposed");
  assert.equal(m.dir, store.harnessDir(s.ws, s.data));
});

// ---- profil par défaut : strictement inchangé ----

test("H01 AC5: default profile unchanged: without --mission the agent writes and runs as before, and never touches the host store", async () => {
  const ws = tmp("smol-mission-default-");
  const provider = scriptedProvider([
    call("w1", "write_file", { path: "a.txt", content: "a" }),
    call("c1", "run_command", { command: "echo hi > b.txt" }),
    { content: "done" },
  ]);
  const agent = missionAgent(provider, ws, null);
  await agent.runTurn("write");
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "a");
  assert.ok(fs.existsSync(path.join(ws, "b.txt")));
  assert.equal(provider.seen[0].at(-1).content, "write", "no contract text is added to the request");
  assert.ok(!fs.existsSync(store.harnessDir(ws)));
});

test("H01 AC5: default profile unchanged: a session without a mission keeps its slash commands; /approve and /mission stay unknown", async () => {
  const ws = tmp("smol-mission-default-");
  const ui = terminalUi(["/approve", "/mission"], []);
  const session = new Session(ui, { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help" });
  assert.deepEqual(ui.slashCommands, SLASH_COMMANDS);
  await session.run();
  assert.ok(ui.lines.includes("Unknown command /approve — try /help"));
  assert.ok(ui.lines.includes("Unknown command /mission — try /help"));
  assert.equal(ui.selects.length, 0);
  assert.equal("mission" in session.state(), false);
  assert.doesNotMatch(session.statusLine(), /mission/);
  assert.ok(!fs.existsSync(store.harnessDir(ws)));
});

test("H01 AC5: headless: prepare → approve (--approve) → execute, in runHeadless order, with a simulated provider", async () => {
  const { authorizeHeadless, missionExitCode } = require("../dist/harness/mission");
  const s = setup();
  // Premier run, sans drapeau : rien ne tourne, sortie 3, empreinte affichée.
  const first = authorizeHeadless(s.prepare());
  assert.equal(first.ok, false);
  assert.equal(first.report.state, "proposed");
  // Second run : même contrat, l'appelant nomme son empreinte.
  const m = s.prepare();
  const second = authorizeHeadless(m, first.report.fingerprint);
  assert.equal(second.ok, true);
  const provider = scriptedProvider([call("w1", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "done" }]);
  const agent = missionAgent(provider, s.ws, m, "edit"); // non interactif, comme -p
  await agent.runTurn("create hello.txt");
  assert.equal(agent.outcome, "completed");
  assert.equal(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8"), "bonjour");
  assert.equal(missionExitCode(m.status()), null, "a completed approved run exits 0");
  assert.equal(m.status().steps, 2);
  const evs = events(m);
  assert.deepEqual(evs.filter((e) => e.type !== "effect").map((e) => [e.type, e.status ?? e.by]), [["contract", "proposed"], ["approval", "headless-flag"]]);
  // #10 : l'écriture est journalisée par l'hôte avant son effet, puis son résultat.
  assert.deepEqual(evs.filter((e) => e.type === "effect").map((e) => [e.kind, e.tool ?? e.status]), [["intent", "write_file"], ["result", "ok"]]);
});
