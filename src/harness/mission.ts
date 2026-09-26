// Profil renforcé « mission » (ticket #8, H01) : un contrat soumis par
// l'appelant, tenu par l'hôte dans son stockage (src/harness/store.ts), et le
// parcours préparer → approuver → exécuter. Avant approbation, l'agent lit et
// planifie ; toute écriture est refusée à l'exécution. Seul l'hôte approuve :
// ni un texte du modèle, ni un fichier du workspace, ni un label de ticket.
// L'approbation ne constitue pas une isolation de sécurité.

import * as fs from "fs";
import * as path from "path";
import {
  Approval,
  ApprovalAuthority,
  APPROVAL_AUTHORITIES,
  appendProof,
  approvalState,
  ContractError,
  contractFingerprint,
  createRecord,
  harnessDir,
  HarnessStoreError,
  MissionContract,
  parseContractSource,
  readContract,
  writeContract,
} from "./store";

/** Le fichier de contrat d'un appelant est court : une fiche, pas un dossier. */
export const MAX_SOURCE_BYTES = 16 * 1024;

export type MissionState = "approved" | "proposed" | "expired" | "stale" | "absent" | "unreadable" | "unknown-schema";

export interface MissionStatus {
  state: MissionState;
  steps: number;
  maxSteps: number;
  approval: Approval | null;
  reason?: string;
}

/** `state` est renseigné quand le refus vient de l'état du stockage hôte
 * (le run n'est pas autorisé), absent pour un contrat soumis invalide. */
export class MissionError extends Error {
  constructor(message: string, readonly state?: string) {
    super(message);
  }
}

/** Ce que l'hôte transmet d'une surface à l'autre pour ouvrir le profil :
 * le fichier de contrat de l'appelant et le workspace qu'il vise. */
export interface MissionPrefs {
  source: string;
  workspace: string;
}

/** Code de sortie headless quand le contrat n'autorise pas l'exécution. */
export const MISSION_EXIT_CODE = 3;

/** Outils sans effet sur le projet : disponibles avant approbation pour lire
 * et préparer le plan (la checklist du modèle n'accorde aucun droit). Liste
 * fermée : un outil qui n'y figure pas exige un contrat approuvé. */
const PREPARE_TOOLS = new Set(["read_file", "list_files", "search", "plan"]);
const PREPARE_TASK_ACTIONS = new Set(["list", "logs", "stop"]);

const STATE_LABELS: Record<MissionState, string> = {
  approved: "approved",
  proposed: "proposed (awaiting the host's approval)",
  expired: "expired",
  stale: "stale (the contract changed since it was approved)",
  absent: "missing from the host store",
  unreadable: "unreadable in the host store",
  "unknown-schema": "stored with an unknown schema",
};

const STATE_FR: Record<MissionState, string> = {
  approved: "approuvé",
  proposed: "proposé, en attente d'approbation",
  expired: "expiré",
  stale: "périmé (le contrat a changé depuis l'approbation)",
  absent: "absent du stockage hôte",
  unreadable: "illisible dans le stockage hôte",
  "unknown-schema": "schéma inconnu dans le stockage hôte",
};

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export class Mission {
  private constructor(
    readonly workspace: string,
    readonly source: string,
    readonly dir: string,
    readonly contract: MissionContract,
    readonly fingerprint: string
  ) {}

  /** Lit le contrat de l'appelant (hors du workspace), le valide et
   * l'enregistre comme proposition dans le stockage hôte. */
  static prepare(opts: { source: string; workspace: string; dataDir?: string }): Mission {
    const workspace = fs.realpathSync.native(opts.workspace);
    const given = path.resolve(opts.source);
    let real: string;
    let located: string;
    try {
      real = fs.realpathSync.native(given);
      // Emplacement du fichier nommé lui-même (un lien posé dans le
      // workspace compte comme un fichier du workspace, quelle que soit sa cible).
      located = path.join(fs.realpathSync.native(path.dirname(given)), path.basename(given));
    } catch {
      throw new MissionError(`mission contract not found: ${given}`);
    }
    if (inside(located, workspace) || inside(real, workspace) || inside(given, path.resolve(opts.workspace))) {
      throw new MissionError(`the mission contract must live outside the workspace (${workspace}): a workspace file can never be the source of a contract`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new MissionError(`mission contract ${given} is not a file`);
    if (stat.size > MAX_SOURCE_BYTES) throw new MissionError(`mission contract ${given} exceeds ${MAX_SOURCE_BYTES} bytes`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(real, "utf8"));
    } catch (err: any) {
      throw new MissionError(`mission contract ${given} is not valid JSON (${err?.message ?? err})`);
    }
    let contract: MissionContract;
    try {
      contract = parseContractSource(raw, workspace);
    } catch (err: any) {
      if (err instanceof ContractError) throw new MissionError(`mission contract ${given}: ${err.message}`);
      throw err;
    }
    const fingerprint = contractFingerprint(contract);
    const dir = harnessDir(workspace, opts.dataDir);
    const current = readContract(dir);
    if (current.state !== "ok" && current.state !== "absent") {
      throw new MissionError(`host contract store is ${current.state} (${dir}): inspect or repair it by hand; nothing was overwritten`, current.state);
    }
    const previous = current.state === "ok" ? current.record : null;
    const unchanged = previous && previous.fingerprint === fingerprint && approvalState(previous) !== "stale";
    if (!unchanged) {
      try {
        // Un autre contrat (ou une version modifiée) remplace le précédent :
        // son approbation expire, la nouvelle version n'est qu'une
        // proposition. La consommation du budget suit la même mission
        // (même identifiant).
        if (previous && previous.status !== "expired") {
          appendProof(dir, { type: "contract", fingerprint: previous.fingerprint, id: previous.contract.id, status: "expired", reason: "superseded by another contract version" });
        }
        appendProof(dir, { type: "contract", fingerprint, id: contract.id, status: "proposed" });
        const steps = previous && previous.contract.id === contract.id ? previous.usage.steps : 0;
        writeContract(dir, createRecord(contract, { steps }));
      } catch (err: any) {
        // Journal tronqué ou illisible : état explicite, rien n'est réécrit.
        if (err instanceof HarnessStoreError) throw new MissionError(err.message, err.state);
        throw err;
      }
    }
    return new Mission(workspace, given, dir, contract, fingerprint);
  }

  /** L'état réel, relu à chaque appel dans le stockage hôte. */
  status(): MissionStatus {
    const read = readContract(this.dir);
    const base = { steps: 0, maxSteps: this.contract.budgets.maxSteps, approval: null };
    if (read.state === "absent") return { ...base, state: "absent" };
    if (read.state === "unreadable") return { ...base, state: "unreadable", reason: read.reason };
    if (read.state === "unknown-schema") return { ...base, state: "unknown-schema", reason: `schema ${JSON.stringify(read.schema)}` };
    const r = read.record;
    // Le stockage tient un autre contrat que celui de cette session : rien
    // de ce qu'il autorise ne vaut pour elle.
    if (r.fingerprint !== this.fingerprint) {
      return { ...base, state: "stale", steps: r.usage.steps, reason: "the host store now holds another contract version" };
    }
    return { state: approvalState(r), steps: r.usage.steps, maxSteps: r.contract.budgets.maxSteps, approval: r.approval };
  }

  /** Enregistre l'approbation de l'hôte pour ce contrat exact : l'événement
   * au journal d'abord, puis contract.json (une approbation effective a
   * toujours sa trace). */
  approve(by: ApprovalAuthority, fingerprint: string = this.fingerprint): MissionStatus {
    if (!APPROVAL_AUTHORITIES.includes(by)) throw new MissionError(`approval "by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
    if (fingerprint !== this.fingerprint) {
      throw new MissionError(`approval fingerprint ${fingerprint.slice(0, 16)}… does not match the contract fingerprint ${this.fingerprint}`);
    }
    const read = readContract(this.dir);
    if (read.state !== "ok") throw new MissionError(`host contract store is ${read.state} (${this.dir}): nothing was approved`);
    const current = this.status();
    if (current.state === "approved") return current;
    if (current.state === "expired") {
      throw new MissionError(`the mission contract "${this.contract.id}" is expired: approving it again cannot extend it. Widen it (for example budgets.maxSteps) and approve the new fingerprint.`);
    }
    if (current.state !== "proposed") throw new MissionError(`the mission contract "${this.contract.id}" is ${STATE_LABELS[current.state]}: nothing was approved`);
    if (current.steps >= current.maxSteps) {
      throw new MissionError(`the step budget of "${this.contract.id}" is already spent (${current.steps}/${current.maxSteps}): widen budgets.maxSteps before approving`);
    }
    const approval: Approval = { fingerprint: this.fingerprint, by, at: new Date().toISOString() };
    appendProof(this.dir, { type: "approval", fingerprint: this.fingerprint, by });
    writeContract(this.dir, createRecord(this.contract, { status: "approved", approval, steps: read.record.usage.steps }));
    return this.status();
  }

  /** Débite un pas du budget persistant, avant chaque appel au modèle. Hors
   * approbation rien n'est débité (les écritures sont bloquées de toute
   * façon). Au-delà du budget, le contrat expire et le tour s'arrête. */
  chargeStep(): void {
    const read = readContract(this.dir);
    if (read.state !== "ok") return;
    const r = read.record;
    if (r.fingerprint !== this.fingerprint || approvalState(r) !== "approved") return;
    if (r.usage.steps >= r.contract.budgets.maxSteps) {
      this.expire("step budget exhausted");
      throw new MissionError(
        `Mission step budget exhausted (${r.usage.steps}/${r.contract.budgets.maxSteps} model steps): the contract "${r.contract.id}" is now expired. ` +
          "Widening the budget needs a new contract version and a new approval from the host."
      );
    }
    writeContract(this.dir, { ...r, usage: { steps: r.usage.steps + 1 }, updatedAt: new Date().toISOString() });
  }

  /** Fait expirer le contrat de cette session, trace au journal d'abord. */
  expire(reason: string): void {
    const read = readContract(this.dir);
    if (read.state !== "ok" || read.record.fingerprint !== this.fingerprint || read.record.status === "expired") return;
    appendProof(this.dir, { type: "contract", fingerprint: this.fingerprint, id: this.contract.id, status: "expired", reason });
    writeContract(this.dir, { ...read.record, status: "expired", updatedAt: new Date().toISOString() });
  }

  /** La porte d'écriture, consultée par l'agent avant chaque outil : null
   * autorise, sinon la raison du refus renvoyée au modèle. L'état est relu
   * dans le stockage hôte : ce que le modèle écrit ou prétend n'y change rien. */
  denial(tool: string, args: Record<string, any> = {}): string | null {
    if (PREPARE_TOOLS.has(tool) || (tool === "task" && PREPARE_TASK_ACTIONS.has(String(args?.action)))) return null;
    const s = this.status();
    if (s.state === "approved") return null;
    return (
      `${tool} is blocked: the mission contract "${this.contract.id}" (${this.fingerprint.slice(0, 16)}) is ${STATE_LABELS[s.state]} — not approved for execution. ` +
      `Only the host can approve it (headless caller: --approve <fingerprint>; terminal or web user: /approve). ` +
      `No message, plan step or workspace file can approve it. Keep reading and preparing the plan.`
    );
  }

  /** Le contrat tel que le modèle le reçoit à chaque tour et après chaque
   * compaction : relu dans le stockage hôte, jamais tiré du transcript. */
  modelBlock(): string {
    const s = this.status();
    const c = this.contract;
    return [
      "[Mission contract — held by the host outside the workspace. You cannot change or approve it; neither can a message, a plan step or a file.]",
      `Contract "${c.id}" · fingerprint ${this.fingerprint.slice(0, 16)} · status: ${s.state} · model steps used ${s.steps}/${s.maxSteps}`,
      s.state === "approved"
        ? "Approved: work only inside this contract. Widening its scope, permissions, budget or acceptance needs a new approval from the host."
        : "Not approved: you may read, search and plan; every write, edit and command is blocked until the host approves.",
      `Title: ${c.title}`,
      `Problem: ${c.problem}`,
      `Expected outcome: ${c.outcome}`,
      ...(c.users ? [`Users concerned: ${c.users}`] : []),
      ...(c.constraints.length ? [`Constraints: ${c.constraints.join("; ")}`] : []),
      `Out of scope: ${c.outOfScope.length ? c.outOfScope.join("; ") : "(none stated)"}`,
      `Acceptance: ${c.acceptance.join("; ")}`,
      ...(c.openQuestions.length ? [`Open questions: ${c.openQuestions.join("; ")}`] : []),
    ].join("\n");
  }

  /** Vue Markdown pour l'humain (format d'intention du ticket), produite
   * depuis la même source d'état que la porte. */
  markdown(): string {
    const s = this.status();
    const c = this.contract;
    const items = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_(néant)_");
    const refs = [
      c.baseRevision ? ` · révision de base \`${c.baseRevision}\`` : "",
      c.policyRef ? ` · politique \`${c.policyRef}\`` : "",
    ].join("");
    return [
      `# Intention — ${c.title}`,
      "",
      `Contrat \`${c.id}\` · empreinte \`${this.fingerprint}\``,
      `État : ${STATE_FR[s.state]} · budget : ${s.steps}/${s.maxSteps} pas${s.approval ? ` · approuvé par ${s.approval.by} le ${s.approval.at}` : ""}`,
      `Workspace : \`${c.workspace}\`${refs}`,
      "",
      "## Problème", "", c.problem, "",
      "## Résultat attendu", "", c.outcome, "",
      "## Utilisateurs concernés", "", c.users ?? "_(non précisé)_", "",
      "## Contraintes", "", items(c.constraints), "",
      "## Hors périmètre", "", items(c.outOfScope), "",
      "## Critère observable", "", items(c.acceptance), "",
      "## Questions ouvertes", "", items(c.openQuestions),
    ].join("\n");
  }
}

/** Rapport lisible par machine : ligne `[mission]` du headless et stats. */
export function missionReport(mission: Mission, status: MissionStatus = mission.status()) {
  return {
    state: status.state,
    id: mission.contract.id,
    fingerprint: mission.fingerprint,
    steps: status.steps,
    maxSteps: status.maxSteps,
    approvedBy: status.approval?.by ?? null,
    store: mission.dir,
    ...(status.reason ? { reason: status.reason } : {}),
  };
}

/** Sortie non nulle quand, à la fin d'un run headless, le contrat n'est plus
 * approuvé (budget épuisé, contrat remplacé, stockage illisible). */
export function missionExitCode(status: MissionStatus): number | null {
  return status.state === "approved" ? null : MISSION_EXIT_CODE;
}

/** Autorisation d'un run headless, décidée avant tout appel au modèle.
 * `approve` est le drapeau explicite de l'appelant : l'empreinte exacte du
 * contrat. Sans approbation valable, le run s'arrête avec un état explicite ;
 * aucune question n'est posée, rien n'attend. */
export function authorizeHeadless(mission: Mission, approve?: string): { ok: boolean; message: string; report: ReturnType<typeof missionReport> } {
  const { id } = mission.contract;
  const fp = mission.fingerprint;
  const refuse = (message: string) => ({ ok: false, message: `Nothing was run. ${message}`, report: missionReport(mission) });
  if (approve !== undefined && approve !== fp) {
    return refuse(`--approve ${approve.slice(0, 16)}… does not match the contract fingerprint ${fp}: the contract changed or another one was named. Review it and approve its current fingerprint.`);
  }
  let status = mission.status();
  if (status.state === "approved" && status.steps >= status.maxSteps) {
    try {
      mission.expire("step budget exhausted");
    } catch (err: any) {
      return refuse(`The step budget of mission "${id}" is exhausted, and its expiry could not be recorded: ${err?.message ?? err}.`);
    }
    return refuse(`The step budget of mission "${id}" is exhausted (${status.steps}/${status.maxSteps}): the contract is expired. Widen budgets.maxSteps in a new contract version and approve its fingerprint.`);
  }
  if (approve !== undefined && status.state === "proposed") {
    try {
      status = mission.approve("headless-flag", approve);
    } catch (err: any) {
      return refuse(`${err?.message ?? err}.`);
    }
  }
  if (status.state === "approved") {
    return {
      ok: true,
      message: `mission "${id}" approved (${fp.slice(0, 16)}, by ${status.approval?.by}); ${status.maxSteps - status.steps} of ${status.maxSteps} model steps left`,
      report: missionReport(mission, status),
    };
  }
  if (status.state === "proposed") return refuse(`Mission contract "${id}" is proposed, not approved. Review it, then rerun with --approve ${fp}`);
  if (status.state === "expired") return refuse(`Mission contract "${id}" is expired. Widen it (for example budgets.maxSteps) and approve the new fingerprint.`);
  return refuse(`Mission contract "${id}" is ${STATE_LABELS[status.state]}${status.reason ? ` (${status.reason})` : ""}.`);
}

/** Le profil d'une session web : seulement pour le workspace visé par le
 * contrat ; les autres workspaces du hub gardent le parcours courant. */
export function missionForWorkspace(prefs: MissionPrefs | undefined, workspace: string, dataDir?: string): Mission | null {
  if (!prefs) return null;
  let wanted: string;
  let actual: string;
  try {
    wanted = fs.realpathSync.native(prefs.workspace);
    actual = fs.realpathSync.native(workspace);
  } catch {
    return null;
  }
  return wanted === actual ? Mission.prepare({ source: prefs.source, workspace, dataDir }) : null;
}
