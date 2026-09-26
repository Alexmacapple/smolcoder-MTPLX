// H03-2 (#16) : preuves sur macOS réel du backend isolé Seatbelt. Lancé par
// `npm run test:os`, jamais par `npm test` (qui doit tourner partout) : ce
// fichier exige macOS et /usr/bin/sandbox-exec, et échoue — il ne se saute
// pas — si le backend y est inopérant. Ailleurs, chaque test est sauté avec
// son motif. Les noms « H03-2 OS ACn » renvoient aux critères du chapeau #12
// que le ticket #16 reprend ; « limite connue » marque ce que Seatbelt ne
// couvre pas, observé plutôt que tu.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code : le HOME
// vu par les commandes confinées est ce faux dossier personnel.
const REAL_HOME = os.userInfo().homedir;
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const HOME = tmp("smol-os-home-");
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../../dist/harness/store");
const { Mission } = require("../../dist/harness/mission");
const { decide, minimalEnv, terminalExec } = require("../../dist/harness/policy");
const { missionExecutor } = require("../../dist/harness/sandbox-executor");
const { Agent } = require("../../dist/agent");
const { ContextManager } = require("../../dist/context");
const { EventBus } = require("../../dist/events");
const { Plan } = require("../../dist/plan");
const { runCommandResult } = require("../../dist/tools/shell");
const { TaskManager } = require("../../dist/tools/tasks");
const { Terminal } = require("../../dist/web/terminal");

const MAC = process.platform === "darwin";
const skip = MAC ? false : `macOS only (this system is ${process.platform})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---- fixture : secrets factices, serveurs hôtes, workspace au nom hostile ----

const SECRET = { outside: "sk-os-outside-FAKE-1f2e", home: "sk-os-home-FAKE-7c3a", env: "sk-os-dotenv-FAKE-9b0d", git: "sk-os-gitcfg-FAKE-4e61" };
const SECRETS = Object.values(SECRET);
let F; // la fixture, préparée une fois

async function server(body) {
  const s = http.createServer((q, r) => r.end(body));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}

async function fixture() {
  if (F) return F;
  const root = tmp("smol-os-");
  const ws = path.join(root, 'ws "q" (a+b) [x] \\ é');
  fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  const outside = tmp("smol-os-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET.outside);
  fs.mkdirSync(path.join(HOME, ".ssh"));
  fs.writeFileSync(path.join(HOME, ".ssh", "id_fake"), SECRET.home);
  fs.writeFileSync(path.join(ws, ".env"), `API_KEY=${SECRET.env}\n`);
  fs.writeFileSync(path.join(ws, ".env.example"), "API_KEY=your-key-here\n");
  fs.writeFileSync(path.join(ws, ".git", "config"), `[remote "origin"]\n\turl = https://u:${SECRET.git}@example.com/r.git\n`);
  // Trois serveurs sur le loopback, lancés par l'hôte (non confinés) : la
  // destination que la politique nomme, un serveur de test interdit, une
  // « API locale » non autorisée (la forme de celle de MTPLX).
  const allowed = await server("pong-allowed");
  const forbidden = await server("pong-forbidden");
  const localApi = await server('{"data":[{"id":"qwen","context_length":262144}]}');
  const port = (s) => s.address().port;
  const contract = path.join(tmp("smol-os-src-"), "contract.json");
  fs.writeFileSync(contract, JSON.stringify({ schema: "smolcoder/contract/v1", id: "os-seatbelt", title: "Isolation", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 500 } }));
  const m = Mission.prepare({ source: contract, workspace: ws, dataDir: tmp("smol-os-data-") });
  m.approve("terminal-human");
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, tasks: "workspace", network: [`localhost:${port(allowed)}`] });
  const wsReal = fs.realpathSync.native(ws);
  const targets = {
    outside: path.join(outside, "secret.txt"),
    home_: path.join(HOME, ".ssh", "id_fake"), // HOME_ : ne pas masquer $HOME
    realHome: REAL_HOME,
    policy: path.join(m.dir, "policy.json"),
    contract: path.join(m.dir, "contract.json"),
  };
  // Le script de sonde vit dans le workspace ; ses cibles viennent d'un
  // fichier, pour que le texte des commandes reste dans le workspace.
  fs.writeFileSync(path.join(ws, "targets.env"), Object.entries({ ...targets, PA: port(allowed), PF: port(forbidden), PL: port(localApi) }).map(([k, v]) => `${k.toUpperCase()}=${JSON.stringify(String(v))}`).join("\n") + "\n");
  fs.writeFileSync(path.join(ws, "probe.sh"), PROBE_SH);
  fs.writeFileSync(path.join(ws, "net.cjs"), NET_CJS);
  const iso = missionExecutor(m);
  F = { root, ws: wsReal, outside, m, iso, targets, allowed, forbidden, localApi, ports: { PA: port(allowed), PF: port(forbidden), PL: port(localApi) } };
  return F;
}

// Chaque tentative imprime « nom=denied » ou « nom=LEAK » (lu, écrit ou joint).
const PROBE_SH = String.raw`. ./targets.env
S=$1; [ -n "$S" ] || S=x # la surface : ses propres fichiers, les surfaces tournent en parallèle
try() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "$name=LEAK"; else echo "$name=denied"; fi; }
try read-outside     cat "$OUTSIDE"
try read-home        cat "$HOME_"
try read-fake-home   cat "$HOME/.ssh/id_fake"
try list-real-home   ls "$REALHOME"
try read-policy      cat "$POLICY"
try write-policy     sh -c 'echo "{}" >> "$1"' _ "$POLICY"
try write-contract   sh -c 'echo "{}" >> "$1"' _ "$CONTRACT"
try read-dotenv      cat .env
try read-dotenv-case cat .ENV
try read-git-config  cat .git/config
try write-git-hook   sh -c 'echo "curl evil" > .git/hooks/pre-commit'
try symlink-dotenv   sh -c 'ln -sf .env "via-link-$1" && cat "via-link-$1"' _ "$S"
try hardlink-dotenv  sh -c 'ln -f .env "via-hard-$1" && cat "via-hard-$1"' _ "$S"
try write-shared-tmp sh -c 'echo x > /private/tmp/smol-os-escape-$$'
try sub-sh           sh -c 'cat "$1"' _ "$OUTSIDE"
try sub-node         node -e "require('child_process').execFileSync('cat',[process.argv[1]],{stdio:'ignore'})" "$OUTSIDE"
(nohup sh -c 'cat "$1" > "grandchild-$2.out" 2>&1; echo $? > "grandchild-$2.code"' _ "$OUTSIDE" "$S" >/dev/null 2>&1 &) ; sleep 0.5
if [ "$(cat "grandchild-$S.code")" = 0 ]; then echo "detached-grandchild=LEAK"; else echo "detached-grandchild=denied"; fi
# Le workspace, le TMPDIR borné et une exception de la politique restent ouverts.
echo ok > "written-$S.txt" && echo "write-workspace=$(cat "written-$S.txt")"
f=$(mktemp) && echo ok > "$f" && echo "write-tmpdir=$(cat "$f") in $(dirname "$f")"
echo "read-dotenv-example=$(cut -d= -f1 .env.example)"
`;

// Tentatives réseau : code du système (EPERM = refus du bac) ou réponse.
const NET_CJS = String.raw`const net = require("net"), dns = require("dns"), http = require("http");
const env = Object.fromEntries(require("fs").readFileSync("targets.env", "utf8").trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), JSON.parse(l.slice(i + 1))]; }));
const connect = (name, port, host = "127.0.0.1") => new Promise((done) => {
  const s = net.connect(Number(port), host);
  s.setTimeout(3000, () => { console.log(name + "=TIMEOUT"); s.destroy(); done(); });
  s.on("connect", () => { console.log(name + "=CONNECTED"); s.destroy(); done(); });
  s.on("error", (e) => { console.log(name + "=" + e.code); done(); });
});
(async () => {
  await connect("forbidden-http", env.PF);
  await connect("local-api", env.PL);
  await connect("closed-port-9", 9);
  await connect("remote-test-net", env.PA, "192.0.2.1");
  await new Promise((done) => dns.lookup("example.com", (e) => { console.log("dns=" + (e ? e.code : "RESOLVED")); done(); }));
  await new Promise((done) => http.get("http://127.0.0.1:" + env.PA, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { console.log("allowed=" + b); done(); }); }).on("error", (e) => { console.log("allowed=" + e.code); done(); }));
  await new Promise((done) => http.get("http://localhost:" + env.PA, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { console.log("allowed-by-name=" + b); done(); }); }).on("error", (e) => { console.log("allowed-by-name=" + e.code); done(); }));
  await new Promise((done) => http.createServer().listen(0, "127.0.0.1", function () { console.log("listen=LISTENING"); this.close(); done(); }).on("error", (e) => { console.log("listen=" + e.code); done(); }));
})();
`;

const results = (text) => Object.fromEntries(plain(text).split("\n").filter((l) => /^[a-z0-9-]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const env = () => minimalEnv([]);
const run = (f, command, timeoutMs = 60000) => runCommandResult(command, f.ws, undefined, timeoutMs, { env: env(), login: false }, f.iso, "command");

test("H03-2 OS: the Seatbelt backend is ready on this Mac (probe: sandbox-exec runs, the host store stays unreadable)", { skip }, async () => {
  const f = await fixture();
  assert.equal(f.iso.status.state, "ready", f.iso.status.reason);
  assert.match(f.iso.tmpDir, /\/smol-sandbox-[^/]+$/);
});

test("H03-2 OS AC1: a workspace script and its subprocesses cannot read a fake external secret, the host store, protected names or the home folder, nor alter a protected control", { skip }, async () => {
  const f = await fixture();
  const before = { policy: fs.readFileSync(f.targets.policy, "utf8"), contract: fs.readFileSync(f.targets.contract, "utf8") };
  const r = await run(f, "sh probe.sh run");
  assert.equal(r.status, "exited", r.output);
  const got = results(r.output);
  const denied = ["read-outside", "read-home", "read-fake-home", "list-real-home", "read-policy", "write-policy", "write-contract", "read-dotenv", "read-dotenv-case", "read-git-config", "write-git-hook", "symlink-dotenv", "hardlink-dotenv", "write-shared-tmp", "sub-sh", "sub-node", "detached-grandchild"];
  for (const k of denied) assert.equal(got[k], "denied", `${k}: ${got[k]}\n${r.output}`);
  assert.equal(got["write-workspace"], "ok");
  assert.match(got["write-tmpdir"], new RegExp(`^ok in ${f.iso.tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "mktemp lands in the bounded TMPDIR");
  assert.equal(got["read-dotenv-example"], "API_KEY", "the policy's exception stays readable");
  for (const s of SECRETS) assert.ok(!r.output.includes(s), `${s} leaked`);
  assert.match(fs.readFileSync(path.join(f.ws, "grandchild-run.out"), "utf8"), /Operation not permitted/, "the detached grandchild was confined too");
  assert.deepEqual({ policy: fs.readFileSync(f.targets.policy, "utf8"), contract: fs.readFileSync(f.targets.contract, "utf8") }, before, "the host store is unchanged");
  assert.ok(!fs.existsSync(path.join(f.ws, ".git", "hooks", "pre-commit")), "no git hook was planted");
});

test("H03-2 OS AC2: network closed by default — forbidden HTTP server, unauthorized local API, DNS and a remote address refused; the destination the policy names answers, from a subprocess too", { skip }, async () => {
  const f = await fixture();
  // Témoins hôtes : les deux serveurs refusés répondent hors du bac.
  const hostGet = (p) => new Promise((done) => http.get(`http://127.0.0.1:${p}`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => done(b)); }));
  assert.equal(await hostGet(f.ports.PF), "pong-forbidden");
  assert.match(await hostGet(f.ports.PL), /context_length/);
  const r = await run(f, "node net.cjs");
  const got = results(r.output);
  assert.deepEqual(got, {
    "forbidden-http": "EPERM", "local-api": "EPERM", "closed-port-9": "EPERM", "remote-test-net": "EPERM", dns: got.dns,
    allowed: "pong-allowed", "allowed-by-name": "pong-allowed", listen: "EPERM",
  }, r.output);
  assert.notEqual(got.dns, "RESOLVED", `DNS resolution is refused (${got.dns})`);
  const sub = await run(f, `set -a; . ./targets.env; set +a; sh -c 'curl -sS -m 3 "http://127.0.0.1:$PA"; echo; curl -sS -m 3 "http://127.0.0.1:$PF" || echo "subprocess-forbidden=refused"'`);
  assert.match(sub.output, /^pong-allowed\n/, sub.output);
  assert.match(sub.output, /subprocess-forbidden=refused/);
  assert.doesNotMatch(sub.output, /pong-forbidden/);
});

/** Un arbre de descendants ordinaires : un job de fond, un enfant node et son
 * propre enfant ; chacun écrit son pid dans le workspace. */
const TREE = (tag) => [
  `rm -f ${tag}.pids`,
  `(sleep 300 & echo $! >> ${tag}.pids; wait) &`,
  `node -e "const c=require('child_process').spawn('sleep',['300'],{stdio:'ignore'});require('fs').appendFileSync('${tag}.pids',process.pid+'\\n'+c.pid+'\\n');setInterval(()=>{},1000)" &`,
  `echo $$ >> ${tag}.pids`,
  "sleep 300",
].join("\n");
async function treePids(f, tag) {
  const file = path.join(f.ws, `${tag}.pids`);
  await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().split("\n").length >= 4, 15000, `${tag} descendants`);
  return fs.readFileSync(file, "utf8").trim().split("\n").map(Number);
}

test("H03-2 OS AC4: timeout, task stop and terminal interrupt kill every descendant, checked pid by pid, with an observable result", { skip }, async (t) => {
  const f = await fixture();
  const all = [];
  t.after(() => { for (const p of all) if (alive(p)) process.kill(p, "SIGKILL"); });
  // 1. run_command : délai dépassé.
  const timed = run(f, TREE("timeout"), 3000);
  const tp = await treePids(f, "timeout");
  all.push(...tp);
  const r = await timed;
  assert.deepEqual({ status: r.status, started: r.started, timeoutMs: r.timeoutMs }, { status: "timeout", started: true, timeoutMs: 3000 });
  await until(() => tp.every((p) => !alive(p)), 5000, "the timed-out tree to die");
  // 2. Tâche de fond arrêtée.
  const tasks = new TaskManager(f.ws, f.iso);
  const id = tasks.start(TREE("task"), { env: env(), login: false });
  const kp = await treePids(f, "task");
  all.push(...kp);
  assert.match(tasks.stop(id), /stopped/);
  await until(() => kp.every((p) => !alive(p)), 5000, "the stopped task's tree to die");
  assert.match(tasks.logs(id), /^Task t1 \[stopped\]/);
  // 3. Terminal web interrompu (ctrl+c).
  let out = "";
  const term = new Terminal("t1", f.ws, { output: (s) => (out += s), done() {} }, undefined, f.iso);
  t.after(() => term.close());
  term.write(TREE("term"));
  const mp = await treePids(f, "term");
  all.push(...mp);
  term.interrupt();
  await until(() => /\[interrupted\]/.test(out), 10000, "the interruption");
  await until(() => mp.every((p) => !alive(p)), 5000, "the interrupted tree to die");
});

test("H03-2 OS AC4 (known limit): a descendant that detaches with setsid survives the process-group kill, yet stays confined", { skip }, async (t) => {
  const f = await fixture();
  const daemon = String.raw`. ./targets.env; export OUTSIDE PF; perl -e 'use POSIX; use IO::Socket::INET; exit 0 if fork; POSIX::setsid(); open(STDIN,"</dev/null"); open(STDOUT,">/dev/null"); open(STDERR,">/dev/null"); open(my $p,">","daemon.pid"); print $p $$; close $p; for (1..300) { my $r = open(my $s,"<",$ENV{OUTSIDE}) ? "read=LEAK" : "read=denied"; my $n = IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>$ENV{PF},Timeout=>1) ? "net=LEAK" : "net=denied"; open(my $l,">>","daemon.log"); print $l "$r $n\n"; close $l; sleep 1 }'`;
  const r = await run(f, daemon, 5000);
  assert.equal(r.status, "exited", "the command returns: its shell is gone");
  await until(() => fs.existsSync(path.join(f.ws, "daemon.log")), 5000, "the daemon's first attempt");
  const pid = Number(fs.readFileSync(path.join(f.ws, "daemon.pid"), "utf8"));
  t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
  await sleep(1200);
  assert.equal(alive(pid), true, "known limit: the detached daemon outlives the process-group kill (same as the host adapter)");
  const log = fs.readFileSync(path.join(f.ws, "daemon.log"), "utf8").trim().split("\n");
  assert.ok(log.length >= 2 && log.every((l) => l === "read=denied net=denied"), `still confined: ${log.join(" | ")}`);
  process.kill(pid, "SIGKILL");
});

test("H03-2 OS AC5: the same boundary for run_command, background task, automatic check and web terminal, through the access decision", { skip }, async (t) => {
  const f = await fixture();
  const line = (surface) => `sh probe.sh ${surface} > ${surface}.out 2>&1; echo done > ${surface}.marker`;
  // 1. et 2. run_command et task.start, par les outils du modèle, sous la décision d'accès.
  const replies = [
    { toolCalls: [{ id: "c1", name: "run_command", args: { command: line("command") } }] },
    { toolCalls: [{ id: "t1", name: "task", args: { action: "start", command: line("task") } }] },
    { content: "done" },
  ];
  let i = 0;
  const provider = { label: "fake", modelId: "fake", contextWindow: 32000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; }, async chat() { return { content: "", toolCalls: [], ...replies[Math.min(i++, replies.length - 1)] }; } };
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {} };
  const taskManager = new TaskManager(f.ws, f.iso);
  t.after(() => taskManager.killAll());
  const toolCtx = { workspace: f.ws, taskManager, plan: new Plan(), filesTouched: new Set(), commandsRun: [], executor: f.iso };
  // 3. Vérification automatique : la commande d'acceptation, même décision.
  const agent = new Agent(provider, "bypass", "sys", toolCtx, new ContextManager(32000, 2000), new EventBus(), ui, false, 30, { command: line("check"), maxAttempts: 1 }, f.m);
  await agent.runTurn("probe the boundary");
  // 4. Terminal web : la garde du hub (décision, environnement) et l'exécuteur isolé.
  let out = "";
  const dones = [];
  const term = new Terminal("t1", f.ws, { output: (s) => (out += s), done: (c) => dones.push(c) }, {
    exec: () => terminalExec(f.m),
    decide: (cmd, cwd) => decide(f.m, { surface: "terminal", tool: "terminal", args: { command: cmd }, cwd }),
  }, f.iso);
  t.after(() => term.close());
  term.write(line("terminal"));
  await until(() => ["command", "task", "check", "terminal"].every((s) => fs.existsSync(path.join(f.ws, `${s}.marker`))), 20000, "the four surfaces");
  for (const s of ["command", "task", "check", "terminal"]) {
    const got = results(fs.readFileSync(path.join(f.ws, `${s}.out`), "utf8"));
    assert.deepEqual(Object.entries(got).filter(([, v]) => v === "LEAK"), [], `${s}: nothing leaks`);
    assert.equal(got["read-outside"], "denied", `${s}: the external secret stays out of reach`);
    assert.equal(got["write-workspace"], "ok", `${s}: the workspace stays writable`);
  }
  assert.equal(agent.verificationResult.passed, true, "the check itself ran and passed");
});

test("H03-2 OS AC6: an inoperative backend — sandbox-exec missing, or one that does not confine — blocks every command; nothing runs", { skip }, async () => {
  const f = await fixture();
  const fake = path.join(tmp("smol-os-fake-"), "sandbox-exec");
  fs.writeFileSync(fake, '#!/bin/sh\n# drops "-p <profile>" and runs the command unconfined\nshift 2\nexec "$@"\n', { mode: 0o755 });
  for (const [sandboxExec, why] of [["/nonexistent/sandbox-exec", /not found/], [fake, /could read the host store/]]) {
    const iso = missionExecutor(f.m, { sandboxExec });
    assert.equal(iso.status.state, "unavailable");
    assert.match(iso.status.reason, why);
    const r = await runCommandResult("echo ran > blocked.marker", f.ws, undefined, 10000, { env: env(), login: false }, iso, "command");
    assert.deepEqual({ started: r.started, status: r.status }, { started: false, status: "spawn_error" });
    assert.match(r.error, /isolated execution unavailable.*nothing was run/s);
    assert.ok(!fs.existsSync(path.join(f.ws, "blocked.marker")), `${sandboxExec}: nothing ran`);
  }
});

test("H03-2 OS AC3 (partial, #17 continues): an npm test of a fixture runs under isolation", { skip }, async () => {
  const f = await fixture();
  const dir = path.join(f.ws, "fixture");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "a.test.js"), 'require("node:test")("adds", () => require("node:assert").equal(1 + 1, 2));\n');
  const r = await run(f, "cd fixture && npm test");
  assert.equal(r.exitCode, 0, r.output);
  assert.match(plain(r.output), /pass 1/);
});

test("H03-2 OS (known limit, #17): git does not work under isolation — an existing ~/.gitconfig is unreadable, and the default policy protects .git", { skip }, async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(HOME, ".gitconfig"), "[user]\n\tname = fake\n");
  const version = await run(f, "git --version");
  assert.equal(version.exitCode, 128, version.output);
  assert.match(version.output, /unable to access '.*\.gitconfig': Operation not permitted/);
  fs.rmSync(path.join(HOME, ".gitconfig"));
  const init = await run(f, "git init -q repo");
  assert.notEqual(init.exitCode, 0);
  assert.match(init.output, /repo\/\.git: Operation not permitted/, "creating .git is refused like any protected name");
});

test.after(() => {
  for (const s of [F?.allowed, F?.forbidden, F?.localApi]) s?.close();
});
