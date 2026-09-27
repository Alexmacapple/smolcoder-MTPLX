// H03-4 (#18) : l'état de l'isolation reste visible pendant toute la session,
// pas seulement dans la ligne d'ouverture — page web (état exposé par le hub,
// pastille de la barre d'état) et interface terminal (ligne d'état). Hors
// profil, rien ne change. Tests déterministes : l'exécuteur isolé y est
// simulé au point d'injection (lanceur et sonde), comme dans
// test/sandbox-executor.test.js ; le binaire réel est éprouvé dans test/os/.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "smol-isostate-home-"));
process.env.HOME = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const { Mission } = require("../dist/harness/mission");
const sbx = require("../dist/harness/sandbox-executor");
const { Session } = require("../dist/session");
const { WebHub } = require("../dist/web/hub");
const client = () => require("../dist/web/client");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const RULES = { protect: [".env", ".env.*", ".git"], except: [".env.example"] };
const FAKE_MODEL = { id: "fake-model", backend: "ollama", baseUrl: "http://127.0.0.1:9", contextWindow: 8000 };

function contract(ws) {
  const file = path.join(tmp("smol-isostate-src-"), "contract.json");
  fs.writeFileSync(file, JSON.stringify({ schema: "smolcoder/contract/v1", id: "isostate", title: "Isolation", problem: "p", outcome: "o", acceptance: ["a"], budgets: { maxSteps: 50 } }));
  const m = Mission.prepare({ source: file, workspace: ws, dataDir: tmp("smol-isostate-data-") });
  m.approve("terminal-human");
  return m;
}

/** Un backend Seatbelt sain simulé : sonde réussie, aucun lancement réel ;
 * sa politique se change en cours de session. */
function healthy(ws, listen = []) {
  let policy = { rules: RULES, network: [], listen };
  const exec = sbx.createSandboxExecutor({
    workspace: ws, policy: () => policy, hostPaths: [path.join(HOME, ".smolcoder")], canary: HOME,
    platform: "darwin", sandboxExec: process.execPath, tmpRoot: tmp("smol-isostate-tmp-"),
    launch: () => { throw new Error("nothing is launched in these tests"); },
    probe: () => ({ status: 0, stdout: "SEATBELT_OK\n", stderr: "" }),
  });
  return { exec, setListen: (l) => (policy = { ...policy, listen: l }) };
}

function quietUi() {
  return {
    slashCommands: [], hintLeft: "", start() {}, close() {}, refresh() {},
    async readInput() { return "/exit"; }, async select() { return null; }, async prompt() { return null; },
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {},
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "no"; }, turnEnd() {}, planUpdated() {},
  };
}

test("H03-4 AC5 (interface): the session state carries the isolation — ready with the listening ports the policy grants now, or unavailable with its reason — and nothing outside the profile", () => {
  const ws = tmp("smol-isostate-ws-");
  const m = contract(ws);
  const { exec, setListen } = healthy(ws, ["localhost:5173"]);
  const s = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "web", isolation: exec });
  const ready = s.state().isolation;
  assert.deepEqual(
    { backend: ready.backend, state: ready.state, listen: ready.listen, label: ready.label },
    { backend: "seatbelt", state: "ready", listen: ["localhost:5173"], label: "isolated · listens localhost:5173" },
  );
  assert.match(ready.reason, /probed/);
  assert.equal(ready.line, sbx.isolationLine(exec.status, ["localhost:5173"]), "the full opening line, with the local-network limit of listening");
  setListen([]);
  assert.deepEqual([s.state().isolation.listen, s.state().isolation.label], [[], "isolated"], "read again at each state: it follows the policy");

  const off = sbx.missionExecutor(m, { platform: "linux" });
  const blocked = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "web", isolation: off }).state().isolation;
  assert.deepEqual({ state: blocked.state, listen: blocked.listen, label: blocked.label }, { state: "unavailable", listen: [], label: "isolation unavailable" });
  assert.match(blocked.reason, /only on macOS.*linux/);
  assert.match(blocked.line, /^· isolation unavailable \(.*linux.*\) — under the mission profile no command runs/);

  const historic = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help" }).state();
  assert.equal("isolation" in historic, false, "outside the profile the state is unchanged");
});

test("H03-4 AC5 (interface): the terminal status row shows the isolation for the whole session; outside the profile it is unchanged", () => {
  const ws = tmp("smol-isostate-ws-");
  const m = contract(ws);
  const { exec, setListen } = healthy(ws, ["localhost:5173"]);
  const s = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: exec });
  assert.match(plain(s.statusLine()), /mission approved 0\/50 · isolated · listens localhost:5173$/);
  setListen([]);
  assert.match(plain(s.statusLine()), /mission approved 0\/50 · isolated$/);
  const off = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "terminal", isolation: sbx.missionExecutor(m, { platform: "win32" }) });
  assert.match(plain(off.statusLine()), /· isolation unavailable$/);
  const historic = new Session(quietUi(), { workspace: ws, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help" });
  assert.doesNotMatch(plain(historic.statusLine()), /isolat|mission/);
});

// ---- hub : l'état exposé à la page, du début à la fin de la session --------

function request(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: hub.port, method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Le flux SSE de la page, lu en continu. */
function stream(hub) {
  const events = [];
  const req = http.get({ host: "127.0.0.1", port: hub.port, path: "/events?k=" + hub.authToken }, (res) => {
    let buf = "";
    res.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  req.on("error", () => {});
  return { events, close: () => req.destroy() };
}

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test("H03-4 AC5 (interface): the web hub exposes the isolation state of a mission session from its start to its end — a policy change shows at the next state — and none for a session outside the profile", async () => {
  const missionWs = tmp("smol-isostate-ws-");
  const otherWs = tmp("smol-isostate-other-");
  const m = contract(missionWs);
  const { exec, setListen } = healthy(missionWs, ["localhost:5173"]);
  // Les sessions réelles de la page, avec l'exécuteur simulé pour la mission.
  const factory = async (ui, workspace) => workspace === missionWs
    ? new Session(ui, { workspace, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", mission: m, surface: "web", isolation: exec })
    : new Session(ui, { workspace, chosen: FAKE_MODEL, prefs: {}, cfg: {}, help: "help", surface: "web" });
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir: tmp("smol-isostate-hub-"), factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  const sse = stream(hub);
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: missionWs })).body);
    const { id: other } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: otherWs })).body);
    const states = (sid) => sse.events.filter((e) => e.t === "state" && e.sid === sid && e.s.mode);
    const first = await waitFor(() => states(id)[0], "the mission session's first state");
    assert.deepEqual({ state: first.s.isolation.state, listen: first.s.isolation.listen, label: first.s.isolation.label }, { state: "ready", listen: ["localhost:5173"], label: "isolated · listens localhost:5173" });
    assert.match(first.s.isolation.line, /^· isolation: macOS Seatbelt/);
    // Plus tard dans la session : chaque état poussé la porte encore, relue.
    setListen([]);
    const seen = states(id).length;
    await request(hub, "POST", "/cycle" + k, { sid: id });
    const later = await waitFor(() => states(id).slice(seen).find((e) => e.s.mode !== first.s.mode), "a later state");
    assert.deepEqual([later.s.isolation.state, later.s.isolation.listen, later.s.isolation.label], ["ready", [], "isolated"]);
    // Une page qui se reconnecte la retrouve aussi.
    const again = stream(hub);
    try {
      const replayed = await waitFor(() => again.events.find((e) => e.t === "state" && e.sid === id), "the replayed state");
      assert.equal(replayed.s.isolation.state, "ready");
    } finally {
      again.close();
    }
    const historic = await waitFor(() => states(other)[0], "the other session's state");
    assert.equal("isolation" in historic.s, false, "outside the profile the page gets nothing new");
  } finally {
    sse.close();
    hub.close();
  }
});

// ---- page : la pastille de la barre d'état ---------------------------------

test("H03-4 AC5 (interface): the page renders the isolation as a status-bar chip — green when ready with its listening ports, red with its reason when unavailable, the full line on hover — and nothing without it", () => {
  const { isolationChip, CLIENT_JS } = client();
  assert.equal(isolationChip(undefined), null, "outside the profile: no chip, the historic status bar");
  const line = "· isolation: macOS Seatbelt — …; they may listen on localhost:5173, which the local network can reach…";
  assert.deepEqual(isolationChip({ state: "ready", reason: "probed", listen: ["localhost:5173"], label: "isolated · listens localhost:5173", line }), { cls: "iso-chip ready", text: "isolated · listens localhost:5173", title: line });
  const off = isolationChip({ state: "unavailable", reason: "/usr/bin/sandbox-exec not found or not executable", listen: [], label: "isolation unavailable", line: "· isolation unavailable (…)" });
  assert.deepEqual(off, { cls: "iso-chip off", text: "isolation unavailable — /usr/bin/sandbox-exec not found or not executable", title: "· isolation unavailable (…)" });
  assert.ok(CLIENT_JS.includes(isolationChip.toString()), "the page runs this very function");
  assert.match(CLIENT_JS, /isolationChip\(s\.isolation\)/, "the status bar asks it at every state");
  const { STYLES } = require("../dist/web/styles");
  assert.match(STYLES, /\.iso-chip\.ready \{[^}]*--green/);
  assert.match(STYLES, /\.iso-chip\.off \{[^}]*--red/);
});
