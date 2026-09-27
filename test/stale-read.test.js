// H07 (#19) — péremption de lecture : un fichier modifié depuis la dernière
// lecture de l'agent (par une personne, un autre processus, une tâche de fond,
// une commande) est signalé AVANT une nouvelle édition, au niveau de la boucle
// de l'agent, sans journal d'effets (#10). La modification externe est
// injectée par le test entre la lecture et l'écriture.
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

function workspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-h07-stale-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

/** Un fournisseur simulé qui joue des pas écrits d'avance ; chaque pas reçoit
 * le dernier message et rend un appel d'outil, ou null pour conclure. */
function scripted(steps) {
  const results = [];
  let i = 0;
  return {
    results,
    label: 'fake', modelId: 'fake', contextWindow: 32000, maxOutputTokens: 2000, setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      const last = messages.at(-1);
      if (last.role === 'tool') results.push(last.content);
      const step = steps[i++];
      const call = step ? step(last, messages) : null;
      if (!call) return { content: 'Done', toolCalls: [] };
      return { content: '', toolCalls: [{ id: `c${i}`, ...call }] };
    },
  };
}

function agentIn(ws, provider) {
  const ui = { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {}, async confirmCommand() { return 'yes'; } };
  const ctx = { workspace: ws, plan: new Plan(), taskManager: new TaskManager(ws), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, 'edit', 'sys', ctx, new ContextManager(32000, 2000), new EventBus(), ui, false, 20);
}

const MODULE = Array.from({ length: 60 }, (_, i) => `export const v${i + 1} = ${i + 1}; // ${'-'.repeat(24)}`).join('\n') + '\n';
const HUMAN = MODULE.replace('export const v30 = 30;', 'export const v30 = 300; // changed by a person');

test('H07 AC3 (edit): a file changed on disk after the read is flagged before the edit, which is not applied', async t => {
  const ws = workspace(t);
  const file = path.join(ws, 'app.js');
  fs.writeFileSync(file, MODULE);
  let atNotice = '';
  let readAtNotice = null;
  const edit = { name: 'edit_file', args: { path: 'app.js', old_text: 'export const v10 = 10;', new_text: 'export const v10 = 11;' } };
  const provider = scripted([
    () => ({ name: 'read_file', args: { path: 'app.js' } }),
    () => { fs.writeFileSync(file, HUMAN); return edit; }, // modification externe injectée
    (_last, messages) => { // l'agent réessaie en connaissance de cause
      atNotice = fs.readFileSync(file, 'utf8');
      readAtNotice = { ...messages.find(m => m.role === 'tool' && m.toolName === 'read_file') };
      return edit;
    },
  ]);
  const agent = agentIn(ws, provider);
  await agent.runTurn('Set v10 to 11.');
  assert.equal(agent.outcome, 'completed');
  const [, notice, retry] = provider.results;
  assert.match(notice, /^Error: "app\.js" was changed on disk after you last read it/);
  assert.match(notice, /No file was changed/);
  assert.ok(notice.includes('export const v30 = 300; // changed by a person'), 'the notice shows the changed region');
  assert.match(notice, /line 30\b/, 'and locates it');
  assert.equal(atNotice, HUMAN, 'the edit was not applied when the change was flagged');
  assert.match(retry, /^Edited app\.js/, 'the next edit, made knowingly, is applied');
  assert.equal(fs.readFileSync(file, 'utf8'), HUMAN.replace('export const v10 = 10;', 'export const v10 = 11;'), 'the external change is kept');
  assert.equal(readAtNotice.evicted, true, 'the out-of-date read left the context as soon as the change was flagged');
  assert.doesNotMatch(readAtNotice.content, /export const v10 = 10;/);
});

test('H07 AC3 (write_file): an overwrite of a file changed since its read is flagged and does not clobber the change', async t => {
  const ws = workspace(t);
  const file = path.join(ws, 'notes.md');
  fs.writeFileSync(file, 'a\nb\n');
  const write = { name: 'write_file', args: { path: 'notes.md', content: 'a\nb\nmine\n' } };
  let atNotice = '';
  const provider = scripted([
    () => ({ name: 'read_file', args: { path: 'notes.md' } }),
    () => { fs.appendFileSync(file, 'c added by another process\n'); return write; },
    () => { atNotice = fs.readFileSync(file, 'utf8'); return null; },
  ]);
  const agent = agentIn(ws, provider);
  await agent.runTurn('Add my line.');
  const notice = provider.results[1];
  assert.match(notice, /^Error: "notes\.md" was changed on disk after you last read it/);
  assert.ok(notice.includes('c added by another process'));
  assert.equal(atNotice, 'a\nb\nc added by another process\n', 'the other process\'s line survives');
});

test('H07 AC3 (deleted): recreating a file deleted since its read is flagged first', async t => {
  const ws = workspace(t);
  const file = path.join(ws, 'old.txt');
  fs.writeFileSync(file, 'keep me\n');
  const write = { name: 'write_file', args: { path: 'old.txt', content: 'recreated\n' } };
  let atNotice = null;
  const provider = scripted([
    () => ({ name: 'read_file', args: { path: 'old.txt' } }),
    () => { fs.rmSync(file); return write; }, // suppression externe injectée
    () => { atNotice = fs.existsSync(file); return write; },
  ]);
  const agent = agentIn(ws, provider);
  await agent.runTurn('Rewrite old.txt.');
  const [, notice, retry] = provider.results;
  assert.match(notice, /^Error: "old\.txt" was changed on disk after you last read it: it was deleted or moved/);
  assert.equal(atNotice, false, 'not recreated when the deletion was flagged');
  assert.match(retry, /^Created old\.txt/, 'the next write, made knowingly, is applied');
});

test('H07 AC3 (command): a file rewritten by a command the agent ran is flagged too', async t => {
  const ws = workspace(t);
  const file = path.join(ws, 'app.js');
  fs.writeFileSync(file, MODULE);
  const provider = scripted([
    () => ({ name: 'read_file', args: { path: 'app.js', offset: 1, limit: 20 } }),
    () => ({ name: 'run_command', args: { command: `node -e "require('fs').appendFileSync('app.js','export const formatted = true;\\n')"` } }),
    () => ({ name: 'edit_file', args: { path: 'app.js', old_text: 'export const v1 = 1;', new_text: 'export const v1 = 0;' } }),
  ]);
  const agent = agentIn(ws, provider);
  await agent.runTurn('Set v1 to 0.');
  const notice = provider.results[2];
  assert.match(notice, /^Error: "app\.js" was changed on disk after you last read it/);
  assert.ok(notice.includes('export const formatted = true;'));
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('export const v1 = 1;'), 'not applied');
});

test('H07 AC3 (no false alarm): the agent\'s own writes, a mere touch and never-read files raise no notice', async t => {
  const ws = workspace(t);
  fs.writeFileSync(path.join(ws, 'a.js'), 'const a = 1;\nconst b = 2;\n');
  fs.writeFileSync(path.join(ws, 'b.js'), 'const c = 3;\n');
  const provider = scripted([
    () => ({ name: 'read_file', args: { path: 'a.js' } }),
    () => ({ name: 'edit_file', args: { path: 'a.js', old_text: 'const a = 1;', new_text: 'const a = 10;' } }),
    () => ({ name: 'edit_file', args: { path: './a.js', old_text: 'const b = 2;', new_text: 'const b = 20;' } }),
    () => { const now = new Date(Date.now() + 5000); fs.utimesSync(path.join(ws, 'a.js'), now, now); return { name: 'edit_file', args: { path: 'a.js', old_text: 'const a = 10;', new_text: 'const a = 100;' } }; },
    () => ({ name: 'edit_file', args: { path: 'b.js', old_text: 'const c = 3;', new_text: 'const c = 30;' } }),
    () => ({ name: 'write_file', args: { path: 'c.js', content: 'const d = 4;\n' } }),
    () => ({ name: 'edit_file', args: { path: 'c.js', old_text: 'const d = 4;', new_text: 'const d = 40;' } }),
    () => ({ name: 'write_file', args: { path: 'a.js', content: 'const a = 0;\n' } }),
  ]);
  const agent = agentIn(ws, provider);
  await agent.runTurn('Update the constants.');
  assert.equal(agent.outcome, 'completed');
  const writes = provider.results.slice(1);
  assert.equal(writes.length, 7);
  for (const r of writes) assert.match(r, /^(Edited|Created|Overwrote) /, r);
  assert.equal(fs.readFileSync(path.join(ws, 'a.js'), 'utf8'), 'const a = 0;\n');
  assert.equal(fs.readFileSync(path.join(ws, 'b.js'), 'utf8'), 'const c = 30;\n');
  assert.equal(fs.readFileSync(path.join(ws, 'c.js'), 'utf8'), 'const d = 40;\n');
});
