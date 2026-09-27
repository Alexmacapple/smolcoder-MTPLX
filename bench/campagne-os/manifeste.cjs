// Manifeste de la campagne OS (#18), au format « campagne-os/v1 », avec les
// statuts du banc (#13, docs/banc-noyau-agents-md-2026-09-26.md). Chaque
// critère du chapeau #12 (criteres.json) est classé d'après les tests OS qui
// le prouvent, lus dans le rapport du rapporteur (rapporteur.mjs) :
// - refus_securite_attendu : un critère de refus dont chaque test a passé ;
// - succes : un critère fonctionnel dont chaque test a passé ;
// - echec_test : au moins un de ses tests a échoué ;
// - blocage_harnais : un test attendu absent, ambigu, sauté ou annulé — rien
//   n'est prouvé —, ou la campagne n'a pas pu tourner (verrou, préconditions) ;
// - mtplx_indisponible : jamais employé, la campagne n'appelle aucun modèle.
// La campagne entière vaut succes quand ses six critères sont acceptables et
// que ses deux suites sortent à 0 sans échec.
// Usage : node manifeste.cjs <dossier du run> (contexte par l'environnement).
"use strict";
const fs = require("fs");
const path = require("path");

const REFUSAL_OK = "refus_securite_attendu";

function suite(command, ctx, rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    command,
    exit_code: ctx?.exitCode ?? null,
    duration_seconds: ctx?.durationSeconds ?? null,
    tests: rows.length,
    pass: count("pass"),
    fail: count("fail"),
    skipped: count("skip") + count("todo"),
    cancelled: count("cancelled"),
    failing: rows.filter((r) => r.status === "fail" || r.status === "cancelled").map((r) => r.name),
  };
}

function criterion(c, osTests, harnessBlock) {
  const matched = [];
  const missing = [];
  const ambiguous = [];
  for (const prefix of c.tests) {
    const found = osTests.filter((t) => t.name.startsWith(prefix));
    if (found.length === 0) missing.push(prefix);
    else if (found.length > 1) ambiguous.push(prefix);
    else matched.push(found[0]);
  }
  const failed = matched.filter((t) => t.status === "fail");
  const idle = matched.filter((t) => t.status !== "pass" && t.status !== "fail");
  let status;
  let reason;
  if (harnessBlock) [status, reason] = ["blocage_harnais", `Campagne non jouée : ${harnessBlock}`];
  else if (failed.length) [status, reason] = ["echec_test", `Test en échec : ${failed.map((t) => `${t.name.split(":")[0]} (${t.error ?? "sans message"})`).join(" ; ")}`];
  else if (missing.length) [status, reason] = ["blocage_harnais", `Test attendu absent : ${missing.join(" ; ")}`];
  else if (ambiguous.length) [status, reason] = ["blocage_harnais", `Préfixe ambigu, plusieurs tests : ${ambiguous.join(" ; ")}`];
  else if (idle.length) [status, reason] = ["blocage_harnais", `Test non exécuté (${idle.map((t) => `${t.name.split(":")[0]} : ${t.status}`).join(" ; ")})`];
  else [status, reason] = [c.kind === "refus" ? REFUSAL_OK : "succes", `${matched.length} test(s) OS passé(s) sur macOS réel`];
  return {
    id: c.id,
    kind: c.kind,
    text: c.text,
    status,
    status_reason: reason,
    duration_ms: Math.round(matched.reduce((s, t) => s + (t.duration_ms ?? 0), 0) * 1000) / 1000,
    tests: matched.map((t) => ({ name: t.name, file: t.file, status: t.status, duration_ms: t.duration_ms, ...(t.error ? { error: t.error } : {}) })),
    ...(missing.length ? { missing } : {}),
    ...(ambiguous.length ? { ambiguous } : {}),
  };
}

/** Le manifeste, sans effet de bord : contexte du run, critères, rapports. */
function buildManifest({ context, criteria, unitTests, osTests }) {
  const block = context.harnessBlock || null;
  const crit = criteria.criteria.map((c) => criterion(c, osTests, block));
  const units = suite("npm test", context.unit, unitTests);
  const oss = suite("npm run test:os", context.os, osTests);
  const prefixes = criteria.criteria.flatMap((c) => c.tests);
  let status;
  let reason;
  if (block) [status, reason] = ["blocage_harnais", block];
  else if (units.fail || oss.fail || crit.some((c) => c.status === "echec_test")) {
    status = "echec_test";
    reason = `Tests en échec : ${[...units.failing, ...oss.failing].join(" ; ") || crit.filter((c) => c.status === "echec_test").map((c) => c.id).join(", ")}`;
  } else if (crit.some((c) => c.status === "blocage_harnais")) {
    status = "blocage_harnais";
    reason = `Critères non prouvés : ${crit.filter((c) => c.status === "blocage_harnais").map((c) => `${c.id} (${c.status_reason})`).join(" ; ")}`;
  } else if (units.exit_code !== 0 || oss.exit_code !== 0 || !units.tests || !oss.tests) {
    status = "blocage_harnais";
    reason = `Suite incomplète : npm test sorti ${units.exit_code} (${units.tests} tests), npm run test:os sorti ${oss.exit_code} (${oss.tests} tests)`;
  } else {
    status = "succes";
    reason = `Six critères du chapeau #12 prouvés sur macOS réel ; npm test ${units.pass}/${units.tests}, npm run test:os ${oss.pass}/${oss.tests}`;
  }
  return {
    format: "campagne-os/v1",
    run: { id: context.runId, started_at: context.startedAt, finished_at: context.finishedAt || null },
    status,
    status_reason: reason,
    harness: context.harness ?? null,
    machine: context.machine ?? null,
    suites: { unit: units, os: oss },
    criteria: crit,
    other_tests: osTests.filter((t) => !prefixes.some((p) => t.name.startsWith(p))).map((t) => ({ name: t.name, file: t.file, status: t.status, duration_ms: t.duration_ms })),
    home_untouched: context.home ?? null,
  };
}

function readRows(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function main(out) {
  const e = process.env;
  const int = (v) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const bool = (v) => (v === "true" ? true : v === "false" ? false : null);
  const home = [e.NPM_AVANT, e.NPM_APRES, e.SMOL_AVANT, e.SMOL_APRES].map(int);
  const context = {
    runId: e.RUN_ID,
    startedAt: e.DEBUTE_LE,
    finishedAt: e.TERMINE_LE,
    harnessBlock: e.BLOCAGE || null,
    harness: { repository_sha: e.SHA_HARNAIS || "inconnu", working_tree_dirty: bool(e.HARNAIS_MODIFIE), branch: e.BRANCHE || null },
    machine: {
      os: e.MACOS_VERSION ? "macOS" : e.SYSTEME || null,
      macos_version: e.MACOS_VERSION || null,
      macos_build: e.MACOS_BUILD || null,
      arch: e.ARCH || null,
      node: e.NODE_VERSION || null,
      npm: e.NPM_VERSION || null,
      sandbox_exec: { path: e.SANDBOX_EXEC, present: e.SANDBOX_EXEC_PRESENT === "1" },
    },
    unit: { exitCode: int(e.UNIT_RC), durationSeconds: int(e.UNIT_DUREE) },
    os: { exitCode: int(e.OS_RC), durationSeconds: int(e.OS_DUREE) },
    home: home.every((n) => n !== null) ? { npm_entries_before: home[0], npm_entries_after: home[1], smolcoder_entries_before: home[2], smolcoder_entries_after: home[3] } : null,
  };
  const criteria = JSON.parse(fs.readFileSync(path.join(__dirname, "criteres.json"), "utf8"));
  const data = buildManifest({ context, criteria, unitTests: readRows(path.join(out, "tests-unitaires.jsonl")), osTests: readRows(path.join(out, "tests-os.jsonl")) });
  const file = path.join(out, "manifeste.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { buildManifest };
if (require.main === module) main(process.argv[2]);
