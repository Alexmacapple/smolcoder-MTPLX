// H07 (#19) — retour d'une commande ou d'un test : le code de sortie réel, le
// cas défaillant et un extrait utile ; une erreur au milieu d'un long journal
// reste visible, quelle que soit la troncature, et le journal complet reste
// consultable à part par une lecture ciblée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isole ~/.smolcoder avant de charger le code : les tests sous --mission
// n'écrivent jamais dans le vrai dossier de données.
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'smol-h07-log-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SMOLCODER_CONFIG = path.join(HOME, 'config.json');

const { Agent } = require('../dist/agent');
const { ContextManager } = require('../dist/context');
const { EventBus } = require('../dist/events');
const { Plan } = require('../dist/plan');
const { TaskManager } = require('../dist/tools/tasks');
const { runCommand } = require('../dist/tools/shell');

const FAILING = 'not ok 3001 - parses french dates';
const CAUSE = 'AssertionError [ERR_ASSERTION]: expected 3 to equal 4';

/** Un journal de test de près de 500 000 caractères, dont la seule cause
 * décisive est au milieu (ligne 3001), loin du début comme de la fin. */
const NOISY = `for (let i = 1; i <= 3000; i++) console.log('ok ' + i + ' - ' + 'x'.repeat(70));
console.log(${JSON.stringify(FAILING)});
console.log('  ' + ${JSON.stringify(CAUSE)});
for (let i = 3002; i <= 6001; i++) console.log('ok ' + i + ' - ' + 'y'.repeat(70));
console.log('# tests 6001');
process.exitCode = require('fs').existsSync('fixed.txt') ? 0 : 1;
`;

function workspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-h07-log-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'noisy.cjs'), NOISY);
  return ws;
}

function agentIn(ws, chat, verification) {
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {}, async confirmCommand() { return 'yes'; } };
  const provider = { label: 'fake', modelId: 'fake', contextWindow: 8000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; }, chat };
  const ctx = { workspace: ws, plan: new Plan(), taskManager: new TaskManager(ws), filesTouched: new Set(), commandsRun: [] };
  // Petite fenêtre : le plafond des résultats d'outils tombe vers 2 300 caractères.
  return new Agent(provider, 'edit', 'sys', ctx, new ContextManager(8000, 2000), new EventBus(), ui, false, 10, verification);
}

test('H07 AC2 (run_command): a failure in the middle of a long log stays visible under the default cap', async t => {
  const ws = workspace(t);
  const result = await runCommand('node noisy.cjs', ws);
  assert.match(result, /^Error: command exited with code 1\n/, 'the real exit code comes first');
  assert.ok(result.includes(FAILING), 'the failing case is visible');
  assert.ok(result.includes(CAUSE), 'its cause is visible');
  assert.match(result, /ok 1 - x/, 'the head of the log is kept');
  assert.match(result, /# tests 6001/, 'the tail of the log is kept');
  assert.match(result, /\[exit code 1 in [\d.]+s\]$/);
  assert.ok(result.length < 9000, `bounded (${result.length} characters)`);
});

test('H07 AC2 (agent): the tool result shows the failing case under a small window, and the full log is readable apart', async t => {
  const ws = workspace(t);
  const seen = {};
  let step = 0;
  const agent = agentIn(ws, async messages => {
    step++;
    const last = messages.at(-1);
    if (step === 1) return { content: '', toolCalls: [{ id: 'run', name: 'run_command', args: { command: 'node noisy.cjs' } }] };
    if (step === 2) {
      seen.run = last.content;
      const ref = /read_file \{"path": "(log:\d+)", "offset": (\d+)\}/.exec(last.content);
      if (!ref) return { content: 'No log reference.', toolCalls: [] };
      return { content: '', toolCalls: [{ id: 'log', name: 'read_file', args: { path: ref[1], offset: Number(ref[2]), limit: 20 } }] };
    }
    if (step === 3) seen.log = last.content;
    return { content: 'Done', toolCalls: [] };
  });
  await agent.runTurn('Run the test suite and find the failure.');
  assert.equal(agent.outcome, 'completed');
  const cap = agent.ctxMgr.toolResultCharLimit();
  assert.match(seen.run, /^Error: command exited with code 1\n/);
  assert.ok(seen.run.includes(FAILING), 'the failing case survives the context cap');
  assert.ok(seen.run.includes(CAUSE), 'its cause survives the context cap');
  assert.ok(seen.run.length <= cap, `the result fits the cap (${seen.run.length} > ${cap})`);
  assert.ok(seen.log, 'the full log was read apart, by a targeted read');
  assert.ok(seen.log.includes(FAILING) && seen.log.includes(CAUSE), 'the targeted read shows the failure in context');
  assert.match(seen.log, /ok 2999 - x/, 'with the lines around it');
  assert.match(seen.log, /\[showing lines \d+-\d+ of 6004\. Call read_file with \{"path": "log:\d+", "offset": \d+\} to continue\.\]/);
});

test('H07 AC2 (log store): logs are read-only, bounded to the last outputs, and never files of the workspace', async t => {
  const { executeTool } = require('../dist/tools');
  const { CommandLogs } = require('../dist/tools/command-log');
  const ws = workspace(t);
  const logs = new CommandLogs(2);
  const ctx = { workspace: ws, plan: new Plan(), taskManager: new TaskManager(ws), filesTouched: new Set(), commandsRun: [], logs };
  for (let i = 0; i < 3; i++) await executeTool('run_command', { command: 'node noisy.cjs' }, ctx);
  assert.equal(logs.size, 2, 'only the last outputs are kept');
  assert.match(await executeTool('read_file', { path: 'log:1' }, ctx), /^Error: "log:1" is not a command log kept by this session/);
  assert.match(await executeTool('read_file', { path: 'log:3', offset: 3001, limit: 1 }, ctx), new RegExp('^' + FAILING));
  for (const tool of ['write_file', 'edit_file']) {
    assert.match(await executeTool(tool, { path: 'log:3', content: 'x', old_text: 'a', new_text: 'b' }, ctx), /names a command log kept by the harness, which is read-only/);
  }
  assert.deepEqual(fs.readdirSync(ws).sort(), ['noisy.cjs'], 'nothing is written to the workspace');
  // Sans stock (appelant qui n'en fournit pas), « log:3 » reste un chemin ordinaire.
  assert.match(await executeTool('read_file', { path: 'log:3' }, { ...ctx, logs: undefined }), /^Error: file "log:3" does not exist/);
});

test('H07 AC2 (acceptance): a failing acceptance check with a long log hands the failing case to the model', async t => {
  const ws = workspace(t);
  let step = 0;
  let repairPrompt = '';
  const agent = agentIn(ws, async messages => {
    step++;
    if (step === 2) {
      repairPrompt = messages.at(-1).content;
      return { content: '', toolCalls: [{ id: 'fix', name: 'write_file', args: { path: 'fixed.txt', content: 'ok' } }] };
    }
    return { content: 'Done', toolCalls: [] };
  }, { command: 'node noisy.cjs', maxAttempts: 2 });
  await agent.runTurn('Make the test suite pass.');
  assert.equal(agent.outcome, 'completed');
  assert.match(repairPrompt, /^\[Acceptance failed/);
  assert.ok(repairPrompt.includes(FAILING), 'the failing case reaches the model');
  assert.ok(repairPrompt.includes(CAUSE), 'its cause reaches the model');
  assert.equal(agent.verificationResult.passed, true);
});

// ---- Sous --mission : l'exception nommée log:<n> de la décision d'accès ----
// Sur le modèle de l'exception fiche:<nom> (#30) : lecture d'un journal gardé
// par la session autorisée pour ce qu'elle est, sans chemin fictif du
// workspace ; journal inconnu et écriture refusés dès la décision.

const { Mission } = require('../dist/harness/mission');
const { decide } = require('../dist/harness/policy');
const { CommandLogs } = require('../dist/tools/command-log');
const fiches = require('../dist/fiches');

/** Un workspace, un contrat approuvé hors du workspace, un stockage hôte et
 * des fiches installées dans un dossier de données jetable. */
function missionSetup(t) {
  const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const ws = tmp('smol-h07-mws-');
  const data = tmp('smol-h07-mdata-');
  const src = tmp('smol-h07-msrc-');
  t.after(() => { for (const d of [ws, data, src]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(ws, 'noisy.cjs'), NOISY);
  fs.writeFileSync(path.join(ws, 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=fake\n');
  const file = path.join(src, 'contract.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'smolcoder/contract/v1', id: 'h07-logs', title: 'Lire un journal', problem: 'p', outcome: 'o', acceptance: ['a'], budgets: { maxSteps: 200 } }));
  const m = Mission.prepare({ source: file, workspace: ws, dataDir: data });
  m.approve('terminal-human');
  const fichesDir = path.join(data, 'fiches');
  fiches.installFiches(path.join(__dirname, '..', 'docs', 'skills'), fichesDir);
  return { ws, m, fichesDir };
}

test('H07 mission (decision): log:<n> is a named, narrow exception — read allowed without a workspace path, unknown log and writes denied; fiche: and ordinary paths unchanged', t => {
  const s = missionSetup(t);
  const logs = new CommandLogs();
  const ref = logs.add('line 1\nline 2\n');
  const ask = (tool, p, extra = {}) => decide(s.m, { surface: 'tool', tool, args: { path: p, content: 'x', old_text: 'a', new_text: 'b' }, logs, fichesDir: s.fichesDir, ...extra });

  const read = ask('read_file', ref);
  assert.equal(read.verdict, 'allow', read.reason);
  assert.deepEqual(read.paths, [], 'no made-up workspace path');
  assert.match(read.reason, /command log .*kept in memory by this session, read-only, never a file/);

  const unknown = ask('read_file', 'log:99');
  assert.equal(unknown.verdict, 'deny');
  assert.match(unknown.reason, /"log:99" is not a command log kept by this session/);
  assert.deepEqual(unknown.paths, []);

  for (const tool of ['write_file', 'edit_file']) {
    const w = ask(tool, ref);
    assert.equal(w.verdict, 'deny', `${tool}: ${w.reason}`);
    assert.match(w.reason, /names a command log kept by the harness, which is read-only/);
    assert.deepEqual(w.paths, []);
  }

  // Aucune régression : fiche:<nom> (#30), chemins ordinaires, chemins protégés.
  const fiche = ask('read_file', 'fiche:tdd');
  assert.equal(fiche.verdict, 'allow', fiche.reason);
  assert.deepEqual(fiche.paths, [path.join(s.fichesDir, 'tdd.md')]);
  assert.equal(ask('write_file', 'fiche:tdd').verdict, 'deny');
  const app = ask('read_file', 'app.js');
  assert.equal(app.verdict, 'allow');
  assert.deepEqual(app.paths, [path.join(s.ws, 'app.js')]);
  assert.equal(ask('write_file', 'app.js').verdict, 'allow');
  assert.equal(ask('read_file', '.env').verdict, 'deny');
  // L'exception tient au stock fourni par l'hôte : sans lui, « log:1 » est un
  // chemin ordinaire du workspace, comme fiche: sans dossier de fiches.
  const bare = decide(s.m, { surface: 'tool', tool: 'read_file', args: { path: ref } });
  assert.equal(bare.verdict, 'allow');
  assert.deepEqual(bare.paths, [path.join(s.ws, ref)]);
});

test('H07 mission (agent): a shortened command output is read back through the decision, an unknown log and a write are refused by it', async t => {
  const s = missionSetup(t);
  const results = [];
  let step = 0;
  let ref = null;
  const provider = {
    label: 'fake', modelId: 'fake', contextWindow: 32000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      step++;
      const last = messages.at(-1);
      if (last.role === 'tool') results.push(last.content);
      if (step === 1) return { content: '', toolCalls: [{ id: 'run', name: 'run_command', args: { command: 'node noisy.cjs' } }] };
      if (step === 2) {
        const m = /read_file \{"path": "(log:\d+)", "offset": (\d+)\}/.exec(last.content);
        if (!m) return { content: 'No log reference.', toolCalls: [] };
        ref = m[1];
        return { content: '', toolCalls: [{ id: 'log', name: 'read_file', args: { path: ref, offset: Number(m[2]), limit: 20 } }] };
      }
      if (step === 3) return { content: '', toolCalls: [{ id: 'unknown', name: 'read_file', args: { path: 'log:99' } }] };
      if (step === 4) return { content: '', toolCalls: [{ id: 'write', name: 'write_file', args: { path: ref, content: 'forged' } }] };
      return { content: 'Done', toolCalls: [] };
    },
  };
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {}, async confirmCommand() { return 'no'; } };
  const ctx = { workspace: s.ws, plan: new Plan(), taskManager: new TaskManager(s.ws), filesTouched: new Set(), commandsRun: [] };
  const agent = new Agent(provider, 'bypass', 'sys', ctx, new ContextManager(32000, 2000), new EventBus(), ui, false, 20, undefined, s.m);
  await agent.runTurn('Run the tests and read the failure.');
  assert.equal(agent.outcome, 'completed');
  const [run, log, unknown, write] = results;
  assert.match(run, /^Error: command exited with code 1\n/);
  assert.ok(ref, 'the shortened output names its log');
  assert.ok(log.includes(FAILING) && log.includes(CAUSE), 'the log is served under --mission');
  assert.match(unknown, /^Error: denied by the access policy \([^)]*\): "log:99" is not a command log kept by this session/);
  assert.match(write, new RegExp(`^Error: denied by the access policy \\([^)]*\\): "${ref}" names a command log kept by the harness, which is read-only`));
  assert.deepEqual(fs.readdirSync(s.ws).sort(), ['.env', 'app.js', 'noisy.cjs'], 'nothing written to the workspace');
});
