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
process.env.USERPROFILE = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const { Mission } = require("../dist/harness/mission");
const { hostExecutor, launch, pickShell, shellArgs } = require("../dist/harness/executor");
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
  // #17 : /bin et /Library entier ne sont plus accordés (docs/allowlist-outils.md).
  for (const root of ["/usr", "/System", "/Library/Developer", "/opt", "/private/etc"]) {
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
  assert.ok(stat.isDirectory(), "a private temporary folder");
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700, "the folder is private");
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

// ---- #46 : le dossier temporaire privé vit et meurt avec la session ---------

/** Le lanceur commun réel, sans sandbox-exec : le shell de la requête tourne
 * sur l'hôte, avec le TMPDIR privé que le bac lui donne. De vrais processus,
 * pour prouver l'ordre de la fermeture partout où npm test tourne ; le
 * confinement lui-même est prouvé sur macOS réel (test/os/). `observe` voit
 * chaque requête avant son lancement. */
function unconfined(observe = () => {}) {
  return (req, spec) => {
    observe(req);
    return launch(req, () => {
      const s = spec(); // sandbox-exec -p <profil> <shell> <arguments>
      return { exe: s.args[2], args: s.args.slice(3), env: s.env };
    });
  };
}
/** Une commande qui ne s'arrête pas d'elle-même et récrée son TMPDIR à chaque
 * battement : vivante après la suppression, elle ferait réapparaître le dossier. */
const TICK = `node -e "const fs=require('fs');setInterval(()=>{fs.mkdirSync(process.env.TMPDIR,{recursive:true});fs.writeFileSync(process.env.TMPDIR+'tick',String(Date.now()))},20)"`;
const REFUSED_CLOSED = /isolated execution unavailable \(.*closed.*\).*nothing was run.*never falls back to the unconfined shell/s;

test("#46 AC1: closing the isolated executor removes its private temporary folder with everything in it — a folder a command made unreadable included, a link removed but never followed — and the executor then says it is closed", (t) => {
  const ws = tmp("smol-sbx-ws-");
  const { exec } = isolated(ws, { policy: { rules: RULES, network: [], listen: ["localhost:5173"] } });
  const dir = exec.tmpDir;
  assert.ok(fs.statSync(dir).isDirectory());
  fs.writeFileSync(path.join(dir, "agent-temp.txt"), "left by a command");
  fs.mkdirSync(path.join(dir, "locked", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "locked", "deep", "file"), "x");
  fs.chmodSync(path.join(dir, "locked"), 0o000);
  // En cas d'échec avant la fermeture, le lanceur doit pouvoir supprimer la passe.
  t.after(() => { try { fs.chmodSync(path.join(dir, "locked"), 0o700); } catch { /* déjà supprimé */ } });
  const elsewhere = tmp("smol-sbx-elsewhere-");
  fs.writeFileSync(path.join(elsewhere, "keep.txt"), "keep");
  fs.symlinkSync(elsewhere, path.join(dir, "link"));
  assert.deepEqual(exec.listening(), ["localhost:5173"]);
  assert.equal(exec.close(), null, "removed: no failure to report");
  assert.equal(fs.existsSync(dir), false, "the private folder is gone");
  assert.equal(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8"), "keep", "the link was removed, its target untouched");
  assert.equal(exec.tmpDir, null, "no private folder any more");
  assert.equal(exec.status.state, "unavailable");
  assert.match(exec.status.reason, /closed/);
  assert.deepEqual(exec.listening(), [], "a closed sandbox grants no listening");
});

test("#46 AC1: after closing, every surface's command is refused and nothing runs — never the host shell", async () => {
  const ws = tmp("smol-sbx-ws-");
  const { exec, launcher } = isolated(ws);
  await exec.start({ surface: "command", command: "true", cwd: ws, env: {}, login: false, capture: "buffer" }).result;
  assert.equal(launcher.calls.length, 1, "before closing, the sandbox launches");
  exec.close();
  for (const surface of ["command", "task", "check", "terminal"]) {
    let closed = false;
    const run = exec.start({ surface, command: surface === "terminal" ? null : marker(`ran-${surface}`), cwd: ws, env: process.env, login: false, capture: surface === "command" || surface === "check" ? "buffer" : "stream", onClose: () => (closed = true) });
    const r = await run.result;
    assert.deepEqual({ started: r.started, status: r.status, exitCode: r.exitCode }, { started: false, status: "spawn_error", exitCode: null }, surface);
    assert.match(r.error, REFUSED_CLOSED, surface);
    assert.equal(run.write("x\n"), false, `${surface}: no shell to write to`);
    await sleep(20);
    assert.equal(closed, false, `${surface}: no process, so no stream to close`);
  }
  assert.equal(launcher.calls.length, 1, "nothing is launched after closing");
  await sleep(300);
  for (const surface of ["command", "task", "check"]) assert.ok(!fs.existsSync(path.join(ws, `ran-${surface}`)), `${surface}: nothing ran, on the host or elsewhere`);
});

test("#46 AC1: a second close does nothing — not even to a folder that reappeared at the same path; an executor that refuses from the start closes without effect", async () => {
  const ws = tmp("smol-sbx-ws-");
  const { exec } = isolated(ws);
  const dir = exec.tmpDir;
  assert.equal(exec.close(), null);
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "someone-else.txt"), "not this session's");
  assert.equal(exec.close(), null, "the second close reports nothing");
  assert.equal(fs.readFileSync(path.join(dir, "someone-else.txt"), "utf8"), "not this session's", "and removes nothing");
  fs.rmSync(dir, { recursive: true, force: true });
  const off = sbx().unavailableExecutor("no backend in this test");
  assert.equal(off.close(), null);
  assert.equal(off.close(), null);
  const r = await off.start({ surface: "command", command: "true", cwd: ws, env: {}, login: false, capture: "buffer" }).result;
  assert.equal(r.status, "spawn_error");
});

test("#46 AC2: closing kills a command the sandbox still runs before it removes the folder, and nothing recreates it", async (t) => {
  const ws = tmp("smol-sbx-ws-");
  const kills = [];
  let dir = null;
  const { exec } = isolated(ws, { deps: { launch: (req, spec) => {
    const run = unconfined()(req, spec);
    return { result: run.result, write: (s) => run.write(s), kill() { kills.push(fs.existsSync(dir)); run.kill(); } };
  } } });
  dir = exec.tmpDir;
  const run = exec.start({ surface: "command", command: TICK, cwd: ws, env: process.env, login: false, capture: "buffer" });
  let settled = false;
  void run.result.then(() => (settled = true));
  t.after(() => { if (!settled) run.kill(); });
  await until(() => fs.existsSync(path.join(dir, "tick")), 10000, "the command writing in its TMPDIR");
  assert.equal(exec.close(), null);
  assert.deepEqual(kills, [true], "killed once, while its folder still existed");
  assert.equal(fs.existsSync(dir), false);
  const r = await run.result;
  assert.equal(r.status, process.platform === "win32" ? "exited" : "signaled", "the command was killed, not left to finish");
  await sleep(300);
  assert.equal(fs.existsSync(dir), false, "the command is dead: nothing recreated the folder");
});

test("#46 AC2: at the end of a session its background task is killed before the private folder is removed, then every start is refused", async (t) => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  const aborted = [];
  let dir = null;
  // Enregistré avant celui du lanceur : voit le dossier au moment de l'arrêt.
  const { exec } = isolated(ws, { deps: { launch: unconfined((req) => req.signal?.addEventListener("abort", () => aborted.push(fs.existsSync(dir)), { once: true })) } });
  dir = exec.tmpDir;
  const ui = quietUi();
  const session = new Session(ui, { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: exec });
  t.after(() => session.taskManager.killAll());
  let ended = false;
  session.onExit = () => (ended = true);
  session.taskManager.start(TICK);
  await until(() => fs.existsSync(path.join(dir, "tick")), 10000, "the background task writing in its TMPDIR");
  await session.shutdown();
  assert.equal(ended, true);
  assert.deepEqual(aborted, [true], "the task was stopped while its folder still existed");
  assert.equal(fs.existsSync(dir), false, "the private folder is removed at the end of the session");
  assert.match(session.taskManager.list(), /t1 {2}stopped/);
  await sleep(300);
  assert.equal(fs.existsSync(dir), false, "the task is dead: nothing recreated the folder");
  const after = await session.toolCtx.executor.start({ surface: "command", command: marker("ran-after-end"), cwd: ws, env: process.env, login: false, capture: "buffer" }).result;
  assert.match(after.error, REFUSED_CLOSED, "the tools' executor refuses once the session has ended");
  await session.shutdown();
  assert.ok(!fs.existsSync(path.join(ws, "ran-after-end")));
});

test("#46 AC2: a session that fails to open closes the sandbox it had built", () => {
  const ws = tmp("smol-sbx-ws-");
  const m = contract(ws);
  const { exec } = isolated(ws);
  const dir = exec.tmpDir;
  const broken = Object.create(m);
  broken.openResume = () => { throw new Error("the host store cannot be read in this test"); };
  assert.throws(() => new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: broken, surface: "web", isolation: exec }), /cannot be read in this test/);
  assert.equal(fs.existsSync(dir), false, "no private folder outlives a session that never opened");
});

test("#46 AC2: the web hub closes a session's sandbox when the session is closed, when it is deleted, when it is closed while still starting, and for every open session when the hub stops", async () => {
  const ws = tmp("smol-sbx-ws-");
  const dirs = [];
  let gate = null;
  const factory = async (ui, workspace) => {
    if (gate) await gate;
    const { exec } = isolated(workspace);
    dirs.push(exec.tmpDir);
    return new Session(ui, { workspace, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: contract(workspace), surface: "web", isolation: exec });
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir: tmp("smol-sbx-hub-"), factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  const open = async () => {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    await until(() => hub.live.get(id)?.session, 5000, "the session");
    return { id, dir: dirs.at(-1) };
  };
  try {
    // 1. Fermée depuis la page.
    const a = await open();
    assert.ok(fs.existsSync(a.dir));
    await request(hub, "POST", "/sessions/close" + k, { id: a.id });
    await until(() => !fs.existsSync(a.dir), 5000, "the closed session's folder to go");
    // 2. Supprimée depuis la page.
    const b = await open();
    await request(hub, "POST", "/sessions/delete" + k, { id: b.id });
    await until(() => !fs.existsSync(b.dir), 5000, "the deleted session's folder to go");
    // 3. Fermée pendant son démarrage : son bac est fermé dès qu'il existe.
    let release;
    gate = new Promise((r) => (release = r));
    const { id: starting } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    await request(hub, "POST", "/sessions/close" + k, { id: starting });
    const built = dirs.length;
    release();
    gate = null;
    await until(() => dirs.length > built, 5000, "the late session to be built");
    await until(() => !fs.existsSync(dirs.at(-1)), 5000, "the late session's folder to go");
    // 4. Arrêt du hub : chaque session ouverte.
    const c = await open();
    const d = await open();
    assert.ok(fs.existsSync(c.dir) && fs.existsSync(d.dir));
    hub.close();
    assert.equal(fs.existsSync(c.dir), false, "an open session's folder goes with the hub");
    assert.equal(fs.existsSync(d.dir), false, "every one of them");
  } finally {
    hub.close();
  }
});
