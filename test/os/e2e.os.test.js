// H03-4 (#18) : bout en bout sur macOS réel. Le vrai binaire smol
// (dist/index.js) est lancé sous --mission, en headless, en interface web et
// en interface terminal (sous un pseudo-terminal), piloté par un faux serveur
// OpenAI-compatible local qui joue le modèle : aucun MTPLX, aucun modèle réel.
// Chaque test prouve que les commandes du modèle et du terminal, et la
// vérification --verify, tournent dans le bac : un témoin hors du workspace,
// lisible par l'hôte, leur reste illisible. Lancé par `npm run test:os`,
// jamais par `npm test` ; ailleurs que sur macOS, chaque test est sauté avec
// son motif. Les noms « H03-4 OS ACn » renvoient aux critères du chapeau #12 ;
// « H04 OS » (#9) prouve le contrôle décisif dans le bac et le verdict hors
// de portée du modèle ; « H08 OS » (#29), le plan proposé puis approuvé en
// deux runs headless et l'écart journalisé sans refus ; « H05 OS » (#10), la
// coupure réelle entre une écriture et son reçu, puis la reprise ; « #46 OS »,
// le dossier temporaire privé du bac supprimé en fin de session sur les trois
// surfaces, et laissé seul par les runs suivants après une coupure brutale.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Un faux dossier personnel pour ce processus et pour chaque smol lancé :
// ni le vrai ~/.smolcoder, ni ~/.smolcoder.json, ni ~/.npm ne sont touchés.
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const HOME = tmp("smol-e2e-home-");
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../../dist/harness/store");
const { Mission } = require("../../dist/harness/mission");

const CLI = path.join(__dirname, "..", "..", "dist", "index.js");
const MODEL = "smol-e2e-fake-model";
const MAC = process.platform === "darwin";
const skip = MAC ? false : `macOS only (this system is ${process.platform})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
async function until(cond, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const free = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const get = (port) => new Promise((done) => http.get({ host: "127.0.0.1", port, timeout: 1000 }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => done(b)); }).on("error", (e) => done(e.code)).on("timeout", function () { this.destroy(); done("TIMEOUT"); }));

// ---- le faux modèle : un serveur OpenAI-compatible local, scripté ----------

/** Répond comme un serveur OpenAI-compatible (`/v1/models`, flux SSE de
 * `/v1/chat/completions`). Chaque requête d'agent (avec outils) consomme
 * l'étape suivante du script ; une étape peut être une fonction, qui agit
 * côté hôte avant de répondre. Une requête sans outils (titre de session)
 * reçoit un titre. Tout est journalisé. */
async function fakeModel(script) {
  const requests = [];
  let step = 0;
  const server = http.createServer(async (q, r) => {
    let raw = "";
    for await (const d of q) raw += d;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: q.method, url: q.url, body });
    if (q.method === "GET" && q.url === "/v1/models") {
      r.writeHead(200, { "content-type": "application/json" });
      return r.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", context_length: 32768 }] }));
    }
    if (q.method === "POST" && q.url === "/v1/chat/completions") {
      let reply = { content: "E2E session" };
      if (body.tools) {
        const s = script[Math.min(step++, script.length - 1)];
        reply = typeof s === "function" ? await s(body) : s;
      }
      r.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o) => r.write(`data: ${JSON.stringify(o)}\n\n`);
      if (reply.content) chunk({ choices: [{ index: 0, delta: { content: reply.content } }] });
      (reply.toolCalls ?? []).forEach((tc, index) => chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] } }] }));
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      return r.end("data: [DONE]\n\n");
    }
    r.writeHead(404, { "content-type": "application/json" });
    r.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const toolResults = () => {
    const last = requests.filter((x) => x.body?.tools).pop();
    return (last?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
  };
  return { url: `http://127.0.0.1:${server.address().port}`, requests, toolResults, close: () => server.close() };
}
const call = (id, name, args) => ({ toolCalls: [{ id, name, args }] });

// ---- la fixture : un workspace, un témoin hors du workspace, une mission ---

const WITNESS = "sk-e2e-witness-FAKE-51c0";
const HOME_SECRET = "sk-e2e-home-FAKE-8d2e";
const DOTENV = "sk-e2e-dotenv-FAKE-a7f3";

// Chaque tentative imprime « nom=denied » ou « nom=LEAK ». Les cibles viennent
// d'un fichier du workspace : le texte des commandes reste dans le workspace,
// la politique les laisse passer, seul le noyau peut les arrêter.
const PROBE_SH = String.raw`. ./targets.env
S=$1
try() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "$name=LEAK"; else echo "$name=denied"; fi; }
try read-witness     cat "$WITNESS"
try read-home-secret cat "$HOME_SECRET"
try read-policy      cat "$POLICY"
try write-policy     sh -c 'echo "{}" >> "$1"' _ "$POLICY"
try read-dotenv      cat .env
try sub-node         node -e "require('fs').readFileSync(process.argv[1])" "$WITNESS"
echo ok > "written-$S.txt" && echo "write-workspace=$(cat "written-$S.txt")"
`;
// La vérification --verify : même sonde ; elle ne passe que confinée.
const VERIFY_SH = String.raw`sh probe.sh check > check.out 2>&1
if grep -q "=LEAK" check.out; then exit 1; fi
grep -q "^write-workspace=ok$" check.out
`;
const DENIED = ["read-witness", "read-home-secret", "read-policy", "write-policy", "read-dotenv", "sub-node"];

const results = (text) => Object.fromEntries(plain(text).split("\n").filter((l) => /^[a-z0-9-]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
function assertConfined(text, what) {
  const got = results(text);
  for (const k of DENIED) assert.equal(got[k], "denied", `${what}: ${k} (${got[k]})\n${text}`);
  assert.equal(got["write-workspace"], "ok", `${what}: the workspace stays writable\n${text}`);
  for (const s of [WITNESS, HOME_SECRET, DOTENV]) assert.ok(!text.includes(s), `${what}: ${s} leaked`);
}

const outside = tmp("smol-e2e-outside-");
fs.writeFileSync(path.join(outside, "witness.txt"), WITNESS);
fs.mkdirSync(path.join(HOME, ".ssh"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".ssh", "id_fake"), HOME_SECRET);

/** Un workspace neuf et sa mission, préparée (et approuvée si demandé) par
 * l'hôte dans le stockage du faux dossier personnel, que smol relira.
 * `checks` (#9) : les contrôles de l'hôte qui couvrent le critère ; sans eux,
 * un run headless sous --mission sort 5 (critère non couvert). */
function fixture(tag, { approve = false, policy = {}, checks } = {}) {
  const ws = tmp(`smol-e2e-${tag}-`);
  const src = path.join(tmp("smol-e2e-src-"), "contract.json");
  fs.writeFileSync(src, JSON.stringify({ schema: "smolcoder/contract/v1", id: `e2e-${tag}`, title: "Bout en bout", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 50 }, ...(checks ? { checks } : {}) }));
  const m = Mission.prepare({ source: src, workspace: ws });
  store.writePolicy(m.dir, { ...store.DEFAULT_POLICY, ...policy });
  if (approve) m.approve("terminal-human");
  fs.writeFileSync(path.join(ws, ".env"), `API_KEY=${DOTENV}\n`);
  fs.writeFileSync(path.join(ws, "targets.env"), [
    `WITNESS=${JSON.stringify(path.join(outside, "witness.txt"))}`,
    `HOME_SECRET=${JSON.stringify(path.join(HOME, ".ssh", "id_fake"))}`,
    `POLICY=${JSON.stringify(path.join(m.dir, "policy.json"))}`,
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(ws, "probe.sh"), PROBE_SH);
  fs.writeFileSync(path.join(ws, "verify.sh"), VERIFY_SH);
  return { ws, src, m };
}

/** Des programmes piégés dans le workspace, que seules les sondes de l'hôte
 * (contrôle syntaxique, détection des modèles) pourraient lancer hors du bac,
 * par une entrée relative, vide ou interne au workspace du PATH. */
function plantProbes(ws) {
  const markers = tmp("smol-e2e-markers-");
  for (const dir of [ws, path.join(ws, "bin"), path.join(ws, "node_modules", ".bin")]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["python3", "python", "docker", "podman"]) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n: > "${markers}/${path.basename(dir)}-${name}"\n[ "$1" = "-I" ] && echo 1\nexit 0\n`, { mode: 0o755 });
    }
  }
  return { markers, PATH: ["node_modules/.bin", "", path.join(ws, "bin"), process.env.PATH].join(":") };
}

/** L'environnement de smol : le faux dossier personnel, le faux modèle comme
 * seul serveur joignable (OLLAMA_HOST ; aucune machine du réseau n'est
 * configurée), et le PATH de l'hôte. */
function smolEnv(model, extra = {}) {
  // TMPDIR transmis (#44) : le binaire range son dossier temporaire privé dans
  // celui de la passe, que le lanceur supprime, et non dans /tmp.
  return { PATH: process.env.PATH, HOME, TMPDIR: process.env.TMPDIR, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: model.url, LANG: "en_US.UTF-8", ...extra };
}

/** Le vrai binaire, en asynchrone : le faux modèle répond depuis ce processus. */
function smol(args, env, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, all: stdout + stderr }); });
  });
}
const tagged = (stderr, tag) => {
  const line = stderr.split("\n").find((l) => l.startsWith(`[${tag}] `));
  assert.ok(line, `a [${tag}] line is printed\n${stderr}`);
  return JSON.parse(line.slice(tag.length + 3));
};

// ---- headless ---------------------------------------------------------------

test("H03-4 OS AC5 (headless): the real smol binary, headless under --mission, runs the model's run_command and the --verify check inside the sandbox — a witness outside the workspace stays unreadable, host probes run no planted program — while the same run without --mission reads it", { skip, timeout: 180000 }, async (t) => {
  const f = fixture("headless", { checks: [{ command: "sh verify.sh", covers: [1] }] });
  const { markers, PATH } = plantProbes(f.ws);
  assert.equal(fs.readFileSync(path.join(outside, "witness.txt"), "utf8"), WITNESS, "the host reads the witness: a refusal below is the sandbox's");
  const script = () => [
    call("c1", "run_command", { command: "sh probe.sh command | tee command.out" }),
    call("w1", "write_file", { path: "bad.py", content: "def f(:\n    pass\n" }),
    { content: "done" },
  ];
  const model = await fakeModel(script());
  t.after(() => model.close());
  const r = await smol([f.ws, "-p", "probe the boundary", "--mission", f.src, "--approve", f.m.fingerprint, "--model", MODEL, "--verify", "sh verify.sh", "--verify-attempts", "1"], smolEnv(model, { PATH }));
  assert.equal(r.code, 0, r.all);
  assert.equal(tagged(r.stderr, "mission").state, "approved");
  const iso = tagged(r.stderr, "isolation");
  assert.deepEqual({ backend: iso.backend, state: iso.state, listen: iso.listen }, { backend: "seatbelt", state: "ready", listen: undefined }, "no listening granted: no listen field");
  assert.deepEqual(tagged(r.stderr, "stats").verification, { attempts: 1, passed: true }, "the check ran once and passed — it passes only when confined");
  // Ce que le modèle a reçu, ce que la commande et la vérification ont écrit.
  const [commandResult, writeResult] = model.toolResults();
  assertConfined(commandResult, "run_command, as the model saw it");
  assertConfined(fs.readFileSync(path.join(f.ws, "command.out"), "utf8"), "run_command");
  assertConfined(fs.readFileSync(path.join(f.ws, "check.out"), "utf8"), "the --verify check");
  assert.match(writeResult, /Warning: Python syntax error/, "the host python compiled bad.py (a planted one would have passed it)");
  assert.deepEqual(fs.readdirSync(markers), [], "no planted program ran on the host");
  for (const s of [WITNESS, HOME_SECRET, DOTENV]) assert.ok(!r.all.includes(s) && !JSON.stringify(model.requests).includes(s), `${s} never left the sandbox`);
  assert.ok(model.requests.every((q) => q.url === "/v1/models" || q.url === "/v1/chat/completions" || /^\/api\//.test(q.url)), "only the fake model was asked");

  // Témoin : le même run sans --mission lit le témoin — la différence est l'isolation.
  const c = fixture("control");
  const control = await fakeModel(script());
  t.after(() => control.close());
  const u = await smol([c.ws, "-p", "probe the boundary", "--model", MODEL, "--verify", "sh verify.sh", "--verify-attempts", "1"], smolEnv(control));
  assert.equal(u.code, 1, "without isolation the check sees the witness and fails");
  assert.doesNotMatch(u.stderr, /^\[isolation\]/m, "outside the profile nothing is said about isolation");
  for (const file of ["command.out", "check.out"]) {
    const got = results(fs.readFileSync(path.join(c.ws, file), "utf8"));
    assert.equal(got["read-witness"], "LEAK", `${file}: the unconfined run reads the witness`);
    assert.equal(got["read-home-secret"], "LEAK", `${file}: and the home folder`);
  }
});

test("H03-4 OS AC3 (headless): a development server started as a background task (npm run dev) listens on the port the policy names and serves the host; another port stays refused; the headless [isolation] line and the status line carry the listening port", { skip, timeout: 180000 }, async (t) => {
  const port = await free();
  let other = await free();
  while (other === port) other = await free();
  const f = fixture("devserver", { policy: { tasks: "workspace", listen: [`localhost:${port}`] }, checks: [{ command: "sh verify.sh", covers: [1] }] });
  fs.writeFileSync(path.join(f.ws, "package.json"), JSON.stringify({ name: "devserver", version: "1.0.0", scripts: { dev: `node server.cjs ${port}` } }));
  fs.writeFileSync(path.join(f.ws, "server.cjs"), 'const port = Number(process.argv[2]);\nrequire("http").createServer((q, r) => r.end("pong-dev-server")).listen(port, "127.0.0.1", () => console.log("dev server on http://127.0.0.1:" + port));\n');
  fs.writeFileSync(path.join(f.ws, "other.cjs"), 'require("http").createServer().listen(Number(process.argv[2]), "127.0.0.1", () => { console.log("other-port=LISTENING"); process.exit(0); }).on("error", (e) => console.log("other-port=" + e.code));\n');
  let hostGot = null;
  const model = await fakeModel([
    call("t1", "task", { action: "start", command: "npm run dev" }),
    // Pendant le run : l'hôte joint le serveur de la tâche, sur le port nommé.
    async () => {
      hostGot = await until(async () => { const b = await get(port); return b === "pong-dev-server" && b; }, 20000, "the dev server to answer the host").catch((e) => String(e));
      return call("c1", "run_command", { command: `node other.cjs ${other}` });
    },
    call("l1", "task", { action: "logs", task_id: "t1" }),
    { content: "done" },
  ]);
  t.after(() => model.close());
  const r = await smol([f.ws, "-p", "start the dev server", "--mission", f.src, "--approve", f.m.fingerprint, "--model", MODEL], smolEnv(model));
  assert.equal(r.code, 0, r.all);
  assert.equal(hostGot, "pong-dev-server", "the host reached the sandboxed dev server on the named port");
  const [started, otherPort, logs] = model.toolResults();
  assert.match(started, /t1/, started);
  assert.match(otherPort, /other-port=EPERM/, "another port stays refused");
  assert.match(logs, /dev server on http:\/\/127\.0\.0\.1:/, logs);
  const iso = tagged(r.stderr, "isolation");
  assert.deepEqual({ state: iso.state, listen: iso.listen }, { state: "ready", listen: [`localhost:${port}`] }, "the headless [isolation] line names the listening port");
  assert.match(plain(r.all), new RegExp(`they may listen on localhost:${port}, which the local network can reach`), "the status line states the limit");
  assert.notEqual(await get(port), "pong-dev-server", "the task was stopped with the run");
});

// ---- #9 : verdicts du vrai binaire, contrôle décisif dans le bac ---------------

test("H04 OS (headless): the real smol binary under --mission runs the decisive check in the sandbox and keeps its verdict out of the model's reach — a trivial test script earns exit 5 and a blocked verdict, a real fix earns exit 0, and report.json/report.md land in the host store, which the sandbox cannot forge", { skip, timeout: 240000 }, async (t) => {
  const witness = path.join(outside, "witness.txt");
  const files = (f) => {
    fs.writeFileSync(path.join(f.ws, "package.json"), JSON.stringify({ name: "h04", version: "1.0.0", scripts: { test: "node --test" } }));
    fs.writeFileSync(path.join(f.ws, "app.js"), "module.exports = () => 1;\n");
    fs.mkdirSync(path.join(f.ws, "test"));
    // Le test approuvé exige aussi le bac : hors de lui, le témoin se lit.
    fs.writeFileSync(path.join(f.ws, "test", "app.test.js"), [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "test('app returns 2', () => assert.equal(require('../app.js')(), 2));",
      `test('the check runs confined', () => assert.throws(() => require('fs').readFileSync(${JSON.stringify(witness)}), /EPERM|not permitted/i));`,
      "",
    ].join("\n"));
    fs.appendFileSync(path.join(f.ws, "targets.env"), `REPORT=${JSON.stringify(path.join(f.m.dir, "report.json"))}\n`);
    fs.writeFileSync(path.join(f.ws, "forge.sh"), '. ./targets.env\nif echo \'{"task":{"state":"verified"}}\' > "$REPORT" 2>/dev/null; then echo forge=LEAK; else echo forge=denied; fi\n');
  };
  const args = (f) => [f.ws, "-p", "make the test pass", "--mission", f.src, "--approve", f.m.fingerprint, "--model", MODEL, "--verify", "npm test", "--verify-attempts", "1"];
  const checks = [{ command: "npm test", covers: [1] }];

  // 1. Le modèle remplace le script de test par un succès trivial.
  const a = fixture("h04-tamper", { checks });
  files(a);
  const tamper = await fakeModel([
    call("w1", "write_file", { path: "package.json", content: JSON.stringify({ name: "h04", version: "1.0.0", scripts: { test: "exit 0" } }) }),
    call("c1", "run_command", { command: "sh forge.sh" }),
    { content: "Terminé : tous les tests passent." },
  ]);
  t.after(() => tamper.close());
  const r1 = await smol(args(a), smolEnv(tamper));
  assert.equal(r1.code, 5, r1.all);
  const v1 = tagged(r1.stderr, "verdict");
  assert.deepEqual([v1.state, v1.verifiers, v1.criteria.passed], ["blocked", "changed", 0]);
  assert.equal(v1.report, path.join(a.m.dir, "report.json"));
  const [, forged] = tamper.toolResults();
  assert.match(forged, /forge=denied/, "the sandbox cannot write the report");
  const rep1 = JSON.parse(fs.readFileSync(path.join(a.m.dir, "report.json"), "utf8"));
  assert.equal(rep1.task.state, "blocked", "the report is the host's, not the forged one");
  assert.deepEqual(rep1.verifiers.changes, ["package.json (modified)"]);
  assert.match(fs.readFileSync(path.join(a.m.dir, "report.md"), "utf8"), /État de la tâche : \*\*blocked\*\*/);
  const ev1 = store.readProofs(a.m.dir).events.filter((e) => e.type === "verdict");
  assert.deepEqual(ev1.map((e) => [e.status, e.cause]), [["not_run", "verifier-changed"]]);
  const direct = require("child_process").spawnSync("npm", ["test"], { cwd: a.ws, env: { PATH: process.env.PATH, HOME }, encoding: "utf8" });
  assert.equal(direct.status, 0, "the tampered script would have passed");

  // 2. Le modèle corrige le code : le contrôle tourne dans le bac et passe.
  const b = fixture("h04-fix", { checks });
  files(b);
  const fix = await fakeModel([
    call("w1", "write_file", { path: "app.js", content: "module.exports = () => 2;\n" }),
    { content: "Terminé." },
  ]);
  t.after(() => fix.close());
  const r2 = await smol(args(b), smolEnv(fix));
  assert.equal(r2.code, 0, r2.all);
  const v2 = tagged(r2.stderr, "verdict");
  assert.deepEqual([v2.state, v2.criteria], ["verified", { passed: 2, failed: 0, not_run: 0, error: 0 }]);
  assert.deepEqual(tagged(r2.stderr, "stats").verification, { attempts: 1, passed: true });
  const ev2 = store.readProofs(b.m.dir).events.filter((e) => e.type === "verdict");
  assert.deepEqual(ev2.map((e) => [e.status, e.exit.code, e.tests, e.criteria]), [["passed", 0, 2, ["acceptance-1", "verify"]]], "both tests ran, the confinement test included");
  for (const f of [a, b]) assert.ok(!fs.readdirSync(f.ws).some((n) => /^report\./.test(n)), "no report inside the workspace");
  // Le même test approuvé, lancé hors du bac, échoue : il lit le témoin.
  // Environnement explicite : un node --test imbriqué hériterait sinon de
  // NODE_TEST_CONTEXT et sortirait 0.
  const unconfined = require("child_process").spawnSync(process.execPath, ["--test"], { cwd: b.ws, env: { PATH: process.env.PATH, HOME }, encoding: "utf8" });
  assert.notEqual(unconfined.status, 0, "outside the sandbox the confinement test fails");
});

// ---- H08 (#29) : plan proposé puis approuvé, en deux runs du vrai binaire --

test("H08 OS (headless): the real smol binary proposes its plan in a read-only --propose-plan run (exit 3, plan shown, fingerprint in the [mission] line), then --approve with --approve-plan records both fingerprints, and a write outside the plan goes through as a journaled deviation while the check passes in the sandbox", { skip, timeout: 240000 }, async (t) => {
  const f = fixture("h08-plan", { checks: [{ command: "grep -q bonjour hello.txt", covers: [1] }] });
  const before = fs.readdirSync(f.ws).sort();
  const lastTagged = (stderr, tag) => {
    const lines = stderr.split("\n").filter((l) => l.startsWith(`[${tag}] `));
    assert.ok(lines.length, `a [${tag}] line is printed\n${stderr}`);
    return JSON.parse(lines.at(-1).slice(tag.length + 3));
  };

  // 1. Run de proposition : le modèle lit, propose, s'arrête ; rien n'est écrit.
  const propose = await fakeModel([
    call("l1", "list_files", {}),
    call("p1", "plan", { action: "propose", steps: "write hello.txt with bonjour\nlet the host check it", files: "hello.txt", risks: "none beyond the contract" }),
    { content: "Plan proposed; waiting for the host." },
  ]);
  t.after(() => propose.close());
  const r1 = await smol([f.ws, "-p", "create hello.txt", "--mission", f.src, "--propose-plan", "--model", MODEL], smolEnv(propose));
  assert.equal(r1.code, 3, r1.all);
  const m1 = lastTagged(r1.stderr, "mission");
  assert.equal(m1.state, "proposed");
  assert.equal(m1.plan.state, "proposed");
  assert.match(m1.plan.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(m1.plan.missingProofs, [], "the only criterion is covered by the host check");
  assert.match(r1.stdout, /# Intention — Bout en bout/);
  assert.match(r1.stdout, new RegExp(`## Plan d'implémentation — proposé[\\s\\S]*${m1.plan.fingerprint}`));
  const first = propose.requests.find((q) => q.body?.tools);
  const names = first.body.tools.map((x) => x.function.name);
  assert.ok(!names.includes("write_file") && !names.includes("run_command"), `read-only tools only: ${names}`);
  assert.ok(first.body.tools.find((x) => x.function.name === "plan").function.parameters.properties.action.enum.includes("propose"));
  assert.match(first.body.messages.at(-1).content, /Plan proposal run/);
  assert.deepEqual(fs.readdirSync(f.ws).sort(), before, "nothing is written in the workspace");
  const ev1 = store.readProofs(f.m.dir).events;
  assert.deepEqual(ev1.map((e) => [e.type, e.kind ?? e.status]), [["contract", "proposed"], ["plan", "proposed"]], "no approval, no verdict");

  // 2. Approbation des deux empreintes, puis le travail : un fichier hors plan.
  const work = await fakeModel([
    call("w1", "write_file", { path: "hello.txt", content: "bonjour\n" }),
    call("w2", "write_file", { path: "notes.md", content: "hors plan\n" }),
    { content: "Terminé." },
  ]);
  t.after(() => work.close());
  const r2 = await smol([f.ws, "-p", "create hello.txt", "--mission", f.src, "--approve", f.m.fingerprint, "--approve-plan", m1.plan.fingerprint, "--model", MODEL], smolEnv(work));
  assert.equal(r2.code, 0, r2.all);
  const m2 = tagged(r2.stderr, "mission");
  assert.deepEqual([m2.state, m2.plan.state, m2.plan.fingerprint], ["approved", "approved", m1.plan.fingerprint]);
  assert.match(r2.all, new RegExp(`with plan ${m1.plan.fingerprint.slice(0, 16)}`));
  assert.equal(tagged(r2.stderr, "verdict").state, "verified", "the host check passed, in the sandbox");
  assert.match(work.requests.find((q) => q.body?.tools).body.messages.at(-1).content, new RegExp(`Plan: approved ${m1.plan.fingerprint.slice(0, 16)}`));
  const [planned, outside] = work.toolResults();
  assert.doesNotMatch(planned, /\[Plan:/);
  assert.match(outside, /\[Plan: "notes\.md" is not among the files of the approved plan — recorded as a deviation/);
  assert.equal(fs.readFileSync(path.join(f.ws, "notes.md"), "utf8"), "hors plan\n", "never blocked");
  const ev2 = store.readProofs(f.m.dir).events;
  const approval = ev2.find((e) => e.type === "approval");
  assert.deepEqual([approval.by, approval.fingerprint, approval.plan], ["headless-flag", f.m.fingerprint, m1.plan.fingerprint]);
  const devs = ev2.filter((e) => e.type === "plan" && e.kind === "deviation");
  assert.deepEqual(devs.map((d) => [d.change, d.before, d.after, d.reason, d.plan]), [["file", [], ["notes.md"], null, m1.plan.fingerprint]]);
  const report = JSON.parse(fs.readFileSync(path.join(f.m.dir, "report.json"), "utf8"));
  assert.deepEqual([report.task.state, report.plan.state, report.plan.deviations.length], ["verified", "approved", 1], "a deviation changes no status");
  assert.match(fs.readFileSync(path.join(f.m.dir, "report.md"), "utf8"), /fichier hors plan : `notes\.md`/);
  assert.ok(!fs.readdirSync(f.ws).some((n) => /plan|report/i.test(n)), "neither the plan nor the report lands in the workspace");
});

// ---- reprise durable (#10, H05) ---------------------------------------------

test("H05 OS (headless): the real smol binary killed between a write and its receipt leaves an intent without result; the next run takes the dead writer's lock, finds the action uncertain with the file's evidence and stops before any model (exit 6); --resolve lets the third run finish without replaying the write", { skip, timeout: 240000 }, async (t) => {
  const f = fixture("h05-cut", { checks: [{ command: "sh check.sh", covers: [1] }] });
  t.after(() => { for (const d of [f.ws, path.dirname(f.src), f.m.dir]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(f.ws, "check.sh"), "grep -q bonjour hello.txt\n");
  const model = await fakeModel([
    call("w1", "write_file", { path: "hello.txt", content: "bonjour" }),
    call("r1", "read_file", { path: "hello.txt" }),
    { content: "hello.txt dit bonjour." },
  ]);
  t.after(() => model.close());
  const effects = () => store.readProofs(f.m.dir).events.filter((e) => e.type === "effect");
  const agentRequests = () => model.requests.filter((q) => q.body?.tools).length;

  // 1. Coupure réelle : le processus est tué (SIGKILL) après l'écriture, avant son reçu.
  const first = await smol([f.ws, "-p", "write hello.txt", "--mission", f.src, "--approve", f.m.fingerprint, "--model", MODEL], smolEnv(model, { SMOLCODER_TEST_CRASH_AT: "after-effect" }));
  assert.equal(first.signal, "SIGKILL", first.all);
  assert.equal(fs.readFileSync(path.join(f.ws, "hello.txt"), "utf8"), "bonjour", "the write happened");
  const cut = effects();
  assert.deepEqual(cut.map((e) => [e.kind, e.tool, e.path]), [["intent", "write_file", "hello.txt"]], "an intent, recorded before the write, and no result");
  const dead = JSON.parse(fs.readFileSync(path.join(f.m.dir, "lock"), "utf8"));
  assert.equal(dead.surface, "headless", "the killed run left its lock behind");
  assert.throws(() => process.kill(dead.pid, 0), /ESRCH/, "its process is gone");
  const before = agentRequests();

  // 2. Reprise : verrou mort repris, action incertaine, suspension avant tout modèle.
  const second = await smol([f.ws, "-p", "continue", "--mission", f.src, "--model", MODEL], smolEnv(model));
  assert.equal(second.code, 6, second.all);
  const resume = tagged(second.stderr, "resume");
  assert.deepEqual(resume.uncertain, [{ id: cut[0].id, tool: "write_file", target: "hello.txt", evidence: "expected" }], "the file matches the intended write: it appears applied — never concluded");
  assert.equal(resume.lock.state, "held");
  assert.equal(resume.lock.tookOver.pid, dead.pid, "the dead writer's lock was taken over");
  assert.match(second.all, /Nothing was run\. 1 action of an earlier session has no recorded result/);
  assert.equal(agentRequests(), before, "the model was never asked");
  assert.deepEqual(effects().map((e) => e.kind), ["intent", "uncertain"]);
  assert.equal(fs.existsSync(path.join(f.m.dir, "lock")), false, "the suspended run released its lock");

  // 3. L'appelant résout ; le run va au bout sans rejouer l'écriture.
  const third = await smol([f.ws, "-p", "check hello.txt and finish", "--mission", f.src, "--model", MODEL, "--resolve", cut[0].id], smolEnv(model));
  assert.equal(third.code, 0, third.all);
  assert.deepEqual(tagged(third.stderr, "resume").resolved, [cut[0].id]);
  const all = effects();
  assert.deepEqual(all.filter((e) => e.kind === "resolved").map((e) => [e.id, e.by]), [[cut[0].id, "headless-flag"]]);
  assert.equal(all.filter((e) => e.kind === "intent" && e.tool === "write_file").length, 1, "the write was never replayed");
  assert.equal(tagged(third.stderr, "verdict").state, "verified");
  assert.equal(fs.readFileSync(path.join(f.ws, "hello.txt"), "utf8"), "bonjour");
  assert.equal(fs.existsSync(path.join(f.m.dir, "lock")), false, "the lock is released at the end of the run");
});

// ---- #46 : le dossier temporaire privé du bac, supprimé en fin de session ----

/** Les dossiers privés des bacs dans le dossier temporaire de la passe (#44),
 * où le binaire range le sien (TMPDIR transmis par smolEnv). */
const sandboxes = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("smol-sandbox-")).sort();
/** La commande confinée note son TMPDIR dans le workspace et y laisse un
 * fichier temporaire, comme une commande de l'agent. */
const TMP_SH = 'echo "$TMPDIR" > "tmpdir-$1.txt" && echo agent > "$TMPDIR/agent-temp.txt" && echo "tmp-written=$1"\n';
/** Une tâche de fond qui écrit dans son TMPDIR et le récrée à chaque
 * battement : vivante après la suppression, elle ferait réapparaître le dossier. */
const TICK_CJS = "const fs = require('fs'), dir = process.env.TMPDIR;\nconsole.log('ticking in ' + dir);\nsetInterval(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/tick', String(Date.now())); }, 50);\n";
function withTmpScripts(f) {
  fs.writeFileSync(path.join(f.ws, "tmp.sh"), TMP_SH);
  fs.writeFileSync(path.join(f.ws, "tick.cjs"), TICK_CJS);
  fs.writeFileSync(path.join(f.ws, "check.sh"), "grep -q bonjour hello.txt\n");
  return f;
}
/** Le TMPDIR privé qu'une commande confinée a noté : un smol-sandbox-* du
 * dossier temporaire de la passe. */
function notedTmp(ws, tag) {
  const dir = fs.readFileSync(path.join(ws, `tmpdir-${tag}.txt`), "utf8").trim().replace(/\/+$/, "");
  assert.match(path.basename(dir), /^smol-sandbox-/, dir);
  assert.equal(path.dirname(dir), fs.realpathSync.native(os.tmpdir()), "the pass's temporary folder holds it");
  return dir;
}
const hasNoted = (ws, tag) => {
  const file = path.join(ws, `tmpdir-${tag}.txt`);
  return fs.existsSync(file) && /smol-sandbox-/.test(fs.readFileSync(file, "utf8"));
};
const CHECKS_46 = [{ command: "sh check.sh", covers: [1] }];
const headless46 = (f, env) => smol([f.ws, "-p", "work", "--mission", f.src, "--approve", f.m.fingerprint, "--model", MODEL], env);

test("#46 OS AC2 (headless): the real smol binary under --mission removes its private temporary folder when a run ends normally — the background task still writing there is killed first, nothing recreates it, and no smol-sandbox-* folder is left", { skip, timeout: 180000 }, async (t) => {
  const f = withTmpScripts(fixture("i46-ok", { policy: { tasks: "workspace" }, checks: CHECKS_46 }));
  const before = sandboxes();
  let ticking = null;
  const model = await fakeModel([
    call("c1", "run_command", { command: "sh tmp.sh ok" }),
    call("t1", "task", { action: "start", command: "node tick.cjs" }),
    // Pendant le run, côté hôte : la tâche écrit dans le dossier privé, à côté
    // du fichier temporaire de la commande.
    async () => {
      const dir = notedTmp(f.ws, "ok");
      ticking = await until(() => fs.existsSync(path.join(dir, "tick")) && fs.existsSync(path.join(dir, "agent-temp.txt")), 20000, "the task ticking in the private folder").then(() => true, (e) => String(e));
      return call("w1", "write_file", { path: "hello.txt", content: "bonjour\n" });
    },
    { content: "done" },
  ]);
  t.after(() => model.close());
  const r = await headless46(f, smolEnv(model));
  assert.equal(r.code, 0, r.all);
  assert.equal(tagged(r.stderr, "isolation").state, "ready");
  assert.equal(tagged(r.stderr, "verdict").state, "verified");
  const [command, task] = model.toolResults();
  assert.match(command, /tmp-written=ok/, command);
  assert.match(task, /Task t1 is running in the background/, task);
  assert.equal(ticking, true, "during the run the background task wrote in the private folder");
  const dir = notedTmp(f.ws, "ok");
  assert.equal(fs.existsSync(dir), false, "the private folder is removed at the end of the run");
  await sleep(500);
  assert.equal(fs.existsSync(dir), false, "the task was killed: nothing recreated the folder");
  assert.deepEqual(sandboxes(), before, "no smol-sandbox-* folder is left behind");
});

test("#46 OS AC2 (headless): the private folder is removed however the run ends — a verdict that cannot pass (exit 5), a suspension on a decision nobody can take (exit 4), a SIGTERM in the middle of a turn (exit 143)", { skip, timeout: 240000 }, async (t) => {
  const before = sandboxes();
  // 1. Échec : aucun contrôle ne couvre le critère, le verdict ne peut pas passer.
  const a = withTmpScripts(fixture("i46-fail"));
  const failing = await fakeModel([call("c1", "run_command", { command: "sh tmp.sh fail" }), { content: "done" }]);
  t.after(() => failing.close());
  const r1 = await headless46(a, smolEnv(failing));
  assert.equal(r1.code, 5, r1.all);
  assert.match(failing.toolResults()[0], /tmp-written=fail/);
  assert.equal(fs.existsSync(notedTmp(a.ws, "fail")), false, "failure: the folder is removed");
  // 2. Suspension : une tâche de fond demande une décision humaine (politique par défaut).
  const b = withTmpScripts(fixture("i46-ask", { checks: CHECKS_46 }));
  const asking = await fakeModel([call("c1", "run_command", { command: "sh tmp.sh ask" }), call("t1", "task", { action: "start", command: "node tick.cjs" }), { content: "done" }]);
  t.after(() => asking.close());
  const r2 = await headless46(b, smolEnv(asking));
  assert.equal(r2.code, 4, r2.all);
  assert.equal(tagged(r2.stderr, "policy").verdict, "ask");
  assert.equal(fs.existsSync(notedTmp(b.ws, "ask")), false, "suspension: the folder is removed");
  // 3. Signal : SIGTERM pendant un tour ; le verrou d'écriture du run donne son pid.
  const c = withTmpScripts(fixture("i46-term", { checks: CHECKS_46 }));
  let atSignal = null;
  const stopped = await fakeModel([
    call("c1", "run_command", { command: "sh tmp.sh term" }),
    async () => {
      atSignal = fs.existsSync(notedTmp(c.ws, "term"));
      process.kill(JSON.parse(fs.readFileSync(path.join(c.m.dir, "lock"), "utf8")).pid, "SIGTERM");
      await sleep(2000);
      return { content: "too late" };
    },
  ]);
  t.after(() => stopped.close());
  const r3 = await headless46(c, smolEnv(stopped));
  assert.equal(r3.code, 143, r3.all);
  assert.equal(atSignal, true, "the folder existed when the signal came");
  assert.equal(fs.existsSync(notedTmp(c.ws, "term")), false, "signal: the folder is removed");
  assert.deepEqual(sandboxes(), before, "no smol-sandbox-* folder is left behind");
});

test("#46 OS AC3 (headless): a run killed outright (SIGKILL) leaves at most its own private folder — the documented limit — and a later run leaves it alone: no clean-up at start-up touches another session's folder", { skip, timeout: 180000 }, async (t) => {
  const before = sandboxes();
  // 1. Coupure réelle, après la commande et avant son reçu.
  const a = withTmpScripts(fixture("i46-kill", { checks: CHECKS_46 }));
  const killed = await fakeModel([call("c1", "run_command", { command: "sh tmp.sh kill" }), { content: "done" }]);
  t.after(() => killed.close());
  const r1 = await headless46(a, smolEnv(killed, { SMOLCODER_TEST_CRASH_AT: "after-effect" }));
  assert.equal(r1.signal, "SIGKILL", r1.all);
  const left = notedTmp(a.ws, "kill");
  t.after(() => fs.rmSync(left, { recursive: true, force: true }));
  assert.ok(fs.existsSync(path.join(left, "agent-temp.txt")), "killed outright, the run could not remove its folder");
  assert.deepEqual(sandboxes(), [...before, path.basename(left)].sort(), "at most its own folder");
  // 2. Un run suivant, normal, sur un autre workspace : il ne supprime que le sien.
  const b = withTmpScripts(fixture("i46-next", { checks: CHECKS_46 }));
  const next = await fakeModel([call("c1", "run_command", { command: "sh tmp.sh next" }), call("w1", "write_file", { path: "hello.txt", content: "bonjour\n" }), { content: "done" }]);
  t.after(() => next.close());
  const r2 = await headless46(b, smolEnv(next));
  assert.equal(r2.code, 0, r2.all);
  assert.equal(fs.existsSync(notedTmp(b.ws, "next")), false, "its own folder is removed");
  assert.ok(fs.existsSync(path.join(left, "agent-temp.txt")), "the killed run's folder is left alone, content included");
  assert.equal(fs.readFileSync(path.join(left, "agent-temp.txt"), "utf8"), "agent\n");
  assert.deepEqual(sandboxes(), [...before, path.basename(left)].sort());
});

// ---- web ----------------------------------------------------------------------

function post(port, token, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `${p}?k=${token}`, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve(JSON.parse(data || "{}")));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function events(port, token) {
  const list = [];
  const req = http.get({ host: "127.0.0.1", port, path: `/events?k=${token}` }, (res) => {
    let buf = "";
    res.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) list.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  req.on("error", () => {});
  return { list, close: () => req.destroy() };
}

test("H03-4 OS AC5 (web): the real smol --web --mission confines the model's run_command and the web terminal alike, and the page's session state shows the isolation", { skip, timeout: 180000 }, async (t) => {
  const f = fixture("web", { approve: true });
  const model = await fakeModel([call("c1", "run_command", { command: "sh probe.sh web-model | tee web-model.out" }), { content: "done" }]);
  t.after(() => model.close());
  const webPort = await free();
  const p = spawn(process.execPath, [CLI, "--web", String(webPort), f.ws, "--mission", f.src, "--model", MODEL], { env: smolEnv(model), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
  t.after(() => p.kill("SIGKILL"));
  const token = (await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?k=([\w-]+)/.exec(out), 20000, "the web UI URL"))[1];
  const sse = events(webPort, token);
  t.after(() => sse.close());
  const state = await until(() => sse.list.find((e) => e.t === "state" && e.s?.mode && e.s.isolation), 30000, "the mission session's state");
  const sid = state.sid;
  assert.equal(state.s.mission.state, "approved");
  assert.deepEqual([state.s.isolation.backend, state.s.isolation.state, state.s.isolation.label], ["seatbelt", "ready", "isolated"], "the page gets the isolation state");
  // 1. Le terminal web de la session.
  const { tid } = await post(webPort, token, "/term/open", { sid });
  assert.ok(tid, "a terminal opens");
  await post(webPort, token, "/term/input", { sid, tid, text: "sh probe.sh web-terminal > web-terminal.out 2>&1; echo done > web-terminal.marker" });
  // 2. Le run_command du modèle, par un message de la page.
  await post(webPort, token, "/msg", { sid, text: "probe the boundary" });
  await until(() => fs.existsSync(path.join(f.ws, "web-terminal.marker")) && /write-workspace=/.test(fs.existsSync(path.join(f.ws, "web-model.out")) ? fs.readFileSync(path.join(f.ws, "web-model.out"), "utf8") : ""), 30000, "the terminal line and the model's command");
  assertConfined(fs.readFileSync(path.join(f.ws, "web-terminal.out"), "utf8"), "web terminal");
  assertConfined(fs.readFileSync(path.join(f.ws, "web-model.out"), "utf8"), "web run_command");
  const later = await until(() => sse.list.filter((e) => e.t === "state" && e.sid === sid && e.s?.mode).pop()?.s.isolation, 5000, "a later state");
  assert.equal(later.state, "ready", "still shown after the turn");
  p.kill("SIGTERM");
  const end = await exited;
  assert.ok(end.code !== null || end.signal, "the web UI stops");
});

// ---- interface terminal (pseudo-terminal) -------------------------------------

test("H03-4 OS AC5 (terminal): the real interactive smol under --mission, driven through a pseudo-terminal, runs the model's run_command inside the sandbox, and its status row keeps showing the isolation", { skip, timeout: 180000 }, async (t) => {
  const f = fixture("tui", { approve: true });
  const model = await fakeModel([call("c1", "run_command", { command: "sh probe.sh tui | tee tui.out" }), { content: "done" }]);
  t.after(() => model.close());
  // `script` donne au binaire un vrai terminal. Ses touches arrivent par un vrai
  // tube (`cat |`) : `script` refuse la socket que Node donne pour entrée. Le
  // groupe entier (sh, cat, script, smol) est tué à la fin, quoi qu'il arrive.
  const inner = 'stty cols 160 rows 40; exec "$@"';
  const p = spawn("/bin/sh", ["-c", `/bin/cat | /usr/bin/script -q /dev/null /bin/sh -c '${inner}' sh "$@"`, "tui", process.execPath, CLI, f.ws, "--mission", f.src, "--model", MODEL], { env: { ...smolEnv(model), TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
  t.after(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* déjà terminé */ } });
  await until(() => /isolation: macOS Seatbelt/.test(plain(out)), 30000, "the opening line");
  await until(() => /mission approved 0\/50 · isolated/.test(plain(out)), 10000, "the status row");
  await sleep(300);
  const mark = out.length; // tout ce qui suit est postérieur à la ligne d'ouverture
  p.stdin.write("probe the boundary");
  await sleep(200);
  p.stdin.write("\r");
  await until(() => fs.existsSync(path.join(f.ws, "tui.out")) && /write-workspace=/.test(fs.readFileSync(path.join(f.ws, "tui.out"), "utf8")), 30000, "the model's command");
  assertConfined(fs.readFileSync(path.join(f.ws, "tui.out"), "utf8"), "terminal run_command");
  await until(() => model.requests.filter((q) => q.body?.tools).length >= 2, 15000, "the end of the turn");
  await sleep(1000);
  const after = plain(out.slice(mark));
  assert.match(after, /mission approved [1-9]\d*\/50 · isolated/, "the status row, redrawn after the turn (steps charged), still shows the isolation");
  p.stdin.write("/exit");
  await sleep(200);
  p.stdin.write("\r");
  p.stdin.end(); // cat, puis script, se terminent avec smol
  const end = await Promise.race([exited, sleep(15000).then(() => null)]);
  assert.ok(end, "the session exits on /exit");
});

// ---- #46 : web et terminal ------------------------------------------------------

test("#46 OS AC2 (web): the real smol --web --mission removes a session's private folder when the page closes it, when the page deletes it, and when the web UI stops with a session open", { skip, timeout: 180000 }, async (t) => {
  const f = withTmpScripts(fixture("i46-web", { approve: true }));
  const before = sandboxes();
  const model = await fakeModel([{ content: "done" }]);
  t.after(() => model.close());
  const webPort = await free();
  const p = spawn(process.execPath, [CLI, "--web", String(webPort), f.ws, "--mission", f.src, "--model", MODEL], { env: smolEnv(model), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
  t.after(() => p.kill("SIGKILL"));
  const token = (await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?k=([\w-]+)/.exec(out), 20000, "the web UI URL"))[1];
  const sse = events(webPort, token);
  t.after(() => sse.close());
  const ready = (sid) => until(() => sse.list.find((e) => e.t === "state" && (!sid || e.sid === sid) && e.s?.isolation?.state === "ready"), 30000, `the state of mission session ${sid ?? "(first)"}`);
  /** Le terminal web de la session note le TMPDIR de son shell confiné. */
  const privateOf = async (sid, tag) => {
    const { tid } = await post(webPort, token, "/term/open", { sid });
    assert.ok(tid, "a terminal opens");
    await post(webPort, token, "/term/input", { sid, tid, text: `sh tmp.sh ${tag}` });
    await until(() => hasNoted(f.ws, tag), 30000, `the ${tag} terminal's TMPDIR`);
    const dir = notedTmp(f.ws, tag);
    await until(() => fs.existsSync(path.join(dir, "agent-temp.txt")), 10000, "the command's temporary file");
    return dir;
  };
  // 1. La session ouverte au lancement, fermée depuis la page.
  const first = (await ready()).sid;
  const closedDir = await privateOf(first, "close");
  await post(webPort, token, "/sessions/close", { id: first });
  await until(() => !fs.existsSync(closedDir), 10000, "the closed session's folder to go");
  // 2. Une nouvelle session, supprimée depuis la page.
  const { id: second } = await post(webPort, token, "/sessions/new", { workspace: f.ws });
  await ready(second);
  const deletedDir = await privateOf(second, "delete");
  await post(webPort, token, "/sessions/delete", { id: second });
  await until(() => !fs.existsSync(deletedDir), 10000, "the deleted session's folder to go");
  // 3. Une troisième, encore ouverte quand l'interface web s'arrête.
  const { id: third } = await post(webPort, token, "/sessions/new", { workspace: f.ws });
  await ready(third);
  const openDir = await privateOf(third, "stop");
  p.kill("SIGTERM");
  const end = await exited;
  assert.ok(end.code !== null || end.signal, "the web UI stops");
  assert.equal(fs.existsSync(openDir), false, "the stopped web UI removed its open session's folder");
  assert.deepEqual(sandboxes(), before, "no smol-sandbox-* folder is left behind");
});

test("#46 OS AC2 (terminal): the real interactive smol under --mission, driven through a pseudo-terminal, keeps its private folder for the session and removes it when the user types /exit", { skip, timeout: 180000 }, async (t) => {
  const f = withTmpScripts(fixture("i46-tui", { approve: true }));
  const before = sandboxes();
  const model = await fakeModel([call("c1", "run_command", { command: "sh tmp.sh tui" }), { content: "done" }]);
  t.after(() => model.close());
  // Même montage que le test AC5 du terminal : `script` pour le terminal, `cat |` pour les touches.
  const inner = 'stty cols 160 rows 40; exec "$@"';
  const p = spawn("/bin/sh", ["-c", `/bin/cat | /usr/bin/script -q /dev/null /bin/sh -c '${inner}' sh "$@"`, "tui", process.execPath, CLI, f.ws, "--mission", f.src, "--model", MODEL], { env: { ...smolEnv(model), TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("close", (code, signal) => r({ code, signal })));
  t.after(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* déjà terminé */ } });
  await until(() => /mission approved 0\/50 · isolated/.test(plain(out)), 30000, "the status row");
  await sleep(300);
  p.stdin.write("note the temporary folder");
  await sleep(200);
  p.stdin.write("\r");
  await until(() => hasNoted(f.ws, "tui"), 30000, "the model's command");
  const dir = notedTmp(f.ws, "tui");
  await until(() => model.requests.filter((q) => q.body?.tools).length >= 2, 15000, "the end of the turn");
  await sleep(500);
  assert.ok(fs.existsSync(path.join(dir, "agent-temp.txt")), "the folder lives as long as the session");
  p.stdin.write("/exit");
  await sleep(200);
  p.stdin.write("\r");
  p.stdin.end();
  const end = await Promise.race([exited, sleep(15000).then(() => null)]);
  assert.ok(end, "the session exits on /exit");
  assert.equal(fs.existsSync(dir), false, "the private folder is removed when the terminal session ends");
  assert.deepEqual(sandboxes(), before, "no smol-sandbox-* folder is left behind");
});
