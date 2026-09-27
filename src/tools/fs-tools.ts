// The five file tools: read_file, write_file, edit_file, list_files, search.
// Design rules for small models: flat string params, generous coaching in every
// error message (an error IS a prompt — write it like one), and hard output
// caps so a single result can't flood a small context window.

import * as fs from "fs";
import * as path from "path";
import { PathRules, protectedSegment, resolveInWorkspace, relPath, SandboxError } from "../sandbox";
import { truncateEnd } from "../util";
import { isHistoryPlaceholder } from "../history";

const READ_LINE_LIMIT = 250;
// Must stay under TOOL_RESULT_CAP (10000) so the registry's outer truncateMiddle
// never silently middle-cuts a read chunk while the trailer claims lines X-Y
// were shown contiguously.
const READ_CHAR_LIMIT = 9000;
const LIST_ENTRY_LIMIT = 200;
const SEARCH_MATCH_LIMIT = 50;
const SEARCH_FILE_SIZE_LIMIT = 512 * 1024;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".nuxt", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".idea", ".vscode", "target",
  ".svelte-kit", ".turbo", "vendor",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip",
  ".gz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi",
  ".wasm", ".db", ".sqlite", ".jar", ".class", ".pyc",
]);

function isProbablyBinary(filePath: string): boolean {
  if (BINARY_EXTS.has(path.extname(filePath).toLowerCase())) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch {
    return true;
  }
  return false;
}

/** Les fichiers voisins d'un chemin absent : de quoi corriger une faute de
 * frappe sans lister tout le workspace. */
function nearbyFiles(root: string, abs: string): string {
  try {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) return "";
    const near = fs.readdirSync(dir).slice(0, 15).join(", ");
    return near ? ` Files that do exist in ${relPath(root, dir)}: ${near}` : "";
  } catch {
    return "";
  }
}

export function readFile(root: string, args: any, maxChars = READ_CHAR_LIMIT): string {
  const charLimit = Math.max(128, Math.min(READ_CHAR_LIMIT, Math.floor(maxChars)));
  const abs = resolveInWorkspace(root, args.path);
  if (!fs.existsSync(abs)) {
    return `Error: file "${args.path}" does not exist.${nearbyFiles(root, abs)}`;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return `Error: "${args.path}" is a folder, not a file. Use list_files with {"path": "${args.path}"} to see what is inside it.`;
  }
  if (stat.size > 8 * 1024 * 1024) return `Error: "${args.path}" exceeds the 8 MB text-file limit. Use a command to extract a small relevant section into a workspace file, then read that file.`;
  if (isProbablyBinary(abs)) {
    return `Error: "${args.path}" looks like a binary file (${stat.size} bytes) and cannot be read as text.`;
  }

  return renderRead(fs.readFileSync(abs, "utf8"), args, charLimit);
}

/** Une lecture présentée au modèle : la tranche demandée (offset, limit),
 * coupée sur une fin de ligne, et l'appel exact pour continuer. Partagée
 * par les fichiers du workspace et les fiches servies par l'hôte (#30). */
export function renderRead(content: string, args: any, maxChars = READ_CHAR_LIMIT): string {
  const charLimit = Math.max(128, Math.min(READ_CHAR_LIMIT, Math.floor(maxChars)));
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const offset = Math.max(1, Number(args.offset) || 1);
  if (offset > total) {
    return `The file "${args.path}" has only ${total} line${total === 1 ? "" : "s"}; you have already read all of it.`;
  }
  const limit = Math.min(Math.max(1, Number(args.limit) || READ_LINE_LIMIT), 1000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join("\n");
  let end = offset - 1 + slice.length;
  let charCut = false;
  if (body.length > charLimit) {
    const kept = body.slice(0, charLimit).split("\n");
    if (kept.length > 1) {
      // Cut on a line boundary so the trailer never claims a partially-shown
      // line was read.
      kept.pop();
      body = kept.join("\n");
      end = offset - 1 + kept.length;
      charCut = true;
    } else {
      // A single line longer than the limit: there is no line boundary to
      // advance to, so a line-based "continue" would loop forever. Serve the
      // head and say so, without a continuation offset.
      body = body.slice(0, charLimit);
      return (
        body +
        `\n\n[line ${offset} of ${total} is very long; showing its first ${charLimit} characters only.]`
      );
    }
  }
  if (offset === 1 && end >= total && !charCut) return body;
  return (
    body +
    `\n\n[showing lines ${offset}-${end} of ${total}. Call read_file with {"path": "${args.path}", "offset": ${end + 1}} to continue.]`
  );
}

export function writeFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  if (typeof args.content !== "string") {
    return 'Error: content is required and must be a string. Example: {"path": "notes.txt", "content": "hello"}';
  }
  if (isHistoryPlaceholder(args.content)) {
    return "Error: this is a history placeholder, not source code. No file was changed. Read the current file and provide the actual complete contents.";
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return `Error: "${args.path}" is an existing folder; cannot write a file there.`;
  }
  const existed = fs.existsSync(abs);
  const prevLines = existed ? fs.readFileSync(abs, "utf8").split("\n").length : 0;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, "utf8");
  const newLines = args.content.split("\n").length;
  return existed
    ? `Overwrote ${args.path} (was ${prevLines} lines, now ${newLines} lines).`
    : `Created ${args.path} (${newLines} lines).`;
}

// ---------------------------------------------------------------------------
// edit_file: exact match first, then a line-trimmed (whitespace-forgiving)
// fallback, then a "closest match" coaching error. Small models paraphrase
// whitespace constantly; forgiving matching is the difference between a usable
// and unusable local edit tool.
// ---------------------------------------------------------------------------

function findTrimmedMatch(fileLines: string[], oldLines: string[]): number[] {
  const targets = oldLines.map((l) => l.trim());
  const matches: number[] = [];
  outer: for (let i = 0; i + targets.length <= fileLines.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      if (fileLines[i + j].trim() !== targets[j]) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

function closestSnippet(fileLines: string[], oldText: string): { text: string; offset: number; limit: number } | null {
  const candidates = oldText.split("\n").map((l) => l.trim());
  // A bare closing brace is not a useful anchor for a failed method edit.
  const firstLine = candidates.find((l) => /[a-zA-Z_$]/.test(l) && l.length > 6) ?? "";
  if (!firstLine) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(firstLine);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const line = norm(fileLines[i]);
    if (!line) continue;
    let score = 0;
    if (line === target) score = 1000;
    else if (line.includes(target) || target.includes(line)) score = 500;
    else {
      const words = target.split(" ").filter((w) => w.length > 2);
      for (const w of words) if (line.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 6) return null;
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(fileLines.length, start + Math.min(20, Math.max(8, candidates.length + 4)));
  return { text: fileLines.slice(start, end).join("\n"), offset: start + 1, limit: end - start };
}

// Retours d'échec exploitables (#19) : un échec d'edit_file dit sa cause
// précise et rend l'extrait actuel qui permet de corriger au tour suivant,
// sans relire le fichier entier. Les extraits sont du texte brut entre deux
// lignes « --- », sans numéros collés aux lignes : un petit modèle les
// recopierait dans old_text.
const EDIT_EXCERPT_CHARS = 1500;
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 2;
const SHOWN_OCCURRENCES = 3;
const SHORT_FILE_LINES = 40;

/** Lignes from..to (1 = première, incluses) du fichier, bornées en caractères. */
function excerpt(fileLines: string[], from: number, to: number, maxChars: number): string {
  return truncateEnd(fileLines.slice(Math.max(1, from) - 1, Math.min(fileLines.length, to)).join("\n"), maxChars);
}

/** « lines 4 and 10 », « lines 4, 10 and 16 » (numéros 1 = première ligne). */
function lineList(starts: number[]): string {
  const n = starts.slice(0, 10).map((s) => String(s + 1));
  if (starts.length > 10) n.push(`${starts.length - 10} more`);
  return n.length === 1 ? `line ${n[0]}` : `lines ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}

/** old_text trouvé à plusieurs endroits : chacun localisé, avec le texte
 * actuel qui l'entoure, pour choisir les lignes qui le rendent unique. */
function ambiguous(shownPath: string, fileLines: string[], starts: number[], span: number, exact: boolean): string {
  const shown = starts.slice(0, SHOWN_OCCURRENCES);
  const per = Math.floor(EDIT_EXCERPT_CHARS / shown.length);
  const blocks = shown.map((s, i) => {
    const from = Math.max(1, s + 1 - CONTEXT_BEFORE);
    const to = Math.min(fileLines.length, s + span + CONTEXT_AFTER);
    return `Occurrence ${i + 1} (line ${s + 1}), current lines ${from}-${to}:\n---\n${excerpt(fileLines, from, to, per)}\n---`;
  });
  const more = starts.length > shown.length ? `\n(${starts.length - shown.length} more not shown.)` : "";
  return (
    `Error: old_text ${exact ? `appears ${starts.length} times` : `matches ${starts.length} places`} in ${shownPath}${exact ? "" : " (ignoring whitespace)"}, at ${lineList(starts)}. No file was changed. ` +
    `Copy a few more of the surrounding lines below into old_text so it matches exactly one place.\n` +
    blocks.join("\n") + more
  );
}

/** Une ligne qui ancre vraiment un endroit (pas une accolade seule). */
const meaningful = (line: string) => /[a-zA-Z_$]/.test(line) && line.trim().length > 6;

/** La plus longue suite de lignes du début de old_text retrouvée telle quelle
 * dans le fichier (espaces de bord ignorés) : l'endroit où old_text décroche.
 * null si rien de significatif ne concorde. */
function divergence(fileLines: string[], oldLines: string[]): { at: number; matched: number } | null {
  const target = oldLines.map((l) => l.trim());
  if (!target[0]) return null;
  let best: { at: number; matched: number } | null = null;
  for (let i = 0; i < fileLines.length; i++) {
    let k = 0;
    while (k < target.length && i + k < fileLines.length && fileLines[i + k].trim() === target[k]) k++;
    if (k > 0 && (!best || k > best.matched)) best = { at: i, matched: k };
  }
  if (!best || best.matched >= target.length) return null;
  return target.slice(0, best.matched).some(meaningful) ? best : null;
}

const clip = (s: string) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + "…" : s);

export function editFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  if (!fs.existsSync(abs)) {
    return `Error: file "${args.path}" does not exist. No file was changed. Use write_file to create a new file.${nearbyFiles(root, abs)}`;
  }
  const oldText = args.old_text;
  const newText = args.new_text ?? "";
  if (typeof oldText !== "string" || oldText.length === 0) {
    return 'Error: old_text is required — copy the exact text from the file that you want to replace. To create a new file use write_file instead.';
  }
  if (typeof newText !== "string") {
    return "Error: new_text must be a string (use an empty string to delete the old text).";
  }
  if (isHistoryPlaceholder(newText)) {
    return "Error: this is a history placeholder, not source code. No file was changed. Read the current file and provide the actual replacement text.";
  }

  const rawContent = fs.readFileSync(abs, "utf8");
  // Normalize to LF for all matching, re-serialize with the file's dominant EOL.
  // Otherwise a model that sends "\n"-separated old_text can never exact-match a
  // CRLF file, and the fallback rebuild leaves the file with mixed line endings.
  const crlf = rawContent.includes("\r\n");
  const content = crlf ? rawContent.replace(/\r\n/g, "\n") : rawContent;
  const oldNorm = oldText.replace(/\r\n/g, "\n");
  const newNorm = newText.replace(/\r\n/g, "\n");
  const serialize = (s: string) => (crlf ? s.replace(/\n/g, "\r\n") : s);

  const fileLines = content.split("\n");
  const oldLines = oldNorm.split("\n");

  // Tier 1: exact match.
  const occurrences = content.split(oldNorm).length - 1;
  if (occurrences === 1) {
    fs.writeFileSync(abs, serialize(content.replace(oldNorm, newNorm)), "utf8");
    return `Edited ${args.path}: replaced 1 occurrence.`;
  }
  if (occurrences > 1) {
    const starts: number[] = [];
    for (let at = content.indexOf(oldNorm); at >= 0; at = content.indexOf(oldNorm, at + oldNorm.length)) {
      starts.push(content.slice(0, at).split("\n").length - 1);
    }
    return ambiguous(String(args.path), fileLines, starts, oldLines.length, true);
  }

  // Tier 2: line-trimmed match (forgives leading/trailing whitespace per line).
  const matches = findTrimmedMatch(fileLines, oldLines);
  if (matches.length === 1) {
    const start = matches[0];
    const replaced = [
      ...fileLines.slice(0, start),
      ...newNorm.split("\n"),
      ...fileLines.slice(start + oldLines.length),
    ].join("\n");
    fs.writeFileSync(abs, serialize(replaced), "utf8");
    return `Edited ${args.path}: replaced 1 occurrence (whitespace differences in old_text were ignored).`;
  }
  if (matches.length > 1) {
    return ambiguous(String(args.path), fileLines, matches, oldLines.length, false);
  }

  // Tier 3: say where old_text stops matching, then coach with the closest
  // real snippet, then — for a short file — show all of it.
  const hint = "Use a small exact replacement; this snippet is only a location hint, not the whole block you tried to replace.";
  const cut = divergence(fileLines, oldLines);
  if (cut) {
    const { at, matched } = cut;
    const from = at + 1;
    const to = Math.min(fileLines.length, at + Math.min(oldLines.length + CONTEXT_AFTER, 20));
    const fileSide = at + matched < fileLines.length ? `line ${at + matched + 1} of the file: ${clip(fileLines[at + matched])}` : `the file ends at line ${fileLines.length}`;
    return (
      `Error: old_text was not found in ${args.path}. No file was changed.\n` +
      `Cause: old_text ${matched === 1 ? `line 1 matches line ${from}` : `lines 1-${matched} match lines ${from}-${at + matched}`} of ${args.path}, ` +
      `then line ${matched + 1} of old_text differs.\n  line ${matched + 1} of old_text: ${clip(oldLines[matched])}\n  ${fileSide}\n` +
      `Read this range: ${JSON.stringify({ path: args.path, offset: from, limit: to - at })}. ${hint}\n---\n${excerpt(fileLines, from, to, EDIT_EXCERPT_CHARS)}\n---`
    );
  }
  const snippet = closestSnippet(fileLines, oldText);
  if (snippet) {
    return (
      `Error: old_text was not found in ${args.path}. No file was changed. Closest source starts at line ${snippet.offset}. Read this range: ${JSON.stringify({path:args.path,offset:snippet.offset,limit:snippet.limit})}. ${hint}\n---\n${truncateEnd(snippet.text, 1500)}\n---`
    );
  }
  const total = fileLines.length - (content.endsWith("\n") ? 1 : 0);
  if (total <= SHORT_FILE_LINES && content.length <= EDIT_EXCERPT_CHARS) {
    return (
      `Error: old_text was not found in ${args.path}, and no line resembles it. No file was changed. ` +
      `The file is short; here is all of it (${total} line${total === 1 ? "" : "s"}). Copy old_text exactly from it.\n---\n${content.replace(/\n$/, "")}\n---`
    );
  }
  // Le mot le plus long de old_text sert d'exemple concret : un gabarit
  // « <mot> » serait recopié tel quel par un petit modèle.
  const word = (oldText.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).sort((a: string, b: string) => b.length - a.length)[0];
  const search = word ? `search ${JSON.stringify({ pattern: word, path: args.path })}` : `search with a distinctive word of old_text and {"path": ${JSON.stringify(args.path)}}`;
  return (
    `Error: old_text was not found in ${args.path} (${total} lines), and no line resembles its first line. No file was changed. ` +
    `Locate the text with ${search}, then read_file that range and copy old_text exactly.`
  );
}

export function listFiles(root: string, args: any): string {
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: folder "${startRel}" does not exist.`;
  if (!fs.statSync(start).isDirectory()) {
    return `Error: "${startRel}" is a file, not a folder. Use read_file to read it.`;
  }

  const entries: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 6) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of names) {
      if (truncated) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.isSymbolicLink()) continue; // never follow links out of the workspace
      const abs = path.join(dir, e.name);
      const rel = relPath(root, abs);
      if (e.isDirectory()) {
        entries.push(rel + "/");
        if (entries.length >= LIST_ENTRY_LIMIT) { truncated = true; return; }
        walk(abs, depth + 1);
      } else {
        entries.push(rel);
        if (entries.length >= LIST_ENTRY_LIMIT) { truncated = true; return; }
      }
    }
  };
  walk(start, 0);

  if (entries.length === 0) return `The folder "${startRel}" is empty.`;
  let out = entries.join("\n");
  if (truncated) {
    out += `\n\n[listing capped at ${LIST_ENTRY_LIMIT} entries. Call list_files with {"path": "<subfolder>"} to explore deeper.]`;
  }
  return out;
}

export function searchFiles(root: string, args: any, protect?: PathRules): string {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return 'Error: pattern is required. Example: {"pattern": "function main"}';
  }
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: folder "${startRel}" does not exist.`;

  const startIsFile = fs.statSync(start).isFile();

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const matches: string[] = [];
  let filesScanned = 0;
  let done = false;

  const walk = (dir: string, depth: number) => {
    if (done || depth > 8) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (done) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      // A symlink's Dirent.isDirectory() is false, so a file symlink would
      // otherwise fall straight into readFileSync and leak its target's
      // contents (e.g. creds -> ~/.ssh/id_rsa) into model context. Skip all.
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (startIsFile && abs !== start) continue;
      // Profil mission : un fichier ou dossier protégé n'est jamais lu.
      if (protect && protectedSegment(relPath(root, abs), protect)) continue;
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (filesScanned++ > 5000) { done = true; return; }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > SEARCH_FILE_SIZE_LIMIT || isProbablyBinary(abs)) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${relPath(root, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= SEARCH_MATCH_LIMIT) { done = true; break; }
        }
      }
    }
  };

  if (startIsFile) {
    walk(path.dirname(start), 8); // degenerate case; just scan that dir shallowly
  } else {
    walk(start, 0);
  }

  if (matches.length === 0) {
    return `No matches for "${pattern}" in ${startRel}. (Searched ${filesScanned} files. Tip: try a shorter or simpler pattern.)`;
  }
  let out = matches.join("\n");
  if (matches.length >= SEARCH_MATCH_LIMIT) {
    out += `\n\n[stopped at ${SEARCH_MATCH_LIMIT} matches — narrow the pattern or search a subfolder with {"path": "..."}]`;
  }
  return out;
}

export { SandboxError };
