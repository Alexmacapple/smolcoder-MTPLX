// Plan d'implémentation approuvé avec le contrat (ticket #29, H08), sous le
// profil mission : le plan structuré que l'agent propose avant approbation,
// l'approbation liée aux deux empreintes, le plan facultatif par défaut ou
// exigé par le contrat. Fournisseur simulé, faux dossier personnel (ni le vrai
// ~/.smolcoder, ni ~/.npm), aucun MTPLX. Les noms « H08 ACn » renvoient aux
// critères d'acceptation du ticket ; le parcours headless en deux runs du vrai
// binaire est prouvé par test/os/e2e.os.test.js (« H08 OS »).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "smol-h08-home-")));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const mission = require("../dist/harness/mission");
const { Mission, authorizeHeadless, missionReport } = mission;
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { buildToolSpecs, executeTool } = require("../dist/tools/index");
const { Session } = require("../dist/session");
const { SessionChannel } = require("../dist/web/channel");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function contractSource(overrides = {}) {
  return {
    schema: "smolcoder/contract/v1",
    id: "greeting",
    title: "Ajouter un fichier de salutation",
    problem: "Le projet n'a pas de fichier de salutation.",
    outcome: "hello.txt contient une salutation.",
    acceptance: ["hello.txt existe", "hello.txt dit bonjour", "le README n'a pas changé"],
    budgets: { maxSteps: 40 },
    ...overrides,
  };
}

function setup(overrides = {}) {
  const ws = tmp("smol-h08-ws-");
  const file = path.join(tmp("smol-h08-src-"), "contract.json");
  const data = tmp("smol-h08-data-");
  fs.writeFileSync(file, JSON.stringify(contractSource(overrides)));
  return { ws, file, data, prepare: () => Mission.prepare({ source: file, workspace: ws, dataDir: data }) };
}

function events(m) {
  const read = store.readProofs(m.dir);
  assert.equal(read.state, "ok", JSON.stringify(read));
  return read.events;
}

/** Le plan que proposera le modèle simulé, tel que l'outil le reçoit. */
const PROPOSAL = {
  action: "propose",
  steps: "write hello.txt\nread it back",
  files: "hello.txt",
  risks: "none beyond the contract",
  proofs: "1: hello.txt is listed by list_files\n2: read_file hello.txt shows bonjour\n3: git diff shows no README change",
};
/** Le même plan, sous sa forme stockée. */
const CONTENT = {
  steps: ["write hello.txt", "read it back"],
  files: ["hello.txt"],
  risks: ["none beyond the contract"],
  proofs: [
    { criterion: 1, proof: "hello.txt is listed by list_files" },
    { criterion: 2, proof: "read_file hello.txt shows bonjour" },
    { criterion: 3, proof: "git diff shows no README change" },
  ],
};

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 16000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools) {
      seen.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), tools });
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}
const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });
const toolResults = (provider, n = -1) => provider.seen.at(n).messages.filter((m) => m.role === "tool").map((m) => m.content);

function terminalUi(inputs, answers) {
  const lines = [];
  const selects = [];
  return {
    lines, selects,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select(title, options) { selects.push({ title, options, at: lines.length }); return answers.length ? answers.shift() : null; },
    async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {},
    println(s = "") { lines.push(String(s)); }, status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {},
  };
}

const FAKE_MODEL = { id: "fake-model", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 16000 };

function session(ui, m, surface = "terminal") {
  return new Session(ui, { workspace: m.workspace, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface });
}

// ---- H08 AC1 : plan proposé avant approbation, affiché avec le contrat ----

test("H08 AC1 (terminal): the plan the agent proposes before approval is shown with the contract by /approve, and the approval event carries its fingerprint", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = scriptedProvider([
    call("l1", "list_files", {}),
    call("p1", "plan", PROPOSAL),
    { content: "Plan proposed; waiting for the host." },
    call("w1", "write_file", { path: "hello.txt", content: "bonjour" }),
    { content: "done" },
  ]);
  const ui = terminalUi(["prepare a plan", "/approve", "go ahead"], [0]);
  const sess = session(ui, m);
  sess.agent.setProvider(provider);
  // Sous --mission, l'outil plan sait proposer ; le reste de ses actions ne change pas.
  const spec = sess.agent.tools.find((t) => t.name === "plan");
  assert.ok(spec.parameters.properties.action.enum.includes("propose"));
  for (const k of ["files", "risks", "proofs", "reason"]) assert.ok(spec.parameters.properties[k], k);
  await sess.run();

  const proposed = events(m).filter((e) => e.type === "plan");
  assert.equal(proposed.length, 1, "one proposal in the host journal");
  assert.equal(proposed[0].kind, "proposed");
  assert.equal(proposed[0].fingerprint, m.fingerprint, "bound to the contract version");
  assert.deepEqual(proposed[0].content, CONTENT);
  const planFp = store.planFingerprint(m.fingerprint, CONTENT);
  assert.equal(proposed[0].plan, planFp);
  assert.match(toolResults(provider, 2).at(-1), new RegExp(`^Plan proposed \\(fingerprint ${planFp.slice(0, 16)}`));

  // /approve montre le contrat, puis le plan, puis demande une seule fois.
  assert.equal(ui.selects.length, 1);
  const shown = ui.lines.slice(0, ui.selects[0].at);
  const contractAt = shown.findIndex((l) => /# Intention — Ajouter un fichier de salutation/.test(l));
  const planAt = shown.findIndex((l) => /## Plan d'implémentation — proposé/.test(l));
  assert.ok(contractAt >= 0 && planAt > contractAt, "the contract, then the plan, before the question");
  for (const x of ["write hello.txt", "`hello.txt`", "none beyond the contract", "read_file hello.txt shows bonjour", planFp]) assert.ok(shown[planAt].includes(x), x);
  assert.match(ui.selects[0].title, new RegExp(`${m.fingerprint.slice(0, 16)}.*plan ${planFp.slice(0, 16)}`));
  assert.equal(ui.selects[0].options[0].label, "Approve contract and plan");

  const approval = events(m).find((e) => e.type === "approval");
  assert.equal(approval.plan, planFp, "the approval event carries the plan fingerprint");
  assert.equal(approval.fingerprint, m.fingerprint);
  assert.equal(approval.by, "terminal-human");
  assert.equal(store.readContract(m.dir).record.approval.plan, planFp, "contract.json keeps it with the approval");
  assert.equal(m.planView().state, "approved");
  assert.equal(fs.readFileSync(path.join(s.ws, "hello.txt"), "utf8"), "bonjour", "after approval the planned write goes through");
  assert.ok(!fs.readdirSync(s.ws).some((f) => /plan/i.test(f)), "nothing about the plan is written into the workspace");
});

test("H08 AC1 (web): the same proposal and approval through the web channel, recorded as web-human", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = scriptedProvider([call("p1", "plan", PROPOSAL), { content: "proposed" }]);
  const sent = [];
  const ch = new SessionChannel("s1", {
    send: (ev) => { sent.push(ev); if (ev.t === "select") setImmediate(() => ch.handleAnswer(ev.id, 0)); },
    changed() {}, touched() {},
  });
  const sess = session(ch, m, "web");
  sess.agent.setProvider(provider);
  ch.getState = () => sess.state();
  for (const input of ["prepare a plan", "/approve", "/exit"]) ch.handleMessage(input);
  await sess.run();
  const planFp = store.planFingerprint(m.fingerprint, CONTENT);
  const texts = sent.filter((ev) => ev.t === "line").map((ev) => ev.s).join("\n");
  assert.match(texts, /# Intention —/);
  assert.match(texts, new RegExp(`## Plan d'implémentation — proposé[\\s\\S]*${planFp}`));
  assert.ok(sent.some((ev) => ev.t === "select" && ev.title.includes(planFp.slice(0, 16))), "the page asks to approve the contract and this plan");
  const approval = events(m).find((e) => e.type === "approval");
  assert.equal(approval.by, "web-human");
  assert.equal(approval.plan, planFp);
});

const CLI = path.join(__dirname, "..", "dist", "index.js");
function smol(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--model", "smol-test-no-such-model"], {
    env: { ...process.env, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: "127.0.0.1:9" },
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ...r, all: r.stdout + r.stderr };
}
function tagged(stderr, tag = "mission") {
  const line = stderr.split("\n").find((l) => l.startsWith(`[${tag}] `));
  assert.ok(line, `a [${tag}] line is printed\n${stderr}`);
  return JSON.parse(line.slice(tag.length + 3));
}

test("H08 AC1 (headless): the proposed plan is shown with the contract and named in the [mission] line; --approve-plan names its exact fingerprint, and the approval event carries it", () => {
  const s = setup();
  const m = Mission.prepare({ source: s.file, workspace: s.ws }); // le stockage du faux dossier personnel, relu par le CLI
  // Proposé par un run --propose-plan précédent (bout en bout : « H08 OS »).
  const { fingerprint: planFp } = m.proposePlan(CONTENT);
  assert.equal(planFp, store.planFingerprint(m.fingerprint, CONTENT));

  let r = smol([s.ws, "-p", "create hello.txt", "--mission", s.file]);
  assert.equal(r.status, 3, r.all);
  assert.match(r.stdout, /# Intention — Ajouter un fichier de salutation/);
  assert.match(r.stdout, new RegExp(`## Plan d'implémentation — proposé[\\s\\S]*${planFp}`));
  let report = tagged(r.stderr);
  assert.equal(report.plan.state, "proposed");
  assert.equal(report.plan.fingerprint, planFp);
  assert.match(r.all, new RegExp(`--approve ${m.fingerprint} --approve-plan ${planFp}`));

  r = smol([s.ws, "-p", "create hello.txt", "--mission", s.file, "--approve", m.fingerprint, "--approve-plan", "0".repeat(64)]);
  assert.equal(r.status, 3, r.all);
  assert.match(r.all, /plan fingerprint 0{16}… does not match the proposed plan/);
  assert.ok(events(m).every((e) => e.type !== "approval"), "a wrong plan fingerprint approves nothing, not even the contract");

  const g = authorizeHeadless(m, m.fingerprint, { approvePlan: planFp });
  assert.equal(g.ok, true, g.message);
  assert.match(g.message, new RegExp(`plan ${planFp.slice(0, 16)}`));
  const approval = events(m).find((e) => e.type === "approval");
  assert.equal(approval.by, "headless-flag");
  assert.equal(approval.plan, planFp);
  assert.equal(g.report.plan.state, "approved");
});

test("H08 headless flags: --approve-plan and --propose-plan are refused when misused, before anything runs", () => {
  const s = setup();
  let r = smol([s.ws, "-p", "x", "--mission", s.file, "--approve-plan", "a".repeat(64)]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--approve-plan approves the proposed plan together with the contract/);
  r = smol([s.ws, "-p", "x", "--mission", s.file, "--approve", "a".repeat(64), "--approve-plan", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--approve-plan needs the plan fingerprint: 64 hexadecimal/);
  r = smol([s.ws, "-p", "x", "--propose-plan"]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--propose-plan is a headless preparation run: it requires -p and --mission/);
  r = smol([s.ws, "-p", "x", "--mission", s.file, "--propose-plan", "--approve", "a".repeat(64)]);
  assert.equal(r.status, 1);
  assert.match(r.all, /never in the same run/);
  r = smol([s.ws, "-p", "x", "--mission", s.file, "--propose-plan", "--verify", "true"]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--propose-plan runs read-only/);
  assert.equal(store.readContract(store.harnessDir(s.ws)).state, "absent", "a refused flag prepares nothing");
});

test("H08 --propose-plan: only a proposed contract can get a plan proposal run; the run is read-only and checks nothing", () => {
  const s = setup();
  const m = s.prepare();
  let g = mission.authorizeProposal(m);
  assert.equal(g.ok, true, g.message);
  assert.match(mission.proposalInstruction(), /"action":"propose"/);
  m.approve("terminal-human");
  g = mission.authorizeProposal(m);
  assert.equal(g.ok, false);
  assert.match(g.message, /already approved/);
});

// ---- H08 AC2 : critère sans preuve prévue signalé avant approbation ----

test("H08 AC2: an acceptance criterion with no planned proof is signalled before approval — to the model, at /approve and in the headless [mission] line; a criterion a host check covers needs none", async () => {
  const s = setup({ checks: [{ command: "test -f hello.txt", covers: [1] }] });
  const m = s.prepare();
  const provider = scriptedProvider([
    // Critère 1 : couvert par un contrôle de l'hôte, rien à déclarer. Critère 3 : oublié.
    call("p1", "plan", { ...PROPOSAL, proofs: "2: read_file hello.txt shows bonjour" }),
    { content: "proposed" },
  ]);
  const ui = terminalUi(["prepare a plan", "/approve"], [null]);
  const sess = session(ui, m);
  sess.agent.setProvider(provider);
  await sess.run();

  const result = toolResults(provider).at(-1);
  assert.match(result, /1\. host check \(run by the host\)/);
  assert.match(result, /2\. planned: read_file hello\.txt shows bonjour/);
  assert.match(result, /3\. NO PLANNED PROOF/);
  assert.deepEqual(m.missingProofs(), [3]);

  const before = ui.lines.slice(0, ui.selects[0].at);
  const view = before.find((l) => /## Plan d'implémentation/.test(l));
  assert.match(view, /1\. hello\.txt existe — contrôle de l'hôte : `test -f hello\.txt`/);
  assert.match(view, /2\. hello\.txt dit bonjour — preuve prévue : read_file hello\.txt shows bonjour/);
  assert.match(view, /3\. le README n'a pas changé — \*\*aucune preuve prévue\*\*/);
  assert.ok(before.includes("· acceptance criteria without a planned proof: 3 — the plan does not say how they will be proven"), "the human is warned before the question");
  assert.equal(m.status().state, "proposed", "a signal, not a refusal: the human still decides (here: declined)");

  const report = missionReport(m);
  assert.deepEqual(report.plan.missingProofs, [3]);
  assert.deepEqual(authorizeHeadless(m).report.plan.missingProofs, [3]);
});

test("H08 AC2: the planned proofs keep the vocabulary of #9 — criteria numbered as in the contract, unknown or repeated numbers refused with a coaching error", async () => {
  const s = setup();
  const m = s.prepare();
  const provider = scriptedProvider([
    call("p1", "plan", { ...PROPOSAL, proofs: "4: nothing" }),
    call("p2", "plan", { ...PROPOSAL, proofs: "2: a\n2: b" }),
    call("p3", "plan", { ...PROPOSAL, proofs: "the tests pass" }),
    call("p4", "plan", { ...PROPOSAL, files: "../outside.txt" }),
    call("p5", "plan", { ...PROPOSAL, files: "" }),
    { content: "gave up" },
  ]);
  const ui = terminalUi(["prepare a plan"], []);
  const sess = session(ui, m);
  sess.agent.setProvider(provider);
  await sess.run();
  const results = toolResults(provider);
  assert.match(results[0], /^Error: .*criterion 4.*the contract has 3/s);
  assert.match(results[1], /^Error: .*criterion 2.*twice/s);
  assert.match(results[2], /^Error: .*"N: proof"/s);
  assert.match(results[3], /^Error: .*outside\.txt/s);
  assert.match(results[4], /^Error: .*at least one file/s);
  assert.ok(events(m).every((e) => e.type !== "plan"), "a refused proposal is never recorded");
});

// ---- plan facultatif par défaut, exigible par le contrat ----

test("H08 decision: the plan is optional by default; a contract field (\"plan\": \"required\") makes it mandatory for approval, on every surface", async () => {
  // Le champ absent n'entre pas dans l'empreinte : les contrats existants gardent la leur.
  const ws = tmp("smol-h08-fp-");
  const base = store.parseContractSource(contractSource(), ws);
  assert.equal("plan" in base, false);
  const required = store.parseContractSource(contractSource({ plan: "required" }), ws);
  assert.equal(required.plan, "required");
  assert.notEqual(store.contractFingerprint(required), store.contractFingerprint(base));
  assert.throws(() => store.parseContractSource(contractSource({ plan: "optional" }), ws), /field "plan" must be "required"/);

  const s = setup({ plan: "required" });
  const m = s.prepare();
  assert.throws(() => m.approve("terminal-human"), /requires an implementation plan approved with it/);
  let g = authorizeHeadless(m, m.fingerprint);
  assert.equal(g.ok, false);
  assert.match(g.message, /--propose-plan/);
  assert.equal(g.report.plan.required, true);
  assert.equal(g.report.plan.state, "none");
  assert.match(m.modelBlock(), /the host requires an implementation plan approved with the contract/);

  const ui = terminalUi(["/approve"], [0]);
  const sess = session(ui, m);
  await sess.run();
  assert.equal(ui.selects.length, 0, "nothing to confirm without a plan");
  assert.ok(ui.lines.some((l) => /requires an implementation plan approved with it/.test(l)));
  assert.equal(m.status().state, "proposed");

  const { fingerprint: planFp } = m.proposePlan(CONTENT);
  assert.throws(() => m.approve("terminal-human"), /requires an implementation plan/);
  g = authorizeHeadless(m, m.fingerprint, { approvePlan: planFp });
  assert.equal(g.ok, true, g.message);
  assert.equal(events(m).find((e) => e.type === "approval").plan, planFp);
});

test("H08 decision: an optional plan can be left out at approval — the contract alone is approved, and nothing tracks the plan afterwards", async () => {
  const s = setup();
  const m = s.prepare();
  const { fingerprint: planFp } = m.proposePlan(CONTENT);
  const provider = scriptedProvider([call("p1", "plan", PROPOSAL), { content: "kept my checklist" }]);
  const ui = terminalUi(["/approve", "go"], [1]);
  const sess = session(ui, m);
  sess.agent.setProvider(provider);
  await sess.run();
  assert.deepEqual(ui.selects[0].options.map((o) => o.label), ["Approve contract and plan", "Approve contract only", "Cancel"]);
  const approval = events(m).find((e) => e.type === "approval");
  assert.equal("plan" in approval, false);
  assert.equal(m.planView().state, "none");
  assert.ok(ui.lines.some((l) => l.includes(`the proposed plan ${planFp.slice(0, 16)} was not approved`)));
  // Proposer après une approbation sans plan : refusé, le plan ne s'approuve qu'avec le contrat.
  assert.match(toolResults(provider).at(-1), /^Error: .*already approved without a plan/s);
  assert.throws(() => m.approve("terminal-human", m.fingerprint, { plan: planFp }), /already approved/);
  assert.equal(events(m).filter((e) => e.type === "plan").length, 1, "the refused proposal is not recorded");
});

// ---- H08 AC5 : sans --mission, et sous mission sans plan proposé, rien ne change ----

/** L'outil plan tel qu'il était avant #29 : hors --mission, il n'a pas bougé. */
const PLAN_SPEC_BEFORE = {
  name: "plan",
  description:
    'Plan runnable increments, kept across compaction. Create: {"action":"set","steps":"wire entry point; run build; add movement and test"}. Finish current step: {"action":"done"} (or supply step). Save exact APIs, error and next edit before a long investigation: {"action":"checkpoint","text":"..."} (max 1000 chars, replaces current step notes). Append: {"action":"add","text":"..."}. Show: {"action":"show"}.',
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "done", "add", "show", "checkpoint"] },
      steps: { type: "string", description: 'The steps, one per line; semicolon lists also accepted (only for "set")' },
      step: { type: "number", description: 'Step number to mark done (optional, for "done")' },
      text: { type: "string", description: 'Step to append or working checkpoint' },
    },
    required: ["action"],
  },
};

test("H08 AC5: without --mission, the plan tool, its schema and its answers are exactly those before #29", async () => {
  for (const mode of ["ro", "edit", "bypass"]) {
    assert.deepEqual(buildToolSpecs(mode).find((t) => t.name === "plan"), PLAN_SPEC_BEFORE, mode);
  }
  const plan = new Plan();
  const ctx = { workspace: tmp("smol-h08-nomission-"), plan, filesTouched: new Set(), commandsRun: [] };
  assert.equal(await executeTool("plan", PROPOSAL, ctx), 'Error: action must be one of "set", "done", "add", "show", "checkpoint". Example: {"action": "done"}');
  assert.equal(await executeTool("plan", { action: "set", steps: "a\nb" }, ctx), "Plan set (2 steps). Current: 1. a");
  assert.equal(await executeTool("plan", { action: "add", text: "c", files: "x.txt", reason: "r" }, ctx), "Added step 3: c");
  assert.equal(await executeTool("plan", { action: "show" }, ctx), "1.[>] a\n2.[ ] b\n3.[ ] c");
  assert.ok(!plan.details, "no structured plan outside the mission profile");
  const w = await executeTool("write_file", { path: "free.txt", content: "x" }, ctx);
  assert.equal(w, "Created free.txt (1 lines).");
  assert.ok(!fs.existsSync(store.harnessDir(ctx.workspace)), "no host store outside the mission profile");
});

test("H08 AC5: under --mission without a proposed plan — even with a checklist set before approval — approval, journal, contract.json, views, report and [mission] line are exactly those before #29", async () => {
  const s = setup();
  const m = s.prepare();
  const blockBefore = m.modelBlock();
  const markdownBefore = m.markdown();
  const provider = scriptedProvider([
    call("p1", "plan", { action: "set", steps: "write hello.txt\ncheck it" }),
    { content: "checklist set" },
    // La relance « étapes non finies » d'avant #29 : inchangée elle aussi.
    { content: "waiting for the host" },
    call("w1", "write_file", { path: "hello.txt", content: "bonjour" }),
    call("w2", "write_file", { path: "other.txt", content: "x" }),
    call("p2", "plan", { action: "add", text: "one more" }),
    { content: "done" },
  ]);
  const ui = terminalUi(["prepare", "/mission", "/approve", "go ahead", "/mission"], [0]);
  const sess = session(ui, m);
  sess.agent.setProvider(provider);
  await sess.run();

  assert.match(provider.seen[2].messages.at(-1).content, /^\[Your plan still has unfinished steps/);
  assert.equal(ui.selects.length, 1);
  assert.equal(ui.selects[0].title, `Approve mission contract ${m.fingerprint.slice(0, 16)}? Writes and commands are then allowed within 40 model steps.`);
  assert.deepEqual(ui.selects[0].options, [
    { label: "Approve", hint: "record my approval of this exact contract" },
    { label: "Cancel", hint: "keep writes and commands blocked" },
  ]);
  assert.ok(ui.lines.every((l) => !/Plan d'implémentation/.test(l)), "no plan view without a proposed plan");
  const results = toolResults(provider);
  assert.deepEqual(results.slice(-3), ["Created hello.txt (1 lines).", "Created other.txt (1 lines).", "Added step 3: one more"], "no plan note on writes or on the checklist");
  assert.equal(fs.readFileSync(path.join(s.ws, "other.txt"), "utf8"), "x");

  const evs = events(m);
  assert.ok(evs.every((e) => e.type !== "plan"), "no plan event");
  const approval = evs.find((e) => e.type === "approval");
  assert.deepEqual(Object.keys(approval).sort(), ["at", "by", "fingerprint", "schema", "type", "verifiers"]);
  assert.deepEqual(Object.keys(store.readContract(m.dir).record.approval).sort(), ["at", "by", "fingerprint", "verifiers"]);
  assert.doesNotMatch(markdownBefore + m.markdown(), /[Pp]lan/, "the contract view says nothing of a plan");
  assert.equal(blockBefore.includes("Plan:"), false);
  assert.equal(m.modelBlock().includes("Plan:"), false);
  assert.deepEqual(Object.keys(missionReport(m)).sort(), ["approvedBy", "fingerprint", "id", "maxSteps", "policy", "state", "steps", "store"]);
  const report = JSON.parse(fs.readFileSync(path.join(m.dir, "report.json"), "utf8"));
  assert.equal("plan" in report, false);
  assert.doesNotMatch(fs.readFileSync(path.join(m.dir, "report.md"), "utf8"), /Plan d'implémentation/);
  assert.equal(m.planView().state, "none");
});
