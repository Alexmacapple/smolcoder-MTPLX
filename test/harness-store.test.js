// Stockage hôte du harnais (docs/decision-stockage-hote.md) : grammaire de
// contract.json et proofs.jsonl, empreintes, écritures atomiques et lectures
// fail-closed. Un état illisible n'est jamais converti en succès.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const store = require("../dist/harness/store");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function source(overrides = {}) {
  return {
    schema: "smolcoder/contract/v1",
    id: "login-redirect",
    title: "Corriger la redirection après connexion",
    problem: "Après connexion, l'utilisateur revient sur l'accueil au lieu de la page demandée.",
    outcome: "La page demandée s'affiche après connexion.",
    outOfScope: ["refonte du formulaire"],
    acceptance: ["npm test passe", "le test de redirection existe"],
    budgets: { maxSteps: 40 },
    ...overrides,
  };
}

test("workspace fingerprint: SHA-256 of the real path, 16 hex, identical through a symlink", () => {
  const ws = tmp("smol-hs-ws-");
  const link = path.join(tmp("smol-hs-link-"), "alias");
  fs.symlinkSync(ws, link);
  const fp = store.workspaceFingerprint(ws);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, createHash("sha256").update(fs.realpathSync.native(ws)).digest("hex").slice(0, 16));
  assert.equal(store.workspaceFingerprint(link), fp);
  const data = tmp("smol-hs-data-");
  assert.equal(store.harnessDir(link, data), path.join(data, "harness", fp));
});

test("contract grammar: closed schema, required fields, workspace bound to the real path", () => {
  const ws = fs.realpathSync.native(tmp("smol-hs-ws-"));
  const c = store.parseContractSource(source(), ws);
  assert.equal(c.workspace, ws);
  assert.deepEqual(c.constraints, []);
  assert.deepEqual(c.openQuestions, []);
  assert.equal(c.users, null);
  assert.equal(c.baseRevision, null);
  assert.equal(c.policyRef, null);
  assert.equal(c.budgets.maxSteps, 40);
  assert.throws(() => store.parseContractSource(source({ extra: 1 }), ws), /unknown field "extra"/);
  assert.throws(() => store.parseContractSource(source({ schema: "smolcoder/contract/v2" }), ws), /schema/);
  assert.throws(() => store.parseContractSource(source({ acceptance: [] }), ws), /acceptance/);
  assert.throws(() => store.parseContractSource(source({ budgets: { maxSteps: 0 } }), ws), /maxSteps/);
  assert.throws(() => store.parseContractSource(source({ budgets: { maxSteps: 5, maxTokens: 9 } }), ws), /budgets/);
  assert.throws(() => store.parseContractSource(source({ id: "../escape" }), ws), /id/);
  assert.throws(() => store.parseContractSource(source({ workspace: tmp("smol-hs-other-") }), ws), /workspace/);
  assert.equal(store.parseContractSource(source({ workspace: ws }), ws).workspace, ws);
});

test("contract fingerprint: any change of the contract changes it, key order does not", () => {
  const ws = fs.realpathSync.native(tmp("smol-hs-ws-"));
  const a = store.parseContractSource(source(), ws);
  const reordered = store.parseContractSource(Object.fromEntries(Object.entries(source()).reverse()), ws);
  const widened = store.parseContractSource(source({ budgets: { maxSteps: 41 } }), ws);
  const reworded = store.parseContractSource(source({ outOfScope: ["refonte du formulaire", "les e-mails"] }), ws);
  assert.match(store.contractFingerprint(a), /^[0-9a-f]{64}$/);
  assert.equal(store.contractFingerprint(reordered), store.contractFingerprint(a));
  assert.notEqual(store.contractFingerprint(widened), store.contractFingerprint(a));
  assert.notEqual(store.contractFingerprint(reworded), store.contractFingerprint(a));
});

test("contract.json: atomic round trip; absent, unreadable and unknown-schema are explicit states", () => {
  const ws = fs.realpathSync.native(tmp("smol-hs-ws-"));
  const dir = store.harnessDir(ws, tmp("smol-hs-data-"));
  assert.deepEqual(store.readContract(dir), { state: "absent" });
  const record = store.createRecord(store.parseContractSource(source(), ws));
  assert.equal(record.schema, "smolcoder/contract/v1");
  assert.equal(record.status, "proposed");
  assert.equal(record.approval, null);
  assert.deepEqual(record.usage, { steps: 0 });
  store.writeContract(dir, record);
  assert.deepEqual(fs.readdirSync(dir), ["contract.json"], "no temporary file left behind");
  const read = store.readContract(dir);
  assert.equal(read.state, "ok");
  assert.deepEqual(read.record, record);

  const file = path.join(dir, "contract.json");
  fs.writeFileSync(file, "{ not json");
  assert.equal(store.readContract(dir).state, "unreadable");
  fs.writeFileSync(file, " ".repeat(store.MAX_CONTRACT_BYTES + 1));
  const big = store.readContract(dir);
  assert.equal(big.state, "unreadable");
  assert.match(big.reason, /exceeds/);
  fs.writeFileSync(file, JSON.stringify({ ...record, schema: "smolcoder/contract/v2" }));
  assert.equal(store.readContract(dir).state, "unknown-schema");
  fs.writeFileSync(file, JSON.stringify({ ...record, status: "done" }));
  assert.equal(store.readContract(dir).state, "unreadable");
  fs.writeFileSync(file, JSON.stringify({ ...record, approval: { fingerprint: record.fingerprint, by: "the-model", at: "now" } }));
  assert.equal(store.readContract(dir).state, "unreadable", "only host authorities can approve");
});

test("approval state: only an approval bound to the current contract fingerprint counts", () => {
  const ws = fs.realpathSync.native(tmp("smol-hs-ws-"));
  const contract = store.parseContractSource(source(), ws);
  const proposed = store.createRecord(contract);
  assert.equal(store.approvalState(proposed), "proposed");
  const approved = store.createRecord(contract, {
    status: "approved",
    approval: { fingerprint: proposed.fingerprint, by: "terminal-human", at: new Date().toISOString() },
  });
  assert.equal(store.approvalState(approved), "approved");
  const edited = { ...approved, contract: { ...approved.contract, outOfScope: [] } };
  assert.equal(store.approvalState(edited), "stale", "editing the stored contract voids its approval");
  assert.equal(store.approvalState({ ...approved, status: "expired" }), "expired");
});

test("proofs.jsonl: append-only, three closed event types, a truncated tail is explicit and blocks appends", () => {
  const dir = path.join(tmp("smol-hs-data-"), "harness", "0123456789abcdef");
  assert.deepEqual(store.readProofs(dir), { state: "absent" });
  const fp = "a".repeat(64);
  store.appendProof(dir, { type: "contract", fingerprint: fp, id: "x", status: "proposed" });
  store.appendProof(dir, { type: "approval", fingerprint: fp, by: "headless-flag" });
  let read = store.readProofs(dir);
  assert.equal(read.state, "ok");
  assert.deepEqual(read.events.map((e) => [e.schema, e.type]), [["smolcoder/proof/v1", "contract"], ["smolcoder/proof/v1", "approval"]]);
  assert.ok(read.events.every((e) => !Number.isNaN(Date.parse(e.at))));
  assert.throws(() => store.appendProof(dir, { type: "note", text: "x" }), /type/);
  assert.throws(() => store.appendProof(dir, { type: "approval", fingerprint: fp, by: "the-model" }), /by/);

  const file = path.join(dir, "proofs.jsonl");
  const before = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, '{"schema":"smolcoder/proof/v1","type":"verd');
  read = store.readProofs(dir);
  assert.equal(read.state, "truncated-tail");
  assert.equal(read.events.length, 2);
  assert.throws(() => store.appendProof(dir, { type: "approval", fingerprint: fp, by: "headless-flag" }), /truncated-tail/);
  assert.equal(fs.readFileSync(file, "utf8"), before + '{"schema":"smolcoder/proof/v1","type":"verd');

  fs.writeFileSync(file, before + JSON.stringify({ schema: "smolcoder/proof/v2", type: "contract" }) + "\n");
  assert.equal(store.readProofs(dir).state, "unknown-schema");
  fs.writeFileSync(file, "garbage\n" + before);
  assert.equal(store.readProofs(dir).state, "unreadable");
});
