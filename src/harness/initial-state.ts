// État initial d'une mission (#71) : un constat daté, avant le premier effet
// du modèle. Il dérive exclusivement du contrat, de la reprise, du scan, des
// vérificateurs, de la politique et de l'exécuteur déjà en vigueur.

import type { Decision } from "./policy";
import type { Mission } from "./mission";
import {
  CheckOutcome,
  classify,
  MissionCheck,
  npmPrecheck,
  verifierChanges,
  verifierStamps,
} from "./proofs";
import type { ExternalChanges, ResumeReport } from "./resume";
import type { IsolatedExecutor, IsolationStatus } from "./sandbox-executor";
import { renderCommandResult, runCommandResult } from "../tools/shell";

export type InitialControlStatus =
  | "passed"
  | "already_failed"
  | "not_run"
  | "refused"
  | "environment_unavailable"
  | "error";

export type InitialControlCause =
  | CheckOutcome["cause"]
  | "contract-not-approved"
  | "model-unavailable"
  | "isolation-unavailable"
  | "resume-suspended"
  | "writer-unavailable";

export interface InitialControl {
  command: string;
  owner: MissionCheck["owner"];
  criteria: string[];
  status: InitialControlStatus;
  cause: InitialControlCause;
  executed: boolean;
  observedAt: string;
  output?: string;
  exit?: { status: string; code: number | null; signal: string | null; durationMs: number };
}

export type MissionInitialStateName =
  | "ready"
  | "already_failing"
  | "not_run"
  | "refused"
  | "environment_unavailable"
  | "error";

export type InitialModel =
  | { state: "ready"; id: string; backend: string }
  | { state: "unavailable"; reason: string };

export interface MissionInitialState {
  schema: "smolcoder/mission-initial/v1";
  observedAt: string;
  surface: string;
  state: MissionInitialStateName;
  reason: string;
  model: InitialModel;
  contract: { state: string; approved: boolean };
  resume: {
    suspended: boolean;
    reason: string | null;
    lock: ResumeReport["lock"];
  };
  isolation: IsolationStatus | { state: "not_checked"; reason: string };
  verifiers: { state: string; frozen: string | null; current: string | null; changes: string[] };
  workspace: {
    beforeAgentEffect: true;
    digest: string | null;
    count: number | null;
    reason?: string;
    humanChanges: ExternalChanges | null;
  };
  controls: InitialControl[];
}

type Authorization =
  | { ok: true; decision: Decision }
  | { ok: false; message: string };

interface CommonInput {
  mission: Mission;
  checks: MissionCheck[];
  surface: string;
  model: InitialModel;
  resume: Pick<ResumeReport, "suspended" | "reason" | "lock" | "external">;
}

interface ObserveInput extends CommonInput {
  executor: IsolatedExecutor;
  authorize: (command: string) => Promise<Authorization>;
  signal?: AbortSignal;
}

interface UnavailableInput extends CommonInput {
  isolation: IsolationStatus | { state: "not_checked"; reason: string };
}

function basic(input: CommonInput, isolation: MissionInitialState["isolation"]): Omit<MissionInitialState, "state" | "reason" | "controls"> {
  const scan = input.mission.scan();
  const status = input.mission.status();
  const verifier = input.mission.verifierState(input.mission.verifierCommands(input.checks.map((check) => check.command)), scan);
  return {
    schema: "smolcoder/mission-initial/v1",
    observedAt: new Date().toISOString(),
    surface: input.surface,
    model: input.model,
    contract: { state: status.state, approved: status.state === "approved" },
    resume: { suspended: input.resume.suspended, reason: input.resume.reason, lock: input.resume.lock },
    isolation,
    verifiers: { state: verifier.state, frozen: verifier.frozen, current: verifier.current, changes: verifier.changes },
    workspace: scan.ok
      ? { beforeAgentEffect: true, digest: scan.digest, count: scan.count, humanChanges: input.resume.external }
      : { beforeAgentEffect: true, digest: null, count: null, reason: scan.reason, humanChanges: input.resume.external },
  };
}

function unexecuted(checks: MissionCheck[], status: InitialControlStatus, cause: InitialControlCause): InitialControl[] {
  return checks.map((check) => ({
    command: check.command,
    owner: check.owner,
    criteria: [...check.criteria],
    status,
    cause,
    executed: false,
    observedAt: new Date().toISOString(),
  }));
}

function resultState(controls: InitialControl[]): { state: MissionInitialStateName; reason: string } {
  if (!controls.length) return { state: "not_run", reason: "aucun contrôle initial n'est défini par le contrat ou l'appelant" };
  if (controls.some((control) => control.status === "environment_unavailable")) return { state: "environment_unavailable", reason: "l'environnement requis par le contrôle initial est indisponible" };
  if (controls.some((control) => control.status === "refused")) return { state: "refused", reason: "la politique d'accès a refusé au moins un contrôle initial" };
  if (controls.some((control) => control.status === "error")) return { state: "error", reason: "au moins un contrôle initial n'a pas pu conclure" };
  if (controls.some((control) => control.status === "already_failed")) return { state: "already_failing", reason: "au moins un contrôle échouait avant le premier effet du modèle" };
  if (controls.some((control) => control.status === "not_run")) return { state: "not_run", reason: "au moins un contrôle initial n'a pas été exécuté" };
  return { state: "ready", reason: "tous les contrôles initiaux exécutés passent" };
}

function withControls(base: ReturnType<typeof basic>, controls: InitialControl[]): MissionInitialState {
  return { ...base, ...resultState(controls), controls, observedAt: new Date().toISOString() };
}

/** Produit un constat explicite quand aucun modèle ne peut être joint. Aucun
 * contrôle n'est lancé, et aucun statut non exécuté ne peut devenir vert. */
export function unavailableMissionInitialState(input: UnavailableInput): MissionInitialState {
  const base = basic(input, input.isolation);
  const cause: InitialControlCause = input.model.state === "unavailable" ? "model-unavailable" : "isolation-unavailable";
  const controls = unexecuted(input.checks, "environment_unavailable", cause);
  return {
    ...base,
    state: "environment_unavailable",
    reason: cause === "model-unavailable" ? "aucun modèle demandé n'est joignable" : "l'isolation requise est indisponible",
    controls,
  };
}

function mappedOutcome(outcome: CheckOutcome): Pick<InitialControl, "status" | "cause"> {
  if (outcome.status === "passed") return { status: "passed", cause: null };
  if (outcome.status === "failed") return { status: "already_failed", cause: outcome.cause };
  if (outcome.status === "not_run") return { status: "not_run", cause: outcome.cause };
  return { status: "error", cause: outcome.cause };
}

/** Exécute les contrôles initiaux uniquement après les portes d'approbation,
 * de reprise, d'isolation et de gel des vérificateurs. Chaque commande passe
 * par l'autorisation et l'exécuteur fournis par la boucle de l'agent. */
export async function observeMissionInitialState(input: ObserveInput): Promise<MissionInitialState> {
  const base = basic(input, input.executor.status);
  if (input.model.state === "unavailable") return unavailableMissionInitialState({ ...input, isolation: input.executor.status });
  if (!base.contract.approved) return withControls(base, unexecuted(input.checks, "not_run", "contract-not-approved"));
  if (input.resume.suspended) return withControls(base, unexecuted(input.checks, "not_run", "resume-suspended"));
  if (input.resume.lock.state !== "held" && input.resume.lock.state !== "unmanaged") {
    return withControls(base, unexecuted(input.checks, "not_run", "writer-unavailable"));
  }
  if (!input.checks.length) return withControls(base, []);
  if (input.executor.status.state !== "ready") {
    return withControls(base, unexecuted(input.checks, "environment_unavailable", "isolation-unavailable"));
  }
  if (base.verifiers.state !== "frozen") {
    const cause = base.verifiers.state === "changed" ? "verifier-changed" : "verifier-unfrozen";
    return withControls(base, unexecuted(input.checks, "not_run", cause));
  }

  const controls: InitialControl[] = [];
  const commands = input.mission.verifierCommands(input.checks.map((check) => check.command));
  const frozen = input.mission.frozenVerifierFiles();
  const watched = Object.keys(frozen);
  for (const check of input.checks) {
    const observedAt = new Date().toISOString();
    let authorization: Authorization;
    try {
      authorization = await input.authorize(check.command);
    } catch (err: any) {
      controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], status: "refused", cause: "policy", executed: false, observedAt, output: String(err?.message ?? err) });
      break;
    }
    if (!authorization.ok) {
      controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], status: "refused", cause: "policy", executed: false, observedAt, output: authorization.message });
      break;
    }
    const precheck = npmPrecheck(input.mission.workspace, check.command);
    if (precheck) {
      controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], ...mappedOutcome(precheck.outcome), executed: false, observedAt, output: precheck.message });
      break;
    }
    const before = input.mission.scan();
    if (!before.ok) {
      controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], status: "error", cause: "fingerprint-unavailable", executed: false, observedAt, output: before.reason });
      break;
    }
    const stamps = verifierStamps(input.mission.workspace, before, watched);
    let result;
    try {
      result = await runCommandResult(check.command, input.mission.workspace, input.signal, check.timeoutMs, authorization.decision.exec, input.executor, "check");
    } catch (err: any) {
      controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], status: "error", cause: "spawn-error", executed: false, observedAt, output: String(err?.message ?? err) });
      break;
    }
    const after = input.mission.scan();
    let outcome = classify(result);
    let output = renderCommandResult(result);
    if (!after.ok) {
      outcome = { status: "error", cause: "fingerprint-unavailable", tests: outcome.tests };
      output += `\n[empreinte finale indisponible : ${after.reason}]`;
    } else {
      const now = verifierStamps(input.mission.workspace, after, watched);
      const written = watched.filter((file) => now.get(file) !== stamps.get(file)).map((file) => `${file} (écrit pendant le contrôle initial)`);
      const altered = verifierChanges(input.mission.workspace, after, frozen, commands);
      if (written.length || altered.length) {
        const changes = [...new Set([...altered, ...written])];
        outcome = { status: "error", cause: "verifier-changed-during-check", tests: outcome.tests };
        output += `\n[entrées du vérificateur modifiées : ${changes.join(", ")}]`;
      }
    }
    controls.push({
      command: check.command,
      owner: check.owner,
      criteria: [...check.criteria],
      ...mappedOutcome(outcome),
      executed: true,
      observedAt,
      output,
      exit: { status: result.status, code: result.exitCode, signal: result.signal, durationMs: Math.max(0, Math.round(result.durationMs)) },
    });
    if (outcome.status !== "passed") break;
  }
  for (const check of input.checks.slice(controls.length)) {
    controls.push({ command: check.command, owner: check.owner, criteria: [...check.criteria], status: "not_run", cause: "not-run", executed: false, observedAt: new Date().toISOString() });
  }
  const final = withControls(base, controls);
  const scan = input.mission.scan();
  final.workspace = scan.ok
    ? { beforeAgentEffect: true, digest: scan.digest, count: scan.count, humanChanges: input.resume.external }
    : { beforeAgentEffect: true, digest: null, count: null, reason: scan.reason, humanChanges: input.resume.external };
  return final;
}

/** Projection courte injectée avec la demande humaine : elle sépare les
 * défauts préexistants du travail qui va commencer, sans autoriser de travail. */
export function renderMissionInitialState(state: MissionInitialState): string {
  const controls = state.controls.length
    ? state.controls.map((control) => `${control.command}: ${control.status}${control.cause ? ` (${control.cause})` : ""}`).join("; ")
    : "aucun contrôle défini";
  const human = state.workspace.humanChanges
    ? ` Changements humains ou externes à préserver : ${state.workspace.humanChanges.files.map((file) => `${file.path} (${file.change})`).join(", ") || "empreinte modifiée"}.`
    : "";
  const firstProblem = state.controls.find((control) => control.status !== "passed");
  const evidence = firstProblem?.output ? ` Première sortie observée : ${firstProblem.output.slice(0, 1600)}.` : "";
  const attribution = state.state === "already_failing"
    ? "Cet échec préexistait au travail de cette session et ne doit pas lui être attribué."
    : "Aucun contrôle non exécuté n'est présenté comme réussi.";
  return (
    `\n\n[État initial de mission constaté le ${state.observedAt}, avant tout effet du modèle dans cette session : ` +
    `${state.state} — ${state.reason}. Contrôles : ${controls}.${human}${evidence} ` +
    `${attribution} Ce constat n'autorise aucune correction et n'élargit pas le contrat.]`
  );
}
