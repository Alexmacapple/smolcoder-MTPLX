// H03-4 (#18) : bout en bout sur macOS réel. Le vrai binaire smol
// (dist/index.js) est lancé sous --mission, en headless, en interface web et
// en interface terminal (sous un pseudo-terminal), piloté par un faux serveur
// OpenAI-compatible local qui joue le modèle : aucun MTPLX, aucun modèle réel.
// Chaque test prouve que les commandes du modèle et du terminal, et la
// vérification --verify, tournent dans le bac : un témoin hors du workspace,
// lisible par l'hôte, leur reste illisible. Lancé par `npm run test:os`,
// jamais par `npm test` ; ailleurs que sur macOS, chaque test est sauté avec
// son motif. Les noms « H03-4 OS ACn » renvoient aux critères du chapeau #12.
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
 * l'hôte dans le stockage du faux dossier personnel, que smol relira. */
function fixture(tag, { approve = false, policy = {} } = {}) {
  const ws = tmp(`smol-e2e-${tag}-`);
  const src = path.join(tmp("smol-e2e-src-"), "contract.json");
  fs.writeFileSync(src, JSON.stringify({ schema: "smolcoder/contract/v1", id: `e2e-${tag}`, title: "Bout en bout", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 50 } }));
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
  return { PATH: process.env.PATH, HOME, SMOLCODER_CONFIG: process.env.SMOLCODER_CONFIG, OLLAMA_HOST: model.url, LANG: "en_US.UTF-8", ...extra };
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
  const f = fixture("headless");
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
  const f = fixture("devserver", { policy: { tasks: "workspace", listen: [`localhost:${port}`] } });
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
