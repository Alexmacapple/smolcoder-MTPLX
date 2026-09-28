// H03-4 (#18) : les sondes internes de l'hôte — `node --check` et la
// compilation Python de src/tools/check.ts, `docker ps` / `podman ps` de
// src/detect.ts — restent hors de l'exécuteur isolé, même sous --mission
// (décision : docs/decision-backend-isole.md, « Sondes internes de l'hôte »).
// Ce test fige la condition de cette décision : elles n'exécutent aucun code
// du workspace, ni le code qu'elles analysent, ni un programme déposé dans le
// workspace et atteint par une entrée relative, vide ou interne au workspace
// du PATH. Il tourne partout sauf sous Windows (programmes piégés en sh).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const skip = process.platform === "win32" ? "the planted programs are sh scripts" : false;
const DIST = path.join(__dirname, "..", "dist");

/** Un programme piégé : il laisse une trace à son nom, puis imite la sonde
 * (« 1 » pour python, une sortie vide pour docker). */
function plant(dir, name, markers, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n: > "${markers}/${tag}-${name}"\n[ "$1" = "-I" ] && echo 1\nexit 0\n`, { mode: 0o755 });
}

test("H03-4 host probes: under the mission profile, node --check, python compile and docker/podman ps never run workspace code — neither the code they check, nor a program planted in the workspace and reached through a relative, empty or in-workspace PATH entry", { skip }, () => {
  const ws = tmp("smol-probe-ws-");
  const markers = tmp("smol-probe-markers-");
  const legit = tmp("smol-probe-bin-"); // dossier d'outils de l'hôte, absolu, hors du workspace
  const home = tmp("smol-probe-home-");
  for (const name of ["python3", "python", "docker", "podman"]) {
    plant(ws, name, markers, "ws"); // atteint par « . » ou par une entrée vide
    plant(path.join(ws, "node_modules", ".bin"), name, markers, "nm"); // par « node_modules/.bin »
    plant(path.join(ws, "bin"), name, markers, "wsabs"); // par une entrée absolue dans le workspace
  }
  // Le docker légitime de l'hôte : la sonde doit toujours le trouver et le lancer.
  fs.writeFileSync(path.join(legit, "docker"), `#!/bin/sh\n: > "${markers}/legit-docker"\nexit 0\n`, { mode: 0o755 });
  // Des sources dont l'exécution laisserait une trace ; syntaxe valide.
  const ran = (tag) => path.join(markers, `code-${tag}`);
  fs.writeFileSync(path.join(ws, "a.js"), `require("fs").writeFileSync(${JSON.stringify(ran("js"))}, "ran");\n`);
  fs.writeFileSync(path.join(ws, "b.mjs"), `import fs from "fs";\nfs.writeFileSync(${JSON.stringify(ran("mjs"))}, "ran");\nexport const x = 1;\n`);
  fs.writeFileSync(path.join(ws, "c.py"), `open(${JSON.stringify(ran("py"))}, "w").write("ran")\n`);
  fs.writeFileSync(path.join(ws, "d.html"), `<html><script>require("fs").writeFileSync(${JSON.stringify(ran("html"))}, "ran");</script></html>\n`);
  // Des erreurs de syntaxe : la preuve que les sondes ont réellement tourné.
  fs.writeFileSync(path.join(ws, "bad.js"), "function f() {\n  return 1;\n\n");
  fs.writeFileSync(path.join(ws, "bad.py"), "def f(:\n    pass\n");
  const script = `
    const path = require("path");
    const { syntaxCheck } = require(${JSON.stringify(path.join(DIST, "tools", "check"))});
    const { detectAll } = require(${JSON.stringify(path.join(DIST, "detect"))});
    const ws = process.cwd();
    // Ce que fait main() sous --mission : la détection des modèles, qui ne
    // connaît pas le workspace, l'apprend ici (le binaire réel : test/os/).
    require(${JSON.stringify(path.join(DIST, "harness", "host-probe"))}).keepHostProbesOutOf(ws);
    const check = (f) => syntaxCheck(path.join(ws, f), f, ws);
    const out = Object.fromEntries(["a.js", "b.mjs", "c.py", "d.html", "bad.js", "bad.py"].map((f) => [f, check(f)]));
    detectAll().then(() => console.log(JSON.stringify(out)));
  `;
  const PATH = ["node_modules/.bin", ".", "", path.join(ws, "bin"), legit, process.env.PATH].join(path.delimiter);
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: ws,
    env: { ...process.env, PATH, HOME: home, USERPROFILE: home, SMOLCODER_CONFIG: path.join(home, "config.json"), OLLAMA_HOST: "127.0.0.1:9" },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  const traces = fs.readdirSync(markers).sort();
  assert.deepEqual(traces.filter((t) => t !== "legit-docker"), [], `workspace code ran on the host: ${traces.join(", ")}`);
  for (const f of ["a.js", "b.mjs", "c.py", "d.html"]) assert.equal(out[f], null, `${f} parses`);
  assert.match(out["bad.js"], /bad\.js has a JavaScript syntax error/, "node --check still runs");
  const python = spawnSync("/bin/sh", ["-c", "command -v python3 || command -v python"], { encoding: "utf8" }).stdout.trim();
  if (python) assert.match(out["bad.py"], /Python syntax error/, `the host python (${python}) still runs`);
  else console.log("# no python on this host: the python probe stays silent");
  assert.ok(traces.includes("legit-docker"), "the docker probe still runs, from an absolute PATH entry outside the workspace");
});

test("H03-4 host probes: the probe PATH keeps only absolute entries outside the excluded folders, and the probes start in a neutral folder", { skip }, () => {
  const { hostProbeOptions, hostProbePath } = require("../dist/harness/host-probe");
  const ws = tmp("smol-probe-ws-");
  const d = path.delimiter;
  assert.equal(hostProbePath(["node_modules/.bin", ".", "", "~/bin", "/usr/bin", path.join(ws, "bin"), ws, "/opt/homebrew/bin"].join(d), [ws]), ["/usr/bin", "/opt/homebrew/bin"].join(d));
  assert.equal(hostProbePath(undefined), "");
  const opts = hostProbeOptions([ws]);
  assert.equal(opts.cwd, os.tmpdir(), "never the workspace, whatever the current folder");
  assert.ok(opts.env.PATH.split(d).every((p) => path.isAbsolute(p) && !p.startsWith(ws)));
  assert.equal(Object.keys(opts.env).filter((k) => k.toUpperCase() === "PATH").length, 1, "a single PATH variable");
  assert.equal(opts.env.HOME, process.env.HOME, "the rest of the host environment is unchanged: these are host probes");
  // Le workspace d'une mission, inscrit par le point d'entrée, vaut pour toutes les sondes.
  const saved = process.env.PATH;
  try {
    process.env.PATH = [path.join(ws, "bin"), "/usr/bin"].join(d);
    assert.equal(hostProbeOptions().env.PATH, [path.join(ws, "bin"), "/usr/bin"].join(d), "outside the profile an absolute entry is the user's own choice");
    require("../dist/harness/host-probe").keepHostProbesOutOf(ws);
    assert.equal(hostProbeOptions().env.PATH, "/usr/bin", "a mission workspace is excluded from every probe");
  } finally {
    process.env.PATH = saved;
  }
});
