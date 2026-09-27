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
      const r = replies[Math.min(i++, replies.length - 1)];
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
