// Profil renforcé « mission » (ticket #8, H01) : un contrat soumis par
// l'appelant, tenu par l'hôte dans son stockage (src/harness/store.ts), et le
// parcours préparer → approuver → exécuter. Avant approbation, l'agent lit et
// planifie ; toute écriture est refusée à l'exécution. Seul l'hôte approuve :
// ni un texte du modèle, ni un fichier du workspace, ni un label de ticket.
// L'approbation ne constitue pas une isolation de sécurité.

import * as fs from "fs";
import * as path from "path";
import type { Plan, PlanHooks } from "../plan";
import { PathRules, resolveInWorkspace } from "../sandbox";
import { describeDeviation, freezeVerifiers, PlanDeviation, PlanReport, PROJECT_COMMANDS, scanWorkspace, VerifierState, verifierChanges, WorkspaceScan } from "./proofs";
import { MissionResume } from "./resume";
import {
  Approval,
  ApprovalAuthority,
  APPROVAL_AUTHORITIES,
  appendProof,
  approvalState,
  ContractError,
  contractFingerprint,
  createRecord,
  DEFAULT_POLICY,
  harnessDir,
  HarnessStoreError,
  isPlanFile,
  MissionContract,
  parseContractSource,
  parsePlanContent,
  PlanChange,
  PlanContent,
  planFingerprint,
  PLAN_REQUIRED,
  ProofEvent,
  readContract,
  readPolicy,
  readProofs,
  VerifierFreeze,
  writeContract,
  writePolicy,
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

/** L'état du plan d'implémentation de cette version du contrat (#29) :
 * aucun, proposé (le dernier proposé, en attente d'approbation), approuvé
 * avec le contrat, ou illisible dans le journal. */
export type PlanState = "none" | "proposed" | "approved" | "unreadable";

export interface PlanView {
  state: PlanState;
  /** Le contrat exige un plan approuvé avec lui (`"plan": "required"`). */
  required: boolean;
  /** Empreinte du plan proposé en attente, ou du plan approuvé. */
  fingerprint: string | null;
  content: PlanContent | null;
  /** Date de la proposition. */
  at: string | null;
  /** Plan approuvé : la version courante, reconstruite en rejouant les
   * écarts journalisés sur la version approuvée (égale à elle sans écart). */
  current: PlanContent | null;
  /** Plan approuvé : les écarts journalisés depuis l'approbation. */
  deviations: PlanDeviation[];
  reason?: string;
}

type PlanProposedEvent = Extract<ProofEvent, { kind: "proposed" }>;
type PlanDeviationEvent = Extract<ProofEvent, { kind: "deviation" }>;

/** Deux contenus identiques, clés comprises (forme canonique de l'empreinte). */
const samePlan = (a: PlanContent, b: PlanContent) => planFingerprint("", a) === planFingerprint("", b);

/** Les rubriques d'un plan qu'un écart peut réécrire. */
const PLAN_FACETS = ["steps", "files", "risks", "proofs"] as const;
type PlanFacet = (typeof PLAN_FACETS)[number];

/** Une rubrique en lignes, les preuves en « N: preuve ». */
function facetLines(c: PlanContent, f: PlanFacet): string[] {
  return f === "proofs" ? c.proofs.map((p) => `${p.criterion}: ${p.proof}`) : [...c[f]];
}

/** Rejoue l'après d'un écart de rubrique sur un contenu. */
function applyFacet(c: PlanContent, f: PlanChange, after: string[]): PlanContent {
  if (f === "file") return c;
  if (f !== "proofs") return { ...c, [f]: [...after] };
  return {
    ...c,
    proofs: after.map((l) => {
      const i = l.indexOf(": ");
      return { criterion: Number(l.slice(0, i)), proof: l.slice(i + 2) };
    }),
  };
}

/** Un chemin écrit est-il au plan ? `dossier/` couvre tout ce qu'il contient. */
const planCovers = (files: string[], rel: string) => files.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f));

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
  /** La reprise durable de cette session (#10) : journal d'effets, état
   * incertain, suspension. Ouverte par l'hôte de la session (terminal, web,
   * headless), ou à défaut au premier effet. */
  private resumeState: MissionResume | null = null;

  private constructor(
    readonly workspace: string,
    readonly source: string,
    readonly dir: string,
    readonly contract: MissionContract,
    readonly fingerprint: string
  ) {}

  /** Ouvre la reprise pour la session qui porte ce contrat : relit le journal
   * d'effets et rend incertaine toute action sans résultat (#10). */
  openResume(surface: string): MissionResume {
    if (this.resumeState) return this.resumeState;
    this.resumeState = new MissionResume(this, surface);
    this.resumeState.open();
    return this.resumeState;
  }

  /** La reprise de cette session, ouverte au besoin. */
  get resume(): MissionResume {
    return this.resumeState ?? this.openResume("agent");
  }

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
    // Politique d'accès (#11) : l'hôte pose la politique par défaut du profil
    // quand le stockage n'en a aucune. Celle que l'appelant a écrite est
    // gardée telle quelle ; une politique illisible n'est jamais écrasée —
    // chaque décision la refusera jusqu'à réparation à la main.
    if (readPolicy(dir).state === "absent") writePolicy(dir, DEFAULT_POLICY);
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
   * toujours sa trace). Elle fige aussi les entrées du vérificateur (#9) :
   * tests, configuration et scripts qui les exécutent, tels que l'hôte les
   * voit en approuvant ; `commands` ajoute une commande de l'appelant
   * (--verify) à celles du contrat. `plan` (#29) : l'empreinte exacte du
   * plan proposé que l'hôte approuve avec le contrat ; l'événement
   * d'approbation la porte. Sans elle, le contrat seul est approuvé — sauf
   * s'il exige un plan. */
  approve(by: ApprovalAuthority, fingerprint: string = this.fingerprint, opts: { commands?: string[]; plan?: string } = {}): MissionStatus {
    if (!APPROVAL_AUTHORITIES.includes(by)) throw new MissionError(`approval "by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
    if (fingerprint !== this.fingerprint) {
      throw new MissionError(`approval fingerprint ${fingerprint.slice(0, 16)}… does not match the contract fingerprint ${this.fingerprint}`);
    }
    const read = readContract(this.dir);
    if (read.state !== "ok") throw new MissionError(`host contract store is ${read.state} (${this.dir}): nothing was approved`);
    const current = this.status();
    if (current.state === "approved") {
      if (opts.plan !== undefined && opts.plan !== current.approval?.plan) {
        const approved = current.approval?.plan;
        throw new MissionError(`the mission contract "${this.contract.id}" is already approved ${approved ? `with plan ${approved.slice(0, 16)}…` : "without a plan"}: a plan is approved only together with the contract, so nothing was approved`);
      }
      return current;
    }
    if (current.state === "expired") {
      throw new MissionError(`the mission contract "${this.contract.id}" is expired: approving it again cannot extend it. Widen it (for example budgets.maxSteps) and approve the new fingerprint.`);
    }
    if (current.state !== "proposed") throw new MissionError(`the mission contract "${this.contract.id}" is ${STATE_LABELS[current.state]}: nothing was approved`);
    if (current.steps >= current.maxSteps) {
      throw new MissionError(`the step budget of "${this.contract.id}" is already spent (${current.steps}/${current.maxSteps}): widen budgets.maxSteps before approving`);
    }
    // #29 : le plan approuvé est exactement celui que l'hôte a vu, et un
    // contrat qui exige un plan ne s'approuve jamais sans lui.
    const plan = this.planView();
    if (opts.plan !== undefined) {
      if (plan.state !== "proposed") throw new MissionError(`no implementation plan is proposed for the mission contract "${this.contract.id}"${plan.state === "unreadable" ? ` (${plan.reason})` : ""}: nothing was approved`);
      if (plan.fingerprint !== opts.plan) {
        throw new MissionError(`plan fingerprint ${opts.plan.slice(0, 16)}… does not match the proposed plan ${plan.fingerprint}: the plan changed or another one was named. Review it and approve its current fingerprint; nothing was approved`);
      }
    } else if (plan.required) {
      throw new MissionError(
        `the mission contract "${this.contract.id}" requires an implementation plan approved with it: ` +
          (plan.state === "proposed"
            ? `approve the proposed plan ${plan.fingerprint} together with the contract`
            : 'the agent proposes one first (plan tool, action "propose"; headless: a --propose-plan run)') +
          "; nothing was approved"
      );
    }
    const frozen = this.freeze(this.verifierCommands(opts.commands));
    const withPlan = opts.plan !== undefined ? { plan: opts.plan } : {};
    const approval: Approval = { fingerprint: this.fingerprint, by, at: new Date().toISOString(), verifiers: frozen, ...withPlan };
    appendProof(this.dir, { type: "approval", fingerprint: this.fingerprint, by, verifiers: frozen?.digest ?? null, ...withPlan });
    writeContract(this.dir, createRecord(this.contract, { status: "approved", approval, steps: read.record.usage.steps }));
    return this.status();
  }

  // ---- plan d'implémentation (#29) ----------------------------------------

  /** Le plan de cette version du contrat, relu dans le stockage hôte : le
   * plan approuvé avec elle (son contenu vient de la proposition journalisée
   * qui porte la même empreinte), sinon le dernier proposé tant qu'elle
   * attend son approbation. Un contrat approuvé sans plan n'en a aucun. */
  planView(): PlanView {
    const required = this.contract.plan === PLAN_REQUIRED;
    const none: PlanView = { state: "none", required, fingerprint: null, content: null, at: null, current: null, deviations: [] };
    const read = readContract(this.dir);
    const record = read.state === "ok" && read.record.fingerprint === this.fingerprint ? read.record : null;
    const approval = record?.approval?.fingerprint === this.fingerprint ? record.approval : null;
    if (approval && !approval.plan) return none;
    if (!approval && (!record || approvalState(record) !== "proposed")) return none;
    const journal = readProofs(this.dir);
    if (journal.state === "unreadable" || journal.state === "unknown-schema") {
      // Illisible ne se dit que d'un plan qu'une approbation nomme ; sans
      // elle, un journal abîmé ne fait pas apparaître de plan.
      return approval?.plan ? { ...none, state: "unreadable", fingerprint: approval.plan, reason: `the proof journal is ${journal.state}` } : none;
    }
    const events = journal.state === "absent" ? [] : journal.events;
    const proposals = events.filter((e: ProofEvent): e is PlanProposedEvent => e.type === "plan" && e.kind === "proposed" && e.fingerprint === this.fingerprint);
    if (approval?.plan) {
      const p = proposals.find((e) => e.plan === approval.plan);
      if (!p) return { ...none, state: "unreadable", fingerprint: approval.plan, reason: `the approved plan ${approval.plan.slice(0, 16)}… is missing from the proof journal` };
      // La version approuvée ne bouge jamais ; la courante se reconstruit en
      // rejouant les écarts, dans l'ordre du journal.
      const devs = events.filter((e: ProofEvent): e is PlanDeviationEvent => e.type === "plan" && e.kind === "deviation" && e.fingerprint === this.fingerprint && e.plan === p.plan);
      let current = p.content;
      for (const d of devs) current = applyFacet(current, d.change, d.after);
      const deviations = devs.map((d) => ({ at: d.at, change: d.change, before: d.before, after: d.after, reason: d.reason }));
      return { state: "approved", required, fingerprint: p.plan, content: p.content, at: p.at, current, deviations };
    }
    const last = proposals.at(-1);
    return last ? { ...none, state: "proposed", fingerprint: last.plan, content: last.content, at: last.at } : none;
  }

  /** Journalise, rubrique par rubrique, ce qui change entre deux versions du
   * plan après approbation. Rend les rubriques changées. */
  private recordDeviations(before: PlanContent, after: PlanContent, reason: string | null, planFp: string): PlanChange[] {
    const changed: PlanChange[] = [];
    for (const f of PLAN_FACETS) {
      const b = facetLines(before, f);
      const a = facetLines(after, f);
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      appendProof(this.dir, { type: "plan", fingerprint: this.fingerprint, kind: "deviation", plan: planFp, change: f, before: b, after: a, reason });
      changed.push(f);
    }
    return changed;
  }

  /** Le chemin relatif du workspace d'un fichier que l'agent vient d'écrire. */
  private relativeOf(p: string): string | null {
    try {
      const abs = resolveInWorkspace(this.workspace, p);
      let rel = path.relative(this.workspace, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) rel = path.relative(this.workspace, path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)));
      rel = rel.split(path.sep).join("/");
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
    } catch {
      return null;
    }
  }

  /** Les critères d'acceptation (numéros à partir de 1) qu'aucun contrôle de
   * l'hôte ne couvre et pour lesquels le plan ne prévoit aucune preuve. Un
   * critère couvert par `checks` (#9) a déjà sa preuve : l'hôte la produit. */
  missingProofs(content: PlanContent | null = this.planView().content): number[] {
    if (!content) return [];
    const covered = new Set((this.contract.checks ?? []).flatMap((k) => k.covers));
    const planned = new Set(content.proofs.map((p) => p.criterion));
    return this.contract.acceptance.map((_, i) => i + 1).filter((n) => !covered.has(n) && !planned.has(n));
  }

  /** Chemins du plan écrits à la façon du workspace : sans `./`, relatifs
   * même donnés en absolu dans le workspace, sans doublon. */
  private normalizePlan(c: PlanContent): PlanContent {
    const files = c.files.map((f) => {
      let p = f.trim();
      const dir = p.endsWith("/");
      if (path.isAbsolute(p)) {
        const rel = path.relative(this.workspace, p);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) p = rel.split(path.sep).join("/") + (dir ? "/" : "");
      }
      while (p.startsWith("./")) p = p.slice(2);
      return p;
    });
    return { ...c, files: [...new Set(files)] };
  }

  /** Enregistre la proposition de l'agent pour ce contrat, tant qu'il attend
   * son approbation : un événement `plan` (`proposed`) au journal, contenu
   * entier et empreinte. Une proposition identique à la précédente n'ajoute
   * rien. Grammaire refusée : MissionError, rien n'est écrit. */
  proposePlan(raw: PlanContent): { fingerprint: string; content: PlanContent; missing: number[]; recorded: boolean } {
    const st = this.status();
    if (st.state !== "proposed") {
      throw new MissionError(
        st.state === "approved"
          ? `the mission contract "${this.contract.id}" is already approved${this.planView().state === "none" ? " without a plan" : " with its plan"}: a plan is approved only together with the contract`
          : `the mission contract "${this.contract.id}" is ${STATE_LABELS[st.state]}: no plan can be proposed for it`
      );
    }
    let content: PlanContent;
    try {
      content = parsePlanContent(this.normalizePlan(raw), this.contract.acceptance.length);
    } catch (err: any) {
      if (err instanceof ContractError) throw new MissionError(err.message.replace(/^plan field /, ""));
      throw err;
    }
    const fingerprint = planFingerprint(this.fingerprint, content);
    const view = this.planView();
    const recorded = !(view.state === "proposed" && view.fingerprint === fingerprint);
    if (recorded) appendProof(this.dir, { type: "plan", fingerprint: this.fingerprint, kind: "proposed", plan: fingerprint, content });
    return { fingerprint, content, missing: this.missingProofs(content), recorded };
  }

  /** La preuve prévue de chaque critère, pour le modèle : contrôle de l'hôte,
   * preuve déclarée, ou absence signalée. */
  private proofLines(content: PlanContent): string[] {
    return this.contract.acceptance.map((_, i) => {
      const n = i + 1;
      const check = this.contract.checks?.some((k) => k.covers.includes(n));
      const p = content.proofs.find((x) => x.criterion === n);
      if (check) return `${n}. host check (run by the host)${p ? `; also planned: ${p.proof}` : ""}`;
      if (p) return `${n}. planned: ${p.proof}`;
      return `${n}. NO PLANNED PROOF — add "${n}: <how it will be proven>" to "proofs" and propose again, or tell the host why it cannot be proven`;
    });
  }

  /** Le plan approuvé avec ce contrat, s'il est en vigueur (#29). */
  private approvedPlan(): PlanView | null {
    if (this.status().state !== "approved") return null;
    const v = this.planView();
    return v.state === "approved" && v.content && v.current ? v : null;
  }

  /** Valide un contenu réécrit après approbation (même grammaire que la
   * proposition) ; MissionError sinon. */
  private checkedContent(raw: PlanContent): PlanContent {
    try {
      return parsePlanContent(this.normalizePlan(raw), this.contract.acceptance.length);
    } catch (err: any) {
      if (err instanceof ContractError) throw new MissionError(err.message.replace(/^plan field /, ""));
      throw err;
    }
  }

  /** Ce que l'hôte fait de l'outil plan sous ce contrat. Avant approbation,
   * les propositions sont validées et journalisées, et une checklist
   * structurée modifiée par set ou add devient la nouvelle proposition.
   * Après approbation avec un plan, tout changement du plan et toute
   * écriture hors du plan deviennent des écarts journalisés — jamais des
   * refus, jamais un remplacement du plan approuvé. */
  planHooks(): PlanHooks {
    const why = (reason: string | null) => (reason ? "" : ' Next time, say why with "reason".');
    return {
      propose: (content, reason, current) => {
        try {
          const approved = this.approvedPlan();
          if (approved) {
            // Réécriture après approbation : un écart par rubrique changée,
            // la version approuvée reste celle du journal.
            const next = this.checkedContent(content);
            const changed = this.recordDeviations(current ?? approved.current!, next, reason, approved.fingerprint!);
            const fp = approved.fingerprint!.slice(0, 16);
            const head = changed.length
              ? `Plan rewritten after approval: recorded as a deviation from the approved plan ${fp} (${changed.join(", ")}) for the host's review, never blocked; the approved plan stays readable as it was approved.${why(reason)}`
              : `Plan unchanged: it matches your current plan (approved plan ${fp}).`;
            return { ok: true, content: next, message: [head, "Expected proof per acceptance criterion:", ...this.proofLines(next)].join("\n") };
          }
          const r = this.proposePlan(content);
          const fp = r.fingerprint.slice(0, 16);
          const head = r.recorded
            ? `Plan proposed (fingerprint ${fp}; ${r.content.steps.length} steps, ${r.content.files.length} files). The host reviews it with the contract and approves both, or not; writes and commands stay blocked until then — wait for the host, do not start the work.`
            : `Plan unchanged (fingerprint ${fp}): the host already has this version.`;
          return { ok: true, content: r.content, message: [head, "Expected proof per acceptance criterion:", ...this.proofLines(r.content)].join("\n") };
        } catch (err: any) {
          return { ok: false, message: String(err?.message ?? err) + (err instanceof MissionError && /already approved without a plan/.test(err.message) ? '. Keep your working checklist with {"action":"set","steps":"..."}.' : "") };
        }
      },
      changed: (before, after, reason) => {
        if (samePlan(before, after)) return "";
        const approved = this.approvedPlan();
        if (approved) {
          try {
            const next = this.checkedContent(after);
            const changed = this.recordDeviations(before, next, reason, approved.fingerprint!);
            return changed.length
              ? `\n[Plan: changed after the host approved plan ${approved.fingerprint!.slice(0, 16)} — recorded as a deviation (${changed.join(", ")}) for the host's review, never blocked.${why(reason)}]`
              : "";
          } catch (err: any) {
            return `Error: this plan change cannot be recorded for the host (${err?.message ?? err}); your plan was left as it was.`;
          }
        }
        if (this.planView().state !== "proposed") return "";
        try {
          const r = this.proposePlan(after);
          return r.recorded ? `\nProposed plan updated (fingerprint ${r.fingerprint.slice(0, 16)}): the host approves this version with the contract.` : "";
        } catch (err: any) {
          return `Error: the proposed plan cannot be updated (${err?.message ?? err}); your plan was left as it was.`;
        }
      },
      wrote: (p) => {
        const approved = this.approvedPlan();
        if (!approved) return "";
        const rel = this.relativeOf(p);
        if (!rel || planCovers(approved.content!.files, rel) || planCovers(approved.current!.files, rel)) return "";
        if (approved.deviations.some((d) => d.change === "file" && d.after[0] === rel)) return "";
        try {
          appendProof(this.dir, { type: "plan", fingerprint: this.fingerprint, kind: "deviation", plan: approved.fingerprint!, change: "file", before: [], after: [rel], reason: null });
        } catch (err: any) {
          return `\n[Plan: "${rel}" is not among the files of the approved plan, and this deviation could not be recorded (${err?.message ?? err}).]`;
        }
        return `\n[Plan: "${rel}" is not among the files of the approved plan — recorded as a deviation for the host's review, never blocked. If it belongs to the work, say why: plan {"action":"add","text":"<step>","files":"${rel}","reason":"<why>"}.]`;
      },
      files: (list) => {
        const files = this.normalizePlan({ steps: [], files: list, risks: [], proofs: [] }).files;
        const bad = files.find((f) => !isPlanFile(f));
        return bad === undefined ? { ok: true, files } : { ok: false, message: `"files" names ${JSON.stringify(bad)}, which is not a relative path inside the workspace (no "..", no leading "/")` };
      },
    };
  }

  /** Pose sur une checklist vide le plan en vigueur : la version courante du
   * plan approuvé (l'approuvée, réécrite par les écarts journalisés), sinon
   * celui qui attend son approbation. La boussole suit le stockage hôte. */
  seedPlan(plan: Plan): void {
    if (plan.exists) return;
    const v = this.planView();
    if (v.state === "approved" && v.current) plan.adopt(v.current);
    else if (v.state === "proposed" && v.content) plan.adopt(v.content);
  }

  /** Le plan pour le rapport de #9 (report.json, report.md) ; null sans plan
   * ni exigence, pour que le rapport ne change pas alors. */
  planReport(): PlanReport | null {
    const v = this.planView();
    if (v.state === "none" && !v.required) return null;
    const content = v.state === "approved" ? v.current : v.state === "proposed" ? v.content : null;
    return {
      state: v.state,
      required: v.required,
      fingerprint: v.fingerprint,
      approved: v.state === "approved" ? v.content : null,
      proposed: v.state === "proposed" ? v.content : null,
      current: v.state === "approved" && v.current && v.content && !samePlan(v.current, v.content) ? v.current : null,
      missingProofs: this.missingProofs(content).map((n) => `acceptance-${n}`),
      deviations: v.deviations,
      note: "Declared by the agent and approved by the host: a guide, never evidence and never a cage — deviations are listed for review and change no status.",
    };
  }

  /** Vue Markdown du plan pour l'humain, à côté de celle du contrat ; vide
   * sans plan (et sans exigence de plan), pour que rien ne change alors. */
  planMarkdown(): string {
    const v = this.planView();
    if (v.state === "none") {
      return v.required
        ? "## Plan d'implémentation — exigé par le contrat, aucun proposé\n\nL'agent le propose avant approbation (outil plan, action « propose ») ; en headless, un run `--propose-plan`. Le contrat ne s'approuve qu'avec lui."
        : "";
    }
    if (v.state === "unreadable" || !v.content) return `## Plan d'implémentation — illisible\n\n${v.reason ?? "contenu introuvable"}${v.fingerprint ? ` (empreinte \`${v.fingerprint}\`)` : ""}.`;
    const c = v.content;
    const criteria = this.contract.acceptance.map((a, i) => {
      const n = i + 1;
      const check = this.contract.checks?.find((k) => k.covers.includes(n));
      const p = c.proofs.find((x) => x.criterion === n);
      const parts = [check ? `contrôle de l'hôte : \`${check.command}\`` : "", p ? `preuve prévue : ${p.proof}` : ""].filter(Boolean);
      return `${n}. ${a} — ${parts.length ? parts.join(" ; ") : "**aucune preuve prévue**"}`;
    });
    const missing = this.missingProofs(c);
    // Après approbation : la version courante quand l'agent a réécrit son
    // plan, puis les écarts — l'approuvée reste affichée telle quelle.
    const cur = v.state === "approved" && v.current && !samePlan(v.current, c) ? v.current : null;
    const after = v.state !== "approved" ? [] : [
      ...(cur
        ? [
            "",
            `### Plan courant — réécrit après approbation (empreinte \`${planFingerprint(this.fingerprint, cur)}\`)`,
            "",
            ...cur.steps.map((s, i) => `${i + 1}. ${s}`),
            "",
            `Fichiers : ${cur.files.map((f) => `\`${f}\``).join(", ")}.`,
            ...(cur.risks.length ? [`Risques : ${cur.risks.join(" ; ")}.`] : []),
            ...(cur.proofs.length ? [`Preuves prévues : ${cur.proofs.map((p) => `${p.criterion}: ${p.proof}`).join(" ; ")}.`] : []),
          ]
        : []),
      "",
      "### Écarts au plan approuvé (journalisés, jamais bloquants)",
      "",
      ...(v.deviations.length ? v.deviations.map((d) => `- ${d.at} — ${describeDeviation(d)}`) : ["_(aucun)_"]),
    ];
    return [
      `## Plan d'implémentation — ${v.state === "proposed" ? "proposé, en attente d'approbation avec le contrat" : "approuvé avec le contrat"}`,
      "",
      `Empreinte \`${v.fingerprint}\` · proposé le ${v.at} · ${c.steps.length} étape(s) · ${c.files.length} fichier(s)${v.required ? " · exigé par le contrat" : ""}`,
      "Un guide, pas une cage : après approbation, un écart est journalisé et montré, jamais bloqué.",
      "",
      "### Ordre des travaux", "", ...c.steps.map((s, i) => `${i + 1}. ${s}`), "",
      "### Fichiers à créer ou modifier", "", ...c.files.map((f) => `- \`${f}\``), "",
      "### Risques et contraintes techniques", "", ...(c.risks.length ? c.risks.map((r) => `- ${r}`) : ["_(aucun déclaré)_"]), "",
      "### Preuve attendue par critère d'acceptation", "", ...criteria,
      ...(missing.length ? ["", `Critère(s) sans preuve prévue : ${missing.join(", ")}.`] : []),
      ...after,
    ].join("\n");
  }

  /** Les entrées figées par l'approbation en vigueur ; {} sans elle. */
  frozenVerifierFiles(): Record<string, string | null> {
    const read = readContract(this.dir);
    if (read.state !== "ok" || read.record.fingerprint !== this.fingerprint || approvalState(read.record) !== "approved") return {};
    return { ...(read.record.approval?.verifiers?.files ?? {}) };
  }

  /** Les noms protégés de la politique : jamais lus pour une empreinte. */
  pathRules(): PathRules {
    const p = readPolicy(this.dir);
    return p.state === "ok" ? p.policy.paths : DEFAULT_POLICY.paths;
  }

  /** Les commandes dont les scripts nommés sont figés : les contrôles du
   * contrat, celles de l'appelant, et les contrôles découvrables du projet. */
  verifierCommands(extra: string[] = []): string[] {
    return [...new Set([...(this.contract.checks ?? []).map((c) => c.command), ...extra.map((c) => c.trim()).filter(Boolean), ...PROJECT_COMMANDS])];
  }

  /** Empreinte actuelle du workspace (noms protégés exclus). */
  scan(): WorkspaceScan {
    return scanWorkspace(this.workspace, this.pathRules());
  }

  private freeze(commands: string[], scan: WorkspaceScan = this.scan()): VerifierFreeze | null {
    const r = freezeVerifiers(this.workspace, scan, commands);
    return "freeze" in r ? r.freeze : null;
  }

  /** L'état des entrées du vérificateur au regard de l'approbation en
   * vigueur : figées et intactes, modifiées (avec la liste), ou non figées. */
  verifierState(commands: string[] = this.verifierCommands(), scan?: WorkspaceScan): VerifierState {
    const read = readContract(this.dir);
    const record = read.state === "ok" && read.record.fingerprint === this.fingerprint ? read.record : null;
    const frozen = record && approvalState(record) === "approved" ? record.approval?.verifiers ?? null : null;
    if (!record || approvalState(record) !== "approved") return { state: "unfrozen", frozen: null, current: null, changes: [], reason: "the contract is not approved" };
    const s = scan ?? this.scan();
    const now = freezeVerifiers(this.workspace, s, commands);
    const current = "freeze" in now ? now.freeze.digest : null;
    if (!frozen) return { state: "unfrozen", frozen: null, current, changes: [], reason: "approved before verifier inputs were frozen, or they exceeded the bounds at approval" + ("reason" in now ? ` (${now.reason})` : "") };
    if (!s.ok) return { state: "changed", frozen: frozen.digest, current: null, changes: [], reason: `the workspace cannot be fingerprinted (${s.reason})` };
    const changes = verifierChanges(this.workspace, s, frozen.files, commands);
    return changes.length ? { state: "changed", frozen: frozen.digest, current, changes } : { state: "frozen", frozen: frozen.digest, current, changes: [] };
  }

  /** Nouvelle approbation des entrées du vérificateur, par l'hôte, sous un
   * contrat déjà approuvé : `digest` nomme exactement ce qui sera figé (tel
   * que l'affiche l'état du vérificateur). Un événement `approval` au
   * journal d'abord, puis contract.json. */
  approveVerifiers(by: ApprovalAuthority, digest: string, opts: { commands?: string[] } = {}): VerifierState {
    if (!APPROVAL_AUTHORITIES.includes(by)) throw new MissionError(`approval "by" must be one of ${APPROVAL_AUTHORITIES.join(", ")}`);
    const read = readContract(this.dir);
    if (read.state !== "ok" || read.record.fingerprint !== this.fingerprint || approvalState(read.record) !== "approved") {
      throw new MissionError(`the mission contract "${this.contract.id}" is not approved: approve the contract itself first`);
    }
    const commands = this.verifierCommands(opts.commands);
    const scan = this.scan();
    const now = freezeVerifiers(this.workspace, scan, commands);
    if (!("freeze" in now)) throw new MissionError(`the verifier inputs cannot be frozen (${now.reason}): nothing was approved`);
    if (now.freeze.digest !== digest) {
      throw new MissionError(`verifier fingerprint ${digest.slice(0, 16)}… does not match the current verifier inputs ${now.freeze.digest}: they changed, or another state was named. Review them and approve the current fingerprint.`);
    }
    const state = this.verifierState(commands, scan);
    if (state.state === "frozen") return state;
    // Une approbation par sujet : celle des entrées ne touche pas au plan
    // approuvé avec le contrat (#29), que contract.json garde.
    const plan = read.record.approval?.plan;
    const approval: Approval = { fingerprint: this.fingerprint, by, at: new Date().toISOString(), verifiers: now.freeze, ...(plan ? { plan } : {}) };
    appendProof(this.dir, { type: "approval", fingerprint: this.fingerprint, by, verifiers: now.freeze.digest });
    writeContract(this.dir, { ...read.record, approval, updatedAt: new Date().toISOString() });
    return this.verifierState(commands);
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

  /** Trace la lecture d'une fiche de méthode installée (#30) : son nom et
   * l'empreinte du contenu servi, liés au contrat de cette session. Appelée
   * avant de servir la fiche : un journal qui refuse l'écriture (ligne
   * tronquée, borne) lève, et la fiche n'est pas servie. */
  recordFiche(name: string, sha256: string): void {
    appendProof(this.dir, { type: "fiche", fingerprint: this.fingerprint, name, sha256 });
  }

  /** La porte d'écriture, consultée par l'agent avant chaque outil : null
   * autorise, sinon la raison du refus renvoyée au modèle. L'état est relu
   * dans le stockage hôte : ce que le modèle écrit ou prétend n'y change rien. */
  denial(tool: string, args: Record<string, any> = {}): string | null {
    if (PREPARE_TOOLS.has(tool) || (tool === "task" && PREPARE_TASK_ACTIONS.has(String(args?.action)))) return null;
    const s = this.status();
    if (s.state === "approved") {
      // #10 : un effet incertain, un journal abîmé suspendent les effets du
      // modèle et les vérifications ; le terminal web reste à l'humain.
      return tool === "terminal" ? null : this.resume.denial();
    }
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
      c.checks?.length
        ? `Host checks: acceptance criteria ${c.checks.flatMap((k) => k.covers).sort((a, b) => a - b).join(", ")} are checked by the host itself; the others are not covered by any check.`
        : "Host checks: none — no acceptance criterion is covered by a host check.",
      "Verification: the host runs the decisive checks itself. The tests, their configuration and the scripts that run them are frozen when the host approves; changing them never earns acceptance — it blocks it until the host approves them again.",
      ...this.planModelLines(s.state),
      ...(c.openQuestions.length ? [`Open questions: ${c.openQuestions.join("; ")}`] : []),
    ].join("\n");
  }

  /** Le plan dans le bloc du contrat (#29) : rien sans plan ni exigence. */
  private planModelLines(state: MissionState): string[] {
    const v = this.planView();
    const fp = v.fingerprint?.slice(0, 16);
    if (v.state === "proposed") return [`Plan: proposed ${fp} (${v.content!.steps.length} steps, ${v.content!.files.length} files) — awaiting the host's approval with the contract.`];
    if (v.state === "approved") {
      return [
        `Plan: approved ${fp} with the contract. It is a guide, not a cage: another file or a changed step is allowed and shown to the host — say why in "reason". Files: ${v.content!.files.join(", ")}.` +
          (v.deviations.length ? ` Deviations recorded so far: ${v.deviations.length} (the host reviews them).` : ""),
      ];
    }
    if (v.state === "unreadable") return [`Plan: the plan approved with the contract cannot be read from the host journal (${v.reason}).`];
    if (v.required && state !== "approved") return ['Plan: the host requires an implementation plan approved with the contract — propose it with the plan tool (action "propose") before approval.'];
    return [];
  }

  /** Vue Markdown pour l'humain (format d'intention du ticket), produite
   * depuis la même source d'état que la porte. */
  markdown(): string {
    const s = this.status();
    const c = this.contract;
    const items = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_(néant)_");
    const checkOf = (i: number) => c.checks?.find((k) => k.covers.includes(i + 1));
    const criteria = c.acceptance.map((a, i) => {
      const k = checkOf(i);
      return `${i + 1}. ${a} — ${k ? `contrôle de l'hôte : \`${k.command}\`` : "non couvert par un contrôle de l'hôte"}`;
    });
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
      "## Critère observable", "", criteria.join("\n"), "",
      "## Questions ouvertes", "", items(c.openQuestions),
    ].join("\n");
  }
}

/** Rapport lisible par machine : ligne `[mission]` du headless et stats.
 * `policy` : version de la politique d'accès, ou l'état qui empêche de la lire. */
export function missionReport(mission: Mission, status: MissionStatus = mission.status(), verifiers?: VerifierState) {
  const policy = readPolicy(mission.dir);
  const plan = mission.planView();
  return {
    state: status.state,
    id: mission.contract.id,
    fingerprint: mission.fingerprint,
    steps: status.steps,
    maxSteps: status.maxSteps,
    approvedBy: status.approval?.by ?? null,
    store: mission.dir,
    policy: policy.state === "ok" ? policy.version : policy.state,
    ...(status.reason ? { reason: status.reason } : {}),
    // #9 : l'état des entrées du vérificateur et l'empreinte qu'une nouvelle
    // approbation figerait (--approve-verifiers).
    ...(verifiers ? { verifiers: { state: verifiers.state, frozen: verifiers.frozen, current: verifiers.current, ...(verifiers.changes.length ? { changes: verifiers.changes.slice(0, 20) } : {}) } } : {}),
    // #29 : le plan, seulement quand il existe ou que le contrat l'exige —
    // l'empreinte qu'--approve-plan doit nommer, les critères sans preuve prévue.
    ...(plan.state !== "none" || plan.required
      ? {
          plan: {
            state: plan.state,
            required: plan.required,
            fingerprint: plan.fingerprint,
            ...(plan.content ? { steps: plan.content.steps.length, files: plan.content.files.length, missingProofs: mission.missingProofs(plan.content) } : {}),
            ...(plan.reason ? { reason: plan.reason } : {}),
          },
        }
      : {}),
  };
}

/** Le complément de la requête d'un run `--propose-plan` (#29). */
export function proposalInstruction(): string {
  return (
    "\n\n[Plan proposal run: the host has not approved the contract, and nothing can be written or run in this run. " +
    'Read what you need, then propose your implementation plan with the plan tool: {"action":"propose","steps":"...","files":"...","risks":"...","proofs":"1: ...\\n2: ..."}. ' +
    "Then stop: the host reviews the plan with the contract and approves both, or not.]"
  );
}

/** Autorisation d'un run headless `--propose-plan` (#29) : seulement sous un
 * contrat proposé, jamais approuvé — l'agent y lit et propose, rien d'autre. */
export function authorizeProposal(mission: Mission): { ok: boolean; message: string; report: ReturnType<typeof missionReport> } {
  const { id } = mission.contract;
  const refuse = (message: string) => ({ ok: false, message: `Nothing was run. ${message}`, report: missionReport(mission) });
  const status = mission.status();
  if (status.state === "approved") {
    return refuse(`Mission contract "${id}" is already approved: a plan is proposed before approval, together with the contract, so there is nothing left to propose. Run without --propose-plan.`);
  }
  if (status.state !== "proposed") return refuse(`Mission contract "${id}" is ${STATE_LABELS[status.state]}${status.reason ? ` (${status.reason})` : ""}: no plan can be proposed for it.`);
  const policy = readPolicy(mission.dir);
  if (policy.state !== "ok") {
    return refuse(`The access policy of mission "${id}" is ${policy.state === "absent" ? "missing from" : `${policy.state} in`} the host store (${mission.dir}): the controller cannot decide, so nothing may run.`);
  }
  return {
    ok: true,
    message: `plan proposal run for mission "${id}" (${mission.fingerprint.slice(0, 16)}): read-only, nothing is written or checked; the host reviews the plan with the contract afterwards`,
    report: missionReport(mission),
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
export function authorizeHeadless(
  mission: Mission,
  approve?: string,
  opts: { verify?: string; approveVerifiers?: string; approvePlan?: string } = {}
): { ok: boolean; message: string; report: ReturnType<typeof missionReport>; verifiers?: VerifierState } {
  const { id } = mission.contract;
  const fp = mission.fingerprint;
  const commands = opts.verify ? [opts.verify] : [];
  const refuse = (message: string) => ({ ok: false, message: `Nothing was run. ${message}`, report: missionReport(mission) });
  if (approve !== undefined && approve !== fp) {
    return refuse(`--approve ${approve.slice(0, 16)}… does not match the contract fingerprint ${fp}: the contract changed or another one was named. Review it and approve its current fingerprint.`);
  }
  // #29 : le plan proposé tel que l'hôte le voit avant d'approuver.
  const proposed = mission.planView();
  let status = mission.status();
  if (status.state === "approved" && status.steps >= status.maxSteps) {
    try {
      mission.expire("step budget exhausted");
    } catch (err: any) {
      return refuse(`The step budget of mission "${id}" is exhausted, and its expiry could not be recorded: ${err?.message ?? err}.`);
    }
    return refuse(`The step budget of mission "${id}" is exhausted (${status.steps}/${status.maxSteps}): the contract is expired. Widen budgets.maxSteps in a new contract version and approve its fingerprint.`);
  }
  // Le contrôleur d'accès (#11) doit pouvoir décider avant qu'un run parte :
  // une politique illisible bloquerait chaque action, autant le dire d'emblée,
  // avant d'enregistrer quoi que ce soit.
  const policy = readPolicy(mission.dir);
  if (policy.state !== "ok") {
    return refuse(`The access policy of mission "${id}" is ${policy.state === "absent" ? "missing from" : `${policy.state} in`} the host store (${mission.dir}): the controller cannot decide, so nothing may run. Repair or remove policy.json by hand (removing it restores the default policy at the next run).`);
  }
  if (approve !== undefined && (status.state === "proposed" || (status.state === "approved" && opts.approvePlan !== undefined))) {
    try {
      status = mission.approve("headless-flag", approve, { commands, ...(opts.approvePlan !== undefined ? { plan: opts.approvePlan } : {}) });
    } catch (err: any) {
      return refuse(`${err?.message ?? err}.`);
    }
  }
  if (status.state === "approved") {
    // #9 : nouvelle approbation des entrées du vérificateur, seulement quand
    // l'appelant nomme exactement l'empreinte de ce qui sera figé.
    if (opts.approveVerifiers !== undefined) {
      try {
        mission.approveVerifiers("headless-flag", opts.approveVerifiers, { commands });
      } catch (err: any) {
        return refuse(`${err?.message ?? err}.`);
      }
    }
    const verifiers = mission.verifierState(mission.verifierCommands(commands));
    const plan = status.approval?.plan;
    // Un plan proposé que l'appelant n'a pas nommé reste non approuvé : dit
    // une fois, au moment où l'approbation se fait sans lui.
    const unapproved = approve !== undefined && !plan && proposed.state === "proposed" && proposed.fingerprint
      ? `; the proposed plan ${proposed.fingerprint.slice(0, 16)} was not approved (--approve-plan ${proposed.fingerprint} approves it with the contract): this run has no plan baseline`
      : "";
    return {
      ok: true,
      message: `mission "${id}" approved (${fp.slice(0, 16)}, by ${status.approval?.by}${plan ? `, with plan ${plan.slice(0, 16)}` : ""}); ${status.maxSteps - status.steps} of ${status.maxSteps} model steps left${unapproved}`,
      report: missionReport(mission, status, verifiers),
      verifiers,
    };
  }
  if (opts.approveVerifiers !== undefined) return refuse(`--approve-verifiers needs an approved contract; mission contract "${id}" is ${STATE_LABELS[status.state]}.`);
  if (status.state === "proposed" && proposed.state === "proposed") {
    return refuse(
      `Mission contract "${id}" is proposed, not approved, and the agent proposed an implementation plan. Review both, then rerun with --approve ${fp} --approve-plan ${proposed.fingerprint}` +
        (proposed.required ? " (this contract requires its plan)." : ` — or --approve ${fp} alone to approve the contract without the plan.`)
    );
  }
  if (status.state === "proposed" && proposed.required) {
    return refuse(`Mission contract "${id}" is proposed, not approved, and it requires an implementation plan approved with it: run smol with --propose-plan first, review the plan, then rerun with --approve ${fp} --approve-plan <plan fingerprint>.`);
  }
  if (status.state === "proposed") return refuse(`Mission contract "${id}" is proposed, not approved. Review it, then rerun with --approve ${fp}`);
  if (status.state === "expired") return refuse(`Mission contract "${id}" is expired. Widen it (for example budgets.maxSteps) and approve the new fingerprint.`);
  return refuse(`Mission contract "${id}" is ${STATE_LABELS[status.state]}${status.reason ? ` (${status.reason})` : ""}.`);
}

/** Le contrat du hub vise-t-il ce workspace ? (sans rien préparer) */
export function missionTargets(prefs: MissionPrefs | undefined, workspace: string): boolean {
  if (!prefs) return false;
  try {
    return fs.realpathSync.native(prefs.workspace) === fs.realpathSync.native(workspace);
  } catch {
    return false;
  }
}

/** Le profil d'une session web : seulement pour le workspace visé par le
 * contrat ; les autres workspaces du hub gardent le parcours courant. */
export function missionForWorkspace(prefs: MissionPrefs | undefined, workspace: string, dataDir?: string): Mission | null {
  return prefs && missionTargets(prefs, workspace) ? Mission.prepare({ source: prefs.source, workspace, dataDir }) : null;
}
