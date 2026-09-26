// H03-1 (#15) : contrat d'exécuteur unique. Trois volets : la caractérisation
// des chemins que l'extraction de l'exécuteur déplace (figée sur le code
// d'avant, elle doit rester verte), la preuve que les quatre surfaces passent
// par un exécuteur injecté, et le contrat de l'adaptateur hôte.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { executeTool } = require("../dist/tools/index");
const { pickShell } = require("../dist/tools/shell");
const { TaskManager } = require("../dist/tools/tasks");
const { Terminal } = require("../dist/web/terminal");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const missingDir = (tag) => path.join(os.tmpdir(), `smol-exec-missing-${tag}-${process.pid}-${Date.now()}`);
const bashOnly = (t) => { if (!/bash/.test(pickShell().exe)) { t.skip("this check uses bash syntax"); return true; } return false; };

// ---- H03-1 AC2 : caractérisation (comportement d'avant l'exécuteur) --------

test("H03-1 AC2: a web terminal whose directory is gone reports the launch failure, retries once, then stops", async (t) => {
  if (bashOnly(t)) return;
  const { exe, label } = pickShell();
  let out = "";
  const term = new Terminal("t1", missingDir("term"), { output: (s) => (out += s), done() {} });
  t.after(() => term.close());
  await until(() => /keeps exiting/.test(out), 10000, "the second quick exit");
  const failed = `\\[could not start ${esc(label)}: spawn ${esc(exe)} ENOENT\\]\\n`;
  assert.match(plain(out), new RegExp(
    `^${esc(label)} · no TTY: interactive programs will not work · ctrl\\+c interrupts\\n` +
    `${failed}\\n\\[shell exited with code (-\\d+) — starting a new one\\]\\n` +
    `${failed}\\n\\[${esc(label)} keeps exiting \\(code \\1\\) — close this tab and open a new terminal\\]\\n$`));
});

test("H03-1 AC2: ctrl+c in the web terminal kills the running command with its shell, says so, and the next line runs in a fresh shell", async (t) => {
  if (bashOnly(t)) return;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smol-exec-term-")));
  let out = "", pid;
  const dones = [];
  const term = new Terminal("t1", dir, { output: (s) => (out += s), done: (code) => dones.push(code) });
  t.after(() => { term.close(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "worker.cjs"), "require('fs').writeFileSync('worker.pid', String(process.pid)); console.log('STARTED'); setInterval(() => {}, 1000);");
  term.write("node worker.cjs");
  await until(() => /STARTED/.test(out), 15000, "the worker");
  pid = Number(fs.readFileSync(path.join(dir, "worker.pid"), "utf8"));
  term.interrupt();
  await until(() => /\[interrupted\]/.test(out), 15000, "the interruption");
  await until(() => !alive(pid), 5000, "the worker to die with its shell");
  term.write("echo after-interrupt");
  await until(() => dones.length >= 1, 15000, "the line after the interruption");
  assert.deepEqual(dones, [0], "the interrupted line reports no exit code; the next one does");
  assert.match(plain(out), /❯ node worker\.cjs\nSTARTED\n\n\[interrupted\]\n❯ echo after-interrupt\nafter-interrupt\n$/);
});

test("H03-1 AC2: a background task that cannot start is reported as exited with code -1 and the system's message", async () => {
  const tasks = new TaskManager(missingDir("task"));
  const id = tasks.start("echo never");
  await until(() => !tasks.hasRunning(), 5000, "the launch failure");
  assert.equal(tasks.logs(id), `Task ${id} [exited code -1] echo never\n[failed to start: spawn ${pickShell().exe} ENOENT]`);
  assert.match(tasks.list(), new RegExp(`^id  status  age  command\\n${id}  exited\\(-1\\)  \\d+s  echo never$`));
});

test("H03-1 AC2: a background task reports its real exit code, and none when a signal ended it", async (t) => {
  if (bashOnly(t)) return;
  const tasks = new TaskManager(process.cwd());
  t.after(() => tasks.killAll());
  const exited = tasks.start("exit 3");
  const killed = tasks.start("kill -9 $$");
  await until(() => !tasks.hasRunning(), 5000, "both tasks to end");
  assert.equal(tasks.logs(exited), `Task ${exited} [exited code 3] exit 3\n(no output yet)`);
  assert.equal(tasks.logs(killed), `Task ${killed} [exited] kill -9 $$\n(no output yet)`);
  assert.match(tasks.list(), new RegExp(`\\n${exited}  exited\\(3\\)  \\d+s  exit 3\\n${killed}  exited  \\d+s  kill -9 \\$\\$$`));
});

// ---- H03-1 AC1 AC3 : les quatre surfaces passent par l'exécuteur injecté ----

/** Un faux exécuteur : il enregistre chaque requête et ne lance rien. Le shell
 * persistant simulé répond à chaque ligne par la sentinelle du terminal. */
function fakeExecutor() {
  const calls = [], writes = [];
  return {
    calls,
    writes,
    start(req) {
      calls.push(req);
      if (req.capture === "stream" && req.command !== null) queueMicrotask(() => req.onOutput?.(`FAKE ${req.surface}\n`));
      return {
        result: Promise.resolve({ started: true, status: "exited", exitCode: 0, signal: null, durationMs: 0, output: req.capture === "buffer" ? `FAKE ${req.surface}\n` : "" }),
        write(text) {
          writes.push(text);
          queueMicrotask(() => req.onOutput?.(`FAKE terminal\n\x1e0\x1e${req.cwd}\x1e\n`));
          return true;
        },
        kill() {},
      };
    },
  };
}

test("H03-1 AC1 AC3: the four surfaces go through the injected executor — run_command, task.start, automatic checks, web terminal", async (t) => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smol-exec-inject-")));
  const fake = fakeExecutor();
  const marker = (name) => `node -e "require('fs').writeFileSync('${name}','ran')"`;
  const taskManager = new TaskManager(ws, fake);
  const toolCtx = { workspace: ws, taskManager, plan: new Plan(), filesTouched: new Set(), commandsRun: [], executor: fake };
  let term;
  t.after(() => { term?.close(); taskManager.killAll(); fs.rmSync(ws, { recursive: true, force: true }); });

  // 1. run_command et 2. task.start, par l'outil du modèle.
  const shown = await executeTool("run_command", { command: marker("ran-command") }, toolCtx);
  const started = await executeTool("task", { action: "start", command: marker("ran-task") }, toolCtx);
  // 3. Vérification automatique : la commande d'acceptation de l'appelant.
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {} };
  const provider = { label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; }, chat: async () => ({ content: "Done", toolCalls: [] }) };
  const agent = new Agent(provider, "edit", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, false, 30, { command: marker("ran-check") });
  await agent.runTurn("finish the task");
  // 4. Terminal web : le shell persistant, puis une ligne.
  const dones = [];
  term = new Terminal("t1", ws, { output() {}, done: (code) => dones.push(code) }, undefined, fake);
  term.write(marker("ran-terminal"));
  await until(() => dones.length >= 1, 5000, "the terminal line");

  const bySurface = {};
  for (const c of fake.calls) bySurface[c.surface] = (bySurface[c.surface] ?? 0) + 1;
  assert.deepEqual(bySurface, { command: 1, task: 1, check: 1, terminal: 1 }, "each surface asks the injected executor exactly once");
  for (const name of ["ran-command", "ran-task", "ran-check", "ran-terminal"]) {
    assert.equal(fs.existsSync(path.join(ws, name)), false, `${name}: nothing may run beside the injected executor`);
  }
  // Ce que chaque surface demande : délais, capture, environnement et shell de
  // connexion du profil courant, inchangés.
  const asked = (surface) => {
    const r = fake.calls.find((c) => c.surface === surface);
    return { command: r.command, cwd: r.cwd, capture: r.capture, timeoutMs: r.timeoutMs, login: r.login, cancellable: r.signal !== undefined };
  };
  assert.deepEqual(asked("command"), { command: marker("ran-command"), cwd: ws, capture: "buffer", timeoutMs: 120000, login: true, cancellable: false });
  assert.deepEqual(asked("check"), { command: marker("ran-check"), cwd: ws, capture: "buffer", timeoutMs: 120000, login: true, cancellable: true });
  assert.deepEqual(asked("task"), { command: marker("ran-task"), cwd: ws, capture: "stream", timeoutMs: undefined, login: true, cancellable: true });
  assert.deepEqual(asked("terminal"), { command: null, cwd: ws, capture: "stream", timeoutMs: undefined, login: true, cancellable: false });
  for (const s of ["command", "check", "task"]) assert.equal(fake.calls.find((c) => c.surface === s).env, process.env, `${s}: the host environment, as before`);
  assert.deepEqual(fake.calls.find((c) => c.surface === "terminal").env, { ...process.env, TERM: "dumb" });
  // Les surfaces rendent le résultat de l'exécuteur injecté, projeté comme avant.
  assert.equal(shown, "FAKE command\n\n[exit code 0 in 0.0s]");
  assert.match(started, /^Task t1 exited almost immediately \(exit code 0\)\. Command: .*\nEarly output:\nFAKE task\n/);
  assert.equal(agent.outcome, "completed");
  assert.deepEqual({ passed: agent.verificationResult.passed, output: agent.verificationResult.output }, { passed: true, output: "FAKE check\n\n[exit code 0 in 0.0s]" });
  assert.deepEqual(dones, [0]);
  assert.equal(fake.writes.length, 1);
  assert.ok(fake.writes[0].includes(marker("ran-terminal")), "the line reaches the shell through the executor's stdin");
});

// ---- H03-1 AC1 : aucun lancement de processus hors de l'exécuteur ----------

test("H03-1 AC1: outside the executor, no source file launches processes, except the two harness-internal probes", () => {
  const src = path.join(__dirname, "..", "src");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const launching = walk(src)
    .filter((f) => f.endsWith(".ts") && /(?:from\s+|require\()\s*["'](?:node:)?child_process["']/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(src, f).split(path.sep).join("/"))
    .sort();
  // detect.ts : `docker ps` / `podman ps`, découverte des ports d'un serveur
  // de modèles. tools/check.ts : `node --check` sur une copie temporaire et
  // `compile()` Python, analyse syntaxique d'un fichier écrit, sans l'exécuter.
  // Ni l'un ni l'autre n'exécute une commande du projet.
  assert.deepEqual(launching, ["detect.ts", "harness/executor.ts", "tools/check.ts"]);
});

// ---- H03-1 AC1 : le contrat de l'adaptateur hôte ---------------------------

const shape = (r) => ({ started: r.started, status: r.status, exitCode: r.exitCode, signal: r.signal });

test("H03-1 AC1: the host executor streams a one-shot command and returns its typed result, output left to the stream", async () => {
  const { hostExecutor } = require("../dist/harness/executor");
  let streamed = "";
  const run = hostExecutor.start({ surface: "task", command: 'node -e "console.log(\'streamed\');process.exit(4)"', cwd: process.cwd(), env: process.env, login: false, capture: "stream", onOutput: (s) => (streamed += s) });
  const r = await run.result;
  assert.deepEqual(shape(r), { started: true, status: "exited", exitCode: 4, signal: null });
  assert.ok(Number.isFinite(r.durationMs) && r.durationMs >= 0);
  assert.equal(r.output, "", "stream mode keeps nothing in the result");
  assert.equal(streamed, "streamed\n");
  assert.equal(run.write("ignored\n"), false, "a one-shot command has no open stdin");
});

test("H03-1 AC1: a persistent shell reads its lines on stdin; kill() ends it by signal, and onClose follows the settled result", async (t) => {
  if (bashOnly(t)) return;
  const { hostExecutor } = require("../dist/harness/executor");
  const events = [];
  let streamed = "";
  const run = hostExecutor.start({ surface: "terminal", command: null, cwd: process.cwd(), env: process.env, login: false, capture: "stream", onOutput: (s) => (streamed += s), onClose: (code) => events.push(["close", code]) });
  run.result.then((r) => events.push(["result", r.status, r.signal]));
  assert.equal(run.write("echo from-stdin\n"), true);
  await until(() => /from-stdin/.test(streamed), 10000, "the line's output");
  run.kill();
  await until(() => events.length >= 2, 10000, "the end of the shell");
  assert.deepEqual(events, [["result", "signaled", "SIGKILL"], ["close", null]]);
  assert.equal(run.write("echo late\n"), false, "nothing is written to a shell that is gone");
});

test("H03-1 AC1: a launch failure settles the result as spawn_error before onClose reports the system's negative code", async () => {
  const { hostExecutor } = require("../dist/harness/executor");
  const events = [];
  const run = hostExecutor.start({ surface: "terminal", command: null, cwd: missingDir("exec"), env: process.env, login: false, capture: "stream", onClose: (code) => events.push(["close", code]) });
  run.result.then((r) => events.push(["result", r.status, r.started, /ENOENT/.test(r.error)]));
  await until(() => events.length >= 2, 5000, "the launch failure");
  assert.deepEqual(events[0], ["result", "spawn_error", false, true]);
  assert.equal(events[1][0], "close");
  assert.ok(events[1][1] < 0, `the raw close code is negative, got ${events[1][1]}`);
});
