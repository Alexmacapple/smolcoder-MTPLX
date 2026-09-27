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
