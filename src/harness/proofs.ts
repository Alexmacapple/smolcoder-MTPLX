// Verdicts structurés et preuves d'acceptation protégées (ticket #9, H04),
// sous le profil mission. Trois choses distinctes, jamais confondues : le
// statut de chaque critère (passed / failed / not_run / error), l'état de la
// tâche (running, verified, incomplete, blocked, cancelled, uncertain) et la
// décision humaine d'accepter, que le harnais n'enregistre jamais. Un verdict
// vient de l'issue réelle du processus ; le texte de sa sortie ne peut que
// retirer un `passed` (zéro test), jamais en donner un. Chaque verdict porte
// l'empreinte du contrat, celle des entrées du vérificateur figées à
// l'approbation et celle des fichiers vérifiés ; une édition postérieure rend
// la preuve périmée, ce qui se constate en comparant les empreintes.
// Définitions, mécanisme anti-altération et limites :
// docs/decision-preuves-acceptation.md.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { insideWorkspace, PathRules, protectedSegment } from "../sandbox";
import type { CommandResult } from "./executor";
import {
  CheckOwner,
  CriterionStatus,
  CRITERION_STATUSES,
  MAX_VERIFIER_FILES,
  MissionContract,
  PlanChange,
  PlanContent,
  ProofEvent,
  readProofs,
  REPORT_SCHEMA,
  VerdictCause,
  VerdictInput,
  VerifierFreeze,
  verifierDigest,
} from "./store";

/** Code de sortie headless d'un run du profil dont la tâche n'est pas
 * `verified` : un critère requis n'est pas `passed` (3 et 4 priment). */
export const VERDICT_EXIT_CODE = 5;

export const TASK_STATES = ["running", "verified", "incomplete", "blocked", "cancelled", "uncertain"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Les contrôles du projet que la découverte peut nommer (#9 : un par critère). */
export const PROJECT_COMMANDS = ["npm run build", "npm run test", "npm run test:e2e"];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ---- empreinte du workspace ------------------------------------------------

/** `stamp` : inode et date de changement d'état, tenus par le noyau ; un
 * processus ne peut pas les remettre à l'identique après une écriture. */
export interface ScannedFile {
  sha256: string;
  stamp: string;
}

export type WorkspaceScan =
  | { ok: true; files: Map<string, ScannedFile>; digest: string; count: number }
  | { ok: false; reason: string };

export const MAX_SCAN_FILES = 20_000;
export const MAX_SCAN_BYTES = 512 * 1024 * 1024;
/** Jamais parcourus : dépendances installées et métadonnées Git. */
const SKIPPED = new Set(["node_modules", ".git"]);

/** Empreinte de tous les fichiers du workspace, hors `node_modules`, `.git`
 * et noms protégés par la politique (jamais lus). Les liens symboliques ne
 * sont pas suivis : leur cible écrite fait leur contenu. Bornée : au-delà,
 * un état explicite, jamais une empreinte partielle. */
export function scanWorkspace(workspace: string, rules: PathRules, limits = { files: MAX_SCAN_FILES, bytes: MAX_SCAN_BYTES }): WorkspaceScan {
  const files = new Map<string, ScannedFile>();
  let bytes = 0;
  const walk = (rel: string): string | null => {
    const abs = rel ? path.join(workspace, ...rel.split("/")) : workspace;
    let names: string[];
    try {
      names = fs.readdirSync(abs).sort();
    } catch (err: any) {
      return `cannot list ${rel || "."} (${err?.code ?? err})`;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (SKIPPED.has(name) || protectedSegment(r, rules)) continue;
      const p = path.join(abs, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch (err: any) {
        return `cannot inspect ${r} (${err?.code ?? err})`;
      }
      if (st.isDirectory()) {
        const why = walk(r);
        if (why) return why;
        continue;
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue; // socket, tube : aucun contenu
      if (files.size >= limits.files) return `the workspace holds more than ${limits.files} files`;
      let digest: string;
      try {
        if (st.isSymbolicLink()) digest = sha256("link:" + fs.readlinkSync(p));
        else {
          bytes += st.size;
          if (bytes > limits.bytes) return `the workspace holds more than ${limits.bytes} bytes`;
          digest = sha256(fs.readFileSync(p));
        }
      } catch (err: any) {
        return `cannot read ${r} (${err?.code ?? err})`;
      }
      files.set(r, { sha256: digest, stamp: `${st.ino}:${st.ctimeMs}` });
    }
    return null;
  };
  const why = walk("");
  if (why) return { ok: false, reason: why };
  const digest = sha256([...files].map(([p, f]) => `${p}\0${f.sha256}\n`).join(""));
  return { ok: true, files, digest, count: files.size };
}

// ---- entrées du vérificateur -------------------------------------------------

/** Dossiers de tests par convention : tout ce qu'ils contiennent. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__snapshots__", "__mocks__", "__fixtures__", "cypress", "playwright"]);
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$|^test_.+\.py$|_test\.(py|go|rb|js|mjs|cjs|ts)$|\.snap$/i;
/** Configuration des lanceurs et de npm, à toute profondeur. */
const CONFIG_FILE = /^(package\.json|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|makefile|gnumakefile|(jest|vitest|vite|playwright|cypress|karma|ava|babel|nyc|c8|mocha)\.config\.[a-z]+|vitest\.workspace\.[a-z]+|\.mocharc(\.[a-z]+)?|\.babelrc(\.[a-z]+)?|\.nycrc(\.[a-z]+)?|\.c8rc(\.[a-z]+)?|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py)$/i;

/** Sorties de build et dossiers temporaires : régénérés par les contrôles
 * eux-mêmes (tsc réécrit dist/x.test.js, un test écrit sous test/tmp), ils ne
 * sont jamais figés, sans quoi un projet honnête se bloquerait seul. */
const TRANSIENT_DIRS = new Set(["dist", "build", "out", "coverage", ".nyc_output", ".next", ".nuxt", ".output", "target", ".turbo", ".cache", ".pytest_cache", "__pycache__", "tmp", "temp", ".tmp"]);
/** Code sous un dossier de tests : un tel fichier ajouté change ce qui s'exécute. */
const CODE_FILE = /\.(c|m)?(j|t)sx?$|\.(py|rb|go|sh)$/i;

/** Un fichier de test, de configuration de test ou de npm, par convention. */
export function isConventionalVerifierInput(rel: string): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.some((s) => TRANSIENT_DIRS.has(s))) return false;
  return CONFIG_FILE.test(base) || TEST_FILE.test(base) || dirs.some((s) => TEST_DIRS.has(s));
}

/** Un fichier conventionnel apparu depuis l'approbation ne compte comme
 * altération que s'il peut changer ce qui s'exécute ou ce qui est attendu :
 * code de test, configuration, mock, instantané. Une donnée ajoutée sous un
 * dossier de tests (sortie écrite par un test) ne compte pas ; modifier ou
 * retirer une donnée figée, si. */
export function countsWhenAdded(rel: string): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  return CONFIG_FILE.test(base) || TEST_FILE.test(base) || dirs.includes("__mocks__") || dirs.includes("__snapshots__") || (dirs.some((s) => TEST_DIRS.has(s)) && CODE_FILE.test(base));
}

/** Découpe une ligne de shell en segments de mots (guillemets et
 * échappements levés), séparés par `;`, `&&`, `||`, `|`, `&`, parenthèses et
 * fins de ligne. Lecture approchée : elle ne sert qu'à nommer les scripts
 * qu'un contrôle exécute, pour les figer. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (ch === "&" && (word.endsWith(">") || command[i + 1] === ">")) {
      word += ch; // 2>&1, &> : des redirections, pas des séparateurs
      inWord = true;
    } else if (";\n&|()".includes(ch)) endSegment();
    else if (/\s/.test(ch)) endWord();
    else {
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const REDIRECT = /^(\d*|&)(>>?|<<?|>&|<&)(.*)$/;
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "node", "nodejs", "python", "python3", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node"]);
/** Options d'interpréteur suivies de code en ligne : aucun fichier de script. */
const INLINE_CODE = new Set(["-e", "--eval", "-p", "--print", "-c", "-m", "--command"]);
/** Options d'interpréteur suivies d'un fichier chargé avant le script. */
const TAKES_FILE = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
const PREFIXES = new Set(["exec", "command", "time", "nice", "nohup", "env", "cross-env"]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);

interface Named {
  files: Set<string>;
  scripts: Set<string>;
}

/** Chemin relatif POSIX d'un mot qui désigne un fichier du workspace, ou null. */
function relativeTo(workspace: string, word: string): string | null {
  if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || word.includes("$") || word.includes("*")) return null;
  const abs = path.resolve(workspace, word);
  if (!insideWorkspace(workspace, abs)) return null;
  const rel = path.relative(workspace, abs).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? rel : null;
}

function nameSegment(workspace: string, words: string[], named: Named, depth: number): void {
  let w: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT.exec(words[i]);
    if (m) {
      if (!m[3]) i++; // l'opérateur seul : sa cible suit
      continue;
    }
    w.push(words[i]);
  }
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || PREFIXES.has(path.posix.basename(w[0])) || (w[0].startsWith("-") && w.length > 1))) w = w.slice(1);
  if (!w.length) return;
  const add = (word: string) => {
    const rel = relativeTo(workspace, word);
    if (rel) named.files.add(rel);
  };
  const cmd = path.posix.basename(w[0]);
  const args = w.slice(1);
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
    const a = args.filter((x) => !x.startsWith("-"));
    let script: string | undefined;
    let tool: string | undefined;
    if (cmd === "npm") {
      if (["test", "t", "tst"].includes(a[0])) script = "test";
      else if (["start", "stop", "restart"].includes(a[0])) script = a[0];
      else if (NPM_RUN.has(a[0])) script = a[1];
      else if (a[0] === "exec" || a[0] === "x") tool = a[1];
    } else if (a[0] === "run") script = a[1];
    else if (a[0] === "exec" || a[0] === "dlx") tool = a[1];
    else script = a[0];
    if (script) for (const s of [script, `pre${script}`, `post${script}`]) named.scripts.add(s);
    if (tool) named.files.add(`node_modules/.bin/${path.posix.basename(tool)}`);
    return;
  }
  if (cmd === "npx") {
    const tool = args.find((a) => !a.startsWith("-"));
    if (tool) named.files.add(`node_modules/.bin/${path.posix.basename(tool)}`);
    return;
  }
  if (INTERPRETERS.has(cmd)) {
    const rest = cmd === "deno" && args[0] === "run" ? args.slice(1) : args;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (INLINE_CODE.has(a)) {
        // sh -c '…' : la ligne en ligne est lue à son tour.
        if (a === "-c" && ["sh", "bash", "zsh", "dash", "ksh"].includes(cmd) && rest[i + 1] && depth < 5) nameCommand(workspace, rest[i + 1], named, depth + 1);
        return;
      }
      if (TAKES_FILE.has(a)) {
        if (rest[i + 1]) add(rest[++i]);
        continue;
      }
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq > 0) {
        if (TAKES_FILE.has(a.slice(0, eq))) add(a.slice(eq + 1));
        continue;
      }
      if (a.startsWith("-")) continue;
      add(a);
      return;
    }
    return;
  }
  if (w[0].includes("/")) add(w[0]);
  // Un outil nu : celui que npm trouve d'abord dans node_modules/.bin, où
  // un fichier déposé masquerait l'outil du système.
  else named.files.add(`node_modules/.bin/${cmd}`);
}

function nameCommand(workspace: string, command: string, named: Named, depth: number): void {
  for (const seg of shellSegments(command)) nameSegment(workspace, seg, named, depth);
}

/** Les scripts de package.json à la racine du workspace ; {} s'il manque. */
function packageScripts(workspace: string): Record<string, unknown> {
  try {
    const file = path.join(workspace, "package.json");
    if (fs.statSync(file).size > 1024 * 1024) return {};
    const scripts = JSON.parse(fs.readFileSync(file, "utf8")).scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return {};
  }
}

/** Les fichiers que les commandes des contrôles exécutent : script d'un
 * interpréteur, programme nommé par un chemin, outil de node_modules/.bin,
 * et, à travers `npm run <nom>` (avec pre et post), ceux des scripts de
 * package.json. Chemins relatifs, existants ou non. */
export function namedVerifierInputs(workspace: string, commands: string[]): string[] {
  const named: Named = { files: new Set(), scripts: new Set() };
  for (const c of commands) nameCommand(workspace, c, named, 0);
  const scripts = packageScripts(workspace);
  const done = new Set<string>();
  for (let guard = 0; guard < 200; guard++) {
    const next = [...named.scripts].find((s) => !done.has(s));
    if (next === undefined) break;
    done.add(next);
    const body = scripts[next];
    if (typeof body === "string") nameCommand(workspace, body, named, 0);
  }
  return [...named.files].sort();
}

/** Empreinte actuelle d'un chemin hors du parcours (node_modules/.bin/…) :
 * la cible écrite du lien et le contenu de la cible si elle est dans le
 * workspace. null : absent ; undefined : un dossier, jamais figé. */
function entryValue(workspace: string, rel: string): string | null | undefined {
  const abs = path.join(workspace, ...rel.split("/"));
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isDirectory()) return undefined;
  let desc = "";
  let target = abs;
  try {
    if (st.isSymbolicLink()) {
      desc = `link:${fs.readlinkSync(abs)}\0`;
      target = fs.realpathSync.native(abs);
    }
    if (!insideWorkspace(workspace, target)) return sha256(desc + "outside");
    const t = fs.statSync(target);
    if (t.isDirectory()) return undefined;
    return sha256(desc + (t.isFile() ? sha256(fs.readFileSync(target)) : "special"));
  } catch {
    return sha256(desc + "unreadable");
  }
}

type ScanOk = Extract<WorkspaceScan, { ok: true }>;

/** Valeur actuelle d'une entrée : celle du parcours, sinon lue à part pour
 * node_modules ; un nom exclu du parcours (protégé) vaut null, jamais lu. */
function currentValue(workspace: string, scan: ScanOk, rel: string): string | null | undefined {
  const f = scan.files.get(rel);
  if (f) return f.sha256;
  if (rel.split("/").includes("node_modules")) return entryValue(workspace, rel);
  try {
    if (fs.lstatSync(path.join(workspace, ...rel.split("/"))).isDirectory()) return undefined;
  } catch {
    return null;
  }
  return null;
}

/** La sélection des entrées du vérificateur : fichiers de test et de
 * configuration par convention, et scripts nommés par les commandes. */
export function selectVerifierInputs(workspace: string, scan: ScanOk, commands: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [p, f] of scan.files) if (isConventionalVerifierInput(p)) out[p] = f.sha256;
  for (const p of namedVerifierInputs(workspace, commands)) {
    if (p in out) continue;
    const v = currentValue(workspace, scan, p);
    if (v !== undefined) out[p] = v;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Ce que figerait une approbation maintenant, ou pourquoi c'est impossible. */
export function freezeVerifiers(workspace: string, scan: WorkspaceScan, commands: string[]): { freeze: VerifierFreeze } | { reason: string } {
  if (!scan.ok) return { reason: scan.reason };
  const files = selectVerifierInputs(workspace, scan, commands);
  if (Object.keys(files).length > MAX_VERIFIER_FILES) return { reason: `more than ${MAX_VERIFIER_FILES} verifier inputs` };
  return { freeze: { digest: verifierDigest(files), files, commands: [...new Set(commands)] } };
}

/** Les écarts entre les entrées figées et l'état actuel : fichier modifié,
 * retiré, ou ajouté (nouveau test, nouvelle configuration, script nommé qui
 * n'existait pas à l'approbation). */
export function verifierChanges(workspace: string, scan: ScanOk, frozen: Record<string, string | null>, commands: string[]): string[] {
  const current = selectVerifierInputs(workspace, scan, commands);
  const changes: string[] = [];
  for (const [p, was] of Object.entries(frozen)) {
    const now = p in current ? current[p] : (currentValue(workspace, scan, p) ?? null);
    if (now !== was) changes.push(`${p} (${was === null ? "added" : now === null ? "removed" : "modified"})`);
  }
  // Un script que nomme une commande compte toujours : il est ce qui s'exécute.
  const named = new Set(namedVerifierInputs(workspace, commands));
  for (const [p, v] of Object.entries(current)) if (!(p in frozen) && v !== null && (named.has(p) || countsWhenAdded(p))) changes.push(`${p} (added)`);
  return changes.sort();
}

/** Tampons du noyau (inode, date de changement d'état) des entrées : une
 * écriture pendant un contrôle les change même si le contenu est rétabli. */
export function verifierStamps(workspace: string, scan: ScanOk, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const p of paths) {
    const f = scan.files.get(p);
    if (f) {
      out.set(p, f.stamp);
      continue;
    }
    try {
      const abs = path.join(workspace, ...p.split("/"));
      const l = fs.lstatSync(abs);
      let stamp = `${l.ino}:${l.ctimeMs}`;
      if (l.isSymbolicLink()) {
        try {
          const t = fs.statSync(abs);
          stamp += `>${t.ino}:${t.ctimeMs}`;
        } catch {
          /* cible absente */
        }
      }
      out.set(p, stamp);
    } catch {
      out.set(p, null);
    }
  }
  return out;
}

// ---- statut d'un contrôle ------------------------------------------------------

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function sumOf(s: string, keys: string[]): number {
  let n = 0;
  for (const k of keys) {
    const m = new RegExp(`(\\d+) ${k}`).exec(s);
    if (m) n += Number(m[1]);
  }
  return n;
}

/** Nombre de tests exécutés (réussis ou échoués) selon les résumés reconnus
 * des lanceurs courants (node:test, TAP, Jest, Mocha, Vitest, pytest) ; null
 * sans résumé reconnu. Ne sert qu'à retirer un `passed` : zéro test exécuté
 * (aucun, ou tous sautés) n'est jamais une réussite. */
export function countTests(output: string): { executed: number | null; zero: boolean } {
  const text = stripAnsi(output);
  const found: number[] = [];
  const nodeTests = [...text.matchAll(/^[ℹ#] tests (\d+)$/gm)];
  const pass = [...text.matchAll(/^[ℹ#] pass (\d+)$/gm)];
  const fail = [...text.matchAll(/^[ℹ#] fail (\d+)$/gm)];
  nodeTests.forEach((t, i) => found.push(pass[i] && fail[i] ? Number(pass[i][1]) + Number(fail[i][1]) : Number(t[1])));
  if (/^1\.\.0\b/m.test(text)) found.push(0);
  for (const j of text.matchAll(/^Tests:\s+(.*?)\s*(\d+) total$/gm)) found.push(sumOf(j[1], ["passed", "failed"]));
  if (/^No tests found/m.test(text)) found.push(0);
  const passing = /^\s*(\d+) passing\b/m.exec(text);
  if (passing) {
    const failing = /^\s*(\d+) failing\b/m.exec(text);
    found.push(Number(passing[1]) + (failing ? Number(failing[1]) : 0));
  }
  for (const v of text.matchAll(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gm)) found.push(sumOf(v[1], ["passed", "failed"]));
  if (/No test files found/.test(text)) found.push(0);
  if (/\bno tests ran\b|\bcollected 0 items\b/.test(text)) found.push(0);
  for (const p of text.matchAll(/^=+ (.*\b(?:passed|failed|skipped)\b.*) in [\d.]+s\b.*=+$/gm)) found.push(sumOf(p[1], ["passed", "failed"]));
  if (!found.length) return { executed: null, zero: false };
  const executed = found.reduce((a, b) => a + b, 0);
  return { executed, zero: executed === 0 };
}

export interface CheckOutcome {
  status: CriterionStatus;
  cause: VerdictCause | null;
  tests: number | null;
}

/** Codes 128 + N par lesquels le shell rapporte un enfant tué par un signal
 * de plantage ou d'arrêt forcé (ILL, TRAP, ABRT, EMT, FPE, KILL, BUS, SEGV,
 * SYS, TERM) : le vérificateur n'a pas conclu. */
const CRASH_CODES = new Set([132, 133, 134, 135, 136, 137, 138, 139, 140, 143]);

/** Le statut d'un contrôle exécuté, depuis l'issue réelle du processus. */
export function classify(result: CommandResult): CheckOutcome {
  switch (result.status) {
    case "spawn_error":
      return { status: "error", cause: "spawn-error", tests: null };
    case "timeout":
      return { status: "error", cause: "timeout", tests: null };
    case "signaled":
      return { status: "error", cause: "crashed", tests: null };
    case "cancelled":
      return { status: "not_run", cause: "cancelled", tests: null };
    default: {
      if (result.exitCode !== null && CRASH_CODES.has(result.exitCode)) return { status: "error", cause: "crashed", tests: null };
      const count = countTests(result.output);
      if (count.zero) return { status: "not_run", cause: "zero-tests", tests: 0 };
      if (result.exitCode !== 0) return { status: "failed", cause: "exit-code", tests: count.executed };
      return { status: "passed", cause: null, tests: count.executed };
    }
  }
}

const NPM_SIMPLE = /^\s*npm\s+(?:(test|t|tst)|run(?:-script)?\s+([^\s;&|<>'"`$]+))((?:\s+--(?:if-present|silent))*)\s*$/;
const NPM_INIT_PLACEHOLDER = /^echo "Error: no test specified" && exit 1$/;

/** Constat avant exécution d'un contrôle `npm test` / `npm run <nom>` : un
 * script absent ou vide ne teste rien (`--if-present` sortirait 0 sans rien
 * lancer), le script par défaut de `npm init` ne contient aucun test. */
export function npmPrecheck(workspace: string, command: string): { outcome: CheckOutcome; message: string } | null {
  const m = NPM_SIMPLE.exec(command);
  if (!m) return null;
  const name = m[1] ? "test" : m[2];
  let scripts: Record<string, unknown>;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8"));
    scripts = raw && typeof raw === "object" && raw.scripts && typeof raw.scripts === "object" ? raw.scripts : {};
  } catch (err: any) {
    if (err?.code !== "ENOENT") return null; // package.json illisible : npm le dira
    scripts = {};
  }
  const body = scripts[name];
  if (typeof body !== "string" || !body.trim()) {
    return { outcome: { status: "not_run", cause: "missing-script", tests: null }, message: `[not run: package.json has no "${name}" script, so "${command}" would test nothing]` };
  }
  if (NPM_INIT_PLACEHOLDER.test(body.trim())) {
    return { outcome: { status: "not_run", cause: "zero-tests", tests: 0 }, message: `[not run: the "${name}" script is npm's placeholder and holds no test]` };
  }
  return null;
}

// ---- critères et contrôles d'une mission ------------------------------------

/** Un contrôle décisif : une commande, son origine, les critères qu'elle couvre. */
export interface MissionCheck {
  command: string;
  owner: CheckOwner;
  criteria: string[];
  timeoutMs?: number;
}

export interface CriterionSpec {
  id: string;
  text: string;
  command: string | null;
  owner: CheckOwner | null;
}

export const VERIFY_CRITERION = "verify";

/** Les contrôles fournis par l'hôte : ceux du contrat, dans l'ordre, puis la
 * commande --verify de l'appelant (fusionnée avec un contrôle identique). */
export function callerChecks(contract: MissionContract, verify?: { command: string; timeoutMs?: number }): MissionCheck[] {
  const out: MissionCheck[] = [];
  for (const c of contract.checks ?? []) {
    out.push({ command: c.command, owner: "contract", criteria: c.covers.map((n) => `acceptance-${n}`), ...(c.timeoutSeconds ? { timeoutMs: c.timeoutSeconds * 1000 } : {}) });
  }
  if (verify) {
    const same = out.find((c) => c.command === verify.command.trim());
    if (same) {
      same.criteria.push(VERIFY_CRITERION);
      if (!same.timeoutMs && verify.timeoutMs) same.timeoutMs = verify.timeoutMs;
    } else out.push({ command: verify.command, owner: "caller", criteria: [VERIFY_CRITERION], ...(verify.timeoutMs ? { timeoutMs: verify.timeoutMs } : {}) });
  }
  return out;
}

/** Les contrôles découverts du projet, un par script : `npm run build`,
 * `npm run test`, `npm run test:e2e`. */
export function projectChecks(commands: string[]): MissionCheck[] {
  return commands.map((command) => {
    const script = /^npm run (\S+)/.exec(command)?.[1] ?? "check";
    return { command, owner: "project" as const, criteria: [`project-${script.replace(/[^a-z0-9:_-]/gi, "-").toLowerCase()}`.slice(0, 64)] };
  });
}

/** Les critères requis : chaque critère du contrat, couvert ou non, puis
 * ceux que les contrôles de ce tour ajoutent (--verify, contrôles du projet). */
export function missionCriteria(contract: MissionContract, checks: MissionCheck[]): CriterionSpec[] {
  const byCriterion = new Map<string, MissionCheck>();
  for (const c of checks) for (const id of c.criteria) byCriterion.set(id, c);
  const specs: CriterionSpec[] = contract.acceptance.map((text, i) => {
    const id = `acceptance-${i + 1}`;
    const c = byCriterion.get(id);
    return { id, text, command: c?.command ?? null, owner: c?.owner ?? null };
  });
  for (const c of checks) {
    for (const id of c.criteria) {
      if (id.startsWith("acceptance-")) continue;
      const text = id === VERIFY_CRITERION ? "Caller acceptance command (--verify)" : `Project check: ${c.command}`;
      specs.push({ id, text, command: c.command, owner: c.owner });
    }
  }
  return specs;
}

// ---- rapport -------------------------------------------------------------------

export type VerdictRecord = VerdictInput & { schema: string; at: string };

export interface CriterionReport {
  id: string;
  text: string;
  command: string | null;
  owner: CheckOwner | null;
  /** Statut constaté maintenant : une preuve périmée vaut `not_run` (stale). */
  status: CriterionStatus;
  cause: VerdictCause | null;
  stale: boolean;
  verdict: Pick<VerdictRecord, "at" | "attempt" | "status" | "cause" | "exit" | "tests" | "files" | "verifiers"> | null;
}

export interface VerifierState {
  state: "frozen" | "changed" | "unfrozen";
  /** Empreinte figée par l'approbation en vigueur, ou null. */
  frozen: string | null;
  /** Empreinte de ce qu'une nouvelle approbation figerait maintenant. */
  current: string | null;
  changes: string[];
  reason?: string;
}

export interface RunInfo {
  outcome: "idle" | "running" | "completed" | "cancelled" | "error";
  suspended: boolean;
  error: string | null;
  attempts: number | null;
}

/** Un écart au plan approuvé, tel que le journal le garde (#29). */
export interface PlanDeviation {
  at: string;
  change: PlanChange;
  before: string[];
  after: string[];
  reason: string | null;
}

/** Le plan d'implémentation dans le rapport (#29) : présent seulement quand
 * un plan existe ou que le contrat l'exige. Déclaratif : il n'entre dans
 * aucun statut ; ses écarts sont listés pour la revue, jamais bloquants. */
export interface PlanReport {
  state: "none" | "proposed" | "approved" | "unreadable";
  required: boolean;
  /** Empreinte du plan approuvé avec le contrat, ou du plan proposé. */
  fingerprint: string | null;
  /** La version approuvée, telle qu'approuvée. */
  approved: PlanContent | null;
  /** La version proposée, en attente d'approbation. */
  proposed: PlanContent | null;
  /** La version courante, réécrite après approbation ; null si identique. */
  current: PlanContent | null;
  /** Critères ni couverts par un contrôle de l'hôte ni prévus au plan. */
  missingProofs: string[];
  deviations: PlanDeviation[];
  note: string;
}

/** Un écart en une ligne lisible (report.md, /mission). */
export function describeDeviation(d: PlanDeviation): string {
  const q = (s: string) => `« ${s} »`;
  const code = (s: string) => `\`${s}\``;
  const diff = (noun: string, fmt: (s: string) => string, [add, rem]: [string, string]) => {
    const added = d.after.filter((x) => !d.before.includes(x));
    const removed = d.before.filter((x) => !d.after.includes(x));
    const parts = [...added.map((x) => `${add} ${fmt(x)}`), ...removed.map((x) => `${rem} ${fmt(x)}`)];
    return `${noun} : ${parts.length ? parts.join(" ; ") : "réordonnés"}`;
  };
  const what =
    d.change === "file" ? `fichier hors plan : ${code(d.after[0] ?? "")}`
      : d.change === "steps" ? diff("étapes", q, ["ajoutée", "retirée"])
        : d.change === "files" ? diff("fichiers", code, ["ajouté", "retiré"])
          : d.change === "risks" ? diff("risques", q, ["ajouté", "retiré"])
            : diff("preuves prévues", q, ["ajoutée", "retirée"]);
  return `${what} — motif : ${d.reason ?? "non donné"}`;
}

export interface VerdictReport {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  workspace: string;
  contract: { id: string; title: string; fingerprint: string; state: string };
  task: { state: TaskState; reason: string };
  /** La décision humaine d'accepter ou d'intégrer : jamais prise par le harnais. */
  decision: { state: "pending"; note: string };
  verifiers: VerifierState;
  files: { digest: string | null; count: number | null; reason?: string };
  criteria: CriterionReport[];
  counts: Record<CriterionStatus, number>;
  uncovered: string[];
  stale: boolean;
  /** Ce que le modèle déclare : jamais une preuve. */
  claims: { plan: string | null; note: string };
  run: RunInfo;
  journal: string;
  /** Le plan d'implémentation (#29), absent sans plan ni exigence. */
  plan?: PlanReport;
}

/** Ce que le rapport lit d'une mission (évite l'import circulaire). */
export interface MissionView {
  workspace: string;
  dir: string;
  fingerprint: string;
  contract: MissionContract;
  status(): { state: string };
}

/** Le dernier verdict de chaque critère, pour ce contrat. */
export function latestVerdicts(events: ProofEvent[], fingerprint: string): Map<string, VerdictRecord> {
  const out = new Map<string, VerdictRecord>();
  for (const e of events) {
    if (e.type !== "verdict" || e.fingerprint !== fingerprint) continue;
    for (const id of (e as VerdictRecord).criteria) out.set(id, e as VerdictRecord);
  }
  return out;
}

const BLOCKING: VerdictCause[] = ["policy", "verifier-changed", "verifier-unfrozen"];

/** L'état de la tâche, dans cet ordre : annulée ; bloquée (contrat non
 * approuvé, décision humaine en suspens, contrôle refusé, vérificateur
 * modifié ou non figé) ; incertaine (vérificateur en erreur, preuve
 * périmée) ; incomplète (critère en échec ou non exécuté) ; vérifiée si
 * tous les critères sont `passed` et que le tour n'a pas fini sur une erreur. */
export function deriveTaskState(contractState: string, run: RunInfo, verifier: VerifierState, criteria: CriterionReport[], filesOk: boolean): { state: TaskState; reason: string } {
  const not = (s: CriterionStatus) => criteria.filter((c) => c.status === s);
  if (run.outcome === "running") return { state: "running", reason: "a turn is in progress; nothing here is final" };
  if (run.outcome === "cancelled") return { state: "cancelled", reason: "the user cancelled the turn" };
  if (contractState !== "approved") return { state: "blocked", reason: `the mission contract is ${contractState}: only the host can approve it` };
  if (run.suspended) return { state: "blocked", reason: "a step needs a human decision (access policy) and this run is headless" };
  if (verifier.state !== "frozen") {
    return { state: "blocked", reason: verifier.state === "changed" ? `the verifier inputs changed since the host approved them (${verifier.changes.slice(0, 5).join(", ")}${verifier.changes.length > 5 ? ", …" : ""})` : "the verifier inputs are not frozen: the host must approve them" };
  }
  const blocked = criteria.filter((c) => c.cause && BLOCKING.includes(c.cause));
  if (blocked.length) return { state: "blocked", reason: `${blocked.map((c) => c.id).join(", ")} could not run (${blocked[0].cause})` };
  if (!filesOk) return { state: "uncertain", reason: "the workspace could not be fingerprinted, so no proof can be dated" };
  const errors = not("error");
  if (errors.length) return { state: "uncertain", reason: `the verifier itself failed for ${errors.map((c) => `${c.id} (${c.cause})`).join(", ")}` };
  const stale = criteria.filter((c) => c.stale);
  if (stale.length) return { state: "uncertain", reason: `the files changed after ${stale.map((c) => c.id).join(", ")} ${stale.length === 1 ? "was" : "were"} verified: the proof is stale` };
  const open = criteria.filter((c) => c.status !== "passed");
  if (open.length) return { state: "incomplete", reason: `${open.length} of ${criteria.length} required criteria are not passed: ${open.map((c) => `${c.id} ${c.status}${c.cause ? ` (${c.cause})` : ""}`).join(", ")}` };
  if (run.outcome === "error") return { state: "uncertain", reason: `every criterion passed, but the run stopped on an error: ${run.error ?? "unknown"}` };
  return { state: "verified", reason: `all ${criteria.length} required criteria passed on the current files` };
}

/** Le rapport, construit depuis le journal, le contrat, l'état du
 * vérificateur et l'empreinte actuelle du workspace. report.json et report.md
 * sont deux rendus de cet objet. */
export function buildReport(input: {
  mission: MissionView;
  criteria: CriterionSpec[];
  verifier: VerifierState;
  scan: WorkspaceScan;
  run: RunInfo;
  plan: { done: number; total: number } | null;
  /** Le plan d'implémentation (#29) ; absent ou null : aucune rubrique. */
  implementationPlan?: PlanReport | null;
}): VerdictReport {
  const { mission, verifier, scan, run } = input;
  const read = readProofs(mission.dir);
  const events = read.state === "ok" || read.state === "truncated-tail" ? read.events : [];
  const latest = latestVerdicts(events, mission.fingerprint);
  const filesDigest = scan.ok ? scan.digest : null;
  const criteria: CriterionReport[] = input.criteria.map((spec) => {
    const base = { id: spec.id, text: spec.text, command: spec.command, owner: spec.owner };
    if (!spec.command) return { ...base, status: "not_run" as const, cause: "not-covered" as const, stale: false, verdict: null };
    const v = latest.get(spec.id);
    if (!v) return { ...base, status: "not_run" as const, cause: "not-run" as const, stale: false, verdict: null };
    const verdict = { at: v.at, attempt: v.attempt, status: v.status, cause: v.cause, exit: v.exit, tests: v.tests, files: v.files, verifiers: v.verifiers };
    // Une preuve ne vaut que pour les fichiers, le vérificateur et la
    // commande qu'elle a vus. Périmée, elle ne s'affiche jamais `passed`.
    const current = v.files !== null && v.files === filesDigest && v.verifiers === verifier.frozen && v.command === spec.command;
    if (current) return { ...base, status: v.status, cause: v.cause, stale: false, verdict };
    if (v.status === "not_run") return { ...base, status: "not_run" as const, cause: "not-run" as const, stale: false, verdict };
    return { ...base, status: "not_run" as const, cause: "stale" as const, stale: true, verdict };
  });
  const counts = Object.fromEntries(CRITERION_STATUSES.map((s) => [s, criteria.filter((c) => c.status === s).length])) as Record<CriterionStatus, number>;
  const contractState = mission.status().state;
  const journal = read.state === "ok" || read.state === "absent" ? "ok" : read.state;
  const task = deriveTaskState(contractState, run, verifier, criteria, scan.ok && journal === "ok");
  if (journal !== "ok" && task.state === "verified") Object.assign(task, { state: "uncertain", reason: `the proof journal is ${journal}` });
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    workspace: mission.workspace,
    contract: { id: mission.contract.id, title: mission.contract.title, fingerprint: mission.fingerprint, state: contractState },
    task,
    decision: { state: "pending", note: "Accepting or integrating the work is a human decision; the harness never records it." },
    verifiers: verifier,
    files: scan.ok ? { digest: scan.digest, count: scan.count } : { digest: null, count: null, reason: scan.reason },
    criteria,
    counts,
    uncovered: criteria.filter((c) => c.cause === "not-covered").map((c) => c.id),
    stale: criteria.some((c) => c.stale),
    claims: { plan: input.plan ? `${input.plan.done}/${input.plan.total}` : null, note: "Declared by the model — a checked plan is never evidence." },
    run,
    journal,
    ...(input.implementationPlan ? { plan: input.implementationPlan } : {}),
  };
}

/** La rubrique du plan dans report.md (#29) : la version approuvée (ou
 * proposée), la version courante si elle a été réécrite, les écarts. */
function renderPlanSection(p: PlanReport): string[] {
  const version = (label: string, c: PlanContent) => [
    `${label} :`,
    "",
    ...c.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `Fichiers : ${c.files.map((f) => `\`${f}\``).join(", ")}.`,
    ...(c.risks.length ? [`Risques : ${c.risks.join(" ; ")}.`] : []),
    ...(c.proofs.length ? [`Preuves prévues : ${c.proofs.map((x) => `${x.criterion}: ${x.proof}`).join(" ; ")}.`] : []),
    "",
  ];
  const fp = p.fingerprint ? `\`${p.fingerprint.slice(0, 16)}\`` : "_(aucune)_";
  const state =
    p.state === "approved" ? `approuvé avec le contrat, empreinte ${fp}`
      : p.state === "proposed" ? `proposé, en attente d'approbation avec le contrat, empreinte ${fp}`
        : p.state === "unreadable" ? `illisible (empreinte ${fp})`
          : "aucun";
  return [
    "## Plan d'implémentation",
    "",
    `Plan ${state}${p.required ? ", exigé par le contrat" : ""}. Un guide déclaré par l'agent et approuvé par l'hôte, jamais une preuve ni une cage : les écarts sont listés pour la revue et ne changent aucun statut.`,
    "",
    ...(p.approved ? version("Version approuvée", p.approved) : []),
    ...(p.proposed ? version("Version proposée", p.proposed) : []),
    ...(p.current ? version("Version courante, réécrite après approbation", p.current) : []),
    ...(p.missingProofs.length ? [`Critère(s) sans preuve prévue ni contrôle de l'hôte : ${p.missingProofs.join(", ")}.`, ""] : []),
    ...(p.state === "approved"
      ? [`${p.deviations.length} écart(s) au plan approuvé${p.deviations.length ? " :" : "."}`, ...(p.deviations.length ? ["", ...p.deviations.map((d) => `- ${d.at} — ${describeDeviation(d)}`)] : []), ""]
      : []),
  ];
}

const STATE_FR: Record<TaskState, string> = {
  running: "en cours",
  verified: "vérifiée",
  incomplete: "incomplète",
  blocked: "bloquée",
  cancelled: "annulée",
  uncertain: "incertaine",
};

const CAUSE_FR: Record<VerdictCause, string> = {
  "exit-code": "code de sortie non nul",
  "zero-tests": "zéro test exécuté",
  "missing-script": "script absent",
  policy: "refusé par la politique d'accès",
  "verifier-changed": "vérificateur modifié depuis l'approbation",
  "verifier-unfrozen": "vérificateur non figé",
  timeout: "délai dépassé",
  crashed: "vérificateur arrêté par un signal",
  "spawn-error": "lancement impossible",
  "no-isolation": "aucun exécuteur isolé",
  "verifier-changed-during-check": "vérificateur modifié pendant le contrôle",
  "fingerprint-unavailable": "empreinte du workspace impossible",
  "journal-unwritable": "verdict non enregistré",
  "not-covered": "non couvert : aucun contrôle de l'hôte",
  "not-run": "pas encore exécuté pour ce contrat",
  stale: "preuve périmée : fichiers ou vérificateur changés depuis",
  cancelled: "annulé",
};

/** Le résumé Markdown : même objet que report.json, jamais un vert périmé
 * (une preuve périmée s'affiche `not_run`). */
export function renderReportMarkdown(r: VerdictReport): string {
  const short = (h: string | null) => (h ? `\`${h.slice(0, 16)}\`` : "_(aucune)_");
  const line = (c: CriterionReport) => {
    const where = c.command ? ` — contrôle \`${c.command}\` (${c.owner})` : "";
    const v = c.verdict;
    const exit = v?.exit ? `, issue ${v.exit.status}${v.exit.code !== null ? ` ${v.exit.code}` : ""}${v.exit.signal ? ` ${v.exit.signal}` : ""}` : "";
    const detail = v ? ` · dernier verdict ${v.status} (tentative ${v.attempt}, ${v.at}${exit}${v.tests !== null ? `, ${v.tests} test(s)` : ", nombre de tests inconnu"})` : "";
    return `- \`${c.status}\`${c.cause ? ` (${CAUSE_FR[c.cause]})` : ""} — ${c.id} : ${c.text}${where}${detail}`;
  };
  const verifiers =
    r.verifiers.state === "frozen" ? `figés à l'approbation, empreinte ${short(r.verifiers.frozen)}`
      : r.verifiers.state === "changed" ? `modifiés depuis l'approbation (${r.verifiers.changes.join(", ")}) — nouvelle approbation de l'hôte requise, empreinte actuelle ${short(r.verifiers.current)}`
        : `non figés${r.verifiers.reason ? ` (${r.verifiers.reason})` : ""} — approbation de l'hôte requise`;
  return [
    `# Verdict — ${r.contract.title}`,
    "",
    `État de la tâche : **${r.task.state}** (${STATE_FR[r.task.state]}) — ${r.task.reason}`,
    `Décision humaine : en attente — accepter ou intégrer reste une décision humaine, jamais enregistrée par le harnais.`,
    `Constat du ${r.generatedAt} sur les fichiers d'empreinte ${short(r.files.digest)}${r.files.count !== null ? ` (${r.files.count} fichiers)` : ` (${r.files.reason})`} : toute modification ultérieure le rend périmé ; smol le refait à chaque tour.`,
    `Contrat \`${r.contract.id}\` · empreinte \`${r.contract.fingerprint}\` · ${r.contract.state}`,
    `Vérificateurs : ${verifiers}`,
    ...(r.journal !== "ok" ? [`Journal des preuves : ${r.journal}`] : []),
    "",
    "## Critères",
    "",
    ...r.criteria.map(line),
    "",
    "## Critères non couverts",
    "",
    ...(r.uncovered.length ? r.criteria.filter((c) => c.cause === "not-covered").map((c) => `- ${c.id} : ${c.text}`) : ["_(aucun)_"]),
    "",
    "## Déclaratif, pas une preuve",
    "",
    `Plan du modèle : ${r.claims.plan ?? "aucun"}. Un plan coché n'est jamais une preuve.`,
    "",
    `Bilan : ${r.criteria.length} critère(s) — ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.not_run} not_run, ${r.counts.error} error.`,
    "",
    // #29 : le plan après le bilan des critères — il n'en change aucun.
    ...(r.plan ? renderPlanSection(r.plan) : []),
  ].join("\n");
}

/** La ligne `[verdict]` du headless et la ligne d'état des sessions. */
export function verdictSummary(r: VerdictReport, reportFile: string | null) {
  return { state: r.task.state, reason: r.task.reason, criteria: r.counts, uncovered: r.uncovered, stale: r.stale, verifiers: r.verifiers.state, report: reportFile };
}

/** Sortie headless selon le verdict : 0 seulement pour une tâche vérifiée. */
export function verdictExitCode(r: VerdictReport | null): number {
  return r && r.task.state === "verified" && r.run.outcome === "completed" ? 0 : VERDICT_EXIT_CODE;
}
