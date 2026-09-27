// Reprise durable et détection des modifications concurrentes (ticket #10,
// H05). Fournisseur simulé, faux dossier personnel (ni le vrai ~/.smolcoder,
// ni ~/.npm), aucun MTPLX. Les noms « H05 Cn » renvoient aux sept critères du
// ticket amendé : C1 schéma de reprise versionné, C2 journal d'effets, C3
// incertitude au redémarrage, C4 changements externes, C5 un seul écrivain,
// C6 AGENTS.md sans rechargement silencieux, C7 même contrat pour le
// terminal, le headless et le web, migration prudente. La coupure réelle du
// vrai binaire est prouvée par test/os/e2e.os.test.js (« H05 OS »).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
const HOME = tmp("smol-h05-home-");
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { Session } = require("../dist/session");

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 16000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages, tools) {
      seen.push({ messages: messages.map((m) => ({ ...m })), tools });
      const r0 = replies[Math.min(i++, replies.length - 1)];
      const r = typeof r0 === "function" ? r0() : r0; // une étape peut agir côté hôte avant de répondre
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}
const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });

function terminalUi(inputs = [], answers = []) {
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
const openSession = (ui, workspace, extra = {}) => new Session(ui, { workspace, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", ...extra });
/** Le disque d'un aller-retour : ce que le hub écrit, puis relit. */
const onDisk = (snapshot) => JSON.parse(JSON.stringify(snapshot));

// ---- provenance des messages (commentaire du ticket, 2026-09-27) -------------

test("H05 provenance: every user message says who wrote it — the human request keeps its typed text apart from the instructions the harness adds, each harness relaunch is marked harness — and a restored session keeps it exactly", async () => {
  const ws = tmp("smol-h05-prov-");
  fs.writeFileSync(path.join(ws, "a.txt"), "un\n");
  const provider = scriptedProvider([
    call("p1", "plan", { action: "set", steps: "read a.txt\nwrite b.txt" }),
    call("r1", "read_file", { path: "a.txt" }),
    { content: "" }, // réponse vide : relance du harnais
    { content: "", truncated: true }, // réponse tronquée : relance du harnais
    { content: "I stop here." }, // plan inachevé : relance du harnais
    { content: "Finished." },
    { content: "Second answer." },
  ]);
  const ui = terminalUi(["Please read a.txt then write b.txt", "And now summarize."]);
  const s = openSession(ui, ws);
  s.agent.setProvider(provider);
  await s.run();

  const users = s.agent.messages.filter((m) => m.role === "user");
  assert.equal(users.length, 5, users.map((m) => m.content).join("\n---\n"));
  assert.deepEqual(users.map((m) => m.origin), ["human", "harness", "harness", "harness", "human"]);
  assert.equal(users[0].parts.human, "Please read a.txt then write b.txt", "the typed text, exactly");
  assert.equal(users[0].content.startsWith(users[0].parts.human), true);
  assert.equal(users[0].content, users[0].parts.human + users[0].parts.harness, "content = typed text + what the harness added, nothing else");
  assert.equal(users[4].parts.human, "And now summarize.");
  for (const m of users.slice(1, 4)) assert.equal(m.parts, undefined, "a relaunch has no human part");
  // Le rôle envoyé au modèle ne change pas, et la provenance ne part pas sur le fil.
  const sent = provider.seen.at(-1).messages.filter((m) => m.role === "user");
  assert.equal(sent.length, 5);
  for (const wire of [require("../dist/providers/lmstudio").toWire, require("../dist/providers/ollama").toWire]) {
    const out = wire(s.agent.messages);
    assert.equal(out.filter((m) => m.role === "user").length, 5, "same roles on the wire");
    assert.ok(out.every((m) => !("origin" in m) && !("parts" in m)), "no provenance field on the wire");
    assert.equal(out.find((m) => m.role === "user").content, users[0].content, "the model reads exactly the same request");
  }

  // Sauvegarde, disque, restauration dans une nouvelle session.
  const saved = onDisk(s.snapshot());
  const back = openSession(terminalUi(), ws);
  back.restore(saved);
  const restored = back.agent.messages.filter((m) => m.role === "user");
  assert.deepEqual(restored.map((m) => m.origin), ["human", "harness", "harness", "harness", "human"]);
  assert.deepEqual(restored.map((m) => m.parts ?? null), users.map((m) => m.parts ?? null));
});

test("H05 provenance: the acceptance relaunch and the compaction note are harness messages; a note the host adds to the request (the --propose-plan instruction) stays apart from the typed text", async () => {
  const ws = tmp("smol-h05-prov2-");
  const provider = scriptedProvider([
    call("w1", "write_file", { path: "x.txt", content: "x" }),
    { content: "done" },
    { content: "done again" },
  ]);
  const ctx = { workspace: ws, plan: new Plan(), taskManager: { runningSummary() { return []; }, recentUrls() { return []; } }, filesTouched: new Set(), commandsRun: [] };
  const ui = terminalUi();
  const agent = new Agent(provider, "edit", "sys", ctx, new ContextManager(16000, 2000), new EventBus(), ui, false, 20,
    { command: `node -e "process.exit(require('fs').existsSync('ok') ? 0 : 1)"`, maxAttempts: 2 });
  await assert.rejects(agent.runTurn("make it pass", [], "\n\n[Harness note: extra instruction]"), /Acceptance checks still fail/);
  const users = agent.messages.filter((m) => m.role === "user");
  assert.equal(users[0].origin, "human");
  assert.equal(users[0].parts.human, "make it pass");
  assert.ok(users[0].parts.harness.startsWith("\n\n[Harness note: extra instruction]"), "the extra instruction is a harness part");
  assert.ok(users[0].parts.harness.includes("Caller-owned acceptance checks"), "and so is the verification instruction");
  const relaunch = users.find((m) => m.content.startsWith("[Acceptance failed"));
  assert.ok(relaunch, "an acceptance relaunch was injected");
  assert.equal(relaunch.origin, "harness");
  // Compaction : la note de reprise est du harnais.
  await agent.compactNow(true, true);
  const note = agent.messages.find((m) => m.compactNote);
  assert.ok(note);
  assert.equal(note.origin, "harness");
});

// ---- C1, C6, C7 : schéma de session v2, consignes, approbations, migration ---

const { spawnSync } = require("child_process");
const { WebHub } = require("../dist/web/hub");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(20);
  }
}
function git(ws, ...args) {
  const r = spawnSync("git", ["-c", "user.name=h05", "-c", "user.email=h05@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: ws, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const system = (s) => s.agent.messages[0].content;

test("H05 C6: AGENTS.md modified between two sessions — the resumed session signals the drift and keeps the version it was using; nothing is reloaded until /instructions and an explicit choice", async () => {
  const ws = tmp("smol-h05-agents-");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "Rule A: answer in French.");
  const a = openSession(terminalUi(), ws);
  assert.match(system(a), /Rule A/);
  const saved = onDisk(a.snapshot());
  assert.equal(saved.schema, "smolcoder/session/v2");
  assert.equal(saved.instructions.workspace.text, "Rule A: answer in French.");
  assert.equal(saved.instructions.global, null);

  fs.writeFileSync(path.join(ws, "AGENTS.md"), "Rule B: answer in English.");
  const inputs = ["hello", "/instructions"];
  const answers = [1]; // garder la version de la session
  const ui = terminalUi(inputs, answers);
  const b = openSession(ui, ws);
  assert.match(system(b), /Rule B/, "a brand-new session reads the files on disk, as before");
  const provider = scriptedProvider([{ content: "bonjour" }]);
  b.agent.setProvider(provider);
  b.restore(saved);
  assert.match(system(b), /Rule A/, "the resumed session keeps its own version");
  assert.doesNotMatch(system(b), /Rule B/);
  assert.ok(ui.lines.some((l) => /AGENTS\.md changed since this session was saved \(AGENTS\.md [0-9a-f]{12} → [0-9a-f]{12}\).*keeps the version it was using — nothing is reloaded silently/.test(l)), ui.lines.join("\n"));
  await b.run();
  assert.match(provider.seen[0].messages[0].content, /Rule A/, "the next request still carries the session version");
  assert.doesNotMatch(provider.seen[0].messages[0].content, /Rule B/);
  assert.equal(ui.selects.length, 1, "/instructions asks before switching");
  assert.match(system(b), /Rule A/, "keeping the session version changes nothing");
  // La transition explicite : un second /instructions, « Reload from disk ».
  inputs.push("/instructions");
  answers.push(0);
  await b.run();
  assert.match(system(b), /Rule B/, "the switch happens only on an explicit choice");
  assert.doesNotMatch(system(b), /Rule A/);
  assert.ok(ui.lines.some((l) => /instructions reloaded from disk/.test(l)));
  assert.equal(onDisk(b.snapshot()).instructions.workspace.text, "Rule B: answer in English.", "the next save records the new version");
});

test("H05 C1: command approvals given with “always” come back with the session, and the resume says so", async () => {
  const ws = tmp("smol-h05-appr-");
  const ui = terminalUi(["list the root"]);
  ui.confirmCommand = async () => "always";
  const a = openSession(ui, ws);
  a.agent.setProvider(scriptedProvider([call("c1", "run_command", { command: "ls /" }), { content: "listed" }]));
  await a.run();
  assert.deepEqual(a.agent.alwaysAllowedList(), ["ls"]);
  const saved = onDisk(a.snapshot());
  assert.deepEqual(saved.approvals, { alwaysAllowed: ["ls"] });

  const asked = [];
  const ui2 = terminalUi(["again"]);
  ui2.confirmCommand = async (cmd) => { asked.push(cmd); return "no"; };
  const b = openSession(ui2, ws);
  const provider = scriptedProvider([call("c2", "run_command", { command: "ls /" }), { content: "listed again" }]);
  b.agent.setProvider(provider);
  b.restore(saved);
  assert.ok(ui2.lines.some((l) => /command approvals restored from the saved session: ls/.test(l)), ui2.lines.join("\n"));
  await b.run();
  assert.deepEqual(asked, [], "the restored approval is used: nobody is asked again");
  const result = provider.seen.at(-1).messages.filter((m) => m.role === "tool").at(-1).content;
  assert.doesNotMatch(result, /declined/);
});

test("H05 C4 (resumed web session): a human commit and a change to a file the agent had seen are signaled, preserved and never attributed to the agent; the plan is re-anchored before the next write, which is refused until the file is re-read", async () => {
  const ws = tmp("smol-h05-ext-");
  git(ws, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(ws, "a.txt"), "v1\n");
  git(ws, "add", ".");
  git(ws, "commit", "-q", "-m", "base");
  const before = git(ws, "rev-parse", "HEAD");
  const a = openSession(terminalUi(["look at a.txt"]), ws);
  a.agent.setProvider(scriptedProvider([
    call("p1", "plan", { action: "set", steps: "edit a.txt\ncheck it" }),
    call("r1", "read_file", { path: "a.txt" }),
    { content: "a.txt says v1" },
  ]));
  await a.run();
  const saved = onDisk(a.snapshot());
  assert.equal(saved.head, before, "the Git revision is saved, read without running git");
  assert.deepEqual(saved.views.map(([p]) => p), ["a.txt"]);

  // Pendant l'arrêt : un commit humain qui modifie a.txt.
  fs.writeFileSync(path.join(ws, "a.txt"), "human commit\n");
  git(ws, "commit", "-q", "-am", "human work");
  const after = git(ws, "rev-parse", "HEAD");

  const ui = terminalUi(["now edit a.txt"]);
  const b = openSession(ui, ws);
  const provider = scriptedProvider([
    call("w1", "write_file", { path: "a.txt", content: "agent\n" }),
    call("p2", "plan", { action: "show" }),
    call("w2", "write_file", { path: "a.txt", content: "agent\n" }),
    { content: "stopping to re-read" },
  ]);
  b.agent.setProvider(provider);
  b.restore(saved);
  const warned = ui.lines.join("\n");
  assert.match(warned, new RegExp(`HEAD moved ${before.slice(0, 12)} → ${after.slice(0, 12)}`));
  assert.match(warned, /files this session had seen changed: a\.txt \(modified\)/);
  assert.match(warned, /preserved and are not the agent's/);
  await b.run();
  // Les trois résultats de ce tour (le transcript repris porte ceux d'avant).
  const results = provider.seen.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content).slice(-3);
  assert.match(results[0], /^Error: The workspace changed outside this session.*Re-anchor your plan/s, "first write: re-anchor the plan");
  assert.match(results[2], /^Error: "a\.txt" was changed on disk after you last read it/, "then the #19 signal: the agent's view is out of date");
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "human commit\n", "the human's work is not overwritten");
  assert.equal(b.toolCtx.filesTouched.has("a.txt"), false, "the human's change is not recorded as the agent's");
  assert.equal(git(ws, "rev-parse", "HEAD"), after, "no reset, no stash, no commit by the harness");
  assert.equal(git(ws, "status", "--porcelain"), "", "nothing else touched");
});

// ---- C7 : migration des sessions anciennes ---------------------------------

/** Un transcript tel que le hub l'écrivait avant #10 (format v1, sans schéma). */
function legacyBody() {
  return {
    snapshot: {
      messages: [
        { role: "user", content: "build the page" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", args: { path: "index.html", content: "<h1>hi</h1>" } }] },
        { role: "tool", content: "Created index.html (1 lines).", toolCallId: "call_1", toolName: "write_file" },
        { role: "user", content: "[Your reply was empty. If the task is finished, summarize what you did. Otherwise make the next tool call now.]" },
        { role: "assistant", content: "Done: index.html created." },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "You're welcome." },
      ],
      plan: [{ text: "write index.html", done: true, note: "kept short" }, { text: "review", done: false }],
      filesTouched: ["index.html"],
      commandsRun: ["npm test → ok"],
      originalRequest: "build the page",
      currentRequest: "thanks",
      mode: "edit",
      effort: null,
      model: "fake-model",
      backend: "ollama",
      baseUrl: "http://127.0.0.1:9",
    },
    events: [{ t: "user", s: "build the page" }, { t: "token", s: "Done" }],
  };
}

function hubWith(dataDir, sessions) {
  const factory = async (ui, workspace, prefs) => {
    const s = new Session(ui, { workspace, chosen: FAKE_MODEL, prefs, cfg: {}, help: "help", surface: "web" });
    sessions.push(s);
    return s;
  };
  return new WebHub({ port: 0, prefs: {}, help: "help", version: "test", dataDir, factory, quiet: true });
}

test("H05 C7 migration: a session saved in the on-disk format of before #10 resumes in the web hub without losing history — the original is archived before any rewrite, the transcript and plan come back whole, and the next save writes the new schema", async () => {
  const dataDir = tmp("smol-h05-mig-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const sessionsDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const id = "abcd1234";
  const bodyFile = path.join(sessionsDir, `${id}.json`);
  fs.writeFileSync(path.join(sessionsDir, `${id}.meta.json`), JSON.stringify({ id, workspace: ws, title: "old session", createdAt: 1, updatedAt: 2, model: "fake-model", backend: "ollama" }));
  const legacy = legacyBody();
  fs.writeFileSync(bodyFile, JSON.stringify(legacy));
  const original = fs.readFileSync(bodyFile);

  const sessions = [];
  const hub = hubWith(dataDir, sessions);
  try {
    assert.equal(hub.resumeSession(id), true);
    const s = await until(() => sessions[0]?.agent.messages.length > 1 && sessions[0], 4000, "the restored session");
    const archive = path.join(sessionsDir, `${id}.v1.json`);
    assert.ok(fs.readFileSync(archive).equals(original), "the original is kept byte for byte before any rewrite");
    assert.deepEqual(onDisk(s.agent.messages.slice(1)), legacy.snapshot.messages, "every message comes back, in order, unchanged");
    assert.ok(s.agent.messages.slice(1).every((m) => m.origin === undefined), "an old message's provenance stays unknown — never guessed");
    assert.deepEqual(onDisk(s.toolCtx.plan.steps), legacy.snapshot.plan);
    assert.deepEqual([...s.toolCtx.filesTouched], ["index.html"]);
  } finally {
    hub.close(); // sauvegarde synchrone à l'arrêt
  }
  const rewritten = JSON.parse(fs.readFileSync(bodyFile, "utf8"));
  assert.equal(rewritten.snapshot.schema, "smolcoder/session/v2", "saved again in the new schema");
  assert.deepEqual(rewritten.snapshot.messages, legacy.snapshot.messages, "with the whole transcript");
  assert.ok(fs.readFileSync(path.join(sessionsDir, `${id}.v1.json`)).equals(original), "and the archive untouched");
  const replay = rewritten.events.map((e) => e.s ?? "").join("\n");
  assert.match(replay, /saved before #10: it is migrated to the new format when saved again; the original stays in/);
});

test("H05 C7 migration: a transcript written by a newer smolcoder is refused and left untouched; an unreadable one is set aside under another name, never overwritten", async () => {
  const dataDir = tmp("smol-h05-mig2-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const sessionsDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const meta = (id) => fs.writeFileSync(path.join(sessionsDir, `${id}.meta.json`), JSON.stringify({ id, workspace: ws, title: id, createdAt: 1, updatedAt: 2 }));
  meta("newer1");
  const newer = JSON.stringify({ snapshot: { ...legacyBody().snapshot, schema: "smolcoder/session/v9" }, events: [] });
  fs.writeFileSync(path.join(sessionsDir, "newer1.json"), newer);
  meta("broken1");
  fs.writeFileSync(path.join(sessionsDir, "broken1.json"), "{half a transcript");
  const sessions = [];
  const hub = hubWith(dataDir, sessions);
  try {
    assert.throws(() => hub.resumeSession("newer1"), /unknown schema \("smolcoder\/session\/v9"\).*not resumed, and nothing was overwritten/);
    assert.equal(fs.readFileSync(path.join(sessionsDir, "newer1.json"), "utf8"), newer);
    assert.equal(hub.resumeSession("broken1"), true);
    await until(() => sessions.length === 1, 4000, "the session starting without its transcript");
    const kept = fs.readdirSync(sessionsDir).filter((n) => n.startsWith("broken1.unreadable-"));
    assert.equal(kept.length, 1, "set aside");
    assert.equal(fs.readFileSync(path.join(sessionsDir, kept[0]), "utf8"), "{half a transcript");
  } finally {
    hub.close();
  }
  assert.equal(fs.readFileSync(path.join(sessionsDir, "newer1.json"), "utf8"), newer, "still untouched after the hub stops");
});

// ---- C2, C3 : journal d'effets, coupures injectées, état incertain ----------

const store = require("../dist/harness/store");
const { Mission } = require("../dist/harness/mission");
const { SimulatedCrash, RESUME_SUSPENDED_EXIT_CODE } = require("../dist/harness/resume");
const { buildReport, callerChecks, missionCriteria } = require("../dist/harness/proofs");

/** Une mission dans le stockage du faux dossier personnel (celui que relit le
 * vrai CLI), approuvée si demandé. */
function missionFixture(tag, { approve = true, maxSteps = 40, checks, acceptance = ["hello.txt dit bonjour"] } = {}) {
  const ws = tmp(`smol-h05-${tag}-ws-`);
  const src = path.join(tmp(`smol-h05-${tag}-src-`), "contract.json");
  fs.writeFileSync(src, JSON.stringify({ schema: "smolcoder/contract/v1", id: `h05-${tag}`, title: "Reprise", problem: "p", outcome: "o", acceptance, budgets: { maxSteps }, ...(checks ? { checks } : {}) }));
  const prepare = () => Mission.prepare({ source: src, workspace: ws });
  const m = prepare();
  if (approve) m.approve("terminal-human");
  return { ws, src, m, prepare };
}
const effects = (m) => {
  const read = store.readProofs(m.dir);
  assert.ok(read.state === "ok" || read.state === "truncated-tail", JSON.stringify(read));
  return read.events.filter((e) => e.type === "effect");
};
const missionSession = (ui, m, surface = "web") => openSession(ui, m.workspace, { mission: m, surface });
const lastToolResults = (provider, n) => provider.seen.at(-1).messages.filter((x) => x.role === "tool").map((x) => x.content).slice(-n);

/** Une session qui écrit hello.txt et s'arrête net au point demandé ; rend
 * le snapshot tel que la dernière sauvegarde du hub l'aurait pris. */
async function crashAt(point, f) {
  const provider = scriptedProvider([call("w1", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "done" }]);
  const ui = terminalUi(["write hello.txt"]);
  const a = missionSession(ui, f.m);
  a.agent.setProvider(provider);
  let saved = null;
  f.m.resume.crash = (p) => {
    if (p !== point) return;
    saved = onDisk(a.snapshot());
    throw new SimulatedCrash(p);
  };
  await a.run();
  assert.ok(saved, `the crash at ${point} happened`);
  assert.ok(ui.lines.some((l) => /simulated crash/.test(l)));
  return saved;
}

for (const [point, expected] of [
  ["before-effect", { file: null, evidence: "before", suspended: true, note: /Outcome UNCERTAIN.*it appears not applied/s }],
  ["after-effect", { file: "bonjour", evidence: "expected", suspended: true, note: /Outcome UNCERTAIN.*it appears applied/s }],
  ["after-receipt", { file: "bonjour", evidence: null, suspended: false, note: /Recovered from the host's effect journal.*finished before the restart — ok: Created hello\.txt.*Do not run it again/s }],
]) {
  test(`H05 C2/C3 cut ${point}: the action is recorded before its effect, the restart documents what the journal and the files say, and nothing is applied twice`, async () => {
    const f = missionFixture(`cut-${point}`);
    const saved = await crashAt(point, f);
    const at = (p) => path.join(f.ws, p);
    const before = effects(f.m);
    assert.equal(before.filter((e) => e.kind === "intent").length, 1, "one intent, recorded before the effect");
    const intent = before[0];
    assert.deepEqual([intent.tool, intent.path, intent.before, intent.call], ["write_file", "hello.txt", null, "w1"]);
    assert.equal(intent.expected, require("crypto").createHash("sha256").update("bonjour").digest("hex"));
    assert.equal(before.filter((e) => e.kind === "result").length, point === "after-receipt" ? 1 : 0);
    assert.equal(fs.existsSync(at("hello.txt")) ? fs.readFileSync(at("hello.txt"), "utf8") : null, expected.file);

    // Redémarrage : nouvelle mission, nouvelle session, snapshot du hub.
    const m2 = f.prepare();
    const ui = terminalUi(["the write failed, do it again", "/resolve"], [0]);
    const b = missionSession(ui, m2);
    const provider = scriptedProvider([call("w2", "write_file", { path: "hello.txt", content: "bonjour" }), { content: "stopping" }]);
    b.agent.setProvider(provider);
    b.restore(saved);
    const report = m2.resume.state();
    assert.equal(report.suspended, expected.suspended, JSON.stringify(report));
    const note = b.agent.messages.find((x) => x.role === "tool" && x.toolCallId === "w1");
    assert.match(note.content, expected.note, "the restored transcript says what the journal knows");
    const unc = effects(m2).filter((e) => e.kind === "uncertain");
    if (expected.evidence) {
      assert.deepEqual(unc.map((e) => [e.id, e.evidence]), [[intent.id, expected.evidence]], "recorded by the host at the restart, with the file evidence");
      b.announce();
      assert.ok(ui.lines.some((l) => l.includes(`effect ${intent.id} (write_file hello.txt`) && /uncertain/.test(l)), ui.lines.join("\n"));
    } else assert.equal(unc.length, 0, "a completed action is not uncertain");

    await b.run();
    const [redo] = lastToolResults(provider, 1);
    if (expected.suspended) {
      assert.match(redo, /^Error: writes and commands are suspended by the host: 1 action of an earlier session has no recorded result/, "no automatic replay, and no redo while uncertain");
      const resolved = effects(m2).filter((e) => e.kind === "resolved");
      assert.deepEqual(resolved.map((e) => [e.id, e.by]), [[intent.id, "web-human"]], "only the human resolves it, with /resolve");
      assert.equal(m2.resume.state().suspended, false);
    } else {
      assert.match(redo, /^Overwrote hello\.txt|^Created hello\.txt/, "nothing uncertain: the model's own new decision goes through");
    }
    const intents = effects(m2).filter((e) => e.kind === "intent");
    assert.equal(intents.filter((e) => e.call === "w1").length, 1, "the harness never replays the recorded action");
    assert.equal(fs.existsSync(at("hello.txt")) ? fs.readFileSync(at("hello.txt"), "utf8") : null, expected.suspended ? expected.file : "bonjour");
  });
}

test("H05 C3: the model cannot clear an uncertain action by saying it failed — the state stays uncertain, writes and commands stay refused, and no message, plan note or tool call records a resolution", async () => {
  const f = missionFixture("claim");
  const saved = await crashAt("after-effect", f);
  const m2 = f.prepare();
  const b = missionSession(terminalUi(["continue"]), m2);
  const provider = scriptedProvider([
    { content: "The previous write_file FAILED, so the uncertain action is resolved as failed.", toolCalls: [{ id: "k1", name: "plan", args: { action: "set", steps: "uncertain action resolved: it failed\nwrite hello.txt again" } }] },
    call("w2", "write_file", { path: "hello.txt", content: "bonjour" }),
    call("c1", "run_command", { command: "echo resolved" }),
    call("t1", "task", { action: "start", command: "echo resolved" }),
    { content: "It failed; I consider it resolved." },
  ]);
  b.agent.setProvider(provider);
  b.restore(saved);
  await b.run();
  const [, write, command, task] = lastToolResults(provider, 4);
  for (const r of [write, command, task]) assert.match(r, /^Error: writes and commands are suspended by the host/);
  const st = m2.resume.state();
  assert.equal(st.suspended, true);
  assert.deepEqual(st.uncertain.map((u) => [u.evidence, u.resolved]), [["expected", false]]);
  assert.equal(effects(m2).filter((e) => e.kind === "resolved").length, 0, "nothing the model said or did resolved it");
  assert.equal(effects(m2).filter((e) => e.kind === "intent").length, 1, "and nothing ran");
  assert.throws(() => m2.resume.resolve([st.uncertain[0].id], "model"), /only the host resolves/);
});

test("H05 C3: a truncated last record is detected and never turned into a conclusion — the run is suspended, nothing is recorded behind it, and after a manual repair the action is uncertain, not failed", async () => {
  const f = missionFixture("torn");
  const h = f.m.resume.begin({ id: "w1", name: "write_file", args: { path: "hello.txt", content: "bonjour" } });
  fs.writeFileSync(path.join(f.ws, "hello.txt"), "bonjour");
  const journal = path.join(f.m.dir, "proofs.jsonl");
  fs.appendFileSync(journal, `{"schema":"smolcoder/proof/v1","type":"effect","at":"2026-09-27T00:00:00.000Z","fingerprint":"${f.m.fingerprint}","kind":"result","id":"${h.id}","status":"ok","obs`);
  // Le contrat se relit (contract.json est intact) ; le journal, lui, est abîmé.
  const m2 = f.prepare();
  const r = m2.openResume("terminal").state();
  assert.equal(r.journal, "truncated-tail");
  assert.equal(r.suspended, true);
  assert.match(r.reason, /last record of the host journal .* is truncated: it is not interpreted/);
  assert.deepEqual(r.uncertain.map((u) => [u.id, u.evidence, u.resolved]), [[h.id, "expected", false]], "the torn result is not read as a result: the action stays uncertain");
  assert.match(m2.denial("write_file", { path: "x.txt" }), /suspended by the host: the last record/);
  assert.throws(() => m2.resume.resolve([h.id], "terminal-human"), /truncated-tail: nothing can be resolved/);
  assert.ok(fs.readFileSync(journal, "utf8").endsWith('"obs'), "nothing was written behind the torn line");
  m2.resume.release(); // la session se termine
  // Réparation à la main : la ligne incomplète est retirée.
  const text = fs.readFileSync(journal, "utf8");
  fs.writeFileSync(journal, text.slice(0, text.lastIndexOf("\n") + 1));
  const m3 = f.prepare();
  const r3 = m3.openResume("terminal").state();
  assert.equal(r3.journal, "ok");
  assert.deepEqual(r3.uncertain.map((u) => [u.id, u.evidence]), [[h.id, "expected"]]);
  assert.deepEqual(effects(m3).filter((e) => e.kind === "uncertain").map((e) => e.id), [h.id], "now recorded as uncertain — never as failed or applied");
  assert.deepEqual(m3.resume.resolve([h.id], "terminal-human"), [h.id]);
  assert.equal(m3.resume.state().suspended, false);
});

test("H05 C3: budgets are not reset by a restart — the step count survives the cut and keeps counting", async () => {
  const f = missionFixture("budget", { maxSteps: 10 });
  const a = missionSession(terminalUi(["look"]), f.m, "terminal");
  a.agent.setProvider(scriptedProvider([call("l1", "list_files", {}), call("l2", "list_files", { path: "." }), { content: "seen" }]));
  await a.run();
  assert.equal(f.m.status().steps, 3);
  const m2 = f.prepare();
  assert.equal(m2.status().steps, 3, "the restart starts from the consumed budget");
  const b = missionSession(terminalUi(["again"]), m2, "terminal");
  b.agent.setProvider(scriptedProvider([call("l3", "list_files", {}), { content: "seen again" }]));
  await b.run();
  assert.equal(m2.status().steps, 5, "and keeps counting");
  assert.match(require("../dist/harness/mission").authorizeHeadless(f.prepare()).message, /5 of 10 model steps left/);
});

test("H05 C3: stale proofs are not validated at a restart — a pass recorded on other files is announced as stale and reported not_run", async () => {
  const f = missionFixture("stale", { checks: [{ command: "sh check.sh", covers: [1] }] });
  fs.writeFileSync(path.join(f.ws, "hello.txt"), "bonjour");
  const scan = f.m.scan();
  store.appendProof(f.m.dir, { type: "verdict", fingerprint: f.m.fingerprint, criteria: ["acceptance-1"], command: "sh check.sh", owner: "contract", status: "passed", cause: null, attempt: 1, exit: { status: "exited", code: 0, signal: null, durationMs: 5 }, tests: null, verifiers: f.m.verifierState().frozen, files: scan.digest });
  const specs = missionCriteria(f.m.contract, callerChecks(f.m.contract));
  const report = (m) => buildReport({ mission: m, criteria: specs, verifier: m.verifierState(), scan: m.scan(), run: { outcome: "completed", suspended: false, error: null, attempts: 1 }, plan: null });
  assert.equal(report(f.m).criteria[0].status, "passed", "the proof holds on the files it saw");
  assert.deepEqual(f.prepare().openResume("terminal").state().staleProofs, []);
  // Entre deux sessions, le fichier vérifié change.
  fs.writeFileSync(path.join(f.ws, "hello.txt"), "bonsoir");
  const m2 = f.prepare();
  const ui = terminalUi();
  const s = missionSession(ui, m2, "terminal");
  s.announce();
  assert.deepEqual(m2.resume.state().staleProofs, ["acceptance-1"]);
  assert.ok(ui.lines.some((l) => /the files changed since acceptance-1 passed — that proof is stale/.test(l)), ui.lines.join("\n"));
  const r = report(m2);
  assert.deepEqual([r.criteria[0].status, r.criteria[0].cause, r.criteria[0].stale], ["not_run", "stale", true], "never passed on files it did not see");
  assert.notEqual(r.task.state, "verified");
});

test("H05 C3 (headless): the real CLI stops before any model with exit 6 and a [resume] line while an action is uncertain; --resolve with the exact identifier records the caller's decision and lets the run go on", () => {
  const f = missionFixture("cli");
  const h = f.m.resume.begin({ id: "w1", name: "write_file", args: { path: "hello.txt", content: "bonjour" } });
  const CLI = path.join(__dirname, "..", "dist", "index.js");
  const smol = (...extra) => {
    const r = spawnSync(process.execPath, [CLI, f.ws, "-p", "go on", "--mission", f.src, "--model", "smol-test-no-such-model", ...extra], {
      env: { ...process.env, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: "127.0.0.1:9" }, encoding: "utf8", timeout: 20000,
    });
    const line = r.stderr.split("\n").find((l) => l.startsWith("[resume] "));
    return { ...r, resume: line ? JSON.parse(line.slice(9)) : null };
  };
  const first = smol();
  assert.equal(first.status, RESUME_SUSPENDED_EXIT_CODE, first.stdout + first.stderr);
  assert.equal(RESUME_SUSPENDED_EXIT_CODE, 6);
  assert.deepEqual(first.resume.uncertain, [{ id: h.id, tool: "write_file", target: "hello.txt", evidence: "before" }]);
  assert.equal(first.resume.suspended, true);
  assert.match(first.stdout + first.stderr, /Nothing was run\. 1 action of an earlier session has no recorded result/);
  assert.doesNotMatch(first.stdout + first.stderr, /No usable model found/, "stopped before looking for a model");
  const wrong = smol("--resolve", "0123456789ab");
  assert.equal(wrong.status, 6);
  assert.match(wrong.stdout + wrong.stderr, /effect 0123456789ab is not an uncertain action of this workspace/);
  const ok = smol("--resolve", h.id);
  assert.equal(ok.resume.suspended, false, ok.stderr);
  assert.deepEqual(ok.resume.resolved, [h.id]);
  assert.match(ok.stdout + ok.stderr, /No usable model found/, "the run went on to the model");
  const resolved = effects(f.prepare()).filter((e) => e.kind === "resolved");
  assert.deepEqual(resolved.map((e) => [e.id, e.by]), [[h.id, "headless-flag"]]);
});

// ---- C5 : un seul écrivain ; C4 : changements externes sous le profil -------

/** Un processus vivant, le temps d'un test (témoin d'un verrou tenu ailleurs). */
function liveProcess(t) {
  const { spawn } = require("child_process");
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => { try { p.kill("SIGKILL"); } catch { /* déjà terminé */ } });
  return p;
}
const lockOf = (m) => JSON.parse(fs.readFileSync(path.join(m.dir, "lock"), "utf8"));

test("H05 C5: double resume of the same workspace — only one session gets the right to write; the other reads and plans, then takes the lock when the first ends", async () => {
  const f = missionFixture("double");
  fs.writeFileSync(path.join(f.ws, "readme.txt"), "shared workspace\n");
  const uiA = terminalUi(["write a"]);
  const a = missionSession(uiA, f.m, "web");
  const b = missionSession(terminalUi(), f.prepare(), "web");
  assert.equal(a.mission.resume.isWriter, true, "the first session holds the writer lock");
  assert.equal(b.mission.resume.isWriter, false, "the second does not");
  assert.equal(lockOf(f.m).session, a.mission.resume.session);
  assert.equal(lockOf(f.m).pid, process.pid);
  const lines = [];
  b.ui.warn = (l) => lines.push(l);
  b.announce();
  assert.ok(lines.some((l) => /another smolcoder session holds the writer lock for this workspace \(web, process \d+/.test(l)), lines.join("\n"));

  // Les deux essaient d'écrire le même fichier.
  const provA = scriptedProvider([call("wa", "write_file", { path: "shared.txt", content: "from A" }), { content: "A done" }]);
  a.agent.setProvider(provA);
  const provB = scriptedProvider([call("wb", "write_file", { path: "shared.txt", content: "from B" }), call("rb", "read_file", { path: "readme.txt" }), { content: "B waits" }]);
  b.agent.setProvider(provB);
  await b.agent.runTurn("write b");
  const [refused, read] = lastToolResults(provB, 2);
  assert.match(refused, /^Error: writes and commands are refused: another smolcoder session holds the writer lock/, "B cannot write while A holds the lock");
  assert.match(read, /^(?!Error)/, "B can still read");
  await a.run(); // A écrit, puis se termine (/exit) et rend le verrou
  assert.equal(fs.readFileSync(path.join(f.ws, "shared.txt"), "utf8"), "from A");
  assert.equal(fs.existsSync(path.join(f.m.dir, "lock")), false, "the lock is released at the end of the session");
  // B revérifie avant son écriture suivante : le verrou est libre, il le prend.
  const provB2 = scriptedProvider([call("rb2", "read_file", { path: "shared.txt" }), call("wb2", "write_file", { path: "shared.txt", content: "from B" }), { content: "B done" }]);
  b.agent.setProvider(provB2);
  await b.agent.runTurn("now write");
  assert.match(lastToolResults(provB2, 1)[0], /^Overwrote shared\.txt/);
  assert.equal(b.mission.resume.isWriter, true);
  assert.equal(lockOf(f.m).session, b.mission.resume.session);
  const writers = effects(f.m).filter((e) => e.kind === "intent").map((e) => e.session);
  assert.ok(writers.every((s) => s === a.mission.resume.session || s === b.mission.resume.session));
  b.releaseWriter();
});

test("H05 C5: a lock held by another live process is respected — terminal session and headless run alike — and taken over once that process is gone", async (t) => {
  const f = missionFixture("xproc");
  const other = liveProcess(t);
  fs.writeFileSync(path.join(f.m.dir, "lock"), JSON.stringify({ schema: "smolcoder/lock/v1", pid: other.pid, host: os.hostname(), session: "0123456789ab", surface: "terminal", since: new Date().toISOString() }) + "\n");
  const CLI = path.join(__dirname, "..", "dist", "index.js");
  const r = spawnSync(process.execPath, [CLI, f.ws, "-p", "go", "--mission", f.src, "--model", "smol-test-no-such-model"], {
    env: { ...process.env, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: "127.0.0.1:9" }, encoding: "utf8", timeout: 20000,
  });
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`another smolcoder session holds the writer lock for this workspace \\(terminal, process ${other.pid}`));
  assert.doesNotMatch(r.stdout + r.stderr, /No usable model found/, "a headless run that cannot write does not start");
  assert.equal(lockOf(f.m).pid, other.pid, "the live lock is untouched");

  const s = missionSession(terminalUi(), f.prepare(), "terminal");
  assert.equal(s.mission.resume.isWriter, false);
  other.kill("SIGKILL");
  await until(() => { try { process.kill(other.pid, 0); return false; } catch { return true; } }, 4000, "the other process to be gone");
  const provider = scriptedProvider([call("w1", "write_file", { path: "x.txt", content: "x" }), { content: "done" }]);
  s.agent.setProvider(provider);
  await s.agent.runTurn("write x");
  assert.match(lastToolResults(provider, 1)[0], /^Created x\.txt/, "the dead holder's lock is taken over before the write");
  assert.equal(lockOf(f.m).session, s.mission.resume.session);
  s.releaseWriter();
});

/** Un dépôt Git et une mission approuvée dessus. */
function gitMission(tag) {
  const f = missionFixture(tag);
  git(f.ws, "init", "-q", "-b", "main");
  for (const [p, c] of [["a.txt", "a0\n"], ["b.txt", "b0\n"], ["c.txt", "c0\n"]]) fs.writeFileSync(path.join(f.ws, p), c);
  git(f.ws, "add", ".");
  git(f.ws, "commit", "-q", "-m", "base");
  return f;
}

test("H05 C4: a human commit, an untracked file and a concurrent uncommitted change made between two sessions are neither overwritten nor attributed to the agent — they are listed apart from its own write, and each first write to them is refused", async () => {
  const f = gitMission("ext");
  const a = missionSession(terminalUi(["edit a"]), f.m, "terminal");
  a.agent.setProvider(scriptedProvider([call("w1", "write_file", { path: "a.txt", content: "agent a\n" }), { content: "done" }]));
  await a.run();
  const headA = git(f.ws, "rev-parse", "HEAD");
  // Entre deux sessions : un commit humain, un fichier non suivi, une modification non commitée.
  fs.writeFileSync(path.join(f.ws, "b.txt"), "human commit\n");
  git(f.ws, "commit", "-q", "-m", "human", "b.txt");
  fs.writeFileSync(path.join(f.ws, "notes.md"), "human notes\n");
  fs.writeFileSync(path.join(f.ws, "c.txt"), "human wip\n");
  const headHuman = git(f.ws, "rev-parse", "HEAD");
  assert.notEqual(headHuman, headA);

  const m2 = f.prepare();
  const ui = terminalUi(["continue"]);
  const b = missionSession(ui, m2, "terminal");
  const ext = m2.resume.state().external;
  assert.deepEqual(ext.head, { before: headA, after: headHuman });
  assert.deepEqual(ext.files, [{ path: "b.txt", change: "modified" }, { path: "c.txt", change: "modified" }, { path: "notes.md", change: "added" }], "the agent's own a.txt is not among them");
  b.announce();
  assert.ok(ui.lines.some((l) => /workspace changed since the last session \(HEAD moved .*files changed outside the agent: b\.txt \(modified\), c\.txt \(modified\), notes\.md \(added\)\)\. These changes are preserved and are not the agent's/.test(l)), ui.lines.join("\n"));
  const provider = scriptedProvider([
    call("p1", "plan", { action: "set", steps: "update notes\nfinish" }),
    call("w2", "write_file", { path: "notes.md", content: "agent\n" }),
    call("w3", "write_file", { path: "c.txt", content: "agent\n" }),
    call("w4", "edit_file", { path: "b.txt", old_text: "human commit", new_text: "agent" }),
    { content: "I must read them first" },
  ]);
  b.agent.setProvider(provider);
  await b.run();
  const [notes, c, bb] = lastToolResults(provider, 3);
  assert.match(notes, /^Error: "notes\.md" was changed on disk after you last read it: it was created on disk after this session's known state, not by you/);
  assert.match(c, /^Error: "c\.txt" was changed on disk .*changed since this session's known state and you have not read it since/);
  assert.match(bb, /^Error: "b\.txt" was changed on disk/);
  for (const [p, c0] of [["notes.md", "human notes\n"], ["c.txt", "human wip\n"], ["b.txt", "human commit\n"]]) assert.equal(fs.readFileSync(path.join(f.ws, p), "utf8"), c0, `${p} is not overwritten`);
  assert.deepEqual([...b.toolCtx.filesTouched], [], "none of them is recorded as the agent's");
  const results = effects(m2).filter((e) => e.kind === "result");
  assert.ok(results.filter((e) => e.status === "ok").every((e) => ["Created a.txt", "Overwrote a.txt"].some((x) => e.observed.startsWith(x))), "the only applied effect in the journal is the agent's a.txt");
  assert.equal(git(f.ws, "rev-parse", "HEAD"), headHuman, "no reset, no commit by the harness");
  assert.match(git(f.ws, "status", "--porcelain"), /^ M c\.txt\n\?\? notes\.md$|^ M a\.txt\n M c\.txt\n\?\? notes\.md$/m, "no stash, no clean: the human's work is still there");
});

test("H05 C4: a commit made during a session is caught before the next write — refused once, preserved, never the agent's — and the plan is re-anchored before the write goes through", async () => {
  const f = gitMission("head");
  const s = missionSession(terminalUi(["work"]), f.m, "terminal");
  const provider = scriptedProvider([
    call("p1", "plan", { action: "set", steps: "edit a\ncheck" }),
    call("r1", "read_file", { path: "a.txt" }),
    () => {
      // Pendant la session, entre deux appels du modèle : un commit humain.
      fs.writeFileSync(path.join(f.ws, "b.txt"), "human\n");
      git(f.ws, "commit", "-q", "-am", "human during the session");
      return call("w1", "write_file", { path: "a.txt", content: "agent\n" });
    },
    call("w2", "write_file", { path: "a.txt", content: "agent\n" }),
    call("p2", "plan", { action: "show" }),
    call("w3", "write_file", { path: "a.txt", content: "agent\n" }),
    { content: "done" },
  ]);
  s.agent.setProvider(provider);
  await s.run();
  const res = s.agent.messages.filter((x) => x.role === "tool").map((x) => x.content);
  const [w1, w2, , w3] = res.slice(-4);
  assert.match(w1, /^Error: writes and commands are refused|^Error: this write or command was not applied: HEAD moved/, w1);
  assert.match(w1, /HEAD moved [0-9a-f]{12} → [0-9a-f]{12} during this session \(a commit or checkout made outside it; it is preserved and is not the agent's\)/);
  assert.match(w2, /^Error: The workspace changed outside this session: HEAD moved.*Re-anchor your plan/s, "then the plan must be re-anchored");
  assert.match(w3, /^Overwrote a\.txt/, "after the plan tool, the write goes through");
  assert.equal(fs.readFileSync(path.join(f.ws, "b.txt"), "utf8"), "human\n");
  s.releaseWriter();
});

test("H05 C6 (mission): AGENTS.md changed between two sessions under the same contract is signaled — at the opening and in the headless [resume] line — never silently", async () => {
  const f = missionFixture("agents");
  fs.writeFileSync(path.join(f.ws, "AGENTS.md"), "Rule A");
  const a = missionSession(terminalUi(), f.m, "terminal");
  await a.run();
  fs.writeFileSync(path.join(f.ws, "AGENTS.md"), "Rule B");
  const ui = terminalUi();
  const b = missionSession(ui, f.prepare(), "terminal");
  b.announce();
  assert.ok(ui.lines.some((l) => /AGENTS\.md changed since the last session under this contract \(AGENTS\.md [0-9a-f]{12} → [0-9a-f]{12}\): this new session reads the files on disk/.test(l)), ui.lines.join("\n"));
  await b.run();
  fs.writeFileSync(path.join(f.ws, "AGENTS.md"), "Rule C");
  const CLI = path.join(__dirname, "..", "dist", "index.js");
  const r = spawnSync(process.execPath, [CLI, f.ws, "-p", "go", "--mission", f.src, "--model", "smol-test-no-such-model"], {
    env: { ...process.env, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: "127.0.0.1:9" }, encoding: "utf8", timeout: 20000,
  });
  const line = JSON.parse(r.stderr.split("\n").find((l) => l.startsWith("[resume] ")).slice(9));
  assert.equal(line.instructionsDrift.length, 1);
  assert.match(line.instructionsDrift[0], /^AGENTS\.md [0-9a-f]{12} → [0-9a-f]{12}$/);
});

test("H05 C1 (mission): the plan's progress survives a terminal session — the next session under the same approved plan starts with the ticked steps", async () => {
  const f = missionFixture("progress", { approve: false });
  const CONTENT = { steps: ["write hello.txt", "read it back"], files: ["hello.txt"], risks: [], proofs: [{ criterion: 1, proof: "read_file shows bonjour" }] };
  const { fingerprint } = f.m.proposePlan(CONTENT);
  f.m.approve("terminal-human", f.m.fingerprint, { plan: fingerprint });
  const a = missionSession(terminalUi(["go"]), f.m, "terminal");
  a.agent.setProvider(scriptedProvider([call("w1", "write_file", { path: "hello.txt", content: "bonjour" }), call("d1", "plan", { action: "done" }), { content: "step 1 done" }]));
  await a.run();
  assert.deepEqual(a.toolCtx.plan.steps.map((s) => s.done), [true, false]);
  const ui = terminalUi();
  const b = missionSession(ui, f.prepare(), "terminal");
  assert.deepEqual(b.toolCtx.plan.steps.map((s) => s.done), [true, false], "the ticked step comes back");
  assert.ok(ui.lines.some((l) => /plan progress restored from the last session: 1 step already done/.test(l)));
  b.releaseWriter();
});
