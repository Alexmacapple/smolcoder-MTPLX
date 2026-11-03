// H03-3 (#17) : l'allow-list de l'empreinte des outils de développement.
// Ces tests tournent partout : ils vérifient la liste documentée, la
// grammaire des champs facultatifs de policy.json (tools, git, listen) et le
// profil qu'en tire le backend Seatbelt, simulé au point d'injection. Les
// preuves sur macOS réel (chaque entrée retirée fait échouer son cas positif)
// sont dans test/os/seatbelt.os.test.js (npm run test:os).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isole ~/.smolcoder et ~/.smolcoder.json avant de charger le code.
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "smol-allow-home-")));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, "config.json");

const store = require("../dist/harness/store");
const sbx = require("../dist/harness/sandbox-executor");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const RULES = { protect: [".env", ".env.*", ".git"], except: [".env.example"] };
const WS = "/Users/someone/project";
const TMPD = "/private/var/folders/xx/yy/T/smol-sandbox-abc";
const doc = () => fs.readFileSync(path.join(__dirname, "..", "docs", "allowlist-outils.md"), "utf8");
const grants = (over = {}) => ({ workspace: WS, tmpDir: TMPD, rules: RULES, network: [], hostPaths: ["/Users/someone/.smolcoder"], ...over });
const allowLines = (profile) => profile.split("\n").filter((l) => l.startsWith("(allow"));

// ---- H03-3 AC1 : la liste est documentée, et rien n'est accordé hors d'elle ----

test("H03-3 AC1: every entry of the tool footprint has a stable id, rules that stand verbatim as lines of the profile, and its section in docs/allowlist-outils.md", () => {
  const list = sbx.TOOL_FOOTPRINT;
  assert.ok(Array.isArray(list) && list.length > 0, "the footprint is an explicit list");
  const ids = list.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  const profile = sbx.seatbeltProfile(grants()).split("\n");
  const DOC = doc();
  for (const e of list) {
    assert.match(e.id, /^[a-z][a-z0-9-]*$/, e.id);
    assert.ok(e.rules.length > 0, `${e.id} grants something`);
    for (const r of e.rules) {
      assert.match(r, /^\(allow /, `${e.id}: a footprint entry only grants`);
      assert.ok(profile.includes(r), `${e.id}: ${r} is a line of the profile, so removing the entry removes exactly its rules`);
    }
    assert.ok(DOC.includes("`" + e.id + "`"), `${e.id} is justified in docs/allowlist-outils.md`);
  }
});

test("H03-3 AC1: the default profile grants nothing outside the documented list — the footprint, the workspace with the bounded TMPDIR, and the policy's exceptions", () => {
  const footprint = sbx.TOOL_FOOTPRINT.flatMap((e) => e.rules);
  const extra = allowLines(sbx.seatbeltProfile(grants())).filter((l) => !footprint.includes(l));
  assert.deepEqual(extra.map((l) => l.replace(/\(regex "(?:[^"\\]|\\.)*"\)/g, "(regex …)")), [
    `(allow file-read* file-write* (subpath "${WS}") (subpath "${TMPD}"))`,
    "(allow file-read-data file-write* (require-all (regex …) (require-not (regex …)) (require-not (regex …)) (require-not (regex …))))",
  ]);
});

test("H03-3 AC1: the footprint keeps only what a measured case needs — no process information, no notification or log service, no read of /bin, /sbin, /private/var/select, the whole of /Library or of /dev (the account's terminals), no write to /dev/zero, /dev/tty or /dev/dtracehelper, no Homebrew configuration but OpenSSL's", () => {
  const profile = sbx.seatbeltProfile(grants());
  for (const gone of ["process-info", "notification_center", "system.logger", "com.apple.logd", '(subpath "/bin")', '(subpath "/sbin")', "/private/var/select", '(subpath "/Library")', '(subpath "/dev")', "/dev/tty", "dtracehelper", "file-ioctl", 'file-write* (literal "/dev/zero")']) {
    assert.ok(!profile.includes(gone), `${gone} is no longer granted`);
  }
  for (const kept of ['(subpath "/usr")', '(subpath "/System")', '(subpath "/Library/Developer")', '(subpath "/opt")', '(subpath "/private/etc")', '(subpath "/private/var/db/timezone")', '(literal "/dev/null")', '(literal "/dev/urandom")', "opendirectoryd.libinfo"]) {
    assert.ok(profile.includes(kept), `${kept} stays granted`);
  }
  const lines = profile.split("\n");
  const etcDenied = lines.findIndex((l) => l.startsWith("(deny file-read*") && l.includes('(subpath "/opt/homebrew/etc")'));
  assert.ok(etcDenied > lines.indexOf('(allow file-read* (subpath "/opt"))'), "Homebrew's service configuration (my.cnf, odbc.ini…) is refused under /opt");
  assert.ok(lines.indexOf('(allow file-read* (subpath "/opt/homebrew/etc/openssl@3"))') > etcDenied, "…but OpenSSL's, which node reads at start, is reopened after");
});

// ---- H03-3 AC2 : trois champs facultatifs de la politique -------------------

test("H03-3 AC2: tools, git and listen are optional policy fields — absent they grant nothing and keep the version of existing policies; present they change it; invalid values make the policy unreadable and are never written", () => {
  const dir = path.join(tmp("smol-allow-grammar-"), "harness", "0123456789abcdef");
  store.writePolicy(dir, store.DEFAULT_POLICY);
  const read = store.readPolicy(dir);
  assert.equal(read.state, "ok");
  for (const f of ["tools", "git", "listen"]) assert.equal(read.policy[f], undefined, `${f}: absent, nothing added in silence`);
  assert.equal(read.version, "smolcoder/policy/v1@b8568bb66a5429ae", "the default policy keeps the version it had before #16 and #17");
  const file = path.join(dir, "policy.json");
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  const good = { tools: ["/Users/someone/.nvm/versions/node/v22.1.0", "/opt/tools/x y"], git: "read", listen: ["localhost:5173", "localhost:65535"] };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...good }));
  const named = store.readPolicy(dir);
  assert.equal(named.state, "ok", named.reason);
  assert.deepEqual({ tools: named.policy.tools, git: named.policy.git, listen: named.policy.listen }, good);
  assert.notEqual(named.version, read.version, "the version follows the new fields");
  const bad = [
    ["tools", ["relative/dir"]], ["tools", ["/"]], ["tools", ["/a/../b"]], ["tools", ["/a/b/"]], ["tools", ["//a"]], ["tools", ["/a\nb"]], ["tools", "/a"], ["tools", [42]],
    ["tools", Array.from({ length: 51 }, (_, i) => `/t/${i}`)], ["tools", ["/" + "a".repeat(1100)]],
    ["git", "write"], ["git", true], ["git", "READ"], ["git", null],
    ["listen", ["0.0.0.0:5173"]], ["listen", ["localhost"]], ["listen", ["*:80"]], ["listen", "localhost:80"], ["listen", ["localhost:0"]],
  ];
  for (const [field, value] of bad) {
    fs.writeFileSync(file, JSON.stringify({ ...base, [field]: value }));
    const r = store.readPolicy(dir);
    assert.equal(r.state, "unreadable", `${field}=${JSON.stringify(value).slice(0, 40)} is refused`);
    assert.match(r.reason, new RegExp(field));
  }
  store.writePolicy(dir, { ...store.DEFAULT_POLICY, tools: ["/opt/x"], git: "read", listen: ["localhost:3000"] });
  assert.deepEqual(store.readPolicy(dir).policy.listen, ["localhost:3000"], "the host writes them like any other field");
  assert.throws(() => store.writePolicy(dir, { ...store.DEFAULT_POLICY, tools: ["~/.nvm"] }), /tools/, "an invalid folder is never written");
});

test("H03-3 AC2: tool folders are read-only grants, placed before the protected names and the host controls, which they never reopen", () => {
  const profile = sbx.seatbeltProfile(grants({ tools: ["/Users/someone/.nvm/versions/node/v22.1.0", "/Users/someone/.npm/_cacache"] }));
  const line = '(allow file-read* (subpath "/Users/someone/.nvm/versions/node/v22.1.0") (subpath "/Users/someone/.npm/_cacache"))';
  assert.ok(profile.split("\n").includes(line), profile);
  assert.ok(!/file-write\*[^\n]*\.nvm/.test(profile), "never writable");
  const at = profile.indexOf(line);
  assert.ok(at < profile.indexOf("(deny file-read-data file-write*"), "before the protected names");
  assert.ok(at < profile.indexOf('(deny file-read* file-write* (subpath "/Users/someone/.smolcoder"))'), "before the host controls, which stay denied");
  assert.throws(() => sbx.seatbeltProfile(grants({ tools: ["relative"] })), /tool folder/);
  assert.ok(!sbx.seatbeltProfile(grants()).includes(".nvm"), "none by default");
});

test("H03-3 AC2: git read reopens the content of .git at any depth — never its writing, never another protected name inside it — and nothing else", () => {
  const { protectedPathRules } = sbx;
  const plain = sbx.seatbeltProfile(grants());
  const profile = sbx.seatbeltProfile(grants({ git: true }));
  const added = profile.split("\n").filter((l) => !plain.split("\n").includes(l) && !l.startsWith(";"));
  assert.equal(added.length, 1, added.join("\n"));
  assert.match(added[0], /^\(allow file-read-data \(require-all /, "read only: no file-write");
  assert.ok(profile.indexOf(added[0]) > profile.lastIndexOf("(deny file-read-data file-write*"), "after the protections it lifts");
  assert.ok(profile.indexOf(added[0]) < profile.indexOf("(deny file-read* file-write* (subpath"), "before the host controls");
  // Le filtre, rejoué comme expression : .git et son contenu, sans .env dedans.
  const res = [...added[0].matchAll(/(\(require-not )?\(regex "((?:[^"\\]|\\.)*)"\)/g)].map((m) => ({ not: !!m[1], re: new RegExp(JSON.parse(`"${m[2]}"`)) }));
  assert.deepEqual(res.map((r) => r.not), [false, true, true], "the .git filter, then .env and .env.* kept closed");
  const reopened = (p) => res.every(({ not, re }) => re.test(p) !== not);
  for (const p of [".git", ".git/HEAD", ".git/config", "sub/.GIT/objects/ab/cd"]) assert.equal(reopened(`${WS}/${p}`), true, `${p} readable`);
  for (const p of [".git/.env", ".git/hooks/.env.local", ".env", "src/app.js", "/elsewhere/.git/config"]) assert.equal(reopened(p.startsWith("/") ? p : `${WS}/${p}`), false, `${p} not reopened`);
  assert.equal(protectedPathRules(WS, RULES).deny.length, 3);
  assert.ok(!sbx.seatbeltProfile(grants({ git: true, rules: { protect: [".env"], except: [] } })).includes("require-all"), "nothing to reopen when .git is not protected");
});

test("H03-3 AC2: listening opens only incoming connections on the named loopback ports — no bind rule, no outgoing connection, nothing by default", () => {
  const profile = sbx.seatbeltProfile(grants({ listen: ["localhost:5173", "localhost:8080"] }));
  const net = profile.split("\n").filter((l) => /network/.test(l) && !l.startsWith(";"));
  assert.deepEqual(net, ['(allow network-inbound (local ip "localhost:5173") (local ip "localhost:8080"))']);
  assert.ok(!/network-bind/.test(profile));
  assert.throws(() => sbx.seatbeltProfile(grants({ listen: ["0.0.0.0:80"] })), /localhost:<port>/);
  assert.ok(!/network/.test(allowLines(sbx.seatbeltProfile(grants())).join("\n")), "nothing listens by default");
});

// ---- H03-3 AC2 : l'exécuteur applique la politique au lancement -------------

function isolated(ws, policy) {
  const calls = [];
  const exec = sbx.createSandboxExecutor({
    workspace: ws,
    policy: () => policy,
    hostPaths: [path.join(HOME, ".smolcoder")],
    canary: HOME,
    platform: "darwin",
    sandboxExec: process.execPath,
    launch: (req, spec) => {
      calls.push(spec());
      return { result: Promise.resolve({ started: true, status: "exited", exitCode: 0, signal: null, durationMs: 0, output: "" }), write: () => true, kill() {} };
    },
    probe: () => ({ status: 0, stdout: "SEATBELT_OK\n", stderr: "" }),
    tmpRoot: tmp("smol-allow-tmproot-"),
  });
  return { exec, calls };
}
const req = (ws) => ({ surface: "command", command: "git status", cwd: ws, env: { PATH: "/usr/bin:/bin", HOME }, login: false, capture: "buffer" });

test("H03-3 AC2: under git read the executor adds GIT_CONFIG_GLOBAL=/dev/null, so git never reads the user's configuration; otherwise only TMPDIR is added", async () => {
  const ws = tmp("smol-allow-ws-");
  const off = isolated(ws, { rules: RULES, network: [] });
  await off.exec.start(req(ws)).result;
  assert.deepEqual(Object.keys(off.calls[0].env).sort(), ["HOME", "PATH", "TMPDIR"]);
  const on = isolated(ws, { rules: RULES, network: [], git: true });
  await on.exec.start(req(ws)).result;
  assert.equal(on.calls[0].env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.deepEqual(Object.keys(on.calls[0].env).sort(), ["GIT_CONFIG_GLOBAL", "HOME", "PATH", "TMPDIR"]);
  assert.match(on.calls[0].args[1], /\(allow file-read-data \(require-all/);
});

test("H03-3 AC2: tool folders are resolved to their real path at launch, and a folder that holds the home folder is refused — nothing runs", async () => {
  const ws = tmp("smol-allow-ws-");
  const real = tmp("smol-allow-tool-");
  const link = path.join(tmp("smol-allow-link-"), "node");
  fs.symlinkSync(real, link);
  const ok = isolated(ws, { rules: RULES, network: [], tools: [link] });
  await ok.exec.start(req(ws)).result;
  assert.ok(ok.calls[0].args[1].includes(`(subpath "${real}")`), "the real folder, which the kernel compares");
  for (const wide of [HOME, path.dirname(HOME)]) {
    const { exec, calls } = isolated(ws, { rules: RULES, network: [], tools: [wide] });
    const r = await exec.start(req(ws)).result;
    assert.deepEqual({ started: r.started, status: r.status }, { started: false, status: "spawn_error" }, wide);
    assert.match(r.error, /tool folder .* holds the home folder.*nothing was run/s);
    assert.equal(calls.length, 0);
  }
});

test("H03-3 AC3: the status line names the ports the policy lets commands listen on, and says the local network can reach them", () => {
  const ready = { backend: "seatbelt", state: "ready", reason: "probed" };
  assert.doesNotMatch(sbx.isolationLine(ready), /listen/, "nothing about listening when none is granted");
  const line = sbx.isolationLine(ready, ["localhost:5173"]);
  assert.match(line, /^· isolation: macOS Seatbelt/);
  assert.match(line, /listen on localhost:5173/);
  assert.match(line, /local network/i);
  const ws = tmp("smol-allow-ws-");
  assert.deepEqual(isolated(ws, { rules: RULES, network: [], listen: ["localhost:5173"] }).exec.listening(), ["localhost:5173"]);
  assert.deepEqual(isolated(ws, "policy.json is not valid JSON").exec.listening(), [], "an unreadable policy grants nothing");
  assert.deepEqual(sbx.unavailableExecutor("no backend").listening(), []);
});
