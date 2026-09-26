const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSystemPrompt, loadAgentsMd, loadAgentsMdDetails } = require('../dist/prompt');

function promptWith(globalAgentsMd, workspaceAgentsMd) {
  return buildSystemPrompt({ workspace: '/tmp/ws', mode: 'edit', shellLabel: 'zsh', globalAgentsMd, workspaceAgentsMd });
}

/** A throwaway home and workspace, each optionally holding an AGENTS.md. */
function setup({ global, local } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smol-agents-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(home, '.smolcoder'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  if (global !== undefined) fs.writeFileSync(path.join(home, '.smolcoder', 'AGENTS.md'), global);
  if (local !== undefined) fs.writeFileSync(path.join(workspace, 'AGENTS.md'), local);
  return { root, home, workspace };
}

test('the global ~/.smolcoder/AGENTS.md is loaded when the workspace has none', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.' });
  try {
    assert.equal(loadAgentsMd(workspace, home), 'Global rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global instructions come first, then the workspace AGENTS.md', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.', local: 'Local rule.' });
  try {
    const text = loadAgentsMd(workspace, home);
    assert.ok(text.includes('Global rule.') && text.includes('Local rule.'));
    assert.ok(text.indexOf('Global rule.') < text.indexOf('Local rule.'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without any AGENTS.md nothing is loaded', () => {
  const { root, home, workspace } = setup();
  try {
    assert.equal(loadAgentsMd(workspace, home), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the workspace AGENTS.md alone behaves as before', () => {
  const { root, home, workspace } = setup({ local: 'Local rule.' });
  try {
    assert.equal(loadAgentsMd(workspace, home), 'Local rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SMOL_NO_GLOBAL_AGENTS=1 keeps workspace instructions without the global ones', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.', local: 'Local rule.' });
  const previous = process.env.SMOL_NO_GLOBAL_AGENTS;
  process.env.SMOL_NO_GLOBAL_AGENTS = '1';
  try {
    const details = loadAgentsMdDetails(workspace, home);
    assert.equal(details.text, 'Local rule.');
    assert.equal(details.globalText, null);
    assert.equal(details.workspaceText, 'Local rule.');
    assert.deepEqual(details.sources, ['AGENTS.md']);
  } finally {
    if (previous === undefined) delete process.env.SMOL_NO_GLOBAL_AGENTS;
    else process.env.SMOL_NO_GLOBAL_AGENTS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absent SMOL_NO_GLOBAL_AGENTS keeps the global instructions', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.', local: 'Local rule.' });
  const previous = process.env.SMOL_NO_GLOBAL_AGENTS;
  delete process.env.SMOL_NO_GLOBAL_AGENTS;
  try {
    assert.equal(loadAgentsMd(workspace, home), 'Global rule.\n\nLocal rule.');
  } finally {
    if (previous === undefined) delete process.env.SMOL_NO_GLOBAL_AGENTS;
    else process.env.SMOL_NO_GLOBAL_AGENTS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a SMOL_NO_GLOBAL_AGENTS value other than 1 keeps the global instructions', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.', local: 'Local rule.' });
  const previous = process.env.SMOL_NO_GLOBAL_AGENTS;
  process.env.SMOL_NO_GLOBAL_AGENTS = '0';
  try {
    assert.equal(loadAgentsMd(workspace, home), 'Global rule.\n\nLocal rule.');
  } finally {
    if (previous === undefined) delete process.env.SMOL_NO_GLOBAL_AGENTS;
    else process.env.SMOL_NO_GLOBAL_AGENTS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the system prompt separates global rules and workspace instructions', () => {
  const prompt = buildSystemPrompt({
    workspace: '/tmp/workspace',
    mode: 'edit',
    shellLabel: 'zsh',
    globalAgentsMd: 'Global rule.',
    workspaceAgentsMd: 'Local rule.',
  });
  const globalHeader = 'Global rules (from ~/.smolcoder/AGENTS.md)';
  const workspaceHeader = 'Workspace instructions (from AGENTS.md)';
  assert.ok(prompt.includes(globalHeader));
  assert.ok(prompt.includes(workspaceHeader));
  assert.ok(prompt.indexOf(globalHeader) < prompt.indexOf(workspaceHeader));
  assert.ok(prompt.includes('the global rules take precedence'));
  assert.ok(prompt.includes('Global rule.') && prompt.includes('Local rule.'));
});

test('the global block renders alone when the workspace has no AGENTS.md', () => {
  const prompt = buildSystemPrompt({
    workspace: '/tmp/workspace',
    mode: 'edit',
    shellLabel: 'zsh',
    globalAgentsMd: 'Global rule.',
  });
  assert.ok(prompt.includes('Global rules (from ~/.smolcoder/AGENTS.md)'));
  assert.ok(!prompt.includes('Workspace instructions (from AGENTS.md)'));
});

test('an oversized global file is capped at exactly 4000 chars with a visible marker', () => {
  const { root, home, workspace } = setup({ global: 'G'.repeat(20000), local: 'Local rule.' });
  try {
    const text = loadAgentsMd(workspace, home);
    assert.ok(text.includes('Local rule.'));
    assert.ok(text.length < 8000, `combined text should stay small, got ${text.length}`);
    assert.equal(text.match(/^G+/)[0].length, 4000, 'global part capped at exactly 4000 chars');
    assert.ok(text.includes('[~/.smolcoder/AGENTS.md was truncated here to save context]'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace that is the smolcoder home does not load the same file twice', () => {
  const { root, home } = setup({ global: 'Global rule.' });
  try {
    const text = loadAgentsMd(path.join(home, '.smolcoder'), home);
    assert.equal(text, 'Global rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace AGENTS.md that is a symlink to the global file is loaded once', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.' });
  try {
    fs.symlinkSync(path.join(home, '.smolcoder', 'AGENTS.md'), path.join(workspace, 'AGENTS.md'));
    assert.equal(loadAgentsMd(workspace, home), 'Global rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace that is a symlink to the smolcoder home loads the file once', () => {
  const { root, home } = setup({ global: 'Global rule.' });
  try {
    const link = path.join(root, 'ws-link');
    fs.symlinkSync(path.join(home, '.smolcoder'), link);
    assert.equal(loadAgentsMd(link, home), 'Global rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable AGENTS.md (a directory) is ignored like a missing one', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.' });
  try {
    fs.mkdirSync(path.join(workspace, 'AGENTS.md'));
    assert.equal(loadAgentsMd(workspace, home), 'Global rule.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('truncation never leaves half a surrogate pair at the cut', () => {
  // The 4000th char would be the high half of the emoji: the cut must back off.
  const { root, home, workspace } = setup({ global: 'a'.repeat(3999) + '😀' + 'b'.repeat(100) });
  try {
    const text = loadAgentsMd(workspace, home);
    const cutPart = text.split('\n[')[0];
    assert.ok(!/[\uD800-\uDBFF]$/.test(cutPart), 'no lone high surrogate at the cut');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('details expose the loaded sources and no warnings on a clean load', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.', local: 'Local rule.' });
  try {
    const d = loadAgentsMdDetails(workspace, home);
    assert.deepEqual(d.sources, ['~/.smolcoder/AGENTS.md', 'AGENTS.md']);
    assert.deepEqual(d.warnings, []);
    assert.equal(d.globalText, 'Global rule.');
    assert.equal(d.workspaceText, 'Local rule.');
    assert.equal(d.text, loadAgentsMd(workspace, home));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('details warn when a present AGENTS.md is unreadable', () => {
  const { root, home, workspace } = setup({ global: 'Global rule.' });
  try {
    fs.mkdirSync(path.join(workspace, 'AGENTS.md'));
    const d = loadAgentsMdDetails(workspace, home);
    assert.equal(d.text, 'Global rule.');
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /AGENTS\.md/);
    assert.match(d.warnings[0], /unreadable|illisible/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('details warn when a file is truncated at its cap', () => {
  const { root, home, workspace } = setup({ global: 'G'.repeat(20000) });
  try {
    const d = loadAgentsMdDetails(workspace, home);
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /truncated/i);
    assert.match(d.warnings[0], /4000|4 000/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the precedence rule states the conflict rule without hard-coded commands', () => {
  const text = promptWith('Global rule.', 'Local rule.');
  assert.match(text, /Safety precedence:/);
  assert.match(text, /cannot override or lift the global safety refusals/);
  assert.ok(!text.includes('git reset --hard'), 'no hard-coded command list in the prompt');
  assert.ok(!text.includes('even when the user explicitly requests'), 'an explicit user request is not overruled');
});

test('no precedence block without a global file', () => {
  assert.ok(!promptWith(null, 'Local rule.').includes('Safety precedence'));
});

test('no precedence block with the global file alone (no possible conflict)', () => {
  assert.ok(!promptWith('Global rule.', null).includes('Safety precedence'));
});
