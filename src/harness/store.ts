// Stockage hôte du harnais — seul module propriétaire de la grammaire de
// ~/.smolcoder/harness/<empreinte-du-workspace>/ (docs/decision-stockage-hote.md) :
// contract.json (le contrat de mission, et depuis #9 les entrées du
// vérificateur figées par l'approbation, depuis #29 l'empreinte du plan
// approuvé avec lui), proofs.jsonl (journal en ajout seul, cinq types
// d'événements, `fiche` ajouté par #30 et `plan` par #29 en amendements de
// la décision, champs de `verdict` fixés par #9), policy.json (la politique
// d'accès du profil, ticket #11), et report.json / report.md (#9), deux
// projections regénérées à chaque tour, jamais relues par le code. Schéma versionné, statuts fermés,
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
export const PROOF_TYPES = ["contract", "approval", "verdict", "fiche", "plan", "effect"] as const;

/** Statut d'un critère d'acceptation (#9, docs/decision-preuves-acceptation.md).
 * `passed` : contrôle exécuté, sorti de lui-même avec 0, au moins un test
 * exécuté s'il le dit, vérificateur intact ; `failed` : exécuté, sorti avec un
 * code non nul ; `not_run` : non exécuté, sauté, zéro test ; `error` : le
 * vérificateur lui-même a échoué (délai, arrêt par un signal, lancement
 * impossible). Aucun autre cas ne donne `passed`. */
export const CRITERION_STATUSES = ["passed", "failed", "not_run", "error"] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];
/** Motifs fermés d'un statut. Ceux du journal décrivent un contrôle ; le
 * rapport ajoute `not-covered`, `not-run` et `stale`, qui décrivent une
 * absence ou une péremption constatée à sa génération. */
export const VERDICT_CAUSES = [
  "exit-code", "zero-tests", "missing-script", "policy", "verifier-changed", "verifier-unfrozen",
  "timeout", "crashed", "spawn-error", "no-isolation", "verifier-changed-during-check", "fingerprint-unavailable",
  "journal-unwritable", "not-covered", "not-run", "stale", "cancelled",
] as const;
export type VerdictCause = (typeof VERDICT_CAUSES)[number];
/** Qui fournit la commande d'un contrôle : le contrat, l'appelant (--verify)
 * ou la découverte des scripts du projet. */
export const CHECK_OWNERS = ["contract", "caller", "project"] as const;
export type CheckOwner = (typeof CHECK_OWNERS)[number];
const EXEC_STATUSES = ["exited", "signaled", "timeout", "cancelled", "spawn_error"];
export const CRITERION_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/** Un contrôle de l'hôte qui couvre des critères du contrat (numéros à partir
 * de 1 dans `acceptance`). Chaque critère est couvert par un contrôle au plus. */
export interface ContractCheck {
  command: string;
  covers: number[];
  /** Délai du contrôle ; absent : celui des vérifications (120 s). */
  timeoutSeconds?: number;
}

/** Les entrées du vérificateur figées à l'approbation (#9) : chemin relatif
 * vers l'empreinte SHA-256 de son contenu, null pour un script nommé absent.
 * `digest` est l'empreinte de `files` ; `commands`, les commandes dont les
 * scripts nommés ont été suivis. */
export interface VerifierFreeze {
  digest: string;
  files: Record<string, string | null>;
  commands: string[];
}

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
  /** Contrôles de l'hôte qui couvrent des critères (#9). Absent : aucun
   * critère n'est couvert, et l'empreinte des contrats antérieurs ne change pas. */
  checks?: ContractCheck[];
  /** `required` (#29) : l'hôte n'approuve ce contrat qu'avec un plan
   * d'implémentation. Absent : plan facultatif, empreinte inchangée. */
  plan?: typeof PLAN_REQUIRED;
}

export interface Approval {
  fingerprint: string;
  by: ApprovalAuthority;
  at: string;
  /** Entrées du vérificateur figées par cette approbation (#9). Absent ou
   * null : non figées (approbation antérieure à #9, ou bornes dépassées). */
  verifiers?: VerifierFreeze | null;
  /** Empreinte du plan d'implémentation approuvé avec le contrat (#29).
   * Absent : contrat approuvé sans plan. */
  plan?: string;
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

/** Le verdict d'un contrôle décisif (#9), champs fermés : l'empreinte du
 * contrat, les critères couverts, la commande et son origine, le statut et
 * son motif, l'issue réelle du processus, le nombre de tests exécutés quand
 * le lanceur le dit, l'empreinte des entrées du vérificateur (figées à
 * l'approbation) et celle des fichiers vérifiés, constatée après le contrôle. */
export interface VerdictInput {
  type: "verdict";
  fingerprint: string;
  criteria: string[];
  command: string;
  owner: CheckOwner;
  status: CriterionStatus;
  cause: VerdictCause | null;
  attempt: number;
  exit: { status: string; code: number | null; signal: string | null; durationMs: number } | null;
  tests: number | null;
  verifiers: string | null;
  files: string | null;
  /** Entrées du vérificateur changées (motifs verifier-changed…), 50 au plus. */
  changes?: string[];
}

/** Plan d'implémentation proposé par l'agent avant approbation (#29) : le
 * contenu entier et son empreinte, liés à l'empreinte du contrat. */
export interface PlanProposedInput {
  type: "plan";
  fingerprint: string;
  kind: "proposed";
  plan: string;
  content: PlanContent;
}

/** Un écart au plan approuvé (#29), constaté après approbation : un fichier
 * écrit hors du plan (`file` : `before` vide, `after` le chemin écrit) ou une
 * rubrique du plan réécrite par l'agent (`steps`, `files`, `risks`, `proofs` :
 * la rubrique avant et après, les preuves en lignes « N: preuve »), avec le
 * motif que l'agent en donne, ou null. Jamais un refus : une trace. */
export interface PlanDeviationInput {
  type: "plan";
  fingerprint: string;
  kind: "deviation";
  plan: string;
  change: PlanChange;
  before: string[];
  after: string[];
  reason: string | null;
}

export type PlanInput = PlanProposedInput | PlanDeviationInput;

// ---- journal d'effets (ticket #10) ----
//
// Chaque action du modèle qui a un effet sur le projet (écriture de fichier,
// commande, tâche de fond lancée) est enregistrée avec un identifiant AVANT
// l'effet (`intent`), puis son résultat observé APRÈS (`result`). Au
// redémarrage, une intention sans résultat devient `uncertain`, enregistré
// par l'hôte avec ce que les fichiers en disent ; seul l'hôte (humain au
// terminal ou dans la page web, appelant headless) la résout (`resolved`).
// Le modèle n'écrit jamais ici : aucune phrase ne résout un état incertain.

/** Les outils dont les appels sont des effets. `task` : seulement `start`. */
export const EFFECT_TOOLS = ["write_file", "edit_file", "run_command", "task"] as const;
export type EffectTool = (typeof EFFECT_TOOLS)[number];
export const EFFECT_KINDS = ["intent", "result", "uncertain", "resolved"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
/** Ce que les fichiers disent d'une intention sans résultat : le fichier est
 * tel qu'avant l'action (`before`), tel que l'action l'aurait laissé
 * (`expected`), ni l'un ni l'autre (`neither`), ou rien (`none` : commande). */
export const EFFECT_EVIDENCE = ["before", "expected", "neither", "none"] as const;
export type EffectEvidence = (typeof EFFECT_EVIDENCE)[number];
export const EFFECT_ID_RE = /^[0-9a-f]{12}$/;
const OBSERVED_MAX = 300;
const CALL_ID_MAX = 128;

/** Une action enregistrée avant son effet. Fichier : `path` (relatif au
 * workspace), l'empreinte `before` du contenu d'avant (null : absent) et celle
 * du contenu `expected` que l'écriture laissera (null : inconnue, edit_file).
 * Commande ou tâche : `command`. `session` : la session qui agit ; `call` :
 * l'identifiant de l'appel d'outil dans le transcript. */
export interface EffectIntentInput {
  type: "effect";
  fingerprint: string;
  kind: "intent";
  id: string;
  session: string;
  call: string;
  tool: EffectTool;
  path?: string;
  before?: string | null;
  expected?: string | null;
  command?: string;
}

export type EffectInput =
  | EffectIntentInput
  // Le résultat observé : `ok` ou `error` selon le retour de l'outil, sa
  // première ligne, et pour un fichier l'empreinte constatée après (null : absent).
  | { type: "effect"; fingerprint: string; kind: "result"; id: string; status: "ok" | "error"; observed: string; after?: string | null }
  // Constaté par l'hôte au redémarrage : aucune conclusion, seulement ce que
  // les fichiers disent, et l'empreinte actuelle du fichier visé.
  | { type: "effect"; fingerprint: string; kind: "uncertain"; id: string; evidence: EffectEvidence; current?: string | null }
  // La décision de l'hôte : l'état actuel du workspace est accepté comme base.
  | { type: "effect"; fingerprint: string; kind: "resolved"; id: string; by: ApprovalAuthority };

export type ProofInput =
  | { type: "contract"; fingerprint: string; id: string; status: ContractStatus; reason?: string }
  | EffectInput
  // `verifiers` (#9) : l'empreinte des entrées du vérificateur figées par
  // cette approbation ; null quand elles n'ont pas pu l'être. `plan` (#29) :
  // l'empreinte du plan approuvé avec le contrat, absente sans plan.
  | { type: "approval"; fingerprint: string; by: ApprovalAuthority; verifiers?: string | null; plan?: string }
  // Lecture d'une fiche de méthode installée (#30) : son nom et l'empreinte
  // du contenu servi, liés à l'empreinte du contrat de la session.
  | { type: "fiche"; fingerprint: string; name: string; sha256: string }
  | PlanInput
  | VerdictInput;

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
const BODY_FIELDS = ["id", "title", "workspace", "baseRevision", "policyRef", "problem", "outcome", "users", "constraints", "outOfScope", "acceptance", "openQuestions", "budgets", "checks", "plan"];
const RECORD_FIELDS = ["schema", "status", "fingerprint", "contract", "approval", "usage", "updatedAt"];
const MAX_CHECK_SECONDS = 3600;
/** Bornes des entrées figées : elles tiennent dans contract.json (256 Kio). */
export const MAX_VERIFIER_FILES = 1000;
const VERIFIER_PATH_MAX = 1024;
const VERIFIER_COMMANDS_MAX = 30;
const CHANGES_MAX = 50;
const CRITERIA_MAX = 50;

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
  const acceptance = list(raw, "acceptance", true);
  const checks = raw.checks === undefined ? undefined : parseChecks(raw.checks, acceptance.length);
  if (raw.plan !== undefined && raw.plan !== PLAN_REQUIRED) {
    throw new ContractError(`field "plan" must be "${PLAN_REQUIRED}" (the host approves the contract only with an implementation plan) or absent (the plan is optional)`);
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
    acceptance,
    openQuestions: list(raw, "openQuestions", false),
    budgets: { maxSteps },
    // Absents : absents aussi du résultat, pour que l'empreinte ne change pas.
    ...(checks ? { checks } : {}),
    ...(raw.plan !== undefined ? { plan: PLAN_REQUIRED } : {}),
  };
}

/** Les contrôles de l'hôte (#9) : une commande, les critères qu'elle couvre
 * (numéros de `acceptance`, chacun couvert une fois au plus), un délai
 * facultatif. La commande est celle de l'appelant, jamais celle du modèle. */
function parseChecks(raw: unknown, criteria: number): ContractCheck[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > ITEMS_MAX) throw new ContractError(`field "checks" must be a list of 1 to ${ITEMS_MAX} checks`);
  const covered = new Set<number>();
  return raw.map((item, i) => {
    const where = `field "checks" item ${i + 1}`;
    if (!isObject(item)) throw new ContractError(`${where} must be {"command": "...", "covers": [1, ...]}`);
    onlyFields(item, ["command", "covers", "timeoutSeconds"], `checks[${i}].`);
    const command = item.command;
    if (typeof command !== "string" || !command.trim() || command.length > TEXT_MAX || /[\x00\r]/.test(command)) {
      throw new ContractError(`${where}: "command" must be a non-empty command of at most ${TEXT_MAX} characters`);
    }
    const covers = item.covers;
    if (!Array.isArray(covers) || !covers.length || covers.length > ITEMS_MAX) throw new ContractError(`${where}: "covers" must list the acceptance criteria it checks (numbers from 1)`);
    for (const n of covers) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > criteria) throw new ContractError(`${where}: "covers" names criterion ${JSON.stringify(n)}, but acceptance has ${criteria}`);
      if (covered.has(n)) throw new ContractError(`${where}: criterion ${n} is already covered by another check`);
      covered.add(n);
    }
    const t = item.timeoutSeconds;
    if (t !== undefined && (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1 || t > MAX_CHECK_SECONDS)) {
      throw new ContractError(`${where}: "timeoutSeconds" must be a whole number from 1 to ${MAX_CHECK_SECONDS}`);
    }
    return { command: command.trim(), covers: [...covers] as number[], ...(t !== undefined ? { timeoutSeconds: t as number } : {}) };
  });
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

/** Empreinte des entrées figées : SHA-256 de leur forme canonique. */
export function verifierDigest(files: Record<string, string | null>): string {
  return sha256(canonical(files));
}

/** Un chemin relatif du workspace, écrit à la façon POSIX, sans `..`. */
export function isRelativeWorkspacePath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= VERIFIER_PATH_MAX && !p.startsWith("/") && !/[\x00-\x1f\x7f\\]/.test(p) &&
    p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function parseVerifiers(raw: unknown): VerifierFreeze | null {
  if (raw === null) return null;
  if (!isObject(raw)) throw new ContractError('field "approval.verifiers" must be null or an object');
  onlyFields(raw, ["digest", "files", "commands"], "approval.verifiers.");
  const { digest, files, commands } = raw;
  if (!isObject(files) || Object.keys(files).length > MAX_VERIFIER_FILES) throw new ContractError(`field "approval.verifiers.files" must map at most ${MAX_VERIFIER_FILES} workspace paths`);
  for (const [p, v] of Object.entries(files)) {
    if (!isRelativeWorkspacePath(p)) throw new ContractError(`field "approval.verifiers.files" holds an invalid path ${JSON.stringify(p)}`);
    if (v !== null && (typeof v !== "string" || !HEX64.test(v))) throw new ContractError(`field "approval.verifiers.files" must map each path to a SHA-256 or null`);
  }
  if (!Array.isArray(commands) || commands.length > VERIFIER_COMMANDS_MAX || !commands.every((c) => typeof c === "string" && c.length <= TEXT_MAX)) {
    throw new ContractError('field "approval.verifiers.commands" must be a list of commands');
  }
  const map = files as Record<string, string | null>;
  if (typeof digest !== "string" || digest !== verifierDigest(map)) throw new ContractError('field "approval.verifiers.digest" does not match its files');
  return { digest, files: { ...map }, commands: [...(commands as string[])] };
}

function parseApproval(raw: unknown): Approval | null {
  if (raw === null) return null;
  if (!isObject(raw)) throw new ContractError('field "approval" must be null or an object');
  onlyFields(raw, ["fingerprint", "by", "at", "verifiers", "plan"], "approval.");
  if (typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint)) throw new ContractError('field "approval.fingerprint" must be 64 hexadecimal characters');
  if (!APPROVAL_AUTHORITIES.includes(raw.by as ApprovalAuthority)) throw new ContractError(`field "approval.by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) throw new ContractError('field "approval.at" must be a date');
  if (raw.plan !== undefined && (typeof raw.plan !== "string" || !HEX64.test(raw.plan))) throw new ContractError('field "approval.plan" must be 64 hexadecimal characters');
  const approval: Approval = { fingerprint: raw.fingerprint, by: raw.by as ApprovalAuthority, at: raw.at };
  if (raw.verifiers !== undefined) approval.verifiers = parseVerifiers(raw.verifiers);
  if (raw.plan !== undefined) approval.plan = raw.plan as string;
  return approval;
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

const hexOrNull = (v: unknown) => v === null || (typeof v === "string" && HEX64.test(v));
const wholeOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

/** Champs fermés d'un verdict (#9) : voir VerdictInput. */
function checkVerdict(event: Record<string, unknown>): void {
  onlyFields(event, ["schema", "type", "at", "fingerprint", "criteria", "command", "owner", "status", "cause", "attempt", "exit", "tests", "verifiers", "files", "changes"]);
  const bad = (field: string) => new ContractError(`proof field "${field}" of a verdict is invalid`);
  const { criteria, command, owner, status, cause, attempt, exit, tests, verifiers, files, changes } = event;
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > CRITERIA_MAX || !criteria.every((c) => typeof c === "string" && CRITERION_ID_RE.test(c))) throw bad("criteria");
  if (typeof command !== "string" || !command.trim() || command.length > TEXT_MAX) throw bad("command");
  if (!CHECK_OWNERS.includes(owner as CheckOwner)) throw bad("owner");
  if (!CRITERION_STATUSES.includes(status as CriterionStatus)) throw bad("status");
  if (cause !== null && !VERDICT_CAUSES.includes(cause as VerdictCause)) throw bad("cause");
  if ((status === "passed") !== (cause === null)) throw bad("cause");
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) throw bad("attempt");
  if (exit !== null) {
    if (!isObject(exit)) throw bad("exit");
    onlyFields(exit, ["status", "code", "signal", "durationMs"], "exit.");
    if (!EXEC_STATUSES.includes(exit.status as string)) throw bad("exit.status");
    if (exit.code !== null && (typeof exit.code !== "number" || !Number.isSafeInteger(exit.code))) throw bad("exit.code");
    if (exit.signal !== null && (typeof exit.signal !== "string" || !/^[A-Z0-9]{1,16}$/.test(exit.signal))) throw bad("exit.signal");
    if (!wholeOrNull(exit.durationMs) || exit.durationMs === null) throw bad("exit.durationMs");
  }
  if (!wholeOrNull(tests)) throw bad("tests");
  if (!hexOrNull(verifiers)) throw bad("verifiers");
  if (!hexOrNull(files)) throw bad("files");
  if (changes !== undefined && (!Array.isArray(changes) || changes.length > CHANGES_MAX || !changes.every((c) => typeof c === "string" && c.length <= VERIFIER_PATH_MAX + 20))) throw bad("changes");
}

/** Champs fermés d'un événement `effect` (#10). */
function checkEffectEvent(event: Record<string, unknown>): void {
  const bad = (field: string) => new ContractError(`proof field "${field}" of an effect event is invalid`);
  if (!EFFECT_KINDS.includes(event.kind as EffectKind)) throw bad("kind");
  if (typeof event.id !== "string" || !EFFECT_ID_RE.test(event.id)) throw bad("id");
  const line = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0a-\x1f\x7f]/.test(v);
  switch (event.kind) {
    case "intent": {
      onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "id", "session", "call", "tool", "path", "before", "expected", "command"]);
      if (typeof event.session !== "string" || !EFFECT_ID_RE.test(event.session)) throw bad("session");
      if (!line(event.call, CALL_ID_MAX)) throw bad("call");
      if (!EFFECT_TOOLS.includes(event.tool as EffectTool)) throw bad("tool");
      if (event.tool === "write_file" || event.tool === "edit_file") {
        if (!isRelativeWorkspacePath(event.path)) throw bad("path");
        if (!hexOrNull(event.before)) throw bad("before");
        if (!hexOrNull(event.expected)) throw bad("expected");
        if (event.command !== undefined) throw bad("command");
      } else {
        if (typeof event.command !== "string" || !event.command.trim() || event.command.length > TEXT_MAX) throw bad("command");
        if (event.path !== undefined || event.before !== undefined || event.expected !== undefined) throw bad("path");
      }
      return;
    }
    case "result":
      onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "id", "status", "observed", "after"]);
      if (event.status !== "ok" && event.status !== "error") throw bad("status");
      if (!line(event.observed, OBSERVED_MAX)) throw bad("observed");
      if (event.after !== undefined && !hexOrNull(event.after)) throw bad("after");
      return;
    case "uncertain":
      onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "id", "evidence", "current"]);
      if (!EFFECT_EVIDENCE.includes(event.evidence as EffectEvidence)) throw bad("evidence");
      if (event.current !== undefined && !hexOrNull(event.current)) throw bad("current");
      return;
    default:
      onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "id", "by"]);
      if (!APPROVAL_AUTHORITIES.includes(event.by as ApprovalAuthority)) throw bad("by");
  }
}

/** La première ligne d'un retour d'outil, sans caractère de contrôle, bornée. */
export function observedLine(output: string): string {
  const first = String(output ?? "").split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, OBSERVED_MAX);
}

function checkEvent(event: Record<string, unknown>): void {
  if (!PROOF_TYPES.includes(event.type as (typeof PROOF_TYPES)[number])) throw new ContractError(`unknown proof event type ${JSON.stringify(event.type)}`);
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) throw new ContractError('proof field "at" must be a date');
  if (typeof event.fingerprint !== "string" || !HEX64.test(event.fingerprint)) throw new ContractError('proof field "fingerprint" must be 64 hexadecimal characters');
  if (event.type === "verdict") return checkVerdict(event);
  if (event.type === "plan") return checkPlanEvent(event);
  if (event.type === "effect") return checkEffectEvent(event);
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
    onlyFields(event, ["schema", "type", "at", "fingerprint", "by", "verifiers", "plan"]);
    if (!APPROVAL_AUTHORITIES.includes(event.by as ApprovalAuthority)) throw new ContractError(`proof field "by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
    if (event.verifiers !== undefined && !hexOrNull(event.verifiers)) throw new ContractError('proof field "verifiers" must be 64 hexadecimal characters or null');
    if (event.plan !== undefined && (typeof event.plan !== "string" || !HEX64.test(event.plan))) throw new ContractError('proof field "plan" of an approval must be 64 hexadecimal characters');
  }
}

// ---- plan d'implémentation (ticket #29) ----
//
// Proposé par l'agent avant approbation, par l'outil plan, puis approuvé par
// l'hôte avec le contrat (l'empreinte du plan dans l'approbation). Le journal
// garde le contenu entier de chaque proposition — c'est là que se relit le
// plan approuvé — puis chaque écart constaté après approbation, avant et
// après : la version courante se reconstruit en les rejouant, sans jamais
// remplacer l'approuvée. Le plan est un guide, jamais une preuve ni une
// permission ; un écart n'est jamais un refus.

/** Seule valeur du champ `plan` du contrat : l'approbation exige un plan. */
export const PLAN_REQUIRED = "required";
export const PLAN_KINDS = ["proposed", "deviation"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
/** Ce qu'un écart change : un fichier écrit hors du plan, ou une rubrique. */
export const PLAN_CHANGES = ["file", "steps", "files", "risks", "proofs"] as const;
export type PlanChange = (typeof PLAN_CHANGES)[number];
const DEVIATION_ITEMS_MAX = 50;
const DEVIATION_ITEM_MAX = 1024;
const REASON_MAX = 500;

/** La preuve prévue d'un critère d'acceptation (numéro à partir de 1) :
 * une déclaration de l'agent, jamais un contrôle ni une preuve. */
export interface PlannedProof {
  criterion: number;
  proof: string;
}

/** Le contenu d'un plan : l'ordre des travaux (étapes), les fichiers à créer
 * ou modifier (chemins relatifs du workspace ; « dossier/ » vaut tout ce qu'il
 * contient), les risques et contraintes techniques, la preuve prévue par
 * critère. Ni l'état coché des étapes ni les notes de travail n'en font partie. */
export interface PlanContent {
  steps: string[];
  files: string[];
  risks: string[];
  proofs: PlannedProof[];
}

export const PLAN_STEPS_MAX = 20;
export const PLAN_FILES_MAX = 50;
const PLAN_PATH_MAX = 300;
const PLAN_FIELDS = ["steps", "files", "risks", "proofs"];

/** Un fichier du plan : chemin relatif du workspace à la façon POSIX, sans
 * `..` ; une barre finale désigne un dossier et tout ce qu'il contient. */
export function isPlanFile(p: unknown): p is string {
  if (typeof p !== "string" || p.length > PLAN_PATH_MAX) return false;
  return isRelativeWorkspacePath(p.endsWith("/") ? p.slice(0, -1) : p);
}

function planItems(raw: Record<string, unknown>, key: string, max: number, min: number): string[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    throw new ContractError(`plan field "${key}" must be a list of ${min ? `${min} to ` : "at most "}${max} items`);
  }
  return v.map((item, i) => {
    if (typeof item !== "string" || !item.trim() || item.length > ITEM_MAX || /[\x00-\x08\x0a-\x1f\x7f]/.test(item)) {
      throw new ContractError(`plan field "${key}" item ${i + 1} must be a non-empty line of at most ${ITEM_MAX} characters`);
    }
    return item;
  });
}

/** Contenu d'un plan, validé. `criteria` : nombre de critères du contrat
 * (null pour un contenu relu dans le journal, borné par ITEMS_MAX). */
export function parsePlanContent(raw: unknown, criteria: number | null): PlanContent {
  if (!isObject(raw)) throw new ContractError("the plan must be an object");
  onlyFields(raw, PLAN_FIELDS, "plan.");
  const steps = planItems(raw, "steps", PLAN_STEPS_MAX, 1);
  const files = planItems(raw, "files", PLAN_FILES_MAX, 1);
  for (const f of files) {
    if (!isPlanFile(f)) throw new ContractError(`plan field "files" names ${JSON.stringify(f)}, which is not a relative path inside the workspace (no "..", no leading "/", at most ${PLAN_PATH_MAX} characters)`);
  }
  if (new Set(files).size !== files.length) throw new ContractError('plan field "files" names a file twice');
  const risks = planItems(raw, "risks", ITEMS_MAX, 0);
  const proofs = raw.proofs;
  const bound = criteria ?? ITEMS_MAX;
  if (!Array.isArray(proofs) || proofs.length > bound) throw new ContractError(`plan field "proofs" must list at most one planned proof per acceptance criterion`);
  const seen = new Set<number>();
  const parsed = proofs.map((p, i) => {
    if (!isObject(p)) throw new ContractError(`plan field "proofs" item ${i + 1} must be {"criterion": <number>, "proof": "..."}`);
    onlyFields(p, ["criterion", "proof"], `plan.proofs[${i}].`);
    const n = p.criterion;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > bound) {
      throw new ContractError(`plan field "proofs" names criterion ${JSON.stringify(n)}, but the contract has ${bound} acceptance criteria`);
    }
    if (seen.has(n)) throw new ContractError(`plan field "proofs" gives criterion ${n} twice`);
    seen.add(n);
    if (typeof p.proof !== "string" || !p.proof.trim() || p.proof.length > ITEM_MAX || /[\x00-\x08\x0a-\x1f\x7f]/.test(p.proof)) throw new ContractError(`plan field "proofs": the proof of criterion ${n} must be a non-empty text of at most ${ITEM_MAX} characters`);
    return { criterion: n, proof: p.proof };
  });
  return { steps, files, risks, proofs: parsed.sort((a, b) => a.criterion - b.criterion) };
}

/** Empreinte d'un plan : SHA-256 de la forme canonique de son contenu et de
 * l'empreinte du contrat qu'il réalise — le même texte sous un autre contrat
 * est un autre plan. */
export function planFingerprint(contractFp: string, content: PlanContent): string {
  return sha256(canonical({ contract: contractFp, content }));
}

/** Champs fermés d'un événement `plan` ; l'empreinte déclarée doit être celle
 * du contenu (un journal retouché à la main devient illisible). */
function checkPlanEvent(event: Record<string, unknown>): void {
  if (!PLAN_KINDS.includes(event.kind as PlanKind)) throw new ContractError(`proof field "kind" of a plan event must be one of ${PLAN_KINDS.join(", ")}`);
  if (typeof event.plan !== "string" || !HEX64.test(event.plan)) throw new ContractError('proof field "plan" must be 64 hexadecimal characters');
  if (event.kind === "deviation") {
    onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "plan", "change", "before", "after", "reason"]);
    if (!PLAN_CHANGES.includes(event.change as PlanChange)) throw new ContractError(`proof field "change" of a plan deviation must be one of ${PLAN_CHANGES.join(", ")}`);
    for (const side of ["before", "after"]) {
      const v = event[side];
      if (!Array.isArray(v) || v.length > DEVIATION_ITEMS_MAX || !v.every((x) => typeof x === "string" && x.length <= DEVIATION_ITEM_MAX && !/[\x00-\x08\x0a-\x1f\x7f]/.test(x))) {
        throw new ContractError(`proof field "${side}" of a plan deviation must be a list of at most ${DEVIATION_ITEMS_MAX} lines`);
      }
    }
    if (event.change === "file" && ((event.before as string[]).length !== 0 || (event.after as string[]).length !== 1 || !isRelativeWorkspacePath((event.after as string[])[0]))) {
      throw new ContractError('a "file" deviation names one written path in "after" and nothing in "before"');
    }
    if (event.reason !== null && (typeof event.reason !== "string" || !event.reason.trim() || event.reason.length > REASON_MAX)) throw new ContractError('proof field "reason" of a plan deviation must be null or a text of at most 500 characters');
    return;
  }
  onlyFields(event, ["schema", "type", "at", "fingerprint", "kind", "plan", "content"]);
  const content = parsePlanContent(event.content, null);
  if (planFingerprint(event.fingerprint as string, content) !== event.plan) throw new ContractError('proof field "plan" does not match the proposed content');
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
  // #10 : la ligne est sur le disque avant que l'appelant n'agisse (une
  // intention précède toujours son effet) : écrite puis synchronisée.
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

// ---- report.json et report.md : projections du verdict (ticket #9) ----
//
// Regénérés par l'hôte au début et à la fin de chaque tour du profil, depuis
// le journal, le contrat et l'état constaté du workspace ; les deux fichiers
// viennent du même objet. Aucune décision ne les relit : la source reste
// proofs.jsonl. Hors d'atteinte des outils du modèle comme tout ce dossier.

export const REPORT_SCHEMA = "smolcoder/report/v1";
export const REPORT_FILE = "report.json";
export const REPORT_MD_FILE = "report.md";

/** Écrit les deux projections, chacune atomiquement. */
export function writeReportFiles(dir: string, json: string, markdown: string): { json: string; markdown: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = { json: path.join(dir, REPORT_FILE), markdown: path.join(dir, REPORT_MD_FILE) };
  writeAtomic(files.json, json);
  writeAtomic(files.markdown, markdown);
  return files;
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

// ---- lock et resume.json : un seul écrivain, état connu (ticket #10) ----
//
// `lock` : le verrou mono-écrivain par workspace que la rubrique
// « conséquences » réservait à #10 — PID, machine, session, surface et date.
// Créé exclusivement (O_EXCL) ; un verrou dont le processus n'existe plus est
// repris, jamais un verrou vivant. Il ne bloque pas un éditeur externe : la
// session revérifie avant chaque effet. `resume.json` : l'enregistrement de
// reprise, l'état que la dernière session a laissé (révision Git, empreinte
// de chaque fichier, consignes chargées, progression du plan, budget
// consommé), réécrit atomiquement par la session qui écrit. Une référence
// pour constater ce qui a changé depuis, jamais une source de droit.

export const LOCK_FILE = "lock";
export const LOCK_SCHEMA = "smolcoder/lock/v1";
export const RESUME_FILE = "resume.json";
export const RESUME_SCHEMA = "smolcoder/resume/v1";
export const MAX_RESUME_BYTES = 4 * 1024 * 1024;
/** Au-delà, l'enregistrement ne garde que l'empreinte globale du workspace. */
export const MAX_RESUME_FILES = 5000;

export interface WriterLock {
  schema: typeof LOCK_SCHEMA;
  pid: number;
  host: string;
  session: string;
  surface: string;
  since: string;
}

export type LockRead = { state: "absent" } | { state: "unreadable"; reason: string } | { state: "ok"; lock: WriterLock };

export interface ResumeRecord {
  schema: typeof RESUME_SCHEMA;
  at: string;
  session: string;
  surface: string;
  /** Empreinte du contrat de la session qui a écrit. */
  contract: string;
  head: string | null;
  /** Empreinte globale (celle de #9) et, sous la borne, celle de chaque fichier. */
  files: { digest: string | null; entries: Record<string, string> | null };
  instructions: { global: string | null; workspace: string | null };
  plan: { fingerprint: string | null; steps: { text: string; done: boolean; note?: string }[] } | null;
  steps: number;
}

export type ResumeRead = { state: "absent" } | ReadFailure | { state: "ok"; record: ResumeRecord };

const SURFACE_RE = /^[a-z-]{1,20}$/;

function parseLock(raw: unknown): WriterLock {
  if (!isObject(raw)) throw new ContractError("the lock is not a JSON object");
  onlyFields(raw, ["schema", "pid", "host", "session", "surface", "since"]);
  if (raw.schema !== LOCK_SCHEMA) throw new ContractError(`unknown lock schema ${JSON.stringify(raw.schema)}`);
  if (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1) throw new ContractError('lock field "pid" is invalid');
  if (typeof raw.host !== "string" || raw.host.length > 255 || /[\x00-\x1f\x7f]/.test(raw.host)) throw new ContractError('lock field "host" is invalid');
  if (typeof raw.session !== "string" || !EFFECT_ID_RE.test(raw.session)) throw new ContractError('lock field "session" is invalid');
  if (typeof raw.surface !== "string" || !SURFACE_RE.test(raw.surface)) throw new ContractError('lock field "surface" is invalid');
  if (typeof raw.since !== "string" || Number.isNaN(Date.parse(raw.since))) throw new ContractError('lock field "since" must be a date');
  return { schema: LOCK_SCHEMA, pid: raw.pid, host: raw.host, session: raw.session, surface: raw.surface, since: raw.since };
}

export function readLock(dir: string): LockRead {
  const raw = readBounded(path.join(dir, LOCK_FILE), 4096);
  if (raw.state !== "ok") return raw;
  try {
    return { state: "ok", lock: parseLock(JSON.parse(raw.text)) };
  } catch (err: any) {
    return { state: "unreadable", reason: `${LOCK_FILE}: ${err?.message ?? err}` };
  }
}

/** Crée le verrou s'il n'existe pas (création exclusive). false : déjà pris. */
export function createLock(dir: string, lock: WriterLock): boolean {
  const checked = parseLock(JSON.parse(JSON.stringify(lock)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(path.join(dir, LOCK_FILE), "wx", 0o600);
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(checked) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Remplace atomiquement un verrou mort par le sien (l'appelant a constaté
 * que son processus n'existe plus, puis relit pour confirmer). */
export function replaceLock(dir: string, lock: WriterLock): void {
  const checked = parseLock(JSON.parse(JSON.stringify(lock)));
  writeAtomic(path.join(dir, LOCK_FILE), JSON.stringify(checked) + "\n");
}

/** Retire le verrou seulement s'il appartient encore à cette session. */
export function removeLock(dir: string, session: string): boolean {
  const read = readLock(dir);
  if (read.state !== "ok" || read.lock.session !== session) return false;
  try {
    fs.unlinkSync(path.join(dir, LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

function parseResume(raw: Record<string, unknown>): ResumeRecord {
  onlyFields(raw, ["schema", "at", "session", "surface", "contract", "head", "files", "instructions", "plan", "steps"]);
  const bad = (f: string) => new ContractError(`resume field "${f}" is invalid`);
  if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) throw bad("at");
  if (typeof raw.session !== "string" || !EFFECT_ID_RE.test(raw.session)) throw bad("session");
  if (typeof raw.surface !== "string" || !SURFACE_RE.test(raw.surface)) throw bad("surface");
  if (typeof raw.contract !== "string" || !HEX64.test(raw.contract)) throw bad("contract");
  if (raw.head !== null && (typeof raw.head !== "string" || raw.head.length > 200)) throw bad("head");
  const files = raw.files;
  if (!isObject(files)) throw bad("files");
  onlyFields(files, ["digest", "entries"], "files.");
  if (!hexOrNull(files.digest)) throw bad("files.digest");
  if (files.entries !== null) {
    if (!isObject(files.entries) || Object.keys(files.entries).length > MAX_RESUME_FILES) throw bad("files.entries");
    for (const [p, h] of Object.entries(files.entries)) if (!isRelativeWorkspacePath(p) || typeof h !== "string" || !HEX64.test(h)) throw bad("files.entries");
  }
  const ins = raw.instructions;
  if (!isObject(ins)) throw bad("instructions");
  onlyFields(ins, ["global", "workspace"], "instructions.");
  if (!hexOrNull(ins.global) || !hexOrNull(ins.workspace)) throw bad("instructions");
  const plan = raw.plan;
  if (plan !== null) {
    if (!isObject(plan)) throw bad("plan");
    onlyFields(plan, ["fingerprint", "steps"], "plan.");
    if (!hexOrNull(plan.fingerprint)) throw bad("plan.fingerprint");
    if (!Array.isArray(plan.steps) || plan.steps.length > 50 || !plan.steps.every((s) => isObject(s) && typeof s.text === "string" && s.text.length <= ITEM_MAX && typeof s.done === "boolean" && (s.note === undefined || (typeof s.note === "string" && s.note.length <= 1000)))) throw bad("plan.steps");
  }
  if (!Number.isSafeInteger(raw.steps) || (raw.steps as number) < 0) throw bad("steps");
  return raw as unknown as ResumeRecord;
}

export function readResume(dir: string): ResumeRead {
  const raw = readBounded(path.join(dir, RESUME_FILE), MAX_RESUME_BYTES);
  if (raw.state !== "ok") return raw;
  let data: unknown;
  try {
    data = JSON.parse(raw.text);
  } catch (err: any) {
    return { state: "unreadable", reason: `${RESUME_FILE} is not valid JSON (${err?.message ?? err})` };
  }
  if (!isObject(data)) return { state: "unreadable", reason: `${RESUME_FILE} is not a JSON object` };
  if (data.schema !== RESUME_SCHEMA) return { state: "unknown-schema", schema: data.schema };
  try {
    return { state: "ok", record: parseResume(data) };
  } catch (err: any) {
    return { state: "unreadable", reason: `${RESUME_FILE}: ${err?.message ?? err}` };
  }
}

/** Écriture atomique ; un enregistrement invalide n'est jamais écrit. */
export function writeResume(dir: string, record: ResumeRecord): void {
  const checked = parseResume(JSON.parse(JSON.stringify({ ...record, schema: RESUME_SCHEMA })));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, RESUME_FILE), JSON.stringify({ ...checked, schema: RESUME_SCHEMA }) + "\n");
}
