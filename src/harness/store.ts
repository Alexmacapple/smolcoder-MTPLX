// Stockage hôte du harnais — seul module propriétaire de la grammaire de
// ~/.smolcoder/harness/<empreinte-du-workspace>/ (docs/decision-stockage-hote.md) :
// contract.json (le contrat de mission), proofs.jsonl (journal en ajout
// seul, quatre types d'événements, `fiche` ajouté par #30 en amendement de
// la décision) et policy.json (la politique d'accès du
// profil, ticket #11). Schéma versionné, statuts fermés,
// validation et bornes de lecture vivent ici ; tout consommateur passe par
// ce module pour que les portes ne dérivent pas vers des lectures
// différentes. Fail-closed : un fichier illisible, un schéma inconnu ou une
// dernière ligne tronquée sont des états explicites, jamais ignorés ni
// convertis en succès. États discrets uniquement, jamais de score.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../config";
import { FICHE_NAME_RE } from "../fiches";
import { writeAtomic } from "../web/store";

export const CONTRACT_SCHEMA = "smolcoder/contract/v1";
export const PROOF_SCHEMA = "smolcoder/proof/v1";
export const CONTRACT_FILE = "contract.json";
export const PROOFS_FILE = "proofs.jsonl";
/** Bornes dures de lecture : une corruption ne doit pas coûter la session. */
export const MAX_CONTRACT_BYTES = 256 * 1024;
export const MAX_PROOFS_BYTES = 8 * 1024 * 1024;

export const CONTRACT_STATUSES = ["proposed", "approved", "expired"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
/** Les seules autorités qui approuvent : l'hôte (drapeau de l'appelant
 * headless, humain au terminal ou dans l'interface web). Jamais le modèle,
 * un fichier du workspace ou un label de ticket. */
export const APPROVAL_AUTHORITIES = ["headless-flag", "terminal-human", "web-human"] as const;
export type ApprovalAuthority = (typeof APPROVAL_AUTHORITIES)[number];
export const PROOF_TYPES = ["contract", "approval", "verdict", "fiche"] as const;

/** Le contrat de mission : les sept rubriques du format d'intention, plus
 * l'identité, le workspace, la révision de base, la référence de politique
 * (#11) et les budgets. Tout ce qui est ici entre dans l'empreinte. */
export interface MissionContract {
  id: string;
  title: string;
  /** Chemin réel du workspace, rempli par l'hôte. */
  workspace: string;
  baseRevision: string | null;
  policyRef: string | null;
  problem: string;
  outcome: string;
  users: string | null;
  constraints: string[];
  outOfScope: string[];
  acceptance: string[];
  openQuestions: string[];
  /** Budget de pas du modèle. Aucun plafond global de contexte (décision #4). */
  budgets: { maxSteps: number };
}

export interface Approval {
  fingerprint: string;
  by: ApprovalAuthority;
  at: string;
}

export interface ContractRecord {
  schema: typeof CONTRACT_SCHEMA;
  status: ContractStatus;
  fingerprint: string;
  contract: MissionContract;
  approval: Approval | null;
  /** Consommation persistante du budget, hors empreinte. */
  usage: { steps: number };
  updatedAt: string;
}

export type ReadFailure =
  | { state: "unreadable"; reason: string }
  | { state: "unknown-schema"; schema: unknown };

export type ContractRead = { state: "absent" } | ReadFailure | { state: "ok"; record: ContractRecord };

export type ProofInput =
  | { type: "contract"; fingerprint: string; id: string; status: ContractStatus; reason?: string }
  | { type: "approval"; fingerprint: string; by: ApprovalAuthority }
  // Lecture d'une fiche de méthode installée (#30) : son nom et l'empreinte
  // du contenu servi, liés à l'empreinte du contrat de la session.
  | { type: "fiche"; fingerprint: string; name: string; sha256: string }
  // Les champs d'un verdict sont fixés par #9 ; seule l'enveloppe est
  // contrôlée ici.
  | { type: "verdict"; [key: string]: unknown };

export type ProofEvent = ProofInput & { schema: typeof PROOF_SCHEMA; at: string };

export type ProofsRead =
  | { state: "absent" }
  | ReadFailure
  | { state: "ok"; events: ProofEvent[] }
  | { state: "truncated-tail"; events: ProofEvent[]; tail: string };

/** Un contrat soumis ou stocké qui ne respecte pas la grammaire. */
export class ContractError extends Error {}

/** Une écriture refusée parce que le stockage n'est pas dans un état sain. */
export class HarnessStoreError extends Error {
  constructor(readonly state: "unreadable" | "truncated-tail", message: string) {
    super(message);
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TEXT_MAX = 2000;
const ITEM_MAX = 500;
const ITEMS_MAX = 20;
const REF_MAX = 200;
const MAX_STEPS = 100_000;
const BODY_FIELDS = ["id", "title", "workspace", "baseRevision", "policyRef", "problem", "outcome", "users", "constraints", "outOfScope", "acceptance", "openQuestions", "budgets"];
const RECORD_FIELDS = ["schema", "status", "fingerprint", "contract", "approval", "usage", "updatedAt"];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** SHA-256 du chemin réel du workspace, tronqué à seize caractères
 * hexadécimaux : stable à travers les liens symboliques. */
export function workspaceFingerprint(workspace: string): string {
  return sha256(fs.realpathSync.native(workspace)).slice(0, 16);
}

export function harnessDir(workspace: string, dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "harness", workspaceFingerprint(workspace));
}

function onlyFields(obj: Record<string, unknown>, allowed: string[], prefix = ""): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ContractError(`unknown field "${prefix}${key}"`);
  }
}

function text(obj: Record<string, unknown>, key: string, required: boolean, max = TEXT_MAX): string | null {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new ContractError(`field "${key}" is required`);
    return null;
  }
  if (typeof v !== "string" || !v.trim()) throw new ContractError(`field "${key}" must be a non-empty string`);
  if (v.length > max) throw new ContractError(`field "${key}" exceeds ${max} characters`);
  return v.trim();
}

function list(obj: Record<string, unknown>, key: string, required: boolean): string[] {
  const v = obj[key];
  if (v === undefined) {
    if (required) throw new ContractError(`field "${key}" is required`);
    return [];
  }
  if (!Array.isArray(v) || v.length > ITEMS_MAX) throw new ContractError(`field "${key}" must be a list of at most ${ITEMS_MAX} items`);
  if (required && !v.length) throw new ContractError(`field "${key}" needs at least one item`);
  return v.map((item, i) => {
    if (typeof item !== "string" || !item.trim() || item.length > ITEM_MAX) {
      throw new ContractError(`field "${key}" item ${i + 1} must be a non-empty string of at most ${ITEM_MAX} characters`);
    }
    return item.trim();
  });
}

/** Corps du contrat, normalisé. `workspaceReal` : le chemin réel attendu
 * (contrat soumis) ; null pour un contrat déjà stocké. */
function parseBody(raw: unknown, workspaceReal: string | null): MissionContract {
  if (!isObject(raw)) throw new ContractError("the contract must be a JSON object");
  onlyFields(raw, BODY_FIELDS);
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ContractError('field "id" must be 1-64 letters, digits, ".", "_" or "-"');
  let workspace: string;
  if (workspaceReal === null) {
    if (typeof raw.workspace !== "string" || !path.isAbsolute(raw.workspace)) throw new ContractError('field "workspace" must be an absolute path');
    workspace = raw.workspace;
  } else {
    if (raw.workspace !== undefined) {
      let given = "";
      try {
        given = typeof raw.workspace === "string" ? fs.realpathSync.native(raw.workspace) : "";
      } catch {
        /* chemin absent : refusé ci-dessous */
      }
      if (given !== workspaceReal) throw new ContractError(`field "workspace" names another folder than the session workspace (${workspaceReal})`);
    }
    workspace = workspaceReal;
  }
  const budgets = raw.budgets;
  if (!isObject(budgets)) throw new ContractError('field "budgets" is required: {"maxSteps": <whole number>}');
  onlyFields(budgets, ["maxSteps"], "budgets.");
  const maxSteps = budgets.maxSteps;
  if (typeof maxSteps !== "number" || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS) {
    throw new ContractError(`field "budgets.maxSteps" must be a whole number from 1 to ${MAX_STEPS}`);
  }
  return {
    id,
    title: text(raw, "title", true, REF_MAX)!,
    workspace,
    baseRevision: text(raw, "baseRevision", false, REF_MAX),
    policyRef: text(raw, "policyRef", false, REF_MAX),
    problem: text(raw, "problem", true)!,
    outcome: text(raw, "outcome", true)!,
    users: text(raw, "users", false),
    constraints: list(raw, "constraints", false),
    outOfScope: list(raw, "outOfScope", false),
    acceptance: list(raw, "acceptance", true),
    openQuestions: list(raw, "openQuestions", false),
    budgets: { maxSteps },
  };
}

/** Contrat soumis par l'appelant (déjà lu depuis son fichier). */
export function parseContractSource(raw: unknown, workspaceReal: string): MissionContract {
  if (!isObject(raw)) throw new ContractError("the contract must be a JSON object");
  const { schema, ...body } = raw;
  if (schema !== CONTRACT_SCHEMA) throw new ContractError(`unknown contract schema ${JSON.stringify(schema)}: expected "${CONTRACT_SCHEMA}"`);
  return parseBody(body, workspaceReal);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Empreinte du contrat : SHA-256 de sa forme canonique (clés triées). */
export function contractFingerprint(contract: MissionContract): string {
  return sha256(canonical(contract));
}

export function createRecord(
  contract: MissionContract,
  opts: { status?: ContractStatus; approval?: Approval | null; steps?: number } = {}
): ContractRecord {
  return {
    schema: CONTRACT_SCHEMA,
    status: opts.status ?? "proposed",
    fingerprint: contractFingerprint(contract),
    contract,
    approval: opts.approval ?? null,
    usage: { steps: opts.steps ?? 0 },
    updatedAt: new Date().toISOString(),
  };
}

function parseApproval(raw: unknown): Approval | null {
  if (raw === null) return null;
  if (!isObject(raw)) throw new ContractError('field "approval" must be null or an object');
  onlyFields(raw, ["fingerprint", "by", "at"], "approval.");
  if (typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint)) throw new ContractError('field "approval.fingerprint" must be 64 hexadecimal characters');
  if (!APPROVAL_AUTHORITIES.includes(raw.by as ApprovalAuthority)) throw new ContractError(`field "approval.by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) throw new ContractError('field "approval.at" must be a date');
  return { fingerprint: raw.fingerprint, by: raw.by as ApprovalAuthority, at: raw.at };
}

function parseRecord(raw: Record<string, unknown>): ContractRecord {
  onlyFields(raw, RECORD_FIELDS);
  if (!CONTRACT_STATUSES.includes(raw.status as ContractStatus)) throw new ContractError(`field "status" must be one of ${CONTRACT_STATUSES.join(", ")}`);
  if (typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint)) throw new ContractError('field "fingerprint" must be 64 hexadecimal characters');
  const usage = raw.usage;
  if (!isObject(usage) || !Number.isSafeInteger(usage.steps) || (usage.steps as number) < 0) throw new ContractError('field "usage.steps" must be a whole number');
  onlyFields(usage, ["steps"], "usage.");
  if (typeof raw.updatedAt !== "string") throw new ContractError('field "updatedAt" must be a date');
  return {
    schema: CONTRACT_SCHEMA,
    status: raw.status as ContractStatus,
    fingerprint: raw.fingerprint,
    contract: parseBody(raw.contract, null),
    approval: parseApproval(raw.approval),
    usage: { steps: usage.steps as number },
    updatedAt: raw.updatedAt,
  };
}

type Bounded = { state: "absent" } | { state: "unreadable"; reason: string } | { state: "ok"; text: string };

function readBounded(file: string, max: number): Bounded {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: String(err?.message ?? err) };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size > max) return { state: "unreadable", reason: `${file} exceeds the ${max}-byte read bound (${size} bytes)` };
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { state: "ok", text: buf.subarray(0, read).toString("utf8") };
  } catch (err: any) {
    return { state: "unreadable", reason: String(err?.message ?? err) };
  } finally {
    fs.closeSync(fd);
  }
}

export function readContract(dir: string): ContractRead {
  const raw = readBounded(path.join(dir, CONTRACT_FILE), MAX_CONTRACT_BYTES);
  if (raw.state !== "ok") return raw;
  let data: unknown;
  try {
    data = JSON.parse(raw.text);
  } catch (err: any) {
    return { state: "unreadable", reason: `${CONTRACT_FILE} is not valid JSON (${err?.message ?? err})` };
  }
  if (!isObject(data)) return { state: "unreadable", reason: `${CONTRACT_FILE} is not a JSON object` };
  if (data.schema !== CONTRACT_SCHEMA) return { state: "unknown-schema", schema: data.schema };
  try {
    return { state: "ok", record: parseRecord(data) };
  } catch (err: any) {
    return { state: "unreadable", reason: `${CONTRACT_FILE}: ${err?.message ?? err}` };
  }
}

/** Écriture atomique (fichier temporaire puis renommage, motif de
 * src/web/store.ts). Un enregistrement invalide n'est jamais écrit. */
export function writeContract(dir: string, record: ContractRecord): void {
  const checked = parseRecord(JSON.parse(JSON.stringify(record)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, CONTRACT_FILE), JSON.stringify(checked, null, 2) + "\n");
}

/** Ce que l'enregistrement autorise réellement. `stale` : les empreintes ne
 * correspondent plus au contenu (contrat modifié après approbation) — la
 * péremption se constate, elle n'est jamais un champ stocké. */
export function approvalState(record: ContractRecord): "approved" | "proposed" | "expired" | "stale" {
  const actual = contractFingerprint(record.contract);
  if (record.fingerprint !== actual) return "stale";
  if (record.status === "expired") return "expired";
  if (record.status === "proposed") return "proposed";
  return record.approval?.fingerprint === actual ? "approved" : "stale";
}

function checkEvent(event: Record<string, unknown>): void {
  if (!PROOF_TYPES.includes(event.type as (typeof PROOF_TYPES)[number])) throw new ContractError(`unknown proof event type ${JSON.stringify(event.type)}`);
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) throw new ContractError('proof field "at" must be a date');
  if (event.type === "verdict") return;
  if (typeof event.fingerprint !== "string" || !HEX64.test(event.fingerprint)) throw new ContractError('proof field "fingerprint" must be 64 hexadecimal characters');
  if (event.type === "contract") {
    onlyFields(event, ["schema", "type", "at", "fingerprint", "id", "status", "reason"]);
    if (typeof event.id !== "string" || !ID_RE.test(event.id)) throw new ContractError('proof field "id" is invalid');
    if (!CONTRACT_STATUSES.includes(event.status as ContractStatus)) throw new ContractError('proof field "status" is invalid');
    if (event.reason !== undefined && (typeof event.reason !== "string" || event.reason.length > REF_MAX)) throw new ContractError('proof field "reason" is invalid');
  } else if (event.type === "fiche") {
    onlyFields(event, ["schema", "type", "at", "fingerprint", "name", "sha256"]);
    if (typeof event.name !== "string" || !FICHE_NAME_RE.test(event.name)) throw new ContractError('proof field "name" must be a method sheet name');
    if (typeof event.sha256 !== "string" || !HEX64.test(event.sha256)) throw new ContractError('proof field "sha256" must be 64 hexadecimal characters');
  } else {
    onlyFields(event, ["schema", "type", "at", "fingerprint", "by"]);
    if (!APPROVAL_AUTHORITIES.includes(event.by as ApprovalAuthority)) throw new ContractError(`proof field "by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
  }
}

/** Ajoute une ligne au journal. Refuse d'écrire derrière une ligne finale
 * tronquée : la nouvelle ligne serait collée à l'ancienne et illisible. */
export function appendProof(dir: string, input: ProofInput): ProofEvent {
  const { type, ...rest } = input as { type: string } & Record<string, unknown>;
  const event = { schema: PROOF_SCHEMA, type, at: new Date().toISOString(), ...rest } as Record<string, unknown>;
  checkEvent(event);
  const file = path.join(dir, PROOFS_FILE);
  const line = JSON.stringify(event) + "\n";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new HarnessStoreError("unreadable", `${file}: ${err?.message ?? err}`);
  }
  if (size > 0) {
    const last = Buffer.alloc(1);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, last, 0, 1, size - 1);
    } finally {
      fs.closeSync(fd);
    }
    if (last[0] !== 0x0a) throw new HarnessStoreError("truncated-tail", `${file} ends with a truncated line (truncated-tail): repair it by hand before anything else is recorded`);
  }
  if (size + Buffer.byteLength(line) > MAX_PROOFS_BYTES) throw new HarnessStoreError("unreadable", `${file} would exceed its ${MAX_PROOFS_BYTES}-byte read bound`);
  fs.appendFileSync(file, line);
  return event as ProofEvent;
}

// ---- policy.json : la politique d'accès du profil mission (ticket #11) ----
//
// Écrite par l'hôte (la politique par défaut du profil, à la préparation) ou
// par l'appelant de confiance, à la main ; jamais par un outil du modèle ni
// par un fichier du workspace. Schéma fermé, tous les champs obligatoires :
// une politique partielle est illisible, pas complétée en silence. Seules
// exceptions, `network` (#16), puis `tools`, `git` et `listen` (#17) : leur
// absence vaut la valeur la plus stricte (rien d'accordé) et laisse intacte
// la version des politiques écrites avant eux ; ils ne règlent que le bac des
// commandes isolées, jamais les outils de fichiers du modèle. Aucune valeur
// ne peut rendre le profil plus large que le sandbox courant : pas de règle
// « tout autoriser » pour les commandes, et les chemins de `paths` restent
// confinés au workspace quoi que dise la politique. Sa
// version est son empreinte : elle se constate, elle n'est jamais un champ
// modifiable.

export const POLICY_SCHEMA = "smolcoder/policy/v1";
export const POLICY_FILE = "policy.json";
export const MAX_POLICY_BYTES = 64 * 1024;
/** `workspace` : une commande qui reste dans le workspace passe, une commande
 * qui en sort exige une décision humaine (la règle du sandbox courant) ;
 * `ask` : toute commande exige une décision humaine ; `deny` : aucune. */
export const POLICY_RULES = ["workspace", "ask", "deny"] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

export interface AccessPolicy {
  /** Motifs d'un seul nom de fichier ou de dossier (joker `*`). */
  paths: { protect: string[]; except: string[] };
  /** run_command, vérifications automatiques et terminal web. */
  commands: PolicyRule;
  /** task.start : tâches de fond persistantes. */
  tasks: PolicyRule;
  /** Variables d'environnement transmises nommément aux sous-processus, en
   * plus de PATH, HOME, TERM et LANG. */
  env: string[];
  /** Destinations réseau que le backend isolé (#16) laisse joindre, de la
   * forme `localhost:<port>` : Seatbelt ne sait pas filtrer un hôte distant
   * (docs/decision-backend-isole.md). Absent : aucune. */
  network?: string[];
  /** Dossiers absolus hors du workspace dont les commandes isolées lisent le
   * contenu, jamais l'écrivent : node installé sous le dossier personnel,
   * cache npm d'une installation hors ligne, dossier git d'un worktree
   * (docs/allowlist-outils.md). Absent : aucun. */
  tools?: string[];
  /** `read` : le contenu de `.git` devient lisible par les commandes isolées,
   * jamais modifiable (ni commit, ni index, ni hook). Absent : `.git` suit
   * `paths`. */
  git?: "read";
  /** Ports sur lesquels les commandes isolées peuvent écouter, de la forme
   * `localhost:<port>` ; joignables du réseau local si le programme écoute
   * sur toutes les interfaces (docs/allowlist-outils.md). Absent : aucun. */
  listen?: string[];
}

/** La politique par défaut du profil : celle du sandbox courant, en plus
 * strict (secrets et métadonnées Git protégés, tâches de fond soumises à
 * décision humaine), jamais en plus large. */
export const DEFAULT_POLICY: AccessPolicy = {
  paths: { protect: [".env", ".env.*", ".git"], except: [".env.example"] },
  commands: "workspace",
  tasks: "ask",
  env: [],
};

export type PolicyRead = { state: "absent" } | ReadFailure | { state: "ok"; policy: AccessPolicy; version: string };

const POLICY_FIELDS = ["schema", "paths", "commands", "tasks", "env", "network", "tools", "git", "listen"];
const OPTIONAL_POLICY_FIELDS = ["schema", "network", "tools", "git", "listen"];
const PATTERN_RE = /^[^\\/\x00]{1,100}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const POLICY_ITEMS_MAX = 50;
const TOOL_PATH_MAX = 1024;

/** Un dossier d'outils : chemin absolu écrit sous sa forme normale (ni `..`,
 * ni `//`, ni barre finale), jamais la racine, sans caractère de contrôle.
 * Grammaire partagée avec le profil Seatbelt. */
export function isToolFolder(v: unknown): v is string {
  return typeof v === "string" && v.length <= TOOL_PATH_MAX && v !== "/" && path.posix.isAbsolute(v) && path.posix.normalize(v) === v && !v.endsWith("/") && !/[\x00-\x1f\x7f]/.test(v);
}

/** Une destination réseau nommée : `localhost:<port>`, port de 1 à 65535
 * écrit sans zéro de tête. Grammaire partagée avec le profil Seatbelt. */
export function isNetworkDestination(v: unknown): v is string {
  const m = typeof v === "string" ? /^localhost:([1-9][0-9]{0,4})$/.exec(v) : null;
  return !!m && Number(m[1]) <= 65535;
}

function patterns(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.length > POLICY_ITEMS_MAX) throw new ContractError(`policy field "paths.${key}" must be a list of at most ${POLICY_ITEMS_MAX} names`);
  return v.map((item, i) => {
    if (typeof item !== "string" || !PATTERN_RE.test(item) || item === "." || item === ".." || !item.trim()) {
      throw new ContractError(`policy field "paths.${key}" item ${i + 1} must be one file or folder name (\`*\` allowed, no "/")`);
    }
    return item;
  });
}

function rule(obj: Record<string, unknown>, key: string): PolicyRule {
  if (!POLICY_RULES.includes(obj[key] as PolicyRule)) throw new ContractError(`policy field "${key}" must be one of ${POLICY_RULES.join(", ")}`);
  return obj[key] as PolicyRule;
}

/** Corps de la politique (sans `schema`), normalisé. */
function parsePolicyBody(raw: Record<string, unknown>): AccessPolicy {
  onlyFields(raw, POLICY_FIELDS);
  for (const key of POLICY_FIELDS) if (!OPTIONAL_POLICY_FIELDS.includes(key) && raw[key] === undefined) throw new ContractError(`policy field "${key}" is required`);
  const paths = raw.paths;
  if (!isObject(paths)) throw new ContractError('policy field "paths" must be {"protect": [...], "except": [...]}');
  onlyFields(paths, ["protect", "except"], "paths.");
  const env = raw.env;
  if (!Array.isArray(env) || env.length > POLICY_ITEMS_MAX || !env.every((n) => typeof n === "string" && ENV_NAME_RE.test(n))) {
    throw new ContractError(`policy field "env" must be a list of at most ${POLICY_ITEMS_MAX} environment variable names`);
  }
  const network = raw.network;
  if (network !== undefined && (!Array.isArray(network) || network.length > POLICY_ITEMS_MAX || !network.every(isNetworkDestination))) {
    throw new ContractError(`policy field "network" must be a list of at most ${POLICY_ITEMS_MAX} destinations "localhost:<port>" (port 1-65535): the isolated backend cannot filter a remote host`);
  }
  const { tools, git, listen } = raw;
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > POLICY_ITEMS_MAX || !tools.every(isToolFolder))) {
    throw new ContractError(`policy field "tools" must be a list of at most ${POLICY_ITEMS_MAX} absolute folders written in normal form (no "..", no trailing "/", not "/")`);
  }
  if (git !== undefined && git !== "read") throw new ContractError('policy field "git" must be "read" (git may read .git, never write it) or absent');
  if (listen !== undefined && (!Array.isArray(listen) || listen.length > POLICY_ITEMS_MAX || !listen.every(isNetworkDestination))) {
    throw new ContractError(`policy field "listen" must be a list of at most ${POLICY_ITEMS_MAX} ports "localhost:<port>" (port 1-65535)`);
  }
  return {
    paths: { protect: patterns(paths, "protect"), except: patterns(paths, "except") },
    commands: rule(raw, "commands"),
    tasks: rule(raw, "tasks"),
    env: env as string[],
    // Absents : absents aussi du résultat, pour que l'empreinte ne change pas.
    ...(network !== undefined ? { network: network as string[] } : {}),
    ...(tools !== undefined ? { tools: tools as string[] } : {}),
    ...(git !== undefined ? { git: "read" as const } : {}),
    ...(listen !== undefined ? { listen: listen as string[] } : {}),
  };
}

/** Version citée par chaque décision : schéma et empreinte du contenu. */
export function policyVersion(policy: AccessPolicy): string {
  return `${POLICY_SCHEMA}@${sha256(canonical(policy)).slice(0, 16)}`;
}

export function readPolicy(dir: string): PolicyRead {
  const raw = readBounded(path.join(dir, POLICY_FILE), MAX_POLICY_BYTES);
  if (raw.state !== "ok") return raw;
  let data: unknown;
  try {
    data = JSON.parse(raw.text);
  } catch (err: any) {
    return { state: "unreadable", reason: `${POLICY_FILE} is not valid JSON (${err?.message ?? err})` };
  }
  if (!isObject(data)) return { state: "unreadable", reason: `${POLICY_FILE} is not a JSON object` };
  if (data.schema !== POLICY_SCHEMA) return { state: "unknown-schema", schema: data.schema };
  try {
    const policy = parsePolicyBody(data);
    return { state: "ok", policy, version: policyVersion(policy) };
  } catch (err: any) {
    return { state: "unreadable", reason: `${POLICY_FILE}: ${err?.message ?? err}` };
  }
}

/** Écriture atomique ; une politique invalide n'est jamais écrite. */
export function writePolicy(dir: string, policy: AccessPolicy): void {
  const checked = parsePolicyBody({ schema: POLICY_SCHEMA, ...JSON.parse(JSON.stringify(policy)) });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, POLICY_FILE), JSON.stringify({ schema: POLICY_SCHEMA, ...checked }, null, 2) + "\n");
}

export function readProofs(dir: string): ProofsRead {
  const raw = readBounded(path.join(dir, PROOFS_FILE), MAX_PROOFS_BYTES);
  if (raw.state !== "ok") return raw;
  const lines = raw.text.split("\n");
  const tail = lines.pop() ?? ""; // "" quand le fichier finit par un saut de ligne
  const events: ProofEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let data: unknown;
    try {
      data = JSON.parse(lines[i]);
    } catch {
      return { state: "unreadable", reason: `${PROOFS_FILE} line ${i + 1} is not valid JSON` };
    }
    if (!isObject(data) || data.schema !== PROOF_SCHEMA) return { state: "unknown-schema", schema: isObject(data) ? data.schema : undefined };
    if (!PROOF_TYPES.includes(data.type as (typeof PROOF_TYPES)[number])) return { state: "unknown-schema", schema: `${PROOF_SCHEMA} type ${JSON.stringify(data.type)}` };
    try {
      checkEvent(data);
    } catch (err: any) {
      return { state: "unreadable", reason: `${PROOFS_FILE} line ${i + 1}: ${err?.message ?? err}` };
    }
    events.push(data as ProofEvent);
  }
  return tail ? { state: "truncated-tail", events, tail } : { state: "ok", events };
}
