// H07 (#19) — retour d'une commande ou d'un test : le code de sortie réel, le
// cas défaillant et un extrait utile ; une erreur au milieu d'un long journal
// reste visible, quelle que soit la troncature, et le journal complet reste
// consultable à part par une lecture ciblée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
