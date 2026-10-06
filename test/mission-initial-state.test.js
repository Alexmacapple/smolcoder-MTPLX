const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smol-initial-home-"));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const { Mission } = require("../dist/harness/mission");
const { callerChecks } = require("../dist/harness/proofs");
const {
  observeMissionInitialState,
  unavailableMissionInitialState,
} = require("../dist/harness/initial-state");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");

const made = [HOME];
const tmp = (prefix) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

test.after(() => {
  for (const dir of made.reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(command = "node check.cjs") {
  const workspace = tmp("smol-initial-ws-");
  const source = path.join(tmp("smol-initial-source-"), "contract.json");
  const dataDir = tmp("smol-initial-data-");
  fs.writeFileSync(path.join(workspace, "check.cjs"), "process.exit(1);\n");
  fs.writeFileSync(source, JSON.stringify({
    schema: "smolcoder/contract/v1",
    id: "initial-state",
    title: "État initial",
    problem: "Un contrôle peut déjà échouer.",
    outcome: "L'échec initial reste attribué au départ.",
    acceptance: ["le contrôle passe"],
    ...(command ? { checks: [{ command, covers: [1] }] } : {}),
    budgets: { maxSteps: 20 },
  }));
  const mission = Mission.prepare({ source, workspace, dataDir });
  return { workspace, mission };
}

const resume = (external = null) => ({
  suspended: false,
  reason: null,
  lock: { state: "held" },
  external,
});

const model = { state: "ready", id: "mtplx-qwen", backend: "lmstudio" };

function executor(result, state = "ready") {
  const requests = [];
  return {
    requests,
    status: { backend: "seatbelt", state, reason: state === "ready" ? "ok" : "sonde en échec" },
    tmpDir: state === "ready" ? "/tmp/fake" : null,
    listening() { return []; },
    close() { return null; },
    start(request) {
      requests.push(request);
      return { result: Promise.resolve(result), write() { return false; }, kill() {} };
    },
  };
}

function sequenceExecutor(results) {
  let index = 0;
  const isolated = executor(exited(0));
  isolated.start = function start(request) {
    this.requests.push(request);
    const result = results[Math.min(index++, results.length - 1)];
    return { result: Promise.resolve(result), write() { return false; }, kill() {} };
  };
  return isolated;
}

const exited = (code) => ({
  started: true,
  status: "exited",
  exitCode: code,
  signal: null,
  durationMs: 7,
  output: code === 0 ? "ok" : "échec déjà présent",
});

const allow = async () => ({
  ok: true,
  decision: {
    verdict: "allow",
    reason: "test",
    policyVersion: "smolcoder/policy/v1@0000000000000000",
    exec: { env: process.env, login: false },
  },
});

test("#71 : un contrôle rouge avant tout effet est enregistré comme échec initial", async () => {
  const { mission } = fixture();
  mission.approve("headless-flag");
  const isolated = executor(exited(1));
  const state = await observeMissionInitialState({
    mission,
    checks: callerChecks(mission.contract),
    surface: "headless",
    model,
    resume: resume(),
    executor: isolated,
    authorize: allow,
  });

  assert.equal(state.state, "already_failing");
  assert.equal(state.controls[0].status, "already_failed");
  assert.equal(state.controls[0].cause, "exit-code");
  assert.match(state.controls[0].output, /échec déjà présent/);
  assert.equal(isolated.requests.length, 1);
  assert.equal(isolated.requests[0].surface, "check");
  assert.equal(state.workspace.beforeAgentEffect, true);
});

test("#71 : les portes non franchies ont des états distincts et ne deviennent jamais vertes", async () => {
  const proposed = fixture();
  const proposedState = await observeMissionInitialState({
    mission: proposed.mission,
    checks: callerChecks(proposed.mission.contract),
    surface: "terminal",
    model,
    resume: resume(),
    executor: executor(exited(0)),
    authorize: allow,
  });
  assert.deepEqual([proposedState.state, proposedState.controls[0].status, proposedState.controls[0].cause], ["not_run", "not_run", "contract-not-approved"]);

  const unavailableModel = unavailableMissionInitialState({
    mission: proposed.mission,
    surface: "headless",
    model: { state: "unavailable", reason: "aucun serveur MTPLX" },
    resume: resume(),
    isolation: { state: "not_checked", reason: "modèle absent" },
    checks: callerChecks(proposed.mission.contract),
  });
  assert.deepEqual([unavailableModel.state, unavailableModel.controls[0].status, unavailableModel.controls[0].cause], ["environment_unavailable", "environment_unavailable", "model-unavailable"]);

  const isolatedFixture = fixture();
  isolatedFixture.mission.approve("headless-flag");
  const noIsolation = await observeMissionInitialState({
    mission: isolatedFixture.mission,
    checks: callerChecks(isolatedFixture.mission.contract),
    surface: "web",
    model,
    resume: resume(),
    executor: executor(exited(0), "unavailable"),
    authorize: allow,
  });
  assert.deepEqual([noIsolation.state, noIsolation.controls[0].status, noIsolation.controls[0].cause], ["environment_unavailable", "environment_unavailable", "isolation-unavailable"]);

  const refusedFixture = fixture();
  refusedFixture.mission.approve("headless-flag");
  const refused = await observeMissionInitialState({
    mission: refusedFixture.mission,
    checks: callerChecks(refusedFixture.mission.contract),
    surface: "headless",
    model,
    resume: resume(),
    executor: executor(exited(0)),
    authorize: async () => ({ ok: false, message: "Error: refus de la politique" }),
  });
  assert.deepEqual([refused.state, refused.controls[0].status, refused.controls[0].cause], ["refused", "refused", "policy"]);

  const missingFixture = fixture("npm run absent");
  missingFixture.mission.approve("headless-flag");
  const missing = await observeMissionInitialState({
    mission: missingFixture.mission,
    checks: callerChecks(missingFixture.mission.contract),
    surface: "terminal",
    model,
    resume: resume(),
    executor: executor(exited(0)),
    authorize: allow,
  });
  assert.deepEqual([missing.state, missing.controls[0].status, missing.controls[0].cause], ["not_run", "not_run", "missing-script"]);
});

test("#71 : les changements humains du départ sont nommés et le contrôle ne les touche pas", async () => {
  const { mission, workspace } = fixture();
  mission.approve("headless-flag");
  const note = path.join(workspace, "notes-humaines.md");
  fs.writeFileSync(note, "à préserver\n");
  const before = fs.readFileSync(note, "utf8");
  const external = {
    head: null,
    files: [{ path: "notes-humaines.md", change: "added" }],
    unattributed: [],
    more: 0,
    digestChanged: true,
  };

  const state = await observeMissionInitialState({
    mission,
    checks: callerChecks(mission.contract),
    surface: "web",
    model,
    resume: resume(external),
    executor: executor(exited(0)),
    authorize: allow,
  });

  assert.deepEqual(state.workspace.humanChanges, external);
  assert.equal(fs.readFileSync(note, "utf8"), before);
  assert.equal(state.controls[0].status, "passed");
});

test("#71 : l'absence de contrôle reste not_run sans dépendre de l'isolation", async () => {
  const { mission } = fixture("");
  mission.approve("headless-flag");
  const state = await observeMissionInitialState({
    mission,
    checks: [],
    surface: "terminal",
    model,
    resume: resume(),
    executor: executor(exited(0), "unavailable"),
    authorize: allow,
  });
  assert.equal(state.state, "not_run");
  assert.equal(state.controls.length, 0);
  assert.match(state.reason, /aucun contrôle initial/);
});

test("#71 : l'Agent commun aux trois surfaces constate avant le modèle et sépare le verdict ultérieur", async () => {
  const { mission, workspace } = fixture();
  mission.approve("headless-flag");
  mission.openResume("headless");
  const isolated = sequenceExecutor([exited(1), exited(0)]);
  const seen = [];
  const provider = {
    label: "fake",
    modelId: "mtplx-qwen",
    contextWindow: 16_000,
    maxOutputTokens: 2_000,
    setEffort() {},
    effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((message) => ({ ...message })));
      return { content: "terminé", toolCalls: [], generatedTokens: 5, promptTokens: 200, completionTokens: 5 };
    },
  };
  const ui = {
    lines: [],
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {},
    println(value = "") { this.lines.push(String(value)); },
    status(value) { this.lines.push(String(value)); },
    warn(value) { this.lines.push(String(value)); },
    error(value) { this.lines.push(String(value)); },
    async confirmCommand() { return "no"; },
  };
  const toolContext = {
    workspace,
    plan: new Plan(),
    taskManager: { runningSummary() { return []; }, recentUrls() { return []; } },
    filesTouched: new Set(),
    commandsRun: [],
    executor: isolated,
  };
  const agent = new Agent(provider, "edit", "sys", toolContext, new ContextManager(16_000, 2_000), new EventBus(), ui, false, 20, undefined, mission);

  await agent.runTurn("Traite la mission.");

  assert.equal(seen.length, 1);
  assert.match(seen[0].find((message) => message.role === "user").content, /État initial de mission.*already_failing/s);
  assert.equal(agent.initialMissionState().controls[0].status, "already_failed");
  assert.equal(agent.initialMissionState().surface, "headless");
  assert.equal(agent.missionVerdict.report.initial.controls[0].status, "already_failed");
  assert.equal(agent.missionVerdict.report.criteria[0].status, "passed", "le contrôle ultérieur garde son attribution propre");
  assert.equal(isolated.requests.length, 2, "un contrôle initial, puis le contrôle d'acceptation");
  assert.equal(fs.existsSync(path.join(workspace, "nouveau.txt")), false, "le prévol ne lance aucune correction de l'agent");

  await agent.runTurn("Confirme le verdict.");
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1].filter((message) => message.role === "user").at(-1).content, /État initial de mission/);
  assert.equal(isolated.requests.length, 3, "le second tour relance l'acceptation, pas le contrôle initial");
});
