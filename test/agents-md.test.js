const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAgentsMd } = require('../dist/prompt');

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
