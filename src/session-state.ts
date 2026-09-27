// Schéma de reprise des sessions (ticket #10, H05) : ce qu'une session
// sauvegardée emporte pour revenir sans rien réinventer — le transcript avec
// la provenance de chaque message, la version des consignes (AGENTS.md) que la
// session utilisait, les approbations de commandes, la vue que l'agent avait
// des fichiers (#19) et la révision Git au moment de la sauvegarde. Le schéma
// est versionné ; une session antérieure (sans champ `schema`) se lit comme
// v1 et se migre en mémoire sans rien perdre, l'original étant archivé par le
// stockage des sessions (src/web/store.ts) avant la première réécriture. Un
// schéma inconnu (écrit par un smol plus récent) n'est jamais repris ni
// réécrit. Sous le profil mission, l'état qui fait foi (contrat, budget,
// preuves, plan, journal d'effets) reste dans le stockage hôte : le snapshot
// n'en garde qu'une référence.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Msg } from "./providers/types";
import type { PlanStep } from "./plan";
import type { Effort } from "./providers/types";
import type { Mode } from "./tools/index";

export const SESSION_SCHEMA = "smolcoder/session/v2";
export const LEGACY_SESSION_SCHEMA = "smolcoder/session/v1";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Une consigne chargée : le texte exactement tel qu'il entre dans le prompt
 * (plafond appliqué) et son empreinte. */
export interface LoadedInstruction {
  text: string;
  sha256: string;
}

/** Les consignes réellement chargées par une session : le noyau global
 * (~/.smolcoder/AGENTS.md) et l'AGENTS.md du workspace, null quand absents. */
export interface SessionInstructions {
  global: LoadedInstruction | null;
  workspace: LoadedInstruction | null;
}

export function instruction(text: string | null): LoadedInstruction | null {
  return text === null ? null : { text, sha256: sha256(text) };
}

/** Deux versions des consignes sont-elles les mêmes ? */
export function sameInstructions(a: SessionInstructions, b: SessionInstructions): boolean {
  return (a.global?.sha256 ?? null) === (b.global?.sha256 ?? null) && (a.workspace?.sha256 ?? null) === (b.workspace?.sha256 ?? null);
}

/** « workspace 1a2b3c4d… → 5e6f7a8b… » pour chaque consigne qui diffère. */
export function describeInstructionDrift(session: SessionInstructions, disk: SessionInstructions): string[] {
  const fp = (x: LoadedInstruction | null) => (x ? x.sha256.slice(0, 12) : "absent");
  const out: string[] = [];
  if ((session.global?.sha256 ?? null) !== (disk.global?.sha256 ?? null)) out.push(`~/.smolcoder/AGENTS.md ${fp(session.global)} → ${fp(disk.global)}`);
  if ((session.workspace?.sha256 ?? null) !== (disk.workspace?.sha256 ?? null)) out.push(`AGENTS.md ${fp(session.workspace)} → ${fp(disk.workspace)}`);
  return out;
}

/** Référence à l'état hôte d'une session sous le profil mission : le contrat,
 * le plan approuvé, le budget consommé et la politique au moment de la
 * sauvegarde. Une référence, jamais la source : le stockage hôte fait foi. */
export interface MissionRef {
  contract: string;
  plan: string | null;
  steps: number;
  policy: string | null;
}

/** Everything needed to bring a session back after a restart. */
export interface SessionSnapshot {
  /** Absent : session sauvegardée avant #10 (v1). */
  schema?: typeof SESSION_SCHEMA;
  messages: Msg[]; // without the system message — rebuilt on restore
  plan: PlanStep[];
  filesTouched: string[];
  commandsRun: string[];
  originalRequest: string;
  currentRequest: string;
  mode: Mode;
  effort: Effort | null;
  model: string;
  backend: string;
  /** Server the model ran on (absent in sessions saved before network hosts). */
  baseUrl?: string;
  /** v2 : les consignes que la session utilisait, texte compris : une reprise
   * les garde au lieu de relire le disque en silence. */
  instructions?: SessionInstructions;
  /** v2 : les programmes approuvés « always » par l'humain (hors profil
   * mission, où « always » ne vaut que pour l'appel). */
  approvals?: { alwaysAllowed: string[] };
  /** v2 : la vue de l'agent (#19) — chemin relatif du workspace vers
   * l'empreinte du contenu qu'il a vu en dernier (lu ou écrit par lui). */
  views?: Array<[string, string]>;
  /** v2 : la révision Git du workspace à la sauvegarde (null hors Git). */
  head?: string | null;
  /** v2, profil mission seulement : la référence à l'état hôte. */
  mission?: MissionRef;
  savedAt?: string;
}

export type SnapshotRead =
  | { state: "ok"; snapshot: SessionSnapshot; schema: typeof SESSION_SCHEMA | typeof LEGACY_SESSION_SCHEMA }
  | { state: "unknown-schema"; schema: unknown }
  | { state: "unreadable"; reason: string };

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const MAX_APPROVALS = 50;
const PROGRAM_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function loaded(v: unknown): LoadedInstruction | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || typeof v.text !== "string" || typeof v.sha256 !== "string") return undefined;
  // Une empreinte qui ne correspond plus au texte : fichier retouché à la main.
  return sha256(v.text) === v.sha256 ? { text: v.text, sha256: v.sha256 } : undefined;
}

/** Lit un snapshot : v2 validé, v1 (sans schéma) migré en mémoire sans rien
 * retirer du transcript, schéma inconnu refusé. Les champs v2 mal formés sont
 * écartés un par un (et dits dans `dropped`), jamais inventés. */
export function readSnapshot(raw: unknown): SnapshotRead & { dropped?: string[] } {
  if (!isObject(raw)) return { state: "unreadable", reason: "the saved session is not a JSON object" };
  if (raw.schema !== undefined && raw.schema !== SESSION_SCHEMA) return { state: "unknown-schema", schema: raw.schema };
  if (!Array.isArray(raw.messages)) return { state: "unreadable", reason: "the saved session has no message list" };
  const legacy = raw.schema === undefined;
  const snapshot = { ...raw } as SessionSnapshot;
  const dropped: string[] = [];
  if (!legacy) {
    if (raw.instructions !== undefined) {
      const g = isObject(raw.instructions) ? loaded(raw.instructions.global) : undefined;
      const w = isObject(raw.instructions) ? loaded(raw.instructions.workspace) : undefined;
      if (g === undefined || w === undefined) {
        delete snapshot.instructions;
        dropped.push("instructions");
      } else snapshot.instructions = { global: g, workspace: w };
    }
    if (raw.approvals !== undefined) {
      const list = isObject(raw.approvals) && Array.isArray(raw.approvals.alwaysAllowed) ? raw.approvals.alwaysAllowed : null;
      if (!list || list.length > MAX_APPROVALS || !list.every((p: unknown) => typeof p === "string" && PROGRAM_RE.test(p))) {
        delete snapshot.approvals;
        dropped.push("approvals");
      }
    }
    if (raw.views !== undefined) {
      const ok = Array.isArray(raw.views) && raw.views.every((e: unknown) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string" && HEX64.test(e[1]));
      if (!ok) {
        delete snapshot.views;
        dropped.push("views");
      }
    }
    if (raw.head !== undefined && raw.head !== null && (typeof raw.head !== "string" || raw.head.length > 200)) {
      delete snapshot.head;
      dropped.push("head");
    }
  }
  return { state: "ok", snapshot, schema: legacy ? LEGACY_SESSION_SCHEMA : SESSION_SCHEMA, ...(dropped.length ? { dropped } : {}) };
}

// ---- révision Git, lue sans lancer git ---------------------------------------
//
// L'hôte ne lance aucun programme du workspace pour savoir où en est Git : il
// lit les fichiers de .git (HEAD, la référence, packed-refs), worktrees
// compris. Un dépôt illisible vaut null, jamais une révision inventée.

const MAX_GIT_FILE = 64 * 1024;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_GIT_FILE) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Le dossier Git du workspace (ou d'un de ses parents) et son dossier commun
 * (celui du dépôt principal pour un worktree). */
function gitDirs(workspace: string): { gitDir: string; commonDir: string } | null {
  let dir = path.resolve(workspace);
  for (;;) {
    const dotgit = path.join(dir, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotgit);
    } catch {
      /* rien ici : on remonte */
    }
    if (st?.isDirectory()) return { gitDir: dotgit, commonDir: dotgit };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readSmall(dotgit) ?? "");
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1].trim());
      const common = readSmall(path.join(gitDir, "commondir"));
      return { gitDir, commonDir: common ? path.resolve(gitDir, common.trim()) : gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** La révision de HEAD : le SHA du commit, `unborn:<ref>` pour une branche sans
 * commit, null hors dépôt ou si le dépôt ne se lit pas. */
export function readGitHead(workspace: string): string | null {
  const dirs = gitDirs(workspace);
  if (!dirs) return null;
  const head = readSmall(path.join(dirs.gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  const m = /^ref:\s*(refs\/[^\s]+)$/.exec(head);
  if (!m || m[1].split("/").includes("..")) return null;
  const ref = m[1];
  for (const base of [dirs.gitDir, dirs.commonDir]) {
    const direct = readSmall(path.join(base, ...ref.split("/")))?.trim();
    if (direct && /^[0-9a-f]{40,64}$/.test(direct)) return direct;
  }
  const packed = readSmall(path.join(dirs.commonDir, "packed-refs")) ?? "";
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && /^[0-9a-f]{40,64}$/.test(sha ?? "")) return sha;
  }
  return `unborn:${ref}`;
}

/** Une révision courte pour l'affichage. */
export const shortRev = (rev: string | null | undefined) => (!rev ? "none" : rev.startsWith("unborn:") ? rev : rev.slice(0, 12));
