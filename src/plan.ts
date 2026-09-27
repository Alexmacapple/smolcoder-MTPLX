// The agent's plan: a harness-held checklist. This is deliberately NOT a file
// and NOT model-formatted text — the harness owns the state, so rendering it
// to the user costs zero tokens, and compaction can never destroy it. For a
// small model it works as a compass: every `done` result re-states what comes
// next, and after compaction the whole checklist is re-injected verbatim.
//
// Profil mission (#29) : la même checklist porte, quand l'agent propose un
// plan d'implémentation, son détail structuré (fichiers, risques, preuve
// prévue par critère). L'hôte le valide, le journalise et le fait approuver
// avec le contrat (src/harness/mission.ts) ; hors --mission, rien ne change.

import type { PlanContent, PlannedProof } from "./harness/store";

export interface PlanStep {
  text: string;
  done: boolean;
  /** Model-authored working notes, kept verbatim instead of re-summarized. */
  note?: string;
}

/** Profil mission (#29) : le détail d'un plan structuré, à côté des étapes
 * qui en donnent l'ordre des travaux. */
export interface PlanDetails {
  files: string[];
  risks: string[];
  proofs: PlannedProof[];
}

/** Profil mission (#29) : ce que l'hôte fait d'un plan structuré — le
 * valider, le journaliser, le lier au contrat. Fixés par l'hôte, jamais par
 * un argument du modèle ; absents, l'outil plan est celui d'avant #29. */
export interface PlanHooks {
  /** Une proposition (avant approbation) ou une réécriture (après, un écart) :
   * rend le contenu normalisé et le message pour le modèle, ou le refus. Rien
   * n'est posé sur la checklist en cas de refus. `current` : le plan
   * structuré en cours, s'il y en a un. */
  propose(content: PlanContent, reason: string | null, current: PlanContent | null): { ok: true; content: PlanContent; message: string } | { ok: false; message: string };
  /** Après set ou add sur un plan structuré : une note pour le modèle (vide
   * si l'hôte n'a rien à en dire) ; une note qui commence par « Error: »
   * annule le changement, que l'hôte n'a pas pu enregistrer. */
  changed(before: PlanContent, after: PlanContent, reason: string | null): string;
  /** Après une écriture réussie (write_file, edit_file) : une note pour le
   * modèle, vide si le fichier est au plan ou sans plan approuvé. Jamais un
   * refus : l'écriture a déjà eu lieu. */
  wrote(path: string): string;
  /** Les fichiers qu'`add` ajoute au plan : normalisés, ou le refus. */
  files(list: string[]): { ok: true; files: string[] } | { ok: false; message: string };
}

/** Strip the bullets, numbering and checkboxes local models put on lines. */
const LINE_PREFIX = /^\s*(?:[-*]|\d+[.)])?\s*(?:\[.\]\s*)?/;

/** One item per line; without a newline, the semicolon lists local models
 * often return. Shared by `set` and the structured proposal. */
function splitLines(text: string, singleLine: RegExp = /;\s*/): string[] {
  return text
    .split(text.includes("\n") ? "\n" : singleLine)
    .map((l) => l.replace(LINE_PREFIX, "").trim())
    .filter(Boolean);
}

const PROOF_LINE = /^(?:(?:criterion|criteria|critère|ac|acceptance)\s*)?#?(\d{1,2})\s*[:.)\-–]\s*(.+)$/i;

/** Profil mission (#29) : une liste de fichiers du modèle — un par ligne, ou
 * séparés par des virgules, points-virgules ou espaces sur une seule ligne. */
export function splitFileList(text: unknown): string[] {
  return splitLines(typeof text === "string" ? text : "", /[;,]\s*|\s+/).map((f) => f.replace(/^`+|`+$/g, "").replace(/^\.\//, ""));
}

/** Profil mission (#29) : lit les champs plats d'une proposition (petits
 * modèles : ni objets ni listes imbriqués) — une étape, un fichier, un risque
 * ou une preuve par ligne. La grammaire du contenu (bornes, chemins, numéros
 * des critères) reste celle de l'hôte ; ici, seulement la forme. */
export function readProposal(args: Record<string, any>): { content: PlanContent } | { error: string } {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const steps = splitLines(str(args.steps));
  if (!steps.length) return { error: '"steps" needs at least one step, in the order of the work — one per line.' };
  const files = splitFileList(args.files);
  if (!files.length) return { error: '"files" needs at least one file to create or modify — one path per line, relative to the workspace ("src/" for a whole folder).' };
  const risks = splitLines(str(args.risks));
  const proofText = str(args.proofs);
  const lines = proofText.includes("\n")
    ? proofText.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean)
    : proofText.split(/;\s*(?=(?:(?:criterion|criteria|critère|ac|acceptance)\s*)?#?\d{1,2}\s*[:.)\-–])/i).map((l) => l.trim()).filter(Boolean);
  const proofs: PlannedProof[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PROOF_LINE.exec(lines[i]);
    if (!m) return { error: `each "proofs" line must be "N: proof", N being the acceptance criterion number — line ${i + 1} (${JSON.stringify(lines[i].slice(0, 80))}) is not.` };
    proofs.push({ criterion: Number(m[1]), proof: m[2].trim() });
  }
  return { content: { steps, files, risks, proofs } };
}

export class Plan {
  steps: PlanStep[] = [];
  /** Profil mission (#29) : le détail d'un plan structuré ; null pour la
   * checklist simple, la seule qui existe hors --mission. */
  details: PlanDetails | null = null;

  get exists(): boolean {
    return this.steps.length > 0;
  }

  get doneCount(): number {
    return this.steps.filter((s) => s.done).length;
  }

  /** Index of the current (first undone) step, or -1 when all done/empty. */
  get currentIndex(): number {
    return this.steps.findIndex((s) => !s.done);
  }

  reset(): void {
    this.steps = [];
    this.details = null;
  }

  /** Profil mission (#29) : le contenu comparable d'un plan structuré —
   * l'ordre des travaux et le détail, sans l'état coché ni les notes ; null
   * pour la checklist simple. */
  content(): PlanContent | null {
    if (!this.details) return null;
    return {
      steps: this.steps.map((s) => s.text),
      files: [...this.details.files],
      risks: [...this.details.risks],
      proofs: this.details.proofs.map((p) => ({ ...p })),
    };
  }

  /** Profil mission (#29) : pose un plan structuré. Une étape déjà présente
   * sous le même texte garde son état coché et sa note. */
  adopt(content: PlanContent): void {
    const kept = new Map(this.steps.map((s) => [s.text, s]));
    this.steps = content.steps.map((text) => {
      const old = kept.get(text);
      return { text, done: old?.done ?? false, ...(old?.note !== undefined ? { note: old.note } : {}) };
    });
    this.details = { files: [...content.files], risks: [...content.risks], proofs: content.proofs.map((p) => ({ ...p })) };
  }

  /** Profil mission (#29) : des fichiers de plus au plan structuré. */
  addFiles(files: string[]): void {
    if (!this.details) return;
    for (const f of files) if (!this.details.files.includes(f)) this.details.files.push(f);
  }

  /** Profil mission (#29) : l'état complet, pour annuler un changement que
   * l'hôte n'a pas pu enregistrer. */
  snapshot(): { steps: PlanStep[]; details: PlanDetails | null } {
    return {
      steps: this.steps.map((s) => ({ ...s })),
      details: this.details ? { files: [...this.details.files], risks: [...this.details.risks], proofs: this.details.proofs.map((p) => ({ ...p })) } : null,
    };
  }

  restoreSnapshot(s: { steps: PlanStep[]; details: PlanDetails | null }): void {
    this.steps = s.steps;
    this.details = s.details;
  }

  /** Replace the plan. Accept the semicolon lists local models often return
   * when asked for a newline-separated string. Keep explicit multiline steps
   * intact, including punctuation or code within a step. */
  set(stepsText: string): string {
    const lines = splitLines(stepsText).slice(0, 20);
    if (lines.length === 0) {
      return 'Error: steps is required — one step per line. Example: {"action": "set", "steps": "create index.html\\ncreate game.js\\ntest the page"}';
    }
    this.steps = lines.map((text) => ({ text, done: false }));
    return `Plan set (${this.steps.length} steps). Current: 1. ${this.steps[0].text}`;
  }

  /** Mark a step done. No index = the current step. Returns a compact
   * "what's next" line — cheap tokens that keep the model on course. */
  markDone(stepNumber?: number): string {
    if (!this.exists) return 'Error: no plan yet. Create one first with {"action": "set", "steps": "..."}';
    let idx: number;
    if (stepNumber === undefined || stepNumber === null) {
      idx = this.currentIndex;
      if (idx < 0) return "All steps are already done.";
    } else {
      idx = Math.floor(stepNumber) - 1;
      if (idx < 0 || idx >= this.steps.length) {
        return `Error: step ${stepNumber} does not exist. The plan has ${this.steps.length} steps.`;
      }
    }
    this.steps[idx].done = true;
    const next = this.currentIndex;
    return next < 0
      ? `Done: ${idx + 1}. All ${this.steps.length} steps complete.`
      : `Done: ${idx + 1}. Next: ${next + 1}. ${this.steps[next].text}`;
  }

  add(text: string): string {
    if (typeof text !== "string" || !text.trim()) {
      return 'Error: text is required. Example: {"action": "add", "text": "fix the collision bug"}';
    }
    if (this.steps.length >= 20) return "Error: the plan already has 20 steps — finish some first.";
    this.steps.push({ text: text.trim(), done: false });
    return `Added step ${this.steps.length}: ${text.trim()}`;
  }

  checkpoint(text: string): string {
    const idx = this.currentIndex;
    if (idx < 0) return 'Error: create a plan with an unfinished step before recording a checkpoint.';
    if (!text.trim() || text.length > 1000) return 'Error: checkpoint text must be 1–1000 characters. Keep exact APIs, the unresolved error and the next small edit.';
    this.steps[idx].note = text.trim();
    return `Checkpoint saved for step ${idx + 1}: ${text.trim()}`;
  }

  /** Compact model-facing checklist (used by action "show" and after compaction). */
  modelView(): string {
    if (!this.exists) return "No plan set.";
    const steps = this.steps
      .map((s, i) => `${i + 1}.[${s.done ? "x" : i === this.currentIndex ? ">" : " "}] ${s.text}` +
        (s.note && i === this.currentIndex ? `\nWorking checkpoint (agent notes; verify against files): ${s.note}` : ""))
      .join("\n");
    // Profil mission (#29) : le détail d'un plan structuré voyage avec ses
    // étapes, compaction comprise ; la checklist simple reste inchangée.
    const d = this.details;
    if (!d) return steps;
    return [
      steps,
      `Files: ${d.files.join(", ")}`,
      ...(d.risks.length ? [`Risks: ${d.risks.join("; ")}`] : []),
      ...(d.proofs.length ? [`Planned proofs: ${d.proofs.map((p) => `${p.criterion}: ${p.proof}`).join("; ")}`] : []),
    ].join("\n");
  }

  /** One-line summary for the compaction state note. */
  compactLine(): string | null {
    if (!this.exists) return null;
    return `Plan (${this.doneCount}/${this.steps.length} done):\n${this.modelView()}`;
  }

  pendingSummary(): string {
    return this.steps
      .filter((s) => !s.done)
      .map((s) => s.text)
      .join("; ");
  }
}
