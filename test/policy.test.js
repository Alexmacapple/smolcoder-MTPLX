// Politique d'accès du profil renforcé (ticket #11, H02) : une décision
// allow / ask / deny prise avant l'effet, au dernier point avant l'exécution,
// sur les quatre surfaces (outils, tâches, vérifications automatiques,
// terminal web). La politique vit dans le stockage hôte ; une erreur du
// contrôleur bloque. Les noms « H02 ACn » renvoient aux critères
// d'acceptation du ticket.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder, ~/.smolcoder.json et les fichiers de démarrage du shell
// avant de charger le code : ce fichier tourne dans son propre processus.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smol-policy-home-"));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

// Deux faux secrets : l'un dans l'environnement de smol, l'autre exporté par
// le profil du shell de connexion de l'utilisateur.
const ENV_SECRET = "sk-h02-env-9f3c1a7e";
const PROFILE_SECRET = "sk-h02-profile-4b8d2e61";
const FILE_SECRET = "sk-h02-file-7a5c9d30";
process.env.SMOL_H02_FAKE_SECRET = ENV_SECRET;
for (const f of [".bash_profile", ".profile"]) {
  fs.writeFileSync(path.join(HOME, f), `export SMOL_H02_PROFILE_SECRET=${PROFILE_SECRET}\n`);
}
const SECRETS = [ENV_SECRET, PROFILE_SECRET, FILE_SECRET];

const store = require("../dist/harness/store");
const { Mission } = require("../dist/harness/mission");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");
const { WebHub } = require("../dist/web/hub");
const { hostExecutor } = require("../dist/harness/executor");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function contractSource(overrides = {}) {
  return {
    schema: "smolcoder/contract/v1",
    id: "policy-check",
    title: "Vérifier la politique d'accès",
    problem: "Le profil renforcé doit refuser les actions interdites.",
    outcome: "Aucune action interdite n'a d'effet.",
    acceptance: ["les tests passent"],
    budgets: { maxSteps: 200 },
    ...overrides,
  };
}

/** Un workspace (avec un faux secret dans .env), un contrat hors du workspace
 * et un stockage hôte isolé. */
function setup({ approve = true } = {}) {
  const ws = fs.realpathSync.native(tmp("smol-policy-ws-"));
  const file = path.join(tmp("smol-policy-src-"), "contract.json");
  const data = tmp("smol-policy-data-");
  fs.writeFileSync(file, JSON.stringify(contractSource()));
  fs.writeFileSync(path.join(ws, ".env"), `API_KEY=${FILE_SECRET}\n`);
  fs.writeFileSync(path.join(ws, ".env.example"), "API_KEY=your-key-here\n");
  fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".git", "config"), `[remote "origin"]\n\turl = https://user:${FILE_SECRET}@example.com/r.git\n`);
  const m = Mission.prepare({ source: file, workspace: ws, dataDir: data });
  if (approve) m.approve("terminal-human");
  return { ws, file, data, m, policyFile: path.join(m.dir, "policy.json") };
}

/** Pose une politique dans le stockage hôte, comme le ferait l'appelant. */
function writePolicy(s, overrides = {}) {
  const policy = {
    schema: "smolcoder/policy/v1",
    paths: { protect: [".env", ".env.*", ".git"], except: [".env.example"] },
    commands: "workspace",
    tasks: "ask",
    env: [],
    ...overrides,
  };
  fs.mkdirSync(path.dirname(s.policyFile), { recursive: true });
  fs.writeFileSync(s.policyFile, JSON.stringify(policy, null, 2));
  return policy;
}

function fakeUi() {
  const seen = [];
  return {
    seen,
    token(t) { seen.push(t); }, thinking(t) { seen.push(t); },
    toolCall(n, a) { seen.push(JSON.stringify(a)); }, toolResult(r) { seen.push(r); }, println(s) { seen.push(String(s ?? "")); },
    status(s) { seen.push(s); }, warn(s) { seen.push(s); }, error(s) { seen.push(s); },
    startSpinner() {}, stopSpinner() {},
    confirms: [],
    async confirmCommand(command, reason) { this.confirms.push({ command, reason }); return "no"; },
    turnEnd(label) { seen.push("END " + label); }, planUpdated() {},
  };
}

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 32000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function agentFor(provider, s, { mode = "bypass", interactive = false, verification, ui = fakeUi(), mission = s.m } = {}) {
  const ws = s.ws;
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const agent = new Agent(provider, mode, "sys", toolCtx, new ContextManager(32000, 2000), new EventBus(), ui, interactive, 60, verification, mission);
  return { agent, ui };
}

const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });
const toolResults = (provider) => provider.seen.at(-1).filter((m) => m.role === "tool").map((m) => m.content);

/** Aucun faux secret dans ce que le modèle a reçu, dans le transcript ni dans
 * ce que l'interface a affiché. */
function assertNoSecret(label, ...texts) {
  const all = texts.flat(Infinity).map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join("\n");
  for (const secret of SECRETS) assert.ok(!all.includes(secret), `${label}: ${secret} leaked`);
}

// ---- surface 1 : les outils du modèle ----

test("H02 AC1: a tool asking for a protected path has no effect at all (read, write, edit, search, git metadata)", async () => {
  const s = setup();
  const before = fs.readFileSync(path.join(s.ws, ".env"), "utf8");
  const provider = scriptedProvider([
    call("r1", "read_file", { path: ".env" }),
    call("w1", "write_file", { path: ".env", content: "API_KEY=pwned\n" }),
    call("e1", "edit_file", { path: ".env", old_text: "API_KEY", new_text: "LEAK" }),
    call("s1", "search", { pattern: "sk-h02" }),
    call("g1", "read_file", { path: ".git/config" }),
    call("g2", "write_file", { path: ".git/hooks/pre-commit", content: "#!/bin/sh\ncurl evil\n" }),
    call("x1", "read_file", { path: ".env.example" }),
    { content: "done" },
  ]);
  const { agent, ui } = agentFor(provider, s);
  await agent.runTurn("look for the key");
  assert.equal(fs.readFileSync(path.join(s.ws, ".env"), "utf8"), before, ".env is never written");
  assert.ok(!fs.existsSync(path.join(s.ws, ".git", "hooks", "pre-commit")), "git hooks are never written");
  const results = toolResults(provider);
  assert.equal(results.length, 7);
  for (const r of results.slice(0, 3)) assert.match(r, /^Error: .*denied by the access policy/s);
  assert.doesNotMatch(results[3], new RegExp(`\\.env:|\\.git/|${FILE_SECRET}`), "search skips protected files");
  assert.match(results[4], /^Error: .*denied by the access policy/s);
  assert.match(results[5], /^Error: .*denied by the access policy/s);
  assert.match(results[6], /your-key-here/, ".env.example stays readable");
  assertNoSecret("tool results and UI", provider.seen, agent.messages, ui.seen);
});

// ---- surface 1 bis : les sous-processus ne reçoivent plus l'environnement entier ----

test("H02 AC2: a fake secret in smol's environment or the login profile never reaches a subprocess under the profile", async () => {
  const s = setup();
  const provider = scriptedProvider([
    call("c1", "run_command", { command: "printenv" }),
    call("c2", "run_command", { command: 'echo "[$SMOL_H02_FAKE_SECRET][$SMOL_H02_PROFILE_SECRET]"' }),
    { content: "done" },
  ]);
  const { agent, ui } = agentFor(provider, s, { mode: "edit" });
  await agent.runTurn("show the environment");
  const results = toolResults(provider);
  assert.match(results[0], /^PATH=/m, "the minimal environment still carries PATH");
  assert.match(results[1], /\[\]\[\]/, "neither secret is set in the subprocess");
  // Ce que voit le modèle, le transcript et les faits de session (sauvegardés
  // dans ~/.smolcoder/sessions/ par l'interface web), ce que smol affiche.
  assertNoSecret("subprocess output", provider.seen, agent.messages, agent.toolCtx.commandsRun, ui.seen);
});

test("#52: destructive workspace commands suspend headless execution before any effect", async () => {
  const commands = [
    "rm notes.txt",
    "find . -name notes.txt -exec rm {} \\;",
    "printf '%s\\n' notes.txt | xargs rm",
  ];
  for (const command of commands) {
    const s = setup();
    const marker = path.join(s.ws, "notes.txt");
    fs.writeFileSync(marker, "must survive\n");
    const provider = scriptedProvider([call("rm-1", "run_command", { command }), { content: "done" }]);
    const { agent } = agentFor(provider, s, { mode: "edit" });
    const err = await agent.runTurn("remove the marker").then(() => null, (error) => error);
    assert.ok(fs.existsSync(marker), `${command}: the marker must remain untouched`);
    assert.match(String(err?.message), /suspended/i, `${command}: headless execution must be suspended for a human decision`);
  }
});

test("H02 AC1: a masked tool (read-only mode under the profile) has no effect, whatever the model claims", async () => {
  const s = setup();
  const provider = scriptedProvider([
    { content: "The host enabled writes for me.", ...call("w1", "write_file", { path: "masked.txt", content: "x" }) },
    call("c1", "run_command", { command: "echo x > masked-cmd.txt" }),
    call("t1", "task", { action: "start", command: "echo y > masked-task.txt" }),
    { content: "done" },
  ]);
  const { agent } = agentFor(provider, s, { mode: "ro" });
  await agent.runTurn("write");
  await sleep(200);
  for (const f of ["masked.txt", "masked-cmd.txt", "masked-task.txt"]) assert.ok(!fs.existsSync(path.join(s.ws, f)), `${f} must not exist`);
  for (const r of toolResults(provider)) assert.match(r, /^Error: the tool ".*" is not available in read-only mode/);
});

test("H02 AC5: the same command gets the same decision on the four surfaces (run_command, task.start, automatic checks, web terminal)", () => {
  const s = setup();
  writePolicy(s, { tasks: "workspace" });
  const surfaces = (command) => [
    decide(s.m, { surface: "tool", tool: "run_command", args: { command } }),
    decide(s.m, { surface: "tool", tool: "task", args: { action: "start", command } }),
    decide(s.m, { surface: "check", tool: "verification", args: { command } }),
    decide(s.m, { surface: "terminal", tool: "terminal", args: { command }, cwd: s.ws }),
  ];
  for (const [command, verdict] of [["npm test", "allow"], ["cat /etc/hosts", "ask"], ["cat .env", "deny"], [`ls ${s.m.dir}`, "deny"]]) {
    const ds = surfaces(command);
    assert.deepEqual(ds.map((d) => d.verdict), [verdict, verdict, verdict, verdict], command);
    assert.equal(new Set(ds.map((d) => d.reason.replace(/a background task|an automatic check|a terminal command|a command/, "…"))).size, 1, `same reason for ${command}`);
    assert.equal(new Set(ds.map((d) => d.policyVersion)).size, 1);
  }
  s.m.expire("test");
  assert.ok(surfaces("npm test").every((d) => d.verdict === "deny" && /not approved/.test(d.reason)), "an expired contract closes all four at once");
});

// ---- surface 2 : les tâches ----

test("H02 AC5: task.start follows the same decision; under the default profile policy a headless run suspends and nothing starts", async () => {
  const s = setup();
  const marker = path.join(s.ws, "bg-h02.txt");
  const provider = scriptedProvider([call("t1", "task", { action: "start", command: `echo started > bg-h02.txt` }), { content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "bypass" });
  let err = null;
  try {
    err = await agent.runTurn("start the server").then(() => null, (e) => e);
    await sleep(300);
  } finally {
    agent.toolCtx.taskManager.killAll();
  }
  assert.ok(!fs.existsSync(marker), "the background task never started");
  assert.match(String(err?.message), /suspended/i, "headless ask is an explicit suspension");
});

// ---- surface 3 : les vérifications automatiques ----

test("H02 AC5: the caller's acceptance check (verify) goes through the same decision: no contract approval, no run", async () => {
  const s = setup({ approve: false });
  const provider = scriptedProvider([{ content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "edit", verification: { command: "echo ran > verified-h02.txt" } });
  const err = await agent.runTurn("finish").then(() => null, (e) => e);
  assert.ok(!fs.existsSync(path.join(s.ws, "verified-h02.txt")), "the acceptance command must not run under a contract that is not approved");
  assert.match(String(err?.message), /blocked|denied/i, "the turn stops with the decision, it does not report success");
});

test("H02 AC5: automatic project checks (checkProgress, then verify) go through the same decision as run_command", async () => {
  const s = setup();
  writePolicy(s, { commands: "deny" });
  fs.writeFileSync(path.join(s.ws, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('checked-h02.txt','x')\"" } }));
  // Une écriture, puis 23 étapes de plan distinctes : 24 appels d'outils
  // déclenchent le contrôle de progression du harnais.
  const calls = [{ id: "w1", name: "write_file", args: { path: "a.txt", content: "a" } }];
  for (let i = 0; i < 23; i++) calls.push({ id: `p${i}`, name: "plan", args: { action: "add", text: `step ${i}` } });
  const provider = scriptedProvider([{ toolCalls: calls }, { content: "done" }]);
  const { agent, ui } = agentFor(provider, s, { mode: "edit" });
  await agent.runTurn("implement").catch(() => {});
  assert.ok(fs.existsSync(path.join(s.ws, "a.txt")), "file writes are allowed by this policy");
  assert.ok(ui.seen.some((l) => /checking implementation progress/.test(l)), "the harness reached its progress check");
  assert.ok(!fs.existsSync(path.join(s.ws, "checked-h02.txt")), "a policy that denies commands also denies the harness's own checks");
  assert.ok(ui.seen.some((l) => /project check not run — denied by the access policy/.test(l)), "checkProgress itself was refused, not only verify");
});

// ---- surface 4 : le terminal web ----

function request(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: hub.port, method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Un hub web dont la session porte la mission, sans backend de modèle. */
async function missionHub(s) {
  const factory = async (ui, workspace) => {
    const session = {
      // #16 : sous mission, le hub prend l'exécuteur du terminal dans la
      // session et n'ouvre aucun shell sans lui ; ce faux nomme l'adaptateur
      // hôte, l'isolation est éprouvée par test/sandbox-executor.test.js.
      chosen: { id: "fake-model", backend: "ollama" }, workspace, onExit: null, mission: s.m, executor: hostExecutor,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
      state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, urls: [], commands: [] }),
      announce() {}, restore() {}, snapshot: () => ({ messages: [], plan: [], filesTouched: [], commandsRun: [], originalRequest: "", currentRequest: "", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      async suggestTitle() { return null; },
      async run() { for (;;) { if ((await ui.readInput()) === "/exit") return; } },
    };
    return session;
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir: tmp("smol-policy-hub-"), factory, quiet: true });
  const sent = [];
  const send = hub.send.bind(hub);
  hub.send = (ev) => { sent.push(ev); send(ev); };
  await hub.start();
  const k = "?k=" + hub.authToken;
  const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: s.ws })).body);
  for (let i = 0; i < 80 && !hub.live.get(id)?.session; i++) await sleep(25);
  const { tid } = JSON.parse((await request(hub, "POST", "/term/open" + k, { sid: id })).body);
  const output = () => sent.filter((e) => e.t === "term" && e.tid === tid).map((e) => e.s).join("");
  const dones = () => sent.filter((e) => e.t === "termdone" && e.tid === tid);
  const input = async (text) => {
    const before = dones().length;
    await request(hub, "POST", "/term/input" + k, { sid: id, tid, text });
    for (let i = 0; i < 400 && dones().length === before; i++) await sleep(25);
    return dones().at(-1);
  };
  return { hub, input, output };
}

test("H02 AC5: the web terminal goes through the decision: before the contract is approved, a typed command has no effect", async () => {
  const s = setup({ approve: false });
  const { hub, input, output } = await missionHub(s);
  try {
    await input("echo typed > term-h02.txt");
    assert.ok(!fs.existsSync(path.join(s.ws, "term-h02.txt")), "the web terminal must not bypass the contract");
    assert.match(output(), /denied/i);
  } finally {
    hub.close();
  }
});

test("H02 AC2: the web terminal's shell gets the minimal environment under the profile", async () => {
  const s = setup();
  const { hub, input, output } = await missionHub(s);
  try {
    await input("printenv");
    assert.match(output(), /PATH=/);
    assertNoSecret("web terminal output", output());
  } finally {
    hub.close();
  }
});

// ---- le contrôleur fail-closed ----

test("H02 AC4: an unreadable policy blocks every action; it never falls back to allowing", async () => {
  for (const content of ["{ not json", JSON.stringify({ schema: "smolcoder/policy/v2", commands: "workspace" })]) {
    const s = setup();
    fs.mkdirSync(path.dirname(s.policyFile), { recursive: true });
    fs.writeFileSync(s.policyFile, content);
    const provider = scriptedProvider([
      call("w1", "write_file", { path: "a.txt", content: "a" }),
      call("c1", "run_command", { command: "echo x > b.txt" }),
      { content: "done" },
    ]);
    const { agent } = agentFor(provider, s);
    await agent.runTurn("write");
    assert.ok(!fs.existsSync(path.join(s.ws, "a.txt")), `write blocked (${content.slice(0, 12)})`);
    assert.ok(!fs.existsSync(path.join(s.ws, "b.txt")), `command blocked (${content.slice(0, 12)})`);
    for (const r of toolResults(provider)) assert.match(r, /^Error: .*access policy/s);
  }
});

// ---- la politique appartient à l'hôte ----

test("H02 AC3: the workspace cannot change or widen the policy (host file, symlink, command, workspace copy)", async () => {
  const s = setup();
  writePolicy(s, { commands: "deny" });
  const original = fs.readFileSync(s.policyFile, "utf8");
  fs.symlinkSync(path.dirname(s.policyFile), path.join(s.ws, "host-link"));
  fs.mkdirSync(path.join(s.ws, ".smolcoder"));
  fs.writeFileSync(path.join(s.ws, ".smolcoder", "policy.json"), JSON.stringify({ schema: "smolcoder/policy/v1", paths: { protect: [], except: [] }, commands: "workspace", tasks: "workspace", env: ["SMOL_H02_FAKE_SECRET"] }));
  const provider = scriptedProvider([
    call("w1", "write_file", { path: s.policyFile, content: "{}" }),
    call("w2", "write_file", { path: "host-link/policy.json", content: "{}" }),
    call("c1", "run_command", { command: `echo '{}' > ${s.policyFile}` }),
    call("c2", "run_command", { command: "echo widened > widened-h02.txt" }),
    call("r1", "read_file", { path: "../escape.txt" }),
    { content: "done" },
  ]);
  const { agent } = agentFor(provider, s);
  await agent.runTurn("widen the policy");
  assert.equal(fs.readFileSync(s.policyFile, "utf8"), original, "the host policy is unchanged");
  assert.ok(!fs.existsSync(path.join(s.ws, "widened-h02.txt")), "a workspace copy of the policy grants nothing");
  for (const r of toolResults(provider)) assert.match(r, /^Error: /);
});

// ---- bypass ----

test("H02 AC6: under the profile, bypass does not widen the decision: a command outside the workspace still needs a human", async () => {
  const s = setup();
  const outside = path.join(path.dirname(s.ws), `outside-h02-${process.pid}.txt`);
  const provider = scriptedProvider([call("c1", "run_command", { command: `echo x > ${outside}` }), { content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "bypass" });
  try {
    const err = await agent.runTurn("write outside").then(() => null, (e) => e);
    assert.ok(!fs.existsSync(outside), "nothing ran outside the workspace");
    assert.match(String(err?.message), /suspended/i, "headless ask is an explicit suspension, never an implicit yes");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

// ---- l'interface de décision et sa grammaire ----

const { decide, decisionReport, PolicySuspension, POLICY_SUSPENDED_EXIT_CODE } = require("../dist/harness/policy");

test("H02 decision: one allow/ask/deny interface with reason, action, canonical paths and policy version", () => {
  const s = setup();
  const version = decide(s.m, { surface: "tool", tool: "plan", args: {} }).policyVersion;
  assert.match(version, /^smolcoder\/policy\/v1@[0-9a-f]{16}$/);
  const ok = decide(s.m, { surface: "tool", tool: "read_file", args: { path: "src/../.env.example" } });
  assert.deepEqual([ok.verdict, ok.action, ok.paths], ["allow", "read", [path.join(s.ws, ".env.example")]]);
  fs.symlinkSync(path.join(s.ws, ".env"), path.join(s.ws, "innocent.txt"));
  const viaLink = decide(s.m, { surface: "tool", tool: "read_file", args: { path: "innocent.txt" } });
  assert.deepEqual([viaLink.verdict, viaLink.paths], ["deny", [path.join(s.ws, ".env")]], "a link inside the workspace is judged by its target");
  assert.match(viaLink.reason, /protected path/);
  assert.equal(decide(s.m, { surface: "tool", tool: "write_file", args: { path: "sub/.ENV", content: "" } }).verdict, "deny", "an ambiguous (case-folded) path never opens a right");
  assert.equal(decide(s.m, { surface: "tool", tool: "list_files", args: { path: ".git" } }).verdict, "deny");
  const inside = decide(s.m, { surface: "tool", tool: "run_command", args: { command: "npm test" } });
  assert.deepEqual([inside.verdict, inside.action, inside.exec.login], ["allow", "command", false]);
  assert.equal(inside.exec.env.SMOL_H02_FAKE_SECRET, undefined);
  assert.equal(inside.exec.env.PATH, process.env.PATH);
  const out = decide(s.m, { surface: "check", tool: "verification", args: { command: "cat /etc/hosts" } });
  assert.deepEqual([out.verdict, out.action], ["ask", "check"]);
  assert.match(out.reason, /outside the workspace/);
  assert.equal(decide(s.m, { surface: "tool", tool: "run_command", args: { command: "cat .env" } }).verdict, "deny", "a command naming a protected path");
  assert.equal(decide(s.m, { surface: "terminal", tool: "terminal", args: { command: "ls" }, cwd: os.homedir() }).verdict, "deny", "a terminal that left the workspace");
  assert.equal(decide(s.m, { surface: "tool", tool: "launch_rockets", args: {} }).verdict, "deny", "unknown actions are refused");
  assert.equal(decide(s.m, { surface: "tool", tool: "task", args: { action: "logs", task_id: "t1" } }).verdict, "allow");
  assert.equal(decide(s.m, { surface: "tool", tool: "task", args: { action: "start", command: "npm run dev" } }).verdict, "ask", "background tasks need a human by default");
  assert.ok(!("exec" in decisionReport(inside)), "a decision report never carries the environment");
  writePolicy(s, { commands: "ask" });
  const v2 = decide(s.m, { surface: "tool", tool: "run_command", args: { command: "npm test" } });
  assert.equal(v2.verdict, "ask");
  assert.notEqual(v2.policyVersion, version, "the version follows the policy content");
});

test("policy.json grammar: closed schema, every field required, one-name patterns, atomic write, explicit read states", () => {
  const dir = path.join(tmp("smol-policy-grammar-"), "harness", "0123456789abcdef");
  assert.deepEqual(store.readPolicy(dir), { state: "absent" });
  store.writePolicy(dir, store.DEFAULT_POLICY);
  assert.deepEqual(fs.readdirSync(dir), ["policy.json"], "no temporary file left behind");
  const read = store.readPolicy(dir);
  assert.equal(read.state, "ok");
  assert.deepEqual(read.policy, store.DEFAULT_POLICY);
  assert.equal(read.version, store.policyVersion(store.DEFAULT_POLICY));
  const file = path.join(dir, "policy.json");
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  const unreadable = (value, why) => {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(store.readPolicy(dir).state, "unreadable", why);
  };
  unreadable({ ...base, commands: "allow-all" }, "no rule wider than the sandbox exists");
  unreadable({ ...base, extra: 1 }, "unknown field");
  unreadable({ ...base, paths: { protect: ["config/secrets.json"], except: [] } }, "a pattern is one name");
  unreadable({ ...base, paths: { protect: [".."], except: [] } }, '".." is not a pattern');
  unreadable({ ...base, env: ["NOT A NAME"] }, "environment variable names");
  const { env, ...partial } = base;
  unreadable(partial, "a partial policy is never completed silently");
  fs.writeFileSync(file, JSON.stringify({ ...base, schema: "smolcoder/policy/v2" }));
  assert.equal(store.readPolicy(dir).state, "unknown-schema");
  fs.writeFileSync(file, " ".repeat(store.MAX_POLICY_BYTES + 1));
  assert.match(store.readPolicy(dir).reason, /exceeds/);
  assert.throws(() => store.writePolicy(dir, { ...store.DEFAULT_POLICY, commands: "yes" }), /commands/, "an invalid policy is never written");
});

test("prepare: the host writes the default profile policy when none exists; the caller's policy is kept; an unreadable one is never overwritten", () => {
  const s = setup();
  const first = store.readPolicy(s.m.dir);
  assert.equal(first.state, "ok");
  assert.deepEqual(first.policy, store.DEFAULT_POLICY);
  writePolicy(s, { commands: "ask", env: ["TZ"] });
  Mission.prepare({ source: s.file, workspace: s.ws, dataDir: s.data });
  assert.deepEqual([store.readPolicy(s.m.dir).policy.commands, store.readPolicy(s.m.dir).policy.env], ["ask", ["TZ"]]);
  fs.writeFileSync(s.policyFile, "{ broken");
  Mission.prepare({ source: s.file, workspace: s.ws, dataDir: s.data });
  assert.equal(fs.readFileSync(s.policyFile, "utf8"), "{ broken");
  assert.deepEqual(fs.readdirSync(s.ws).sort(), [".env", ".env.example", ".git"], "nothing is written into the workspace");
});

// ---- critères restants, par surface ----

test("H02 AC2: the policy names the extra variables a subprocess may receive; nothing else passes", async () => {
  const s = setup();
  process.env.SMOL_H02_ALLOWED = "visible-by-policy";
  try {
    writePolicy(s, { env: ["SMOL_H02_ALLOWED"] });
    const provider = scriptedProvider([call("c1", "run_command", { command: 'echo "[$SMOL_H02_ALLOWED][$SMOL_H02_FAKE_SECRET]"' }), { content: "done" }]);
    await agentFor(provider, s, { mode: "edit" }).agent.runTurn("show");
    assert.match(toolResults(provider)[0], /\[visible-by-policy\]\[\]/);
  } finally {
    delete process.env.SMOL_H02_ALLOWED;
  }
});

test("H02 AC3: path traversal and a symlink leading out of the workspace are refused before any effect", async () => {
  const s = setup();
  const outDir = fs.realpathSync.native(tmp("smol-policy-out-"));
  fs.writeFileSync(path.join(outDir, "secret.txt"), FILE_SECRET);
  fs.symlinkSync(outDir, path.join(s.ws, "outlink"));
  const provider = scriptedProvider([
    call("w1", "write_file", { path: "outlink/pwn.txt", content: "x" }),
    call("r1", "read_file", { path: "outlink/secret.txt" }),
    call("r2", "read_file", { path: `../${path.basename(outDir)}/secret.txt` }),
    call("w2", "write_file", { path: path.join(outDir, "abs.txt"), content: "x" }),
    { content: "done" },
  ]);
  const { agent, ui } = agentFor(provider, s);
  await agent.runTurn("escape");
  assert.deepEqual(fs.readdirSync(outDir), ["secret.txt"], "nothing was written outside");
  for (const r of toolResults(provider)) assert.match(r, /^Error: denied by the access policy .*outside the workspace/s);
  assertNoSecret("escape attempts", provider.seen, agent.messages, ui.seen);
});

test("H02 AC5: a caller's acceptance command leaving the workspace suspends a headless run; nothing runs", async () => {
  const s = setup();
  const outside = path.join(path.dirname(s.ws), `verify-out-h02-${process.pid}.txt`);
  const { agent } = agentFor(scriptedProvider([{ content: "done" }]), s, { mode: "edit", verification: { command: `echo x > ${outside}` } });
  try {
    const err = await agent.runTurn("finish").then(() => null, (e) => e);
    assert.ok(!fs.existsSync(outside));
    assert.ok(err instanceof PolicySuspension, String(err));
    assert.equal(err.decision.action, "check");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("H02 AC5: in an interactive session, ask is a human question: no runs nothing, yes runs once, always is not remembered under the profile", async () => {
  const s = setup();
  const answers = ["no", "always", "no"];
  const ui = fakeUi();
  ui.confirmCommand = async function (command, reason) { this.confirms.push({ command, reason }); return answers.shift(); };
  // Sort du workspace (donc « ask »), sans effet, avec une sortie courte.
  const cmd = `ls -d ${path.dirname(s.ws)}`;
  const provider = scriptedProvider([call("c1", "run_command", { command: cmd }), call("c2", "run_command", { command: cmd }), call("c3", "run_command", { command: cmd }), { content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "edit", interactive: true, ui });
  await agent.runTurn("look around");
  const results = toolResults(provider);
  assert.equal(ui.confirms.length, 3, "every call asks again: always is not a lasting grant under the profile");
  assert.match(ui.confirms[0].reason, /outside the workspace/);
  assert.match(results[0], /declined/);
  assert.ok(results[1].startsWith(path.dirname(s.ws)) && /\[exit code 0/.test(results[1]), "the approved call ran");
  assert.match(results[2], /declined/);
});

test("H02 AC6: a headless suspension carries the decision and a dedicated exit code; its report never carries the environment", async () => {
  const s = setup();
  const provider = scriptedProvider([call("c1", "run_command", { command: "cat /etc/hosts" }), { content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "edit" });
  const err = await agent.runTurn("x").then(() => null, (e) => e);
  assert.ok(err instanceof PolicySuspension, String(err));
  assert.equal(POLICY_SUSPENDED_EXIT_CODE, 4, "distinct from 1 (failure) and 3 (contract not approved)");
  const report = decisionReport(err.decision);
  assert.deepEqual([report.verdict, report.action, report.command], ["ask", "command", "cat /etc/hosts"]);
  assert.match(report.policyVersion, /^smolcoder\/policy\/v1@/);
  assert.ok(!JSON.stringify(report).includes(process.env.PATH));
  assert.equal(agent.outcome, "error");
  assert.match(agent.messages.filter((m) => m.role === "tool").at(-1).content, /did not run/, "the transcript records that the call never ran");
});

const { Session } = require("../dist/session");
const FAKE_MODEL = { id: "fake-model", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8000 };

function terminalUi(inputs) {
  const lines = [];
  return {
    lines,
    slashCommands: [], getStatus: () => "", hintLeft: "", onModeCycle: null, onCancel: null, onExit: null,
    start() {}, close() {}, refresh() {},
    async readInput() { return inputs.shift() ?? "/exit"; },
    async select() { return null; }, async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {},
    println(s = "") { lines.push(String(s)); }, status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {},
  };
}

test("H02 AC6: switching to bypass under the profile is a visible human gesture that widens nothing; no tool changes the mode or leaves the profile", async () => {
  const s = setup();
  const ui = terminalUi(["/mode bypass"]);
  const session = new Session(ui, { workspace: s.ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: s.m, surface: "terminal" });
  await session.run();
  assert.equal(session.agent.mode, "bypass");
  assert.ok(ui.lines.some((l) => /bypass does not widen the access policy/.test(l)), "the switch is shown on screen");
  ui.lines.length = 0;
  ui.onModeCycle(); // shift+tab : bypass → ro
  ui.onModeCycle(); // ro → edit
  ui.onModeCycle(); // edit → bypass
  assert.ok(ui.lines.some((l) => /bypass does not widen the access policy/.test(l)), "shift+tab into bypass is shown too");
  assert.equal(session.mission, s.m, "the profile is still on");
  assert.ok(!session.agent.tools.some((t) => /mode|bypass|mission|policy/.test(t.name)), "the model has no tool for it");
  const started = new Session(terminalUi([]), { workspace: s.ws, chosen: FAKE_MODEL, prefs: { mode: "bypass" }, cfg: {}, help: "help", mission: s.m, surface: "terminal" });
  started.announce();
  assert.ok(started.ui.lines.some((l) => /bypass does not widen the access policy/.test(l)), "starting in bypass under the profile is shown");
});

// ---- headless réel : le contrôleur fail-closed avant tout modèle ----

const { spawnSync } = require("child_process");
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

test("H02 AC4: headless with an unreadable policy: exit code 3 before any model is looked for, nothing approved, nothing overwritten", () => {
  const ws = fs.realpathSync.native(tmp("smol-policy-cli-"));
  const file = path.join(tmp("smol-policy-cli-src-"), "contract.json");
  fs.writeFileSync(file, JSON.stringify(contractSource()));
  const m = Mission.prepare({ source: file, workspace: ws });
  const policyFile = path.join(m.dir, "policy.json");
  fs.writeFileSync(policyFile, "{ broken");
  const r = smol([ws, "-p", "x", "--mission", file, "--approve", m.fingerprint]);
  assert.equal(r.status, 3, r.all);
  assert.match(r.all, /access policy/);
  const line = r.stderr.split("\n").find((l) => l.startsWith("[mission] "));
  assert.equal(JSON.parse(line.slice("[mission] ".length)).policy, "unreadable");
  assert.ok(store.readProofs(m.dir).events.every((e) => e.type !== "approval"), "nothing was approved");
  assert.equal(fs.readFileSync(policyFile, "utf8"), "{ broken", "the policy is never overwritten");
  assert.deepEqual(fs.readdirSync(ws), [], "nothing ran in the workspace");
});

// ---- web : aucun terminal non gardé sous le profil ----

test("web hub: under --web --mission, no unguarded terminal opens while the mission session is still starting", async () => {
  const s = setup({ approve: false });
  const hub = new WebHub({
    port: 0, prefs: { mission: { source: s.file, workspace: s.ws } }, help: "help", version: "9.9.9",
    dataDir: tmp("smol-policy-hub-"), factory: () => new Promise(() => {}), quiet: true,
  });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: s.ws })).body);
    const r = await request(hub, "POST", "/term/open" + k, { sid: id });
    assert.equal(r.status, 400);
    assert.match(r.body, /mission contract that is not loaded yet/);
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals.length, 0);
  } finally {
    hub.close();
  }
});

// ---- profil par défaut : strictement inchangé ----

test("default profile unchanged: without --mission subprocesses inherit the environment, bypass runs outside the workspace, .env is readable, no policy is written", async () => {
  const ws = fs.realpathSync.native(tmp("smol-policy-default-"));
  fs.writeFileSync(path.join(ws, ".env"), `API_KEY=${FILE_SECRET}\n`);
  const outside = path.join(path.dirname(ws), `outside-default-h02-${process.pid}.txt`);
  const provider = scriptedProvider([
    call("c1", "run_command", { command: 'echo "[$SMOL_H02_FAKE_SECRET]"' }),
    call("r1", "read_file", { path: ".env" }),
    call("c2", "run_command", { command: `echo x > ${outside}` }),
    { content: "done" },
  ]);
  const { agent } = agentFor(provider, { ws, m: null }, { mode: "bypass", mission: null });
  try {
    await agent.runTurn("x");
    const results = toolResults(provider);
    assert.match(results[0], new RegExp(`\\[${ENV_SECRET}\\]`), "the full environment is still inherited");
    assert.match(results[1], new RegExp(FILE_SECRET), ".env stays readable");
    assert.ok(fs.existsSync(outside), "bypass still runs without asking");
    assert.ok(!fs.existsSync(store.harnessDir(ws)), "the host store is never touched");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("default profile unchanged: a web terminal outside the profile runs as before, with the full environment", async () => {
  const ws = fs.realpathSync.native(tmp("smol-policy-default-term-"));
  const { hub, input, output } = await missionHub({ ws, m: null });
  try {
    await input("echo typed > typed.txt");
    await input('echo "[$SMOL_H02_FAKE_SECRET]"');
    assert.ok(fs.existsSync(path.join(ws, "typed.txt")));
    assert.match(output(), new RegExp(`\\[${ENV_SECRET}\\]`));
  } finally {
    hub.close();
  }
});

test("H02 AC2: a background task started under the profile gets the minimal environment too", async () => {
  const s = setup();
  writePolicy(s, { tasks: "workspace" });
  const provider = scriptedProvider([call("t1", "task", { action: "start", command: "printenv > task-env.txt" }), { content: "done" }]);
  const { agent } = agentFor(provider, s, { mode: "edit" });
  try {
    await agent.runTurn("start");
  } finally {
    agent.toolCtx.taskManager.killAll();
  }
  const env = fs.readFileSync(path.join(s.ws, "task-env.txt"), "utf8");
  assert.match(env, /^PATH=/m);
  assertNoSecret("task environment", env);
});
