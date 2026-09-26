// H03-2 (#16) : backend d'exécution isolé pour macOS (Seatbelt) derrière le
// contrat d'exécuteur. Ces tests tournent partout : le backend y est simulé
// au point d'injection (lanceur et sonde), le profil y est vérifié comme
// texte et comme règles. Les preuves sur macOS réel sont dans
// test/os/seatbelt.os.test.js (npm run test:os), hors de npm test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smol-sbx-home-"));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const { Mission } = require("../dist/harness/mission");
const { hostExecutor, pickShell, shellArgs } = require("../dist/harness/executor");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Session } = require("../dist/session");
const { Terminal } = require("../dist/web/terminal");
const { WebHub } = require("../dist/web/hub");
// Chargé à l'usage : chaque test échoue seul tant que le module n'existe pas.
const sbx = () => require("../dist/harness/sandbox-executor");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const RULES = { protect: [".env", ".env.*", ".git"], except: [".env.example"] };
const WS = "/Users/someone/project";
const TMPD = "/private/var/folders/xx/yy/T/smol-sandbox-abc";

/** Défait l'échappement d'une chaîne du langage de profil. */
const unquote = (s) => JSON.parse(`"${s.replace(/\\(.)/g, (_, ch) => (ch === '"' ? '\\"' : ch === "\\" ? "\\\\" : ch))}"`);

// ---- H03-2 AC1 : le profil Seatbelt est généré depuis la politique ----------

test("H03-2 AC1: the Seatbelt profile is generated from the policy — deny by default, system and workspace readable, workspace and bounded TMPDIR writable, host controls denied last, no network unless named", () => {
  const profile = sbx().seatbeltProfile({ workspace: WS, tmpDir: TMPD, rules: RULES, network: [], hostPaths: ["/Users/someone/.smolcoder", "/Users/someone/.smolcoder.json"] });
  const lines = profile.split("\n").filter((l) => l && !l.startsWith(";"));
  assert.equal(lines[0], "(version 1)");
  assert.equal(lines[1], "(deny default)", "everything not granted below is refused");
  for (const root of ["/usr", "/bin", "/System", "/Library", "/private/etc"]) {
    assert.ok(profile.includes(`(subpath "${root}")`), `${root} is readable`);
  }
  assert.ok(profile.includes(`(allow file-read* file-write* (subpath "${WS}") (subpath "${TMPD}"))`), "the workspace and the bounded TMPDIR are readable and writable");
  assert.ok(!/\(allow[^\n]*file-write\*[^\n]*"\/Users\/someone"\)/.test(profile), "the home folder is never writable");
  assert.ok(!profile.includes('(subpath "/Users/someone")'), "the home folder is never granted");
  assert.ok(!/\/private\/tmp|"\/tmp"/.test(profile), "the shared /tmp is not granted: TMPDIR is bounded");
  const host = profile.indexOf('(deny file-read* file-write* (subpath "/Users/someone/.smolcoder") (subpath "/Users/someone/.smolcoder.json"))');
  assert.ok(host > 0, "the host store and the configuration are denied");
  assert.ok(host > profile.indexOf(`(subpath "${WS}")`), "…after every grant: the last matching rule wins, so no grant reopens them");
  assert.ok(!/network/.test(lines.join("\n")), "no network rule at all: every connection is refused");
  assert.ok(!/mach-lookup[^)]*(SecurityServer|securityd|launchservicesd|pasteboard|appleevents)/i.test(profile), "no keychain, LaunchServices, pasteboard or Apple events service");
});

test("H03-2 AC1: protected names become case-insensitive rules at any depth; an exception reopens only an excepted leaf that no protected folder contains", () => {
  const { protectedPathRules, seatbeltProfile } = sbx();
  const r = protectedPathRules(WS, RULES);
  const denied = (p) => {
    let deny = r.deny.some((re) => new RegExp(re).test(p));
    for (const e of r.except) if (new RegExp(e.leaf).test(p) && !e.notUnder.some((re) => new RegExp(re).test(p))) deny = false;
    return deny;
  };
  for (const p of [".env", "sub/deep/.env", ".ENV", ".env.local", ".git", ".git/config", ".git/hooks/pre-commit", "a/.Git/HEAD", ".git/.env.example", ".env.local/.env.example"]) {
    assert.equal(denied(`${WS}/${p}`), true, `${p} is protected`);
  }
  for (const p of [".env.example", "sub/.env.example", "src/app.js", "environment.txt", "my.env", ".gitignore", "notes/.github/x"]) {
    assert.equal(denied(`${WS}/${p}`), false, `${p} is not protected`);
  }
  assert.equal(denied("/elsewhere/.env"), false, "rules name the workspace only");
  const profile = seatbeltProfile({ workspace: WS, tmpDir: TMPD, rules: RULES, network: [], hostPaths: [] });
  const quoted = [...profile.matchAll(/\(regex "((?:[^"\\]|\\.)*)"\)/g)].map((m) => unquote(m[1]));
  for (const re of [...r.deny, ...r.except.flatMap((e) => [e.leaf, ...e.notUnder])]) assert.ok(quoted.includes(re), `${re} is in the profile`);
  assert.ok(profile.indexOf("(deny file-read-data file-write*") < profile.indexOf("(allow file-read-data file-write* (require-all"), "exceptions come after the protections they lift");
  assert.deepEqual(protectedPathRules(WS, { protect: [], except: [".env.example"] }), { deny: [], except: [] }, "nothing protected, nothing to except");
});

test("H03-2 AC1: paths are quoted for the profile language — quotes, backslashes and regex characters escaped; control characters refused", () => {
  const { seatbeltProfile, protectedPathRules } = sbx();
  const odd = '/tmp/ws "q" (a+b) [x] \\ é';
  const profile = seatbeltProfile({ workspace: odd, tmpDir: TMPD, rules: RULES, network: [], hostPaths: [] });
  assert.ok(profile.includes('(subpath "/tmp/ws \\"q\\" (a+b) [x] \\\\ é")'), "a quote and a backslash are escaped in strings");
  const [deny] = protectedPathRules(odd, { protect: [".env"], except: [] }).deny;
  assert.ok(new RegExp(deny).test(`${odd}/.env`) && !new RegExp(deny).test("/tmp/ws _q_ (a+b) [x] \\ é/.env"), "regex characters of the workspace match only themselves");
  assert.throws(() => seatbeltProfile({ workspace: "/tmp/a\nb", tmpDir: TMPD, rules: RULES, network: [], hostPaths: [] }), /control character/);
});

test("H03-2 AC1: a named destination opens only outgoing connections to its loopback port; nothing ever listens", () => {
  const { seatbeltProfile } = sbx();
  const profile = seatbeltProfile({ workspace: WS, tmpDir: TMPD, rules: RULES, network: ["localhost:8080", "localhost:5173"], hostPaths: [] });
  const net = profile.split("\n").filter((l) => /network/.test(l) && !l.startsWith(";"));
  assert.deepEqual(net, ['(allow network-outbound (remote ip "localhost:8080") (remote ip "localhost:5173"))']);
  assert.throws(() => seatbeltProfile({ workspace: WS, tmpDir: TMPD, rules: RULES, network: ["example.com:443"], hostPaths: [] }), /localhost:<port>/);
});

// ---- H03-2 AC2 : la politique nomme ses destinations réseau -----------------

test("H03-2 AC2: the policy names network destinations as localhost:<port> only; absent means none, and existing policies keep their version", () => {
  const dir = path.join(tmp("smol-sbx-grammar-"), "harness", "0123456789abcdef");
  store.writePolicy(dir, store.DEFAULT_POLICY);
  const read = store.readPolicy(dir);
  assert.equal(read.state, "ok");
  assert.equal(read.policy.network, undefined, "absent: no destination, nothing added in silence");
  assert.equal(store.policyVersion(store.DEFAULT_POLICY), "smolcoder/policy/v1@b8568bb66a5429ae", "the default policy keeps the version it had before #16");
  const file = path.join(dir, "policy.json");
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...base, network: ["localhost:8080", "localhost:65535"] }));
  const named = store.readPolicy(dir);
  assert.equal(named.state, "ok", named.reason);
  assert.deepEqual(named.policy.network, ["localhost:8080", "localhost:65535"]);
  assert.notEqual(named.version, read.version, "the version follows the destinations");
  for (const bad of [["example.com:443"], ["*:443"], ["localhost"], ["localhost:0"], ["localhost:65536"], ["127.0.0.1:80"], ["localhost:08"], [42], "localhost:80", Array.from({ length: 51 }, (_, i) => `localhost:${1000 + i}`)]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, network: bad }));
    const r = store.readPolicy(dir);
    assert.equal(r.state, "unreadable", `${JSON.stringify(bad).slice(0, 40)} is refused`);
    assert.match(r.reason, /network/);
  }
  store.writePolicy(dir, { ...store.DEFAULT_POLICY, network: ["localhost:3000"] });
  assert.deepEqual(store.readPolicy(dir).policy.network, ["localhost:3000"], "the host writes it like any other field");
  assert.throws(() => store.writePolicy(dir, { ...store.DEFAULT_POLICY, network: ["0.0.0.0:3000"] }), /network/, "an invalid destination is never written");
});

// ---- H03-2 AC3 : le backend simulé au point d'injection ---------------------

/** Un lanceur simulé : il enregistre la requête et le programme, ne lance rien. */
function fakeLauncher() {
  const calls = [];
  return {
    calls,
    launch(req, spec) {
      calls.push({ req, spec: spec() }); // le programme, choisi comme au vrai lancement

      if (req.capture === "stream" && req.command !== null) queueMicrotask(() => req.onOutput?.("FAKE\n"));
      return {
        result: Promise.resolve({ started: true, status: "exited", exitCode: 0, signal: null, durationMs: 0, output: req.capture === "buffer" ? "FAKE\n" : "" }),
        write(text) { queueMicrotask(() => req.onOutput?.(`\x1e0\x1e${req.cwd}\x1e\n`)); return true; },
        kill() {},
      };
    },
  };
}
const HEALTHY = () => ({ status: 0, stdout: "SEATBELT_OK\n", stderr: "" });

function isolated(ws, over = {}) {
  const launcher = fakeLauncher();
  const probes = [];
  let policy = over.policy ?? { rules: RULES, network: [] };
  const exec = sbx().createSandboxExecutor({
    workspace: ws,
    policy: () => policy,
    hostPaths: [path.join(HOME, ".smolcoder")],
    canary: HOME, // un dossier hôte qui existe
    platform: "darwin",
    sandboxExec: process.execPath, // un exécutable qui existe partout ; jamais lancé ici
    launch: launcher.launch,
    probe: (exe, args, env) => { probes.push({ exe, args, env }); return (over.probe ?? HEALTHY)(); },
    tmpRoot: tmp("smol-sbx-tmproot-"),
    ...over.deps,
  });
  return { exec, launcher, probes, setPolicy: (p) => (policy = p) };
}

test("H03-2 AC3: with a healthy backend, a request becomes sandbox-exec -p <profile> <shell>, with the bounded TMPDIR added to the requested environment and nothing else", async () => {
  const ws = tmp("smol-sbx-ws-");
  const { exec, launcher, probes } = isolated(ws);
  assert.equal(exec.status.state, "ready", exec.status.reason);
  assert.equal(probes.length, 1, "the backend is probed once, when it is created");
  assert.equal(probes[0].args[0], "-p");
  assert.ok(probes[0].args.includes(fs.realpathSync.native(HOME)), "the probe tries to list a host folder");
  const stat = fs.statSync(exec.tmpDir);
  assert.ok(stat.isDirectory() && (stat.mode & 0o777) === 0o700, "a private temporary folder");
  assert.ok(!exec.tmpDir.startsWith(ws + path.sep), "outside the workspace");
  const shell = pickShell();
  const env = { PATH: "/usr/bin:/bin", HOME, LANG: "C" };
  const req = { surface: "command", command: "npm test", cwd: ws, env, login: false, timeoutMs: 120000, capture: "buffer" };
  const r = await exec.start(req).result;
  assert.equal(r.output, "FAKE\n", "the launcher's result comes back unchanged");
  assert.equal(launcher.calls.length, 1);
  const { req: asked, spec } = launcher.calls[0];
  assert.equal(asked, req, "the request reaches the launcher as it was made");
  assert.equal(spec.exe, process.execPath, "the sandbox-exec binary named at creation");
  assert.equal(spec.args[0], "-p");
  assert.ok(spec.args[1].startsWith("(version 1)") && spec.args[1].includes(`(subpath "${ws}")`), "the generated profile, for this workspace");
  assert.deepEqual(spec.args.slice(2), [shell.exe, ...shellArgs(shell, req)], "then the shell and arguments of the host adapter");
  assert.ok(spec.args.includes("npm test\n__smol_command_status=$?\nwait\nexit \"$__smol_command_status\"") || !/bash/.test(shell.exe), "the command, managed as on the host");
  assert.deepEqual(spec.env, { ...env, TMPDIR: exec.tmpDir + "/" }, "only TMPDIR is added, pointing to the bounded folder");
  const term = { surface: "terminal", command: null, cwd: ws, env, login: false, capture: "stream" };
  exec.start(term);
  assert.deepEqual(launcher.calls[1].spec.args.slice(2), [shell.exe, ...shellArgs(shell, term)], "the persistent shell of the web terminal, without login");
});

test("H03-2 AC3: the profile follows the policy at each start; an unreadable policy runs nothing", async () => {
  const ws = tmp("smol-sbx-ws-");
  const { exec, launcher, setPolicy } = isolated(ws);
  const req = { surface: "command", command: "true", cwd: ws, env: {}, login: false, capture: "buffer" };
  await exec.start(req).result;
  assert.ok(!launcher.calls[0].spec.args[1].includes("network-outbound"));
  setPolicy({ rules: { protect: ["secrets"], except: [] }, network: ["localhost:4000"] });
  await exec.start(req).result;
  const second = launcher.calls[1].spec.args[1];
  assert.ok(second.includes('(remote ip "localhost:4000")') && /\[sS\]\[eE\]\[cC\]/.test(second), "the new destination and protection are in the next profile");
  setPolicy("policy.json is not valid JSON");
  const blocked = await exec.start(req).result;
  assert.equal(launcher.calls.length, 2, "nothing is launched");
  assert.deepEqual({ started: blocked.started, status: blocked.status }, { started: false, status: "spawn_error" });
  assert.match(blocked.error, /access policy.*not valid JSON.*nothing was run/s);
});

// ---- H03-2 AC4 : sans backend, le profil renforcé bloque --------------------

test("H03-2 AC4: without a usable backend the executor refuses every request — not macOS, no sandbox-exec, a failing probe, a probe that reads the host store, a workspace holding the home folder — and never launches anything", async () => {
  const ws = tmp("smol-sbx-ws-");
  const cases = [
    [{ deps: { platform: "linux" } }, /only on macOS.*linux/],
    [{ deps: { sandboxExec: path.join(ws, "no-such-sandbox-exec") } }, /sandbox-exec.*not found/],
    [{ probe: () => ({ status: 65, stdout: "", stderr: "sandbox-exec: unbound variable: nonsense at <input string>\n" }) }, /probe failed.*unbound variable/],
    [{ probe: () => ({ status: 3, stdout: "LEAK\n", stderr: "" }) }, /probe.*read the host store/],
    [{ probe: () => ({ status: null, stdout: "", stderr: "", error: "spawnSync ETIMEDOUT" }) }, /probe failed.*ETIMEDOUT/],
  ];
  for (const [over, why] of cases) {
    const { exec, launcher } = isolated(ws, over);
    assert.equal(exec.status.state, "unavailable", String(why));
    assert.match(exec.status.reason, why);
    let closed = false;
    const run = exec.start({ surface: "command", command: "touch ran", cwd: ws, env: {}, login: false, capture: "buffer", onClose: () => (closed = true) });
    const r = await run.result;
    assert.deepEqual({ started: r.started, status: r.status, exitCode: r.exitCode }, { started: false, status: "spawn_error", exitCode: null });
    assert.match(r.error, /isolated execution unavailable.*nothing was run.*never.*unconfined/s);
    assert.equal(run.write("x\n"), false);
    await sleep(5);
    assert.equal(closed, false, "no process, so no stream to close");
    assert.equal(launcher.calls.length, 0, "nothing is ever launched");
  }
  const { exec: homeWs, probes } = isolated(path.dirname(HOME));
  assert.equal(homeWs.status.state, "unavailable");
  assert.match(homeWs.status.reason, /contains the home folder/);
  assert.equal(probes.length, 0, "refused before any probe");
  assert.ok(!fs.existsSync(path.join(ws, "ran")));
});

// ---- Branchement : le profil --mission sert les quatre surfaces -------------

function contract(ws) {
  const file = path.join(tmp("smol-sbx-src-"), "contract.json");
  fs.writeFileSync(file, JSON.stringify({ schema: "smolcoder/contract/v1", id: "sbx-check", title: "Isolation", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 200 } }));
  const m = Mission.prepare({ source: file, workspace: ws, dataDir: tmp("smol-sbx-data-") });
  m.approve("terminal-human");
  return m;
}
const FAKE_MODEL = { id: "fake-model", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8000 };
function quietUi() {
  const lines = [];
  return {
    lines, slashCommands: [], hintLeft: "", start() {}, close() {}, refresh() {},
    async readInput() { return "/exit"; }, async select() { return null; }, async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult(s) { lines.push(s); },
    println(s = "") { lines.push(String(s)); }, status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {},
  };
}
function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen, label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}
const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });
const marker = (name) => `node -e "require('fs').writeFileSync('${name}','ran')"`;

test("H03-2 AC3: under --mission a session installs the isolated executor on all four surfaces; without --mission nothing changes", () => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  const { exec } = isolated(ws);
  const s = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: exec });
  assert.equal(s.executor, exec, "the web terminal takes it from the session");
  assert.equal(s.toolCtx.executor, exec, "run_command and the automatic checks");
  assert.equal(s.taskManager.executor, exec, "background tasks");
  const own = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal" });
  assert.equal(own.executor.status.backend, "seatbelt", "by default the session builds the Seatbelt backend for its mission");
  assert.notEqual(own.executor, hostExecutor);
  const plain = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help" });
  assert.equal(plain.executor, undefined);
  assert.equal(plain.toolCtx.executor, undefined, "outside the profile: the host adapter, as before");
  assert.equal(plain.taskManager.executor, hostExecutor);
});

test("H03-2 AC4: under --mission with no usable backend, none of the four surfaces runs anything, and each says why", async (t) => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  // Les tâches passent la politique sans question : seul l'exécuteur les arrête.
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, tasks: "workspace" });
  const blocked = sbx().missionExecutor(m, { platform: "linux" });
  assert.equal(blocked.status.state, "unavailable");
  const ui = quietUi();
  const session = new Session(ui, { workspace: ws, chosen: FAKE_MODEL, prefs: { mode: "bypass" }, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: blocked });
  let term;
  t.after(() => { term?.close(); session.taskManager.killAll(); });
  // 1. run_command et 2. task.start, par les outils du modèle.
  const provider = scriptedProvider([call("c1", "run_command", { command: marker("ran-command") }), call("t1", "task", { action: "start", command: marker("ran-task") }), { content: "done" }]);
  session.agent.setProvider(provider);
  await session.agent.runTurn("run them");
  const results = provider.seen.at(-1).filter((x) => x.role === "tool").map((x) => x.content);
  assert.match(results[0], /^Error: could not start command: isolated execution unavailable \(.*only on macOS.*\).*nothing was run/s);
  assert.match(results[1], /exited almost immediately \(exit code -1\)[\s\S]*failed to start: isolated execution unavailable/);
  // 3. Vérification automatique : même contexte d'outils que la session.
  const checker = new Agent(scriptedProvider([{ content: "done" }]), "edit", "sys", session.toolCtx, new ContextManager(8000, 2000), new EventBus(), quietUi(), false, 30, { command: marker("ran-check"), maxAttempts: 1 }, m);
  await assert.rejects(checker.runTurn("finish"), /Acceptance checks still fail[\s\S]*isolated execution unavailable/, "the check is never reported as passed");
  assert.equal(checker.verificationResult.passed, false);
  assert.match(checker.verificationResult.output, /isolated execution unavailable/);
  // 4. Terminal web : l'exécuteur de la session, comme le hub le lui donne.
  let out = "";
  term = new Terminal("t1", ws, { output: (s) => (out += s), done() {} }, undefined, session.executor);
  term.write(marker("ran-terminal"));
  await until(() => /no shell running/.test(out), 5000, "the terminal refusal");
  assert.match(out, /could not start .*isolated execution unavailable/);
  for (const name of ["ran-command", "ran-task", "ran-check", "ran-terminal"]) assert.ok(!fs.existsSync(path.join(ws, name)), `${name}: nothing ran`);
});

test("H03-2 AC5: the session says whether isolation is active; outside the profile it says nothing about it", () => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  const ready = quietUi();
  new Session(ready, { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: isolated(ws).exec }).announce();
  assert.ok(ready.lines.some((l) => /^· isolation: macOS Seatbelt/.test(l)), ready.lines.join("\n"));
  const off = quietUi();
  new Session(off, { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: sbx().missionExecutor(m, { platform: "win32" }) }).announce();
  assert.ok(off.lines.some((l) => /^· isolation unavailable \(.*win32.*\) — under the mission profile no command runs/.test(l)), off.lines.join("\n"));
  const plain = quietUi();
  new Session(plain, { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help" }).announce();
  assert.ok(!plain.lines.some((l) => /isolation/.test(l)));
});

// ---- Hub web : le terminal d'une mission prend l'exécuteur de sa session ----

function request(hub, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: hub.port, method, path: url, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function hubTerminal(ws, m, executor) {
  const factory = async (ui, workspace) => ({
    chosen: { id: "fake-model", backend: "ollama" }, workspace, onExit: null, mission: m, ...(executor ? { executor } : {}),
    taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => [] },
    state: () => ({ mode: "edit", model: "fake-model", backend: "ollama", workspace, urls: [], commands: [] }),
    announce() {}, restore() {}, snapshot: () => ({ messages: [], plan: [], filesTouched: [], commandsRun: [], originalRequest: "", currentRequest: "", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
    async suggestTitle() { return null; },
    async run() { for (;;) { if ((await ui.readInput()) === "/exit") return; } },
  });
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir: tmp("smol-sbx-hub-"), factory, quiet: true });
  const sent = [];
  const send = hub.send.bind(hub);
  hub.send = (ev) => { sent.push(ev); send(ev); };
  await hub.start();
  const k = "?k=" + hub.authToken;
  const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
  for (let i = 0; i < 80 && !hub.live.get(id)?.session; i++) await sleep(25);
  const { tid } = JSON.parse((await request(hub, "POST", "/term/open" + k, { sid: id })).body);
  const output = () => sent.filter((e) => e.t === "term" && e.tid === tid).map((e) => e.s).join("");
  return { hub, output, input: (text) => request(hub, "POST", "/term/input" + k, { sid: id, tid, text }) };
}

test("H03-2 AC4: the web hub gives a mission terminal its session's isolated executor, and blocks it when the session has none", async () => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  const { exec, launcher } = isolated(ws);
  const withIt = await hubTerminal(ws, m, exec);
  try {
    await until(() => launcher.calls.length >= 1, 5000, "the terminal's shell");
    assert.equal(launcher.calls[0].req.surface, "terminal", "the session's isolated executor starts the shell");
  } finally {
    withIt.hub.close();
  }
  const without = await hubTerminal(ws, m, null);
  try {
    await until(() => /could not start/.test(without.output()), 5000, "the refusal");
    assert.match(without.output(), /isolated execution unavailable/);
    await without.input(marker("ran-hub"));
    await sleep(300);
    assert.ok(!fs.existsSync(path.join(ws, "ran-hub")), "no unconfined shell behind a mission terminal");
  } finally {
    without.hub.close();
  }
});
