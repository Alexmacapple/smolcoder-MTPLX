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
  // #9 : cette commande de l'appelant n'était pas connue à l'approbation ;
  // l'hôte approuve explicitement les scripts qu'elle exécute (probe.sh).
  const commands = [line("check")];
  f.m.approveVerifiers("terminal-human", f.m.verifierState(f.m.verifierCommands(commands)).current, { commands });
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

// ---- H03-3 (#17) : l'allow-list de l'empreinte des outils ------------------
//
// Chaque entrée de TOOL_FOOTPRINT a son cas positif, mesuré : il passe hors
// du bac et sous le profil complet, et échoue quand on retire l'entrée du
// profil. Les champs facultatifs de la politique (tools, git, listen, network)
// sont éprouvés de même : présents, le cas passe ; absents, il échoue ; et ce
// qui reste hors de la liste reste refusé.

const { spawnSync, execFileSync } = require("child_process");
const sbx = require("../../dist/harness/sandbox-executor");

/** Le cas positif de chaque entrée : une commande et ce qu'elle doit rendre. */
const FOOTPRINT_CASES = {
  "process-fork": ["echo a | tr a b", (o) => o === "b"],
  "process-exec": ["/bin/echo exec-ok", (o) => o === "exec-ok"],
  signal: ["sleep 5 & kill $!; wait $!; echo code=$?", (o) => /code=143/.test(o)],
  "sysctl-read": [`node -e "console.log(require('os').cpus().length > 0)"`, (o) => o === "true"],
  "user-directory": ["id -un", (o) => o === os.userInfo().username],
  "file-metadata": ["cd meta-dir && echo cd-ok", (o) => o === "cd-ok"],
  "root-folder": ["/bin/echo root-ok", (o) => o === "root-ok"],
  usr: ["/usr/bin/shasum -a 1 /dev/null | cut -c1-8", (o) => o === "da39a3ee"],
  system: ["/usr/bin/perl -e 'print 6*7'", (o) => o === "42"],
  "developer-tools": ["GIT_CONFIG_GLOBAL=/dev/null git --version | cut -c1-11", (o) => o === "git version"],
  homebrew: [`node -e "console.log(40 + 2)"`, (o) => o === "42"],
  "homebrew-openssl": [`node -e "console.log(40 + 2)"`, (o) => o === "42"],
  etc: ["curl --version | head -1 | cut -c1-4", (o) => o === "curl"],
  timezone: ["TZ=Europe/Paris date -r 0 +%H", (o) => o === "01"],
  "dev-null": ["cat < /dev/null && echo x > /dev/null && echo null-ok", (o) => o === "null-ok"],
  "dev-sources": ["for d in zero random urandom; do head -c 4 /dev/$d | wc -c | tr -d ' '; done | tr '\\n' ,", (o) => o === "4,4,4,"],
  "dev-fd": ["echo fd-ok > /dev/stderr; /bin/bash -c 'cat <(echo ps-ok)'", (o) => o.split("\n").sort().join(",") === "fd-ok,ps-ok"],
};

/** La fixture d'un `npm test` sans dépendance, partagée par plusieurs cas. */
function npmFixture(f) {
  const dir = path.join(f.ws, "fixture17");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture17", version: "1.0.0", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "a.test.js"), 'require("node:test")("adds", () => require("node:assert").equal(1 + 1, 2));\n');
  return "fixture17";
}

/** Une commande sous un profil donné, lancée comme l'exécuteur la lance. */
function underProfile(f, profile, cmd) {
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", cmd], { cwd: f.ws, env: { ...env(), TMPDIR: `${f.iso.tmpDir}/` }, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
function hostRun(f, cmd) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: f.ws, env: { ...env(), TMPDIR: `${f.iso.tmpDir}/` }, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const profileOf = (f, extra = {}) => sbx.seatbeltProfile({ workspace: f.ws, tmpDir: f.iso.tmpDir, rules: store.DEFAULT_POLICY.paths, network: [], hostPaths: [path.dirname(path.dirname(f.m.dir))], ...extra });

/** La politique de la fixture, élargie le temps d'un test puis rétablie. */
async function withPolicy(f, extra, fn) {
  const file = path.join(f.m.dir, "policy.json");
  const before = fs.readFileSync(file, "utf8");
  store.writePolicy(f.m.dir, { ...store.readPolicy(f.m.dir).policy, ...extra });
  try {
    return await fn();
  } finally {
    fs.writeFileSync(file, before);
  }
}

test("H03-3 OS AC1: every entry of the documented allow-list is needed — its positive case passes outside the sandbox and under the full profile, and fails once the entry is removed", { skip, timeout: 180000 }, async () => {
  const f = await fixture();
  fs.mkdirSync(path.join(f.ws, "meta-dir"), { recursive: true });
  const node = fs.realpathSync.native(execFileSync("/bin/sh", ["-c", "command -v node"], { env: env(), encoding: "utf8" }).trim());
  assert.match(node, /^\/opt\/homebrew\//, "this campaign measures Homebrew's node, whose library and OpenSSL configuration live under /opt/homebrew");
  assert.deepEqual(Object.keys(FOOTPRINT_CASES).sort(), sbx.TOOL_FOOTPRINT.map((e) => e.id).sort(), "one positive case per entry, no more");
  const full = profileOf(f);
  const report = [];
  for (const entry of sbx.TOOL_FOOTPRINT) {
    const [cmd, ok] = FOOTPRINT_CASES[entry.id];
    const host = hostRun(f, cmd);
    assert.ok(ok(host.out), `${entry.id}: the case itself holds outside the sandbox (${host.out})`);
    const inside = underProfile(f, full, cmd);
    assert.ok(ok(inside.out), `${entry.id}: passes under the full profile (exit ${inside.code}: ${inside.out})`);
    const without = full.split("\n").filter((l) => !entry.rules.includes(l)).join("\n");
    assert.notEqual(without, full, `${entry.id}: its rules are lines of the profile`);
    const cut = underProfile(f, without, cmd);
    assert.ok(!ok(cut.out), `${entry.id}: still passes without the entry, so the entry is not justified (${cut.out})`);
    report.push(`${entry.id}: ${cut.out.split("\n").pop().slice(0, 100) || `exit ${cut.code}`}`);
  }
  // Le TMPDIR borné, accordé par l'exécuteur : même épreuve.
  const tmpCase = 'f=$(mktemp) && echo tmp-ok > "$f" && cat "$f"';
  assert.equal(underProfile(f, full, tmpCase).out, "tmp-ok");
  const noTmp = full.replace(` (subpath ${JSON.stringify(f.iso.tmpDir)})`, "");
  assert.notEqual(noTmp, full);
  assert.match(underProfile(f, noTmp, tmpCase).out, /Operation not permitted/);
  console.log(`# removed entry → failure of its case:\n# ${report.join("\n# ")}`);
});

test("H03-3 OS AC2: an npm test of a fixture passes under isolation with the documented allow-list only, while what lies outside it stays refused — home, Homebrew's service configuration, /Library's data, the account's terminals", { skip, timeout: 180000 }, async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(HOME, ".npmrc"), `//registry.npmjs.org/:_authToken=${SECRET.home}\n`);
  const r = await run(f, `cd ${npmFixture(f)} && npm test`);
  assert.equal(r.exitCode, 0, r.output);
  assert.match(plain(r.output), /pass 1/);
  assert.ok(!r.output.includes(SECRET.home), "the npm token of ~/.npmrc never enters");
  // Hors de la liste : chaque tentative, témoin hôte à l'appui.
  const tty = fs.readdirSync("/dev").filter((n) => /^ttys\d+$/.test(n)).map((n) => `/dev/${n}`).find((p) => fs.statSync(p).uid === process.getuid());
  assert.ok(tty, "a terminal of this account exists (the campaign runs from a terminal session)");
  const attempts = {
    "read-npmrc": `cat "$HOME/.npmrc"`,
    "list-homebrew-etc": "ls /opt/homebrew/etc",
    "list-library-data": "ls '/Library/Application Support'",
    "list-library-preferences": "ls /Library/Preferences",
    "open-account-tty": `exec 3< ${tty}`,
    "read-bin-file": "cat /bin/ls",
    "list-dev": "ls /dev",
  };
  const tryAll = Object.entries(attempts).map(([name, cmd]) => `if ( ${cmd} ) >/dev/null 2>&1; then echo ${name}=LEAK; else echo ${name}=denied; fi`).join("\n");
  const host = results(hostRun(f, tryAll).out);
  const inside = results((await run(f, tryAll)).output);
  for (const name of Object.keys(attempts)) {
    assert.equal(host[name], "LEAK", `${name}: allowed outside the sandbox, so the refusal below is the sandbox's`);
    assert.equal(inside[name], "denied", `${name}: refused under isolation`);
  }
  assert.equal((await run(f, "/bin/ls -d / >/dev/null && echo exec-ok")).output.trim(), "exec-ok", "a program of /bin still runs, though its file is not readable");
});

test("H03-3 OS AC3: a node installed under the home folder (nvm layout) runs only when the policy names its folder in tools — read-only, its siblings stay unreadable, and a folder holding the home folder is refused", { skip, timeout: 180000 }, async () => {
  const f = await fixture();
  const src = path.dirname(path.dirname(fs.realpathSync.native(process.execPath)));
  const nvm = path.join(HOME, ".nvm", "versions", "node", path.basename(src));
  if (!fs.existsSync(nvm)) {
    fs.mkdirSync(path.dirname(nvm), { recursive: true });
    execFileSync("/bin/cp", ["-Rc", src, nvm]); // clone APFS : instantané
  }
  const nodeCmd = `"${path.join(nvm, "bin", "node")}" -e "console.log('nvm-node', process.version)"`;
  const denied = await run(f, nodeCmd);
  assert.notEqual(denied.exitCode, 0, denied.output);
  assert.match(denied.output, /sandbox blocked open|Operation not permitted/, "without the entry the library of this node cannot load");
  await withPolicy(f, { tools: [nvm] }, async () => {
    const ok = await run(f, nodeCmd);
    assert.equal(ok.exitCode, 0, ok.output);
    assert.equal(ok.output.trim(), `nvm-node ${process.version}`);
    const npm = await run(f, `PATH="${path.join(nvm, "bin")}:$PATH"; cd ${npmFixture(f)} && npm test`);
    assert.equal(npm.exitCode, 0, npm.output);
    const probe = await run(f, `cat "$HOME/.ssh/id_fake" || echo sibling=denied; echo x > "${path.join(nvm, "planted")}" || echo write=denied`);
    assert.match(probe.output, /sibling=denied/);
    assert.match(probe.output, /write=denied/);
    assert.ok(!probe.output.includes(SECRET.home));
    assert.ok(!fs.existsSync(path.join(nvm, "planted")), "the tool folder is never writable");
  });
  await withPolicy(f, { tools: [HOME] }, async () => {
    const wide = await run(f, "echo ran > wide.marker");
    assert.deepEqual({ started: wide.started, status: wide.status }, { started: false, status: "spawn_error" });
    assert.match(wide.error, /holds the home folder/);
    assert.ok(!fs.existsSync(path.join(f.ws, "wide.marker")));
  });
});

test("H03-3 OS AC4: npm cache and registry — an offline install reads the host cache only when tools names it, never writing it; a registry answers only as a named loopback destination, with a bounded cache; a remote registry is never reached", { skip, timeout: 180000 }, async (t) => {
  const f = await fixture();
  // Registre jetable, lancé par l'hôte : un paquet, un tarball.
  const pkg = tmp("smol-os-pkg-");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "smol-leftpad", version: "1.0.0", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), 'module.exports = (s, n) => String(s).padStart(n, "0");\n');
  execFileSync("npm", ["pack", "--pack-destination", pkg], { cwd: pkg, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))), HOME, npm_config_cache: path.join(pkg, ".cache") }, stdio: "ignore" });
  const tgz = fs.readFileSync(path.join(pkg, "smol-leftpad-1.0.0.tgz"));
  const hits = [];
  const registry = http.createServer((q, r) => {
    hits.push(q.url);
    if (q.url === "/smol-leftpad") return r.end(JSON.stringify({ name: "smol-leftpad", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "smol-leftpad", version: "1.0.0", main: "index.js", dist: { tarball: `http://${q.headers.host}/smol-leftpad/-/smol-leftpad-1.0.0.tgz`, integrity: "sha512-" + require("crypto").createHash("sha512").update(tgz).digest("base64") } } } }));
    if (q.url.endsWith(".tgz")) return r.end(tgz);
    r.statusCode = 404;
    r.end("{}");
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  t.after(() => registry.close());
  const port = registry.address().port;
  const dir = path.join(f.ws, "fixture-dep");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { "smol-leftpad": "1.0.0" } }));
  fs.writeFileSync(path.join(dir, "a.test.js"), 'require("node:test")("pads", () => require("node:assert").equal(require("smol-leftpad")(7, 3), "007"));\n');
  // Le cache de l'hôte, chauffé hors du bac (~/.npm du faux dossier personnel).
  // Asynchrone : le registre répond depuis ce même processus. Sans les
  // variables npm_* qu'exporte `npm run`, qui viseraient le vrai ~/.npm.
  const cache = path.join(HOME, ".npm", "_cacache");
  const hostEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k))), HOME, npm_config_cache: path.join(HOME, ".npm") };
  await require("util").promisify(require("child_process").execFile)("npm", ["install", "--registry", `http://127.0.0.1:${port}`, "--no-audit", "--no-fund"], { cwd: dir, env: hostEnv });
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  const snapshot = () => execFileSync("/usr/bin/find", [cache, "-type", "f"], { encoding: "utf8" }).split("\n").sort().join("\n");
  const cached = snapshot();
  assert.ok(cached.includes("content-v2"), "the host cache holds the package");
  // 1. npm test n'a besoin d'aucun cache (AC2) ; une installation hors ligne, si.
  const offline = "cd fixture-dep && npm ci --offline --no-audit --no-fund && npm test";
  const noCache = await run(f, offline);
  assert.notEqual(noCache.exitCode, 0, "the host cache is out of reach by default");
  assert.match(noCache.output, /EPERM|operation not permitted|root-owned/i, noCache.output);
  await withPolicy(f, { tools: [cache] }, async () => {
    const ok = await run(f, offline);
    assert.equal(ok.exitCode, 0, ok.output);
    assert.match(plain(ok.output), /pass 1/);
  });
  assert.equal(snapshot(), cached, "the host cache was only read: no file added or removed");
  // 2. Un registre : seulement comme destination loopback nommée, cache borné.
  const online = `cd fixture-dep && rm -rf node_modules && npm install --registry http://127.0.0.1:${port} --cache "$TMPDIR/npm-cache" --no-audit --no-fund --fetch-retries=0 && npm test`;
  hits.length = 0;
  const closed = await run(f, online);
  assert.notEqual(closed.exitCode, 0, "no destination named: the registry is out of reach");
  assert.deepEqual(hits, [], "not a single request reached it");
  await withPolicy(f, { network: [...(store.readPolicy(f.m.dir).policy.network ?? []), `localhost:${port}`] }, async () => {
    const ok = await run(f, online);
    assert.equal(ok.exitCode, 0, ok.output);
    assert.match(plain(ok.output), /pass 1/);
    assert.ok(hits.length > 0);
    // 3. Un registre distant : jamais, quelle que soit la politique (sans
    // verrou ni cache, qui renverraient au registre loopback).
    const remote = await run(f, 'npm view left-pad version --registry https://registry.npmjs.org/ --cache "$TMPDIR/npm-remote" --fetch-retries=0 --fetch-timeout=5000', 60000);
    assert.notEqual(remote.exitCode, 0, remote.output);
    assert.match(remote.output, /ENOTFOUND|EPERM|EAI_AGAIN|ECONNREFUSED/, remote.output);
  });
});

/** Les commandes de lecture que demandent les fiches de revue et de
 * vérification finale (docs/skills), sur une branche et son point de départ. */
const REVIEW_GIT = "git status --short && git diff main --stat | tail -1 && git diff main...HEAD --stat | tail -1 && git log main..HEAD --oneline | wc -l | tr -d ' ' && git rev-parse main && git config --global --list; echo status-code=$?";
const hostGit = (cwd) => (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, env: { ...process.env, HOME, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
function reviewRepo(dir) {
  const git = hostGit(dir);
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
  git("add", "f.txt");
  git("commit", "-qm", "feat");
  return git;
}
function assertReview(out, main) {
  assert.match(out, /^ M f\.txt$/m, out);
  assert.match(out, /1 file changed, 2 insertions/, "git diff <point>: the branch and the working tree");
  assert.match(out, /1 file changed, 1 insertion\(\+\)$/m, "git diff <point>...HEAD: the branch only");
  assert.match(out, /^1$/m, "git log <point>..HEAD: one commit");
  assert.ok(out.includes(main), "git rev-parse <point>");
  assert.match(out, /status-code=0/, "git config --global reads /dev/null, not ~/.gitconfig");
}

test("H03-3 OS AC5: git — refused by default; with git read, the review commands (status, diff <point>, diff <point>...HEAD, log <point>..HEAD, rev-parse) work without reading the user's ~/.gitconfig, while commit, index, hooks and other protected names inside .git stay closed", { skip, timeout: 180000 }, async () => {
  const f = await fixture();
  const repo = path.join(f.ws, "repo17");
  let git = hostGit(repo);
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(repo);
    git = reviewRepo(repo);
    fs.writeFileSync(path.join(repo, ".git", ".env"), `TOKEN=${SECRET.env}\n`);
  }
  fs.writeFileSync(path.join(repo, "f.txt"), "a\nb\n");
  fs.writeFileSync(path.join(HOME, ".gitconfig"), `[user]\n\tname = ${SECRET.git}\n`);
  const head = git("rev-parse", "HEAD").trim();
  const main = git("rev-parse", "main").trim();
  const cmd = `cd repo17 && ${REVIEW_GIT}`;
  const off = await run(f, cmd);
  assert.match(off.output, /unable to access '.*\.gitconfig': Operation not permitted/, "default: git stops on the unreadable ~/.gitconfig");
  await withPolicy(f, { git: "read" }, async () => {
    const on = await run(f, cmd);
    assertReview(on.output, main);
    assert.ok(!on.output.includes(SECRET.git), "the user's configuration never enters");
    const writes = await run(f, "cd repo17 && git commit -qam second; echo commit=$?; echo evil > .git/hooks/pre-commit || echo hook=denied; cat .git/.env || echo dotenv=denied");
    assert.match(writes.output, /index\.lock': Operation not permitted/);
    assert.match(writes.output, /hook=denied/);
    assert.match(writes.output, /dotenv=denied/, "a protected name inside .git stays closed");
    assert.ok(!writes.output.includes(SECRET.env));
    // Limite connue, observée : lire .git, c'est lire .git/config.
    const cfg = await run(f, "cat .git/config");
    assert.ok(cfg.output.includes(SECRET.git), "known limit: under git read, a token in a remote URL of .git/config is readable");
  });
  assert.equal(git("rev-parse", "HEAD").trim(), head, "no commit was made");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")));
  const back = await run(f, "cat .git/config");
  assert.ok(!back.output.includes(SECRET.git), "policy restored: .git is closed again");
  fs.rmSync(path.join(HOME, ".gitconfig"));
});

test("H03-3 OS AC5 (worktree): a workspace that is a git worktree keeps its git folder outside — git read alone fails; naming the main repository's .git in tools makes the review commands work, still read-only", { skip, timeout: 180000 }, async () => {
  const mainRepo = tmp("smol-os-mainrepo-");
  const git = reviewRepo(mainRepo);
  git("switch", "-q", "main");
  const wt = path.join(tmp("smol-os-wt-"), "wt");
  git("worktree", "add", "-q", wt, "feature");
  fs.writeFileSync(path.join(wt, "f.txt"), "a\nb\n");
  const main = git("rev-parse", "main").trim();
  const contract = path.join(tmp("smol-os-src-"), "contract.json");
  fs.writeFileSync(contract, JSON.stringify({ schema: "smolcoder/contract/v1", id: "os-worktree", title: "Worktree", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 50 } }));
  const m = Mission.prepare({ source: contract, workspace: wt, dataDir: tmp("smol-os-data-") });
  m.approve("terminal-human");
  const inWt = (iso, cmd) => runCommandResult(cmd, fs.realpathSync.native(wt), undefined, 60000, { env: env(), login: false }, iso, "command");
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, git: "read" });
  const alone = await inWt(missionExecutor(m), REVIEW_GIT);
  assert.match(alone.output, /not a git repository: .*smol-os-mainrepo-.*worktrees/, alone.output);
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, git: "read", tools: [path.join(mainRepo, ".git")] });
  const iso = missionExecutor(m);
  assertReview((await inWt(iso, REVIEW_GIT)).output, main);
  const commit = await inWt(iso, "git commit -qam second; echo commit=$?");
  assert.match(commit.output, /index\.lock': Operation not permitted/, "the main repository stays read-only");
  assert.equal(git("log", "--oneline", "main..feature").trim().split("\n").length, 1, "no commit was made");
});

test("H03-3 OS AC6: listening — refused unless the policy names the port; a named port serves the host, another port stays refused, the status line says so; known limit: listening on every interface is accepted and reachable at the local network address", { skip, timeout: 180000 }, async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.ws, "server17.cjs"), String.raw`const http = require("http");
const [host, port] = [process.argv[2], Number(process.argv[3])];
const s = http.createServer((q, r) => r.end("pong-sandboxed"));
s.on("error", (e) => { console.log("listen=" + e.code); process.exit(0); });
s.listen(port, host, () => { console.log("listen=LISTENING " + s.address().address); setTimeout(() => process.exit(0), 3000); });
`);
  const free = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const port = await free();
  const get = (host) => new Promise((done) => http.get({ host, port, timeout: 1000 }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => done(b)); }).on("error", (e) => done(e.code)).on("timeout", function () { this.destroy(); done("TIMEOUT"); }));
  async function serve(host) {
    const running = run(f, `node server17.cjs ${host} ${port}`, 20000);
    let seen = "";
    const end = Date.now() + 2500;
    while (Date.now() < end && seen !== "pong-sandboxed") { seen = await get("127.0.0.1"); await sleep(100); }
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    const viaLan = lan ? await get(lan) : null;
    return { out: (await running).output.trim(), loopback: seen, lan, viaLan };
  }
  const closed = await serve("127.0.0.1");
  assert.equal(closed.out, "listen=EPERM", "default: nothing listens");
  await withPolicy(f, { listen: [`localhost:${port}`] }, async () => {
    const named = await serve("127.0.0.1");
    assert.match(named.out, /^listen=LISTENING 127\.0\.0\.1$/);
    assert.equal(named.loopback, "pong-sandboxed", "the host reaches the server of the sandbox");
    if (named.lan) assert.notEqual(named.viaLan, "pong-sandboxed", "bound to the loopback, unreachable at the LAN address");
    const other = await run(f, `node server17.cjs 127.0.0.1 ${port + 1}`);
    assert.equal(other.output.trim(), "listen=EPERM", "another port stays refused");
    assert.match(sbx.isolationLine(f.iso.status, f.iso.listening()), new RegExp(`listen on localhost:${port}, which the local network can reach`));
    const every = await serve("0.0.0.0");
    assert.match(every.out, /^listen=LISTENING 0\.0\.0\.0$/, "known limit: Seatbelt accepts listening on every interface");
    if (every.lan) assert.equal(every.viaLan, "pong-sandboxed", `known limit, observed: reachable at the local network address ${every.lan}`);
  });
  assert.deepEqual(f.iso.listening(), [], "policy restored: no listening");
});

// ---- #30 : fiches de méthode installées côté hôte ----

test("#30 OS AC3: installed fiches give isolated commands no new access — reading, listing or overwriting ~/.smolcoder/fiches is refused by the kernel (host witness first), while the host's read_file serves a fiche and journals it", { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const fiches = require("../../dist/fiches");
  const dir = fiches.fichesDir();
  assert.equal(dir, path.join(HOME, ".smolcoder", "fiches"), "the default location, under the fake home");
  fiches.installFiches(path.join(__dirname, "..", "..", "docs", "skills"), dir);
  const tdd = path.join(dir, "tdd.md");
  const before = fs.readFileSync(tdd, "utf8");
  const reads = {
    "read-fiche": `cat "${tdd}"`,
    "read-manifest": `cat "${path.join(dir, "fiches.json")}"`,
    "list-fiches": `ls "${dir}"`,
  };
  const writes = {
    "append-fiche": `echo pwned >> "${tdd}"`,
    "plant-fiche": `echo pwned > "${path.join(dir, "planted.md")}"`,
  };
  const tryAll = (attempts) => Object.entries(attempts).map(([name, cmd]) => `if ( ${cmd} ) >/dev/null 2>&1; then echo ${name}=LEAK; else echo ${name}=denied; fi`).join("\n");
  const host = results(hostRun(f, tryAll(reads)).out);
  const inside = results((await run(f, tryAll({ ...reads, ...writes }))).output);
  for (const name of Object.keys(reads)) {
    assert.equal(host[name], "LEAK", `${name}: allowed outside the sandbox, so the refusal below is the sandbox's`);
    assert.equal(inside[name], "denied", `${name}: refused under isolation`);
  }
  for (const name of Object.keys(writes)) assert.equal(inside[name], "denied", `${name}: refused under isolation`);
  assert.equal(fs.readFileSync(tdd, "utf8"), before, "the installed fiche is unchanged");
  assert.ok(!fs.existsSync(path.join(dir, "planted.md")), "nothing was planted");

  // Par l'agent sous la mission de la fixture : la commande est refusée par
  // la décision d'accès, la lecture nommée est servie par l'hôte et tracée.
  const replies = [
    { toolCalls: [{ id: "c1", name: "run_command", args: { command: `cat "${tdd}"` } }] },
    { toolCalls: [{ id: "r1", name: "read_file", args: { path: "fiche:tdd" } }] },
    { content: "ok" },
  ];
  const seen = [];
  let i = 0;
  const provider = {
    label: "fake", modelId: "fake", contextWindow: 32000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; },
    async chat(messages) { seen.push(messages.map((m) => ({ role: m.role, content: m.content }))); return { content: "", toolCalls: [], generatedTokens: 10, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...replies[Math.min(i++, replies.length - 1)] }; },
  };
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {} };
  const ctx = { workspace: f.ws, taskManager: new TaskManager(f.ws, f.iso), plan: new Plan(), filesTouched: new Set(), commandsRun: [], executor: f.iso, fichesDir: dir };
  const agent = new Agent(provider, "bypass", "sys", ctx, new ContextManager(32000, 2000), new EventBus(), ui, false, 20, undefined, f.m);
  await agent.runTurn("Lis la fiche tdd.");
  const [cmd, read] = seen.at(-1).filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(cmd, /^Error: denied by the access policy.*host store/);
  assert.equal(read, before);
  const proofs = store.readProofs(f.m.dir);
  assert.equal(proofs.state, "ok");
  assert.ok(proofs.events.some((e) => e.type === "fiche" && e.name === "tdd" && e.sha256 === require("crypto").createHash("sha256").update(before).digest("hex")), "the read is journaled");
});

test.after(() => {
  for (const s of [F?.allowed, F?.forbidden, F?.localApi]) s?.close();
});
