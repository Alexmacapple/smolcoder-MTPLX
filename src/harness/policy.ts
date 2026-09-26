// Politique d'accès du profil renforcé (ticket #11, H02) : une décision
// allow / ask / deny, avec motif, action, chemins canoniques et version de
// politique, prise avant l'effet, au dernier point avant l'exécution. Une
// seule fonction décide pour les quatre surfaces : outils du modèle (dont
// run_command et task.start), vérifications automatiques du harnais et
// terminal web. La politique est relue à chaque décision dans le stockage
// hôte (policy.json, grammaire dans ./store) ; un fichier du workspace n'y
// entre jamais. Fail-closed : une politique absente, illisible ou de schéma
// inconnu refuse tout. Ce sont des refus précoces, pas une isolation du
// système (H03) : un scan de texte de commande a des faux négatifs connus.
// Hors profil (sans --mission), rien ici n'est consulté.

import * as path from "path";
import {
  commandEscapesWorkspace,
  insideWorkspace,
  pathCandidates,
  PathRules,
  protectedSegment,
  realPathOf,
  resolveInWorkspace,
  SandboxError,
} from "../sandbox";
import type { ExecOptions } from "../tools/shell";
import { AccessPolicy, POLICY_FILE, PolicyRule, readPolicy } from "./store";
import type { Mission } from "./mission";

export type Verdict = "allow" | "ask" | "deny";
/** tool : un appel d'outil du modèle ; check : une vérification lancée par le
 * harnais (--verify, contrôles du projet) ; terminal : une ligne tapée dans le
 * terminal web. */
export type Surface = "tool" | "check" | "terminal";
export type AccessAction = "read" | "write" | "list" | "search" | "plan" | "command" | "task" | "check" | "terminal" | "unknown";

export interface AccessRequest {
  surface: Surface;
  /** Nom de l'outil (surface tool) ; ignoré pour check et terminal. */
  tool: string;
  args: Record<string, any>;
  /** Terminal web : le dossier courant du shell. */
  cwd?: string;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  action: AccessAction;
  /** Chemins canoniques (liens résolus) que l'action touche. */
  paths: string[];
  /** `smolcoder/policy/v1@<empreinte>`, ou l'état qui a empêché de lire. */
  policyVersion: string;
  command?: string;
  /** Contexte d'exécution imposé quand l'action lance un processus. */
  exec?: ExecOptions;
  /** Recherche : motifs à ne jamais lire. */
  protect?: PathRules;
}

/** Code de sortie headless d'un run suspendu sur une décision « ask ». */
export const POLICY_SUSPENDED_EXIT_CODE = 4;

/** Une décision « ask » dans un run sans humain : suspension explicite,
 * jamais une autorisation par défaut. */
export class PolicySuspension extends Error {
  constructor(readonly decision: Decision) {
    super(
      `Suspended by the access policy (${decision.policyVersion}): ${decision.reason} ` +
        "This run is headless, so nobody can decide now and nothing was run. Rerun the task where a human can answer (terminal or web UI), or keep the work inside the workspace."
    );
  }
}

/** Ce qu'affiche une surface : jamais l'environnement transmis. */
export function decisionReport(d: Decision) {
  return {
    verdict: d.verdict,
    action: d.action,
    reason: d.reason,
    paths: d.paths,
    policyVersion: d.policyVersion,
    ...(d.command !== undefined ? { command: d.command } : {}),
  };
}

export const BYPASS_UNDER_MISSION =
  "· mission profile: bypass does not widen the access policy — protected paths, commands leaving the workspace and background tasks still go through it. Leaving the profile means restarting smol without --mission.";

const BASE_ENV = ["PATH", "HOME", "TERM", "LANG"];
/** Sans elles, presque rien ne démarre sous Windows. */
const WINDOWS_ENV = ["SystemRoot", "ComSpec", "PATHEXT"];

/** L'environnement minimal explicite des sous-processus du profil : PATH,
 * HOME, TERM, LANG et ce que la politique nomme, rien d'autre. */
export function minimalEnv(named: string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const win = process.platform === "win32";
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...(win ? WINDOWS_ENV : []), ...named]) {
    const key = win ? Object.keys(base).find((k) => k.toUpperCase() === name.toUpperCase()) : name;
    if (key !== undefined && base[key] !== undefined) out[key] = base[key];
  }
  return out;
}

function execFor(policy: AccessPolicy | null): ExecOptions {
  return { env: minimalEnv(policy?.env ?? []), login: false };
}

/** Terminal web : le shell persistant démarre (et redémarre) avec le même
 * contexte ; une politique illisible donne le plus petit environnement. */
export function terminalExec(mission: Mission): ExecOptions {
  const read = readPolicy(mission.dir);
  return execFor(read.state === "ok" ? read.policy : null);
}

function actionOf(req: AccessRequest): AccessAction {
  if (req.surface === "check") return "check";
  if (req.surface === "terminal") return "terminal";
  switch (req.tool) {
    case "read_file": return "read";
    case "write_file": case "edit_file": return "write";
    case "list_files": return "list";
    case "search": return "search";
    case "plan": return "plan";
    case "run_command": return "command";
    case "task": return "task";
    default: return "unknown";
  }
}

/** La décision d'accès du profil mission. Ne lance rien, n'écrit rien. */
export function decide(mission: Mission, req: AccessRequest): Decision {
  const action = actionOf(req);
  const read = readPolicy(mission.dir);
  if (read.state !== "ok") {
    const why =
      read.state === "absent" ? "missing from the host store"
        : read.state === "unknown-schema" ? `stored with an unknown schema (${JSON.stringify(read.schema)})`
          : `unreadable (${read.reason})`;
    return {
      verdict: "deny", action, paths: [], policyVersion: read.state,
      reason: `denied: the access policy is ${why} — ${path.join(mission.dir, POLICY_FILE)}. The controller cannot decide, so nothing is allowed; only the host can repair it.`,
    };
  }
  const { policy, version } = read;
  const base = { action, policyVersion: version };
  const deny = (why: string, paths: string[] = [], command?: string): Decision => ({
    ...base, verdict: "deny", paths, reason: `denied by the access policy (${version}): ${why}`, ...(command !== undefined ? { command } : {}),
  });

  // Le contrat d'abord : sans approbation de l'hôte, seules la lecture et la
  // préparation du plan passent (porte du ticket #8, même texte).
  const blocked = mission.denial(req.surface === "tool" ? req.tool : req.surface === "check" ? "verification" : "terminal", req.args);
  if (blocked) return { ...base, verdict: "deny", paths: [], reason: blocked };

  const ws = mission.workspace;
  switch (action) {
    case "read": case "write": case "list": case "search": {
      const given = typeof req.args?.path === "string" && req.args.path.trim() ? req.args.path : action === "list" || action === "search" ? "." : "";
      let abs: string;
      try {
        abs = resolveInWorkspace(ws, given);
      } catch (err: any) {
        return deny(err instanceof SandboxError ? err.message : `cannot resolve "${given}"`);
      }
      const canonical = realPathOf(abs);
      const hit = protectedSegment(path.relative(ws, abs), policy.paths) ?? protectedSegment(path.relative(realPathOf(ws), canonical), policy.paths);
      if (hit) {
        return deny(
          `"${given}" is a protected path ("${hit}" matches paths.protect): it can be neither read nor written under the mission profile. Work without it; only the host can change the policy.`,
          [canonical]
        );
      }
      return { ...base, verdict: "allow", paths: [canonical], reason: "inside the workspace, not protected", ...(action === "search" ? { protect: policy.paths } : {}) };
    }
    case "plan":
      return { ...base, verdict: "allow", paths: [], reason: "the plan checklist has no effect on the project" };
    case "task":
      if (req.args?.action !== "start") return { ...base, verdict: "allow", paths: [], reason: "reads or stops an existing task" };
      return commandDecision(policy, "tasks", "a background task", req.args?.command, mission, deny, base);
    case "command": case "check":
      return commandDecision(policy, "commands", action === "check" ? "an automatic check" : "a command", req.args?.command, mission, deny, base);
    case "terminal": {
      const cwd = req.cwd ?? ws;
      if (!insideWorkspace(ws, cwd)) return deny(`this terminal's current folder (${cwd}) is outside the workspace; close this terminal tab and open a new one, which starts in the workspace`, [], String(req.args?.command ?? ""));
      return commandDecision(policy, "commands", "a terminal command", req.args?.command, mission, deny, base);
    }
    default:
      return deny(`"${req.tool}" is not an action the policy knows; unknown actions are refused`);
  }
}

/** Ce qui, dans une commande, désigne le dossier de données de smol (contrat,
 * politique, preuves, sessions) : ni lisible ni modifiable par une commande. */
function hostStoreMention(command: string, workspace: string, dataDir: string): string | null {
  if (/\.smolcoder/i.test(command)) return ".smolcoder";
  for (const tok of pathCandidates(command)) {
    if (insideWorkspace(dataDir, path.resolve(workspace, tok))) return tok;
  }
  return null;
}

function commandDecision(
  policy: AccessPolicy,
  key: "commands" | "tasks",
  noun: string,
  command: unknown,
  mission: Mission,
  deny: (why: string, paths?: string[], command?: string) => Decision,
  base: { action: AccessAction; policyVersion: string }
): Decision {
  const exec = execFor(policy);
  // Une commande vide ne lance rien : l'outil la refuse lui-même.
  if (typeof command !== "string" || !command.trim()) return { ...base, verdict: "allow", paths: [], reason: "empty command", exec };
  const ws = mission.workspace;
  const dataDir = path.dirname(path.dirname(mission.dir));
  const host = hostStoreMention(command, ws, dataDir);
  if (host) return deny(`this command reaches smol's host store (${host}), which holds the mission contract and this policy`, [], command);
  for (const tok of pathCandidates(command)) {
    const hit = protectedSegment(tok, policy.paths);
    if (hit) return deny(`this command names a protected path (${tok}; "${hit}" matches paths.protect)`, [], command);
  }
  const rule: PolicyRule = policy[key];
  if (rule === "deny") return deny(`${noun} is not allowed under the mission profile (policy "${key}": "deny")`, [], command);
  const ask = (why: string): Decision => ({ ...base, verdict: "ask", paths: [], reason: why, command, exec });
  if (rule === "ask") return ask(`${noun} needs a human decision under the mission profile (policy "${key}": "ask").`);
  const escape = commandEscapesWorkspace(command, ws);
  if (escape) return ask(`this command ${escape}, which needs a human decision under the mission profile (bypass does not change that).`);
  return { ...base, verdict: "allow", paths: [], reason: "stays inside the workspace", command, exec };
}
