// Reprise durable sous le profil mission (ticket #10, H05). Le journal
// d'effets vit dans proofs.jsonl (grammaire : ./store, décision :
// docs/decision-reprise-durable.md) : chaque action du modèle qui a un effet
// sur le projet y est enregistrée avant l'effet, puis son résultat observé
// après. À l'ouverture d'une session, une intention sans résultat devient
// `uncertain` — l'hôte l'enregistre avec ce que les fichiers en disent, sans
// jamais conclure — et les écritures et commandes restent suspendues tant que
// l'hôte (humain, ou appelant headless) ne l'a pas résolue. Aucune promesse
// « exactement une fois », aucune reprise automatique après un état
// incertain ; la réconciliation se limite aux fichiers (les tâches de fond
// vivent en mémoire et meurent avec le processus).

import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { resolveInWorkspace } from "../sandbox";
import { latestVerdicts, WorkspaceScan } from "./proofs";
import {
  appendProof,
  ApprovalAuthority,
  APPROVAL_AUTHORITIES,
  EffectEvidence,
  EffectIntentInput,
  EffectTool,
  EFFECT_ID_RE,
  HarnessStoreError,
  isRelativeWorkspacePath,
  observedLine,
  ProofEvent,
  readProofs,
} from "./store";

/** Code de sortie headless d'un run suspendu par la reprise : un effet
 * incertain attend l'hôte, ou le journal ne permet pas de conclure. */
export const RESUME_SUSPENDED_EXIT_CODE = 6;

/** Les trois points d'injection d'une coupure (tests, `SMOLCODER_TEST_CRASH_AT`) :
 * après l'intention et avant l'effet, après l'effet et avant son résultat,
 * après le résultat. */
export const CRASH_POINTS = ["before-effect", "after-effect", "after-receipt"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Ce que la reprise lit d'une mission (évite l'import circulaire). */
export interface ResumeMission {
  readonly workspace: string;
  readonly dir: string;
  readonly fingerprint: string;
  scan(): WorkspaceScan;
}

type IntentEvent = Extract<ProofEvent, { type: "effect"; kind: "intent" }>;
type ResultEvent = Extract<ProofEvent, { type: "effect"; kind: "result" }>;
type UncertainEvent = Extract<ProofEvent, { type: "effect"; kind: "uncertain" }>;
type ResolvedEvent = Extract<ProofEvent, { type: "effect"; kind: "resolved" }>;

/** Un effet tel que le journal le raconte. */
export interface EffectRecord {
  intent: IntentEvent;
  result: ResultEvent | null;
  uncertain: UncertainEvent | null;
  resolved: ResolvedEvent | null;
}

/** Un effet incertain, avec ce que les fichiers en disent maintenant. */
export interface UncertainEffect {
  id: string;
  tool: EffectTool;
  target: string;
  at: string;
  evidence: EffectEvidence;
  /** Lecture humaine de l'indice : jamais une conclusion. */
  meaning: string;
  resolved: boolean;
}

/** Ce que l'ouverture a constaté, pour l'humain, le headless et les tests. */
export interface ResumeReport {
  journal: "ok" | "absent" | "truncated-tail" | "unreadable" | "unknown-schema";
  journalReason?: string;
  /** Intentions devenues incertaines à cette ouverture. */
  newlyUncertain: string[];
  /** Effets incertains non résolus. */
  uncertain: UncertainEffect[];
  /** Effets terminés avant la reprise (intention et résultat). */
  completed: number;
  /** Enregistrements orphelins (résultat sans intention…), ignorés. */
  orphans: number;
  /** Critères dont le dernier verdict `passed` ne vaut plus pour les
   * fichiers actuels (#9) : périmés, jamais validés. */
  staleProofs: string[];
  suspended: boolean;
  reason: string | null;
}

/** Une coupure simulée (tests en processus) : elle traverse la boucle comme
 * une erreur, le journal restant dans l'état exact de la coupure. */
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

/** L'effet en cours, entre son intention et son résultat. */
export interface EffectHandle {
  id: string;
  tool: EffectTool;
  abs: string | null;
}

/** Plie les événements `effect` du journal, dans l'ordre. */
export function foldEffects(events: ProofEvent[]): { effects: Map<string, EffectRecord>; orphans: number } {
  const effects = new Map<string, EffectRecord>();
  let orphans = 0;
  for (const e of events) {
    if (e.type !== "effect") continue;
    if (e.kind === "intent") {
      if (effects.has(e.id)) orphans++;
      else effects.set(e.id, { intent: e as IntentEvent, result: null, uncertain: null, resolved: null });
      continue;
    }
    const rec = effects.get(e.id);
    if (!rec) {
      orphans++;
      continue;
    }
    if (e.kind === "result" && !rec.result) rec.result = e as ResultEvent;
    else if (e.kind === "uncertain" && !rec.uncertain && !rec.result) rec.uncertain = e as UncertainEvent;
    else if (e.kind === "resolved" && rec.uncertain && !rec.resolved) rec.resolved = e as ResolvedEvent;
    else orphans++;
  }
  return { effects, orphans };
}

const describeTarget = (i: IntentEvent) => (i.path ?? i.command ?? "").slice(0, 120);

function meaningOf(evidence: EffectEvidence, tool: EffectTool): string {
  switch (evidence) {
    case "before":
      return "the file is as it was before the action: it appears not applied";
    case "expected":
      return "the file matches what the action would have written: it appears applied";
    case "neither":
      return tool === "edit_file"
        ? "the file changed since before the action: applied, partly written, or changed by something else"
        : "the file matches neither its content before the action nor the intended one: partly written, or changed by something else";
    default:
      return "a command's effects cannot be read from the files";
  }
}

export class MissionResume {
  /** L'identifiant de cette session dans le journal. */
  readonly session = randomBytes(6).toString("hex");
  /** Coupure injectée (tests en processus) ; en production, la variable
   * d'environnement SMOLCODER_TEST_CRASH_AT tue le processus au point nommé. */
  crash: ((point: CrashPoint) => void) | null = null;
  private effects = new Map<string, EffectRecord>();
  private report: ResumeReport | null = null;
  /** Un résultat n'a pas pu être écrit : plus aucun effet sans trace. */
  private broken: string | null = null;

  constructor(readonly mission: ResumeMission, readonly surface: string) {}

  /** Relit le journal et transforme toute intention sans résultat en état
   * incertain, enregistré par l'hôte avec ce que les fichiers en disent. */
  open(): ResumeReport {
    const read = readProofs(this.mission.dir);
    const journal = read.state;
    const events = read.state === "ok" || read.state === "truncated-tail" ? read.events : [];
    const { effects, orphans } = foldEffects(events);
    this.effects = effects;
    const newly: string[] = [];
    for (const rec of effects.values()) {
      if (rec.result || rec.uncertain) continue;
      const { evidence, current } = this.evidence(rec.intent);
      const uncertain = { type: "effect" as const, fingerprint: this.mission.fingerprint, kind: "uncertain" as const, id: rec.intent.id, evidence, ...(current !== undefined ? { current } : {}) };
      if (journal === "ok") {
        try {
          rec.uncertain = appendProof(this.mission.dir, uncertain) as UncertainEvent;
        } catch (err: any) {
          this.broken = `the host journal refused a record (${err?.message ?? err})`;
          rec.uncertain = { ...uncertain, schema: "smolcoder/proof/v1", at: new Date().toISOString() } as UncertainEvent;
        }
      } else {
        // Journal abîmé : l'incertitude est constatée en mémoire, rien n'est écrit.
        rec.uncertain = { ...uncertain, schema: "smolcoder/proof/v1", at: new Date().toISOString() } as UncertainEvent;
      }
      newly.push(rec.intent.id);
    }
    const completed = [...effects.values()].filter((r) => r.result).length;
    // #9 : une preuve datée par d'autres fichiers que ceux d'aujourd'hui est
    // périmée ; la reprise le dit au lieu de laisser croire au vert.
    const scan = this.mission.scan();
    const staleProofs = [...latestVerdicts(events, this.mission.fingerprint)]
      .filter(([, v]) => v.status === "passed" && (!scan.ok || v.files !== scan.digest))
      .map(([id]) => id);
    this.report = { journal, ...("reason" in read ? { journalReason: read.reason } : {}), newlyUncertain: newly, uncertain: [], completed, orphans, staleProofs, suspended: false, reason: null };
    this.refresh();
    return this.report;
  }

  /** L'état courant de la reprise (sans relire le journal). */
  state(): ResumeReport {
    if (!this.report) return this.open();
    this.refresh();
    return this.report;
  }

  private refresh(): void {
    const r = this.report!;
    r.uncertain = [...this.effects.values()]
      .filter((rec) => rec.uncertain)
      .map((rec) => ({
        id: rec.intent.id,
        tool: rec.intent.tool,
        target: describeTarget(rec.intent),
        at: rec.intent.at,
        evidence: rec.uncertain!.evidence,
        meaning: meaningOf(rec.uncertain!.evidence, rec.intent.tool),
        resolved: !!rec.resolved,
      }));
    const open = r.uncertain.filter((u) => !u.resolved);
    r.suspended = r.journal === "truncated-tail" || r.journal === "unreadable" || r.journal === "unknown-schema" || open.length > 0 || !!this.broken;
    r.reason =
      r.journal === "truncated-tail"
        ? `the last record of the host journal (${path.join(this.mission.dir, "proofs.jsonl")}) is truncated: it is not interpreted, and nothing can be recorded behind it. Repair it by hand (remove the incomplete last line) before anything else is written.`
        : r.journal === "unreadable" || r.journal === "unknown-schema"
          ? `the host journal is ${r.journal}${r.journalReason ? ` (${r.journalReason})` : ""}: no effect can be recorded, so none may happen`
          : this.broken
            ? `${this.broken}: no further effect may happen without its record`
            : open.length
              ? `${open.length} action${open.length > 1 ? "s" : ""} of an earlier session ${open.length > 1 ? "have" : "has"} no recorded result: ${open.map((u) => `${u.id} (${u.tool} ${u.target})`).join(", ")}. Their outcome is uncertain; only the host can resolve it (terminal or web: /resolve; headless: --resolve <id>)`
              : null;
  }

  /** Ce que les fichiers disent d'une intention sans résultat. */
  private evidence(i: IntentEvent): { evidence: EffectEvidence; current?: string | null } {
    if (i.tool !== "write_file" && i.tool !== "edit_file") return { evidence: "none" };
    const current = this.hashOf(i.path!);
    if (i.expected !== undefined && i.expected !== null && current === i.expected) return { evidence: "expected", current };
    if (current === i.before) return { evidence: "before", current };
    return { evidence: "neither", current };
  }

  /** Empreinte du contenu d'un fichier relatif du workspace ; null s'il est absent. */
  private hashOf(rel: string): string | null {
    try {
      return sha256(fs.readFileSync(path.join(this.mission.workspace, ...rel.split("/"))));
    } catch {
      return null;
    }
  }

  /** La suspension, à consulter avant tout effet : null autorise, sinon le
   * motif (la porte de la mission le rend au modèle). */
  denial(): string | null {
    const r = this.state();
    return r.suspended ? `writes and commands are suspended by the host: ${r.reason}. Keep reading and inspecting; a message cannot lift this.` : null;
  }

  /** Enregistre l'intention, sur le disque, avant l'effet. Lève si le
   * journal la refuse : l'effet n'a alors pas lieu. */
  begin(call: { id: string; name: string; args: Record<string, any> }): EffectHandle {
    const tool = call.name as EffectTool;
    const id = randomBytes(6).toString("hex");
    let abs: string | null = null;
    const input: EffectIntentInput = { type: "effect", fingerprint: this.mission.fingerprint, kind: "intent", id, session: this.session, call: String(call.id ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128), tool };
    if (tool === "write_file" || tool === "edit_file") {
      abs = resolveInWorkspace(this.mission.workspace, String(call.args?.path ?? ""));
      let rel = path.relative(this.realWorkspace(), this.realOf(abs)).split(path.sep).join("/");
      if (!isRelativeWorkspacePath(rel)) rel = path.relative(this.mission.workspace, abs).split(path.sep).join("/");
      if (!isRelativeWorkspacePath(rel)) throw new HarnessStoreError("unreadable", `"${call.args?.path}" cannot be recorded as a workspace path`);
      input.path = rel;
      input.before = this.hashOf(rel);
      input.expected = tool === "write_file" && typeof call.args?.content === "string" ? sha256(call.args.content) : null;
    } else {
      input.command = String(call.args?.command ?? "").slice(0, 2000);
    }
    const event = appendProof(this.mission.dir, input) as IntentEvent;
    this.effects.set(id, { intent: event, result: null, uncertain: null, resolved: null });
    this.point("before-effect");
    return { id, tool, abs };
  }

  /** Enregistre le résultat observé, après l'effet. Un résultat qui ne
   * s'écrit pas laisse l'intention seule au journal : à la prochaine
   * ouverture elle sera incertaine, et cette session n'agit plus. */
  end(h: EffectHandle, output: string): void {
    this.point("after-effect");
    const rec = this.effects.get(h.id);
    const after = h.abs && rec?.intent.path ? { after: this.hashOf(rec.intent.path) } : {};
    try {
      const event = appendProof(this.mission.dir, { type: "effect", fingerprint: this.mission.fingerprint, kind: "result", id: h.id, status: output.startsWith("Error") ? "error" : "ok", observed: observedLine(output), ...after });
      if (rec) rec.result = event as ResultEvent;
    } catch (err: any) {
      this.broken = `the result of effect ${h.id} could not be recorded (${err?.message ?? err})`;
    }
    this.point("after-receipt");
  }

  /** Résolution par l'hôte des effets incertains nommés : l'état actuel du
   * workspace est accepté comme base. `by` : une autorité de l'hôte, jamais
   * le modèle. Rend les identifiants résolus ; refuse un identifiant inconnu. */
  resolve(ids: string[], by: ApprovalAuthority): string[] {
    if (!APPROVAL_AUTHORITIES.includes(by)) throw new Error(`only the host resolves an uncertain action (${APPROVAL_AUTHORITIES.join(", ")})`);
    const r = this.state();
    if (r.journal !== "ok" && r.journal !== "absent") throw new Error(`the host journal is ${r.journal}: nothing can be resolved until it is repaired`);
    const done: string[] = [];
    for (const id of ids) {
      if (!EFFECT_ID_RE.test(id)) throw new Error(`"${id}" is not an effect identifier`);
      const rec = this.effects.get(id);
      if (!rec?.uncertain) throw new Error(`effect ${id} is not an uncertain action of this workspace`);
      if (rec.resolved) continue;
      rec.resolved = appendProof(this.mission.dir, { type: "effect", fingerprint: this.mission.fingerprint, kind: "resolved", id, by }) as ResolvedEvent;
      done.push(id);
    }
    this.refresh();
    return done;
  }

  /** Reprise d'un transcript (web) : ce que le journal dit d'un appel d'outil
   * resté sans réponse, ou null pour le message générique. */
  explainCall(callId: string, name: string, args: Record<string, any> = {}): string | null {
    const effectCall = name === "write_file" || name === "edit_file" || name === "run_command" || (name === "task" && args?.action === "start");
    if (!effectCall) return null;
    const rec = [...this.effects.values()].filter((r) => r.intent.call === callId && r.intent.tool === name).pop();
    if (!rec) return `[Not executed: the session stopped before this ${name} ran — the host's effect journal has no record of it, and every effect is recorded before it happens. Nothing was changed by this call.]`;
    const i = rec.intent;
    if (rec.result) return `[Recovered from the host's effect journal (effect ${i.id}): this ${name} finished before the restart — ${rec.result.status}: ${rec.result.observed}. Do not run it again.]`;
    const u = rec.uncertain;
    const meaning = u ? meaningOf(u.evidence, i.tool) : "not yet reconciled";
    if (rec.resolved) return `[Effect ${i.id} (${name} ${describeTarget(i)}) had no recorded result after a restart; the host resolved it (${rec.resolved.by}): the workspace as it is now is the baseline. Evidence then: ${meaning}. Re-read the files before relying on them; do not assume it succeeded or failed.]`;
    return `[Outcome UNCERTAIN (effect ${i.id}, ${name} ${describeTarget(i)}): the session stopped between recording this action and recording its result. Evidence: ${meaning}. Writes and commands are suspended until the host resolves it; do not assume it failed or succeeded, and do not redo it on your own.]`;
  }

  /** Ce que la ligne `[resume]` du headless donne à lire. */
  summary() {
    const r = this.state();
    return {
      journal: r.journal,
      suspended: r.suspended,
      ...(r.reason ? { reason: r.reason } : {}),
      uncertain: r.uncertain.filter((u) => !u.resolved).map((u) => ({ id: u.id, tool: u.tool, target: u.target, evidence: u.evidence })),
      resolved: r.uncertain.filter((u) => u.resolved).map((u) => u.id),
      completed: r.completed,
      ...(r.orphans ? { orphans: r.orphans } : {}),
      ...(r.staleProofs.length ? { staleProofs: r.staleProofs } : {}),
    };
  }

  /** Les lignes que l'ouverture montre à l'humain. */
  lines(): string[] {
    const r = this.state();
    const out: string[] = [];
    if (r.journal === "truncated-tail" || r.journal === "unreadable" || r.journal === "unknown-schema") out.push(`· resume: ${r.reason}`);
    for (const u of r.uncertain.filter((x) => !x.resolved)) {
      out.push(`· resume: effect ${u.id} (${u.tool} ${u.target}, ${u.at}) has no recorded result — uncertain. Evidence: ${u.meaning}.`);
    }
    if (r.uncertain.some((u) => !u.resolved)) out.push("· resume: writes and commands are suspended until you resolve it: /resolve (headless: --resolve <id>). Nothing is replayed automatically.");
    if (r.orphans) out.push(`· resume: ${r.orphans} effect record(s) without their action were ignored`);
    if (r.staleProofs.length) out.push(`· resume: the files changed since ${r.staleProofs.join(", ")} passed — ${r.staleProofs.length > 1 ? "those proofs are" : "that proof is"} stale and count${r.staleProofs.length > 1 ? "" : "s"} as not run until checked again`);
    return out;
  }

  private point(p: CrashPoint): void {
    this.crash?.(p);
    if (process.env.SMOLCODER_TEST_CRASH_AT === p) process.kill(process.pid, "SIGKILL");
  }

  private realWorkspace(): string {
    try {
      return fs.realpathSync.native(this.mission.workspace);
    } catch {
      return this.mission.workspace;
    }
  }

  private realOf(abs: string): string {
    try {
      return fs.realpathSync.native(abs);
    } catch {
      try {
        return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
      } catch {
        return abs;
      }
    }
  }
}
