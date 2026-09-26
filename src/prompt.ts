// The core system prompt. Short instructions; tool details live in schemas.
// Everything else
// the model needs lives in the tool schemas and in coaching error messages.
// If ~/.smolcoder/AGENTS.md or the workspace has an AGENTS.md, their contents
// ride along directly after the prompt (each size-capped, global first) — and
// because they are part of message[0], they survive compaction the same way
// the system prompt does.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Mode } from "./tools/index";

const AGENTS_MD_CAP_CHARS = 8000; // ~2k tokens — small-context friendly
const GLOBAL_AGENTS_MD_CAP_CHARS = 4000; // ~1k tokens — rules shared by every workspace

/** One AGENTS.md read: capped text (null when missing or empty), plus a
 * warning when the file was truncated or present but unreadable. */
interface AgentsFileRead {
  text: string | null;
  warning: string | null;
}

function readAgentsFile(p: string, cap: number, label: string): AgentsFileRead {
  try {
    if (!fs.existsSync(p)) return { text: null, warning: null };
    let text = fs.readFileSync(p, "utf8").trim();
    if (!text) return { text: null, warning: null };
    if (text.length > cap) {
      // Never cut inside a surrogate pair: back off one unit if needed.
      let cut = cap;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      text = text.slice(0, cut) + `\n[${label} was truncated here to save context]`;
      return { text, warning: `${label} truncated at ${cap} chars — trailing rules are not seen` };
    }
    return { text, warning: null };
  } catch (err: any) {
    return { text: null, warning: `${label} present but unreadable (${err?.code ?? err}) — ignored` };
  }
}

/** The on-disk identity of a path: symlinks resolved and platform casing
 * normalized, so two spellings of one file compare equal. */
function fileIdentity(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** What loadAgentsMdDetails reports besides the combined text: which files
 * actually contributed, and anything the user should know (truncation,
 * unreadable file). */
export interface AgentsMdDetails {
  text: string | null;
  sources: string[];
  warnings: string[];
}

/** Read the global ~/.smolcoder/AGENTS.md, then the workspace's AGENTS.md,
 * with provenance and warnings for the caller to surface. */
export function loadAgentsMdDetails(workspace: string, home: string = os.homedir()): AgentsMdDetails {
  const globalPath = path.join(home, ".smolcoder", "AGENTS.md");
  const localPath = path.join(workspace, "AGENTS.md");
  const reads = [{ label: "~/.smolcoder/AGENTS.md", read: readAgentsFile(globalPath, GLOBAL_AGENTS_MD_CAP_CHARS, "~/.smolcoder/AGENTS.md") }];
  if (fileIdentity(localPath) !== fileIdentity(globalPath)) {
    reads.push({ label: "AGENTS.md", read: readAgentsFile(localPath, AGENTS_MD_CAP_CHARS, "AGENTS.md") });
  }
  const sources = reads.filter((r) => r.read.text !== null).map((r) => r.label);
  const warnings = reads.map((r) => r.read.warning).filter((w): w is string => w !== null);
  const loaded = reads.map((r) => r.read.text).filter((t): t is string => t !== null);
  return { text: loaded.length ? loaded.join("\n\n") : null, sources, warnings };
}

/** Read the global ~/.smolcoder/AGENTS.md, then the workspace's AGENTS.md. */
export function loadAgentsMd(workspace: string, home: string = os.homedir()): string | null {
  return loadAgentsMdDetails(workspace, home).text;
}

export function buildSystemPrompt(opts: {
  workspace: string;
  mode: Mode;
  shellLabel: string;
  /** Contents of the workspace AGENTS.md, when present. */
  agentsMd?: string | null;
}): string {
  const os =
    process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

  const modeLine =
    opts.mode === "ro"
      ? "You are in read-only mode: you can read and search files but not change anything."
      : opts.mode === "edit"
        ? "Read, edit and run commands inside the workspace. Commands reaching outside it need approval; keep scratch files in .scratch/."
        : "You have full access to files and commands; nothing asks the user for approval.";

  return (
    `You are smolcoder, a coding agent working in the workspace ${opts.workspace} on ${os}. ` +
    `Commands run in ${opts.shellLabel} with the workspace as the working directory. ` +
    `File paths are relative to the workspace; you cannot access files outside it. ${modeLine}\n\n` +
    `For multi-step work, first set a short plan of runnable increments; mark each step done as you finish it. The plan survives compaction. Use plan checkpoint to retain exact APIs, errors and your next edit during an investigation. Establish a working entry point early and run the build after wiring modules. ` +
    `Read relevant files before editing. Search narrowly and read small line ranges. Inspect a local module's actual exports before importing it. Make one tool call at a time; use small modules and write large files in parts. ` +
    `Read errors and change your approach when a call fails. Put test programs in files rather than long inline shell commands. Verify changes with the relevant test or command; a failed check is not success. ` +
    `Continue until the request is finished or explain the blocker. Summarize the result and verification briefly.` +
    (opts.agentsMd
      ? `\n\nWorkspace instructions from AGENTS.md — follow these:\n${opts.agentsMd}`
      : "")
  );
}
