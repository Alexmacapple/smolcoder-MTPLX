// One session = one workspace + one agent + one UI, plus the input loop and
// slash commands that drive it. Extracted from the CLI entry point so the
// terminal TUI and the web hub (many sessions side by side, one per browser
// sidebar entry) run exactly the same loop.

import * as os from "os";
import { Agent } from "./agent";
import { Config, loadConfig, updateConfig } from "./config";
import { ContextManager } from "./context";
import { detectAll, DetectedModel, resolveContextWindow } from "./detect";
import { EventBus } from "./events";
import { findModelsOnNetwork, FlowUI, manageHosts } from "./network";
import { Mission, MissionPrefs } from "./harness/mission";
import { BYPASS_UNDER_MISSION } from "./harness/policy";
import { readPolicy } from "./harness/store";
import { describeExternal, InstructionPrints } from "./harness/resume";
import { IsolatedExecutor, isolationLine, isolationState, missionExecutor } from "./harness/sandbox-executor";
import { Plan, PlanStep } from "./plan";
import { buildSystemPrompt, loadAgentsMdDetails } from "./prompt";
import { loadHostFiches } from "./fiches";
import { LmStudioProvider } from "./providers/lmstudio";
import { OllamaProvider } from "./providers/ollama";
import { Effort, Msg, Provider } from "./providers/types";
import { Mode, MODE_LABELS, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { renderPlan, SelectOption, SessionUI, SlashCommand } from "./ui";
import { c, truncateEnd } from "./util";
import * as fs from "fs";
import * as path from "path";
import {
  describeInstructionDrift,
  instruction,
  LEGACY_SESSION_SCHEMA,
  readGitHead,
  readSnapshot,
  sameInstructions,
  SESSION_SCHEMA,
  SessionInstructions,
  SessionSnapshot,
  sha256,
  shortRev,
} from "./session-state";

export type { SessionSnapshot } from "./session-state";

/** Per-session preferences from the command line. `effort: null` means an
 * explicit "default"; undefined means "whatever the config remembers". */
export interface SessionPrefs {
  mode?: Mode;
  model?: string;
  backend?: string;
  /** Server the wanted model lives on, when the same id exists on several machines. */
  baseUrl?: string;
  ctx?: number;
  effort?: Effort | null;
  /** Profil mission du hub web : le contrat et le workspace qu'il vise. */
  mission?: MissionPrefs;
}

/** Ajoutées seulement sous le profil mission : sans lui, le menu est inchangé. */
export const MISSION_COMMANDS: SlashCommand[] = [
  { name: "mission", desc: "Show the mission contract and its state" },
  { name: "approve", desc: "Approve the mission contract (your decision, not the model's)" },
  { name: "resolve", desc: "Resolve an action left uncertain by a restart (your decision)" },
];

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "models", desc: "Switch model · add models from other machines" },
  { name: "mode", desc: "Set mode (ro / edit / bypass)" },
  { name: "effort", desc: "Set reasoning effort" },
  { name: "plan", desc: "Show the agent's plan" },
  { name: "context", desc: "Show context usage" },
  { name: "compact", desc: "Compact the conversation now" },
  { name: "tasks", desc: "List background tasks" },
  { name: "logs", desc: "Show task output — /logs t1" },
  { name: "stop", desc: "Stop a background task — /stop t1" },
  { name: "clear", desc: "Reset the conversation" },
  { name: "instructions", desc: "AGENTS.md: the version this session uses · switch explicitly" },
  { name: "help", desc: "Show help" },
  { name: "exit", desc: "Quit smolcoder (web: close this session)" },
];

export const MODE_ORDER: Mode[] = ["ro", "edit", "bypass"];

// ---- model selection helpers (shared with the headless path) --------------

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
export function outputBudget(window: number): number {
  return Math.max(128, Math.min(8192, Math.floor(window / 4)));
}

export function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  return m.backend === "ollama"
    ? new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut, m.vision)
    : new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, m.reasoning, m.vision);
}

/** One-line advice when the effective reasoning setting will be slow: LM
 * Studio applies the model's own default level when none is chosen, and for
 * current qwen builds that default is the maximum. */
export function effortAdvice(m: DetectedModel, effort: Effort | null): string | null {
  if (m.backend !== "lmstudio" || !m.reasoning?.default) return null;
  const d = m.reasoning.default;
  if (effort === null && /^(high|xhigh)$/.test(d)) {
    return `this model thinks at "${d}" by default on LM Studio — expect long pauses before each tool call. /effort off (or --effort off) is many times faster; /effort low or medium keeps some reasoning.`;
  }
  return null;
}

/** Tell the user what context management just did (both UIs; headless logs
 * it to stderr so a long run's log shows when and how hard compaction hit). */
export function reportCompactions(bus: EventBus, ui: { status: (s: string) => void; warn: (s: string) => void }): void {
  bus.on("post_compact", (report: any) => {
    const delta = `${report?.before} → ${report?.after} tokens est.`;
    if (report?.action === "evicted") ui.status(`· pruned context (${delta})`);
    else if (report?.action === "compacted") ui.status(`· compacted the conversation into hand-over notes (${delta})`);
    else if (report?.action === "floor")
      ui.warn(`· context is at its floor: system prompt + tools + the working tail no longer fit comfortably (${delta}). Consider a bigger context window.`);
  });
}

/** `url` says which server the wanted (or else the remembered) model was on;
 * it only breaks ties between machines that serve the same model id. */
export function autoPickModel(
  models: DetectedModel[],
  wanted: string | undefined,
  remembered: string | undefined,
  url?: string
): DetectedModel {
  if (wanted) {
    const hit =
      models.find((m) => m.id === wanted && m.baseUrl === url) ??
      models.find((m) => m.id === wanted) ??
      models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase()));
    if (hit) return hit;
    throw new Error(`Model "${wanted}" was not found on the selected backend. Use /models to choose an available model.`);
  }
  // With nothing remembered, a model on this computer beats one across the network.
  const local = models.filter((m) => !m.host);
  const pool = local.length ? local : models;
  return (
    models.find((m) => m.id === remembered && m.baseUrl === url) ??
    models.find((m) => m.id === remembered) ??
    pool.find((m) => m.backend === "ollama") ??
    pool.find((m) => m.loaded) ??
    pool[0]
  );
}

export function noBackendsMessage(): string {
  return (
    c.red("No usable model found.") +
    `\n\nsmolcoder connects to a running model server; it does not scan installed apps or drives.\n` +
    `  · ${c.bold("Ollama")}: start the app (or run: ollama serve), then check: ollama list\n` +
    `    Found on this computer, at ${c.dim("$OLLAMA_HOST")}, and in Docker containers that publish its port.\n` +
    `    If the list is empty, run: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")}: load a model and start Local Server in the Developer tab (any port).\n` +
    `  · ${c.bold("Another machine")}: start smol in a terminal or with --web and choose "Find models on another machine".\n\n` +
    `Then run smol again.`
  );
}

/** "ollama" on this computer, "ollama @ gpu-box" across the network. */
export function backendLabel(m: DetectedModel): string {
  return m.host ? `${m.backend} @ ${m.host}` : m.backend;
}

export function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${backendLabel(m)} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${MODE_LABELS[mode]} mode`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

function modeColored(mode: Mode): string {
  const label = MODE_LABELS[mode];
  if (mode === "bypass") return c.red(c.bold(label));
  if (mode === "ro") return c.magenta(c.bold(label));
  return c.cyan(c.bold(label));
}

/** Detect backends, pick a model and resolve its context window. Returns null
 * when no backend answers. `progress` gets a short label for each slow step. */
export async function prepareModel(
  prefs: SessionPrefs,
  cfg: Config,
  progress?: (label: string) => void
): Promise<DetectedModel | null> {
  progress?.("looking for Ollama and LM Studio");
  const url = prefs.model ? prefs.baseUrl : cfg.lastModelUrl;
  // Without --model the remembered one wins anyway, so stop looking the moment
  // it shows up instead of waiting out a network host that is switched off.
  const until =
    !prefs.model && cfg.lastModel
      ? (m: DetectedModel) => m.id === cfg.lastModel && (!url || m.baseUrl === url) && (!prefs.backend || m.backend === prefs.backend)
      : undefined;
  const models = (await detectAll({ hosts: cfg.hosts, until })).filter((m) => !prefs.backend || m.backend === prefs.backend);
  if (models.length === 0) return null;
  const chosen = autoPickModel(models, prefs.model, cfg.lastModel, url);
  progress?.(`loading ${chosen.id}`);
  return resolveContextWindow(chosen, prefs.ctx);
}

/** Picker rows for a model list: this computer first, then each network host. */
export function modelOptions(models: DetectedModel[], current?: DetectedModel): SelectOption[] {
  return models.map((m) => ({
    label: m.id,
    hint:
      (m.openaiCompat
        ? `openai-compat${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`
        : m.backend === "ollama"
          ? "ollama"
          : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`) +
      (m.host ? ` · ${m.host}` : "") +
      (m.note ? ` · ${m.note}` : ""),
    current: !!current && m.id === current.id && m.backend === current.backend && m.baseUrl === current.baseUrl,
  }));
}

export const FIND_ROW: SelectOption = { label: "+ Find models on another machine…", hint: "search my network or enter an address" };
export const HOSTS_ROW: SelectOption = { label: "Network hosts…", hint: "rename, remove or re-find added machines" };

/** Nothing answered on this computer. Rather than giving up, offer to look on
 * the network — with both UIs' own pickers, before a session exists. Returns
 * a ready model, or null when the user backs out. */
export async function setupWithoutLocalModels(ui: FlowUI, prefs: SessionPrefs): Promise<DetectedModel | null> {
  for (;;) {
    const pick = await ui.select("No model server found on this computer", [
      { label: "Find models on another machine", hint: "search my network or enter an address" },
      { label: "Look again", hint: "after starting Ollama or LM Studio here" },
    ]);
    if (pick === null) return null;
    if (pick === 0 && !(await findModelsOnNetwork(ui))) continue;
    ui.startSpinner("looking for Ollama and LM Studio");
    const cfg = loadConfig();
    const models = (await detectAll({ hosts: cfg.hosts })).filter((m) => !prefs.backend || m.backend === prefs.backend);
    ui.stopSpinner();
    if (!models.length) {
      ui.warn("Still no model server answering.");
      continue;
    }
    // A machine was just added by hand: let the user say which of its models
    // to load instead of pulling the first one into its memory.
    const idx = models.length === 1 ? 0 : await ui.select("Select model", modelOptions(models));
    if (idx === null) continue;
    ui.startSpinner(`loading ${models[idx].id}`);
    try {
      return await resolveContextWindow(models[idx], prefs.ctx);
    } finally {
      ui.stopSpinner();
    }
  }
}

// ---- session titles ---------------------------------------------------------

/** Ask the model for a short session name from the first exchange. One cheap
 * call with thinking off and a tiny output cap; null when the reply is not
 * usable, in which case the caller keeps its fallback (the first message). */
export async function suggestTitle(messages: Msg[], provider: Provider): Promise<string | null> {
  const first = messages.find((m) => m.role === "user" && !m.compactNote);
  if (!first) return null;
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  try {
    const res = await provider.chat(
      [
        {
          role: "system",
          content:
            "You name coding sessions. Reply with only the title: three to six words, plain text, no quotes, no trailing period.",
        },
        {
          role: "user",
          content:
            `First request:\n${truncateEnd(first.content, 600)}\n\n` +
            (reply ? `Reply excerpt:\n${truncateEnd(reply.content, 400)}\n\n` : "") +
            "Title:",
        },
      ],
      [],
      { effortOverride: "off", maxTokens: 30, timeoutMs: 15_000, background: true }
    );
    return cleanTitle(res.content);
  } catch {
    return null;
  }
}

/** Exported for tests: normalize a model-written title. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  t = t.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t
    .replace(/^(title|session( name)?)\s*:\s*/i, "")
    .replace(/^["'`“”*#\s]+|["'`“”*.\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (t.length < 3 || /[<>{}]/.test(t)) return null;
  if (t.length > 60) {
    t = t.slice(0, 60);
    const cut = t.lastIndexOf(" ");
    if (cut > 20) t = t.slice(0, cut);
    t = t.replace(/[\s,;:.-]+$/, "");
  }
  return t || null;
}

// ---- the session -----------------------------------------------------------

export interface SessionOptions {
  workspace: string;
  chosen: DetectedModel;
  prefs: SessionPrefs;
  cfg: Config;
  /** Text printed by /help. */
  help: string;
  /** Profil renforcé : contrat préparé par l'hôte. Absent = parcours courant. */
  mission?: Mission | null;
  /** Qui approuve avec /approve : l'humain du terminal ou de la page web. */
  surface?: "terminal" | "web";
  /** Profil mission : le backend isolé fourni par l'hôte (les tests en
   * simulent un). Absent : le backend Seatbelt de la mission. */
  isolation?: IsolatedExecutor;
}

export class Session {
  readonly workspace: string;
  chosen: DetectedModel;
  effort: Effort | null;
  readonly agent: Agent;
  readonly toolCtx: ToolContext;
  readonly taskManager: TaskManager;
  readonly ctxMgr: ContextManager;
  readonly bus = new EventBus();
  readonly shell = pickShell();
  /** Host hook: fired once when the session has shut down (/exit, ctrl+c). */
  onExit: (() => void) | null = null;
  /** Host hook: fired after each completed user turn (the web hub names the
   * session after the first one). */
  onTurnDone: (() => void) | null = null;

  /** Les consignes de la session (#10) : lues à l'ouverture, gardées à la
   * reprise, changées seulement par une transition explicite (/instructions). */
  private globalAgentsMd: string | null;
  private workspaceAgentsMd: string | null;
  /** Index des fiches de méthode installées (#30) ; null sans installation. */
  private readonly fichesIndex: string | null;
  private readonly prefs: SessionPrefs;
  private readonly help: string;
  private ended = false;
  readonly mission: Mission | null;
  /** Profil mission : l'exécuteur isolé des quatre surfaces (le hub le donne
   * au terminal web de la session). Absent hors profil : l'adaptateur hôte. */
  readonly executor?: IsolatedExecutor;
  private readonly surface: "terminal" | "web";
  private readonly commands: SlashCommand[];

  constructor(
    readonly ui: SessionUI,
    opts: SessionOptions
  ) {
    const { workspace, chosen, prefs, cfg } = opts;
    this.workspace = workspace;
    this.chosen = chosen;
    this.prefs = prefs;
    this.help = opts.help;
    const mode0 = prefs.mode ?? cfg.lastMode ?? "edit";
    this.effort = prefs.effort !== undefined ? prefs.effort : (cfg.effort ?? null);

    const provider = makeProvider(chosen);
    provider.setEffort(this.effort);
    this.mission = opts.mission ?? null;
    // Profil mission (#16) : toutes les commandes passent par le backend isolé,
    // qui refuse tout s'il est absent ou inopérant. Hors profil, rien ne change.
    this.executor = this.mission ? (opts.isolation ?? missionExecutor(this.mission)) : undefined;
    this.taskManager = new TaskManager(workspace, this.executor);
    this.toolCtx = {
      workspace,
      taskManager: this.taskManager,
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
      ...(this.executor ? { executor: this.executor } : {}),
    };
    this.ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
    const agents = loadAgentsMdDetails(workspace);
    this.globalAgentsMd = agents.globalText;
    this.workspaceAgentsMd = agents.workspaceText;
    for (const w of agents.warnings) ui.status(`· ${w}`);
    // Fiches de méthode installées (#30) : l'index entre dans le prompt et
    // read_file sert `fiche:<nom>` ; sans installation, rien ne change.
    const fiches = loadHostFiches(workspace, agents.workspaceText);
    this.fichesIndex = fiches.index;
    if (fiches.dir) this.toolCtx.fichesDir = fiches.dir;
    for (const w of fiches.warnings) ui.status(`· ${w}`);
    // The step cap is a runaway-loop backstop, not a work limit — esc/ctrl+c
    // is the user's real kill switch, so set it far above any legitimate task.
    this.surface = opts.surface ?? "terminal";
    this.commands = this.mission ? [...SLASH_COMMANDS, ...MISSION_COMMANDS] : SLASH_COMMANDS;
    this.agent = new Agent(provider, mode0, this.sysPrompt(mode0), this.toolCtx, this.ctxMgr, this.bus, ui, true, 1000, undefined, this.mission);
    // #10 : sous le profil, la reprise durable s'ouvre avec la session — même
    // contrat pour le terminal, le web et le headless (src/harness/resume.ts) :
    // verrou d'écriture, état incertain, changements externes, consignes.
    if (this.mission) {
      const resume = this.mission.openResume(this.surface, this.instructionPrints());
      const report = resume.state();
      resume.onExternal = (why) => this.agent.requireReanchor(why);
      if (report.external) this.agent.requireReanchor(`The workspace changed since the last session under this contract (${describeExternal(report.external)}); those changes are someone else's and must be preserved.`);
      // #19 réutilisé : un fichier jamais vu est comparé à l'état connu de l'hôte.
      this.toolCtx.reads?.setBaseline((abs) => resume.baselineHash(abs));
      const ticked = resume.applyPlanProgress(this.toolCtx.plan);
      if (ticked) ui.status(`· plan progress restored from the last session: ${ticked} step${ticked > 1 ? "s" : ""} already done`);
    }

    ui.slashCommands = this.commands;
    ui.hintLeft = workspace.replace(os.homedir(), "~");
    ui.getStatus = () => this.statusLine();
    ui.onModeCycle = () => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(this.agent.mode) + 1) % MODE_ORDER.length];
      this.agent.setMode(next, this.sysPrompt(next));
      this.persist();
      this.noteBypassUnderMission();
    };
    ui.onCancel = () => this.agent.cancel();
    ui.onExit = () => void this.shutdown();
    reportCompactions(this.bus, ui);
    this.bus.on("context_update", () => ui.refresh());
    this.persist();
  }

  private sysPrompt(mode: Mode): string {
    return buildSystemPrompt({
      workspace: this.workspace,
      mode,
      shellLabel: this.shell.label,
      globalAgentsMd: this.globalAgentsMd,
      workspaceAgentsMd: this.workspaceAgentsMd,
      fichesIndex: this.fichesIndex,
    });
  }

  private persist(): void {
    updateConfig({ lastModel: this.chosen.id, lastModelUrl: this.chosen.baseUrl, lastMode: this.agent.mode, effort: this.effort });
  }

  /** The TUI's status row: mode · model · effort · context · plan · tasks. */
  statusLine(): string {
    const agent = this.agent;
    const tasks = this.taskManager.runningSummary().length;
    const plan = this.toolCtx.plan;
    return (
      `${modeColored(agent.mode)} ${c.dim("·")} ${this.chosen.id} ${c.dim(backendLabel(this.chosen))}` +
      (this.effort || agent.provider.effortLabel()
        ? ` ${c.dim("·")} ${c.yellow(agent.provider.effortLabel() ?? this.effort ?? "")}`
        : "") +
      ` ${c.dim("·")} ${c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`)}` +
      (plan.exists
        ? ` ${c.dim("·")} ${
            plan.currentIndex < 0
              ? c.green(`plan ${plan.doneCount}/${plan.steps.length}`)
              : c.cyan(`plan ${plan.doneCount}/${plan.steps.length}`)
          }`
        : "") +
      (tasks ? ` ${c.dim("·")} ${c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)}` : "") +
      (this.mission ? ` ${c.dim("·")} ${this.missionLabel()}` : "")
    );
  }

  /** Profil mission (#11) : passer en bypass est un geste humain (shift+tab,
   * /mode, --mode) qui n'élargit pas la politique ; il est dit à l'écran.
   * Aucun outil du modèle ne change le mode ni ne quitte le profil. */
  private noteBypassUnderMission(): void {
    if (this.mission && this.agent.mode === "bypass") this.ui.status(BYPASS_UNDER_MISSION);
  }

  private missionLabel(): string {
    const s = this.mission!.status();
    const label = `mission ${s.state} ${s.steps}/${s.maxSteps}`;
    const mission = s.state === "approved" ? c.green(label) : c.yellow(label);
    // #18 : l'état de l'isolation reste dans la ligne d'état toute la session.
    if (!this.executor) return mission;
    const iso = isolationState(this.executor);
    return `${mission} ${c.dim("·")} ${iso.state === "ready" ? c.green(iso.label) : c.red(iso.label)}`;
  }

  /** Structured status for the web page's status bar. */
  state(): Record<string, any> {
    const plan = this.toolCtx.plan;
    return {
      mode: this.agent.mode,
      model: this.chosen.id,
      backend: this.chosen.backend,
      host: this.chosen.host,
      vision: this.chosen.vision,
      effort: this.agent.provider.effortLabel() ?? this.effort,
      ctxTokens: this.agent.contextTokens(),
      ctxPct: this.agent.contextPercent(),
      context: this.agent.contextBudget(),
      outcome: this.agent.outcome,
      lastError: this.agent.lastError,
      plan: plan.exists ? { steps: plan.steps, current: plan.currentIndex } : null,
      tasks: this.taskManager.runningSummary().length,
      workspace: this.workspace,
      commands: this.commands,
      urls: this.taskManager.recentUrls(),
      ...(this.mission ? { mission: { ...this.mission.status(), id: this.mission.contract.id, fingerprint: this.mission.fingerprint } } : {}),
      // #18 : la page garde l'état de l'isolation visible toute la session.
      ...(this.executor ? { isolation: isolationState(this.executor) } : {}),
    };
  }

  /** The opening lines: backend · model · mode, workspace, AGENTS.md, advice. */
  announce(): void {
    const ui = this.ui;
    if (this.chosen.note) ui.warn(`  ${this.chosen.note}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
    if (this.mission) {
      ui.println(this.mission.markdown());
      // #29 : le plan proposé ou approuvé, à côté du contrat ; rien sans plan.
      const plan = this.mission.planMarkdown();
      if (plan) ui.println(plan);
      ui.status(
        this.mission.status().state === "approved"
          ? "· mission profile: the contract is approved; the agent works within it"
          : "· mission profile: the agent can read and plan; writes and commands stay blocked until you type /approve"
      );
      if (this.executor) ui.status(isolationLine(this.executor.status, this.executor.listening()));
      this.noteBypassUnderMission();
      for (const line of this.mission.resume.lines()) ui.warn(line);
    }
  }

  /** La résolution humaine d'une action restée incertaine (#10) : chaque
   * effet sans résultat est montré avec ce que les fichiers en disent, puis
   * l'humain accepte l'état actuel du workspace comme base, ou non. */
  private async resolveUncertain(): Promise<void> {
    const { ui } = this;
    const resume = this.mission!.resume;
    const open = resume.state().uncertain.filter((u) => !u.resolved);
    const r = resume.state();
    if (!open.length) {
      ui.status(r.suspended ? `· nothing to resolve here: ${r.reason}` : "· no uncertain action: nothing to resolve");
      return;
    }
    const by = this.surface === "web" ? "web-human" : "terminal-human";
    for (const u of open) {
      ui.status(`· effect ${u.id}: ${u.tool} ${u.target} (${u.at}) — no recorded result. Evidence: ${u.meaning}.`);
      const pick = await ui.select(`Resolve effect ${u.id}? The workspace as it is now becomes the baseline; nothing is replayed or undone.`, [
        { label: "Accept the workspace as it is now", hint: "record my decision; writes resume once nothing else is uncertain" },
        { label: "Leave it uncertain", hint: "writes and commands stay suspended" },
      ]);
      if (pick !== 0) {
        ui.status(`· effect ${u.id} left uncertain — writes and commands stay suspended`);
        continue;
      }
      try {
        resume.resolve([u.id], by);
        ui.status(`· effect ${u.id} resolved (${by})`);
      } catch (err: any) {
        ui.error(String(err?.message ?? err));
      }
    }
    const after = resume.state();
    ui.status(after.suspended ? `· still suspended: ${after.reason}` : "· nothing is uncertain any more: writes and commands follow the contract again");
  }

  /** L'approbation humaine du terminal ou de la page web : la vue du
   * contrat (et du plan proposé, #29), puis une confirmation explicite liée
   * à leurs empreintes. */
  private async approveMission(): Promise<void> {
    const { ui } = this;
    const mission = this.mission!;
    ui.println(mission.markdown());
    const planText = mission.planMarkdown();
    if (planText) ui.println(planText);
    const st = mission.status();
    if (st.state === "approved") {
      // #9 : les entrées du vérificateur ont changé (ou n'ont jamais été
      // figées) : les approuver telles quelles est un nouvel acte humain.
      const v = mission.verifierState();
      if (v.state === "frozen" || !v.current) {
        ui.status(v.state === "frozen" ? "· this contract is already approved; its verifier inputs are unchanged" : `· this contract is already approved; its verifier inputs cannot be frozen (${v.reason})`);
        return;
      }
      ui.status(v.state === "changed" ? `· verifier inputs changed since approval: ${v.changes.join(", ")}` : `· verifier inputs not frozen (${v.reason})`);
      const pick = await ui.select(`Approve the verifier inputs as they are now (${v.current.slice(0, 16)})? Acceptance checks then trust these tests, configuration and scripts.`, [
        { label: "Approve", hint: "freeze the current tests, configuration and scripts" },
        { label: "Cancel", hint: "acceptance stays blocked until they are restored" },
      ]);
      if (pick !== 0) {
        ui.status("· verifier inputs not approved — acceptance stays blocked");
        return;
      }
      try {
        mission.approveVerifiers(this.surface === "web" ? "web-human" : "terminal-human", v.current);
        ui.status(`· verifier inputs approved (${v.current.slice(0, 16)})`);
      } catch (err: any) {
        ui.error(String(err?.message ?? err));
      }
      return;
    }
    const by = this.surface === "web" ? "web-human" : "terminal-human";
    // #29 : un plan proposé s'approuve avec le contrat, dans le même geste ;
    // un contrat qui exige un plan ne s'approuve pas sans lui.
    const plan = mission.planView();
    if (plan.required && plan.state !== "proposed") {
      ui.error(`This mission contract requires an implementation plan approved with it, and none is proposed: ask the agent to propose one (plan tool, action "propose"), then /approve again.`);
      return;
    }
    if (plan.state === "proposed" && plan.fingerprint) {
      const missing = mission.missingProofs(plan.content);
      if (missing.length) ui.warn(`· acceptance criteria without a planned proof: ${missing.join(", ")} — the plan does not say how they will be proven`);
      const pfp = plan.fingerprint.slice(0, 16);
      const options = [
        { label: "Approve contract and plan", hint: "record my approval of this exact contract and this exact plan" },
        ...(plan.required ? [] : [{ label: "Approve contract only", hint: "the plan stays unapproved: no plan baseline, no deviation tracked" }]),
        { label: "Cancel", hint: "keep writes and commands blocked" },
      ];
      const choice = await ui.select(`Approve mission contract ${mission.fingerprint.slice(0, 16)} and plan ${pfp}? Writes and commands are then allowed within ${st.maxSteps - st.steps} model steps.`, options);
      if (choice === null || choice === options.length - 1) {
        ui.status("· not approved — writes and commands stay blocked");
        return;
      }
      try {
        mission.approve(by, mission.fingerprint, choice === 0 ? { plan: plan.fingerprint } : {});
        ui.status(choice === 0
          ? `· mission approved (${mission.fingerprint.slice(0, 16)}) with plan ${pfp}`
          : `· mission approved (${mission.fingerprint.slice(0, 16)}); the proposed plan ${pfp} was not approved — no plan baseline`);
      } catch (err: any) {
        ui.error(String(err?.message ?? err));
      }
      return;
    }
    const pick = await ui.select(`Approve mission contract ${mission.fingerprint.slice(0, 16)}? Writes and commands are then allowed within ${st.maxSteps - st.steps} model steps.`, [
      { label: "Approve", hint: "record my approval of this exact contract" },
      { label: "Cancel", hint: "keep writes and commands blocked" },
    ]);
    if (pick !== 0) {
      ui.status("· not approved — writes and commands stay blocked");
      return;
    }
    try {
      mission.approve(by);
      ui.status(`· mission approved (${mission.fingerprint.slice(0, 16)})`);
    } catch (err: any) {
      ui.error(String(err?.message ?? err));
    }
  }

  /** Les empreintes des consignes de la session, pour la reprise de l'hôte. */
  private instructionPrints(): InstructionPrints {
    const i = this.instructions();
    return { global: i.global?.sha256 ?? null, workspace: i.workspace?.sha256 ?? null };
  }

  /** Les consignes que cette session utilise (#10), texte et empreinte. */
  instructions(): SessionInstructions {
    return { global: instruction(this.globalAgentsMd), workspace: instruction(this.workspaceAgentsMd) };
  }

  /** Le chemin réel du workspace, pour ranger la vue de l'agent en relatif. */
  private realWorkspace(): string {
    try {
      return fs.realpathSync.native(this.workspace);
    } catch {
      return path.resolve(this.workspace);
    }
  }

  /** Le schéma de reprise v2 (#10, src/session-state.ts). */
  snapshot(): SessionSnapshot {
    const ws = this.realWorkspace();
    const views: Array<[string, string]> = [];
    for (const [abs, hash] of this.toolCtx.reads?.entries() ?? []) {
      const rel = path.relative(ws, abs);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) views.push([rel.split(path.sep).join("/"), hash]);
    }
    return {
      schema: SESSION_SCHEMA,
      messages: this.agent.messages.slice(1),
      plan: this.toolCtx.plan.steps.map((s) => ({ ...s })),
      filesTouched: [...this.toolCtx.filesTouched],
      commandsRun: [...this.toolCtx.commandsRun],
      originalRequest: this.agent.originalRequest,
      currentRequest: this.agent.currentRequest,
      mode: this.agent.mode,
      effort: this.effort,
      model: this.chosen.id,
      backend: this.chosen.backend,
      baseUrl: this.chosen.baseUrl,
      instructions: this.instructions(),
      approvals: { alwaysAllowed: this.agent.alwaysAllowedList() },
      views,
      head: readGitHead(this.workspace),
      ...(this.mission ? { mission: this.missionRef() } : {}),
      savedAt: new Date().toISOString(),
    };
  }

  /** La référence à l'état hôte (#10) : le stockage hôte fait foi. */
  private missionRef(): { contract: string; plan: string | null; steps: number; policy: string | null } {
    const m = this.mission!;
    const st = m.status();
    const plan = m.planView();
    const policy = readPolicy(m.dir);
    return { contract: m.fingerprint, plan: plan.state === "approved" ? plan.fingerprint : null, steps: st.steps, policy: policy.state === "ok" ? policy.version : null };
  }

  /** A model-written name for this session, or null to keep the fallback. */
  suggestTitle(): Promise<string | null> {
    return suggestTitle(this.agent.messages, this.agent.provider);
  }

  /** Bring a saved session back (#10) : le transcript et sa provenance, le
   * plan, les consignes que la session utilisait (jamais relues en silence),
   * ses approbations de commandes, la vue que l'agent avait des fichiers et la
   * révision Git. Une session antérieure (v1) se migre sans rien perdre ; un
   * schéma inconnu est refusé. Ce qui a changé depuis la sauvegarde est dit,
   * préservé, et le plan est réancré avant la prochaine écriture. */
  restore(raw: SessionSnapshot): void {
    const read = readSnapshot(raw);
    if (read.state === "unknown-schema") throw new Error(`this session was saved with an unknown schema (${JSON.stringify(read.schema)}), probably by a newer smolcoder: it is not resumed, and nothing is overwritten`);
    if (read.state === "unreadable") throw new Error(`this saved session cannot be read (${read.reason}): it is not resumed`);
    const s = read.snapshot;
    // Profil mission : un appel resté sans réponse est raconté par le journal
    // d'effets de l'hôte (fini, jamais lancé, ou incertain), pas deviné.
    const resume = this.mission?.resume;
    this.agent.restoreTranscript(s.messages ?? [], s.originalRequest ?? "", s.currentRequest ?? "", resume ? (call) => resume.explainCall(call.id, call.name, call.args) : undefined);
    this.toolCtx.plan.steps = (s.plan ?? []).map((p) => ({ text: String(p.text), done: !!p.done,
      ...(typeof p.note === "string" ? { note: p.note.slice(0, 1000) } : {}) }));
    for (const f of s.filesTouched ?? []) this.toolCtx.filesTouched.add(f);
    this.toolCtx.commandsRun.push(...(s.commandsRun ?? []));
    if (read.dropped?.length) this.ui.warn(`· saved session fields could not be read and were left out: ${read.dropped.join(", ")}`);
    this.restoreInstructions(s, read.schema === LEGACY_SESSION_SCHEMA);
    // Approbations « always » (hors profil mission, où elles ne valent que pour l'appel).
    const approvals = s.approvals?.alwaysAllowed ?? [];
    if (!this.mission && approvals.length) {
      this.agent.restoreApprovals(approvals);
      this.ui.status(`· command approvals restored from the saved session: ${approvals.join(", ")} (always allowed)`);
    }
    this.restoreViews(s);
  }

  /** C6 : la version des consignes de la session est conservée ; un écart
   * avec le disque est signalé, jamais rechargé en silence. */
  private restoreInstructions(s: SessionSnapshot, legacy: boolean): void {
    const disk = this.instructions();
    const fps = (x: SessionInstructions) => `global ${x.global ? x.global.sha256.slice(0, 12) : "absent"}, workspace ${x.workspace ? x.workspace.sha256.slice(0, 12) : "absent"}`;
    if (legacy || !s.instructions) {
      this.ui.status(`· this session was saved before smolcoder recorded its instructions: the AGENTS.md version it used is unknown, so the files on disk are loaded (${fps(disk)})`);
      return;
    }
    // L'opt-out du noyau global (SMOL_NO_GLOBAL_AGENTS) reste celui du lancement.
    const optOut = process.env.SMOL_NO_GLOBAL_AGENTS === "1";
    const kept: SessionInstructions = { global: optOut ? null : s.instructions.global, workspace: s.instructions.workspace };
    if (sameInstructions(kept, disk)) return;
    this.globalAgentsMd = kept.global?.text ?? null;
    this.workspaceAgentsMd = kept.workspace?.text ?? null;
    this.agent.setMode(this.agent.mode, this.sysPrompt(this.agent.mode));
    this.mission?.resume.setInstructions(this.instructionPrints());
    this.ui.warn(
      `· AGENTS.md changed since this session was saved (${describeInstructionDrift(kept, disk).join("; ")}): this session keeps the version it was using — nothing is reloaded silently. /instructions shows the difference and switches only when you choose.`
    );
  }

  /** C4 : la vue de l'agent (#19) revient avec la session ; un fichier vu qui a
   * changé depuis, comme un HEAD déplacé, est un changement externe — dit,
   * préservé, jamais attribué à l'agent, et sa première écriture refusée. */
  private restoreViews(s: SessionSnapshot): void {
    const ws = this.realWorkspace();
    const changed: string[] = [];
    for (const [rel, hash] of s.views ?? []) {
      const abs = path.join(ws, ...rel.split("/"));
      if (!abs.startsWith(ws + path.sep)) continue;
      this.toolCtx.reads?.noteHash(abs, hash);
      let now: string | null;
      try {
        now = sha256(fs.readFileSync(abs, "utf8")); // même empreinte que la vue de #19
      } catch {
        now = null;
      }
      if (now !== hash) changed.push(`${rel} (${now === null ? "deleted" : "modified"})`);
    }
    const head = s.head === undefined ? undefined : readGitHead(this.workspace);
    const moved = s.head !== undefined && head !== s.head;
    if (!changed.length && !moved) return;
    const facts = [
      ...(moved ? [`HEAD moved ${shortRev(s.head)} → ${shortRev(head)}`] : []),
      ...(changed.length ? [`files this session had seen changed: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""}`] : []),
    ].join("; ");
    this.ui.warn(`· the workspace changed since this session was saved (${facts}). These changes are preserved and are not the agent's; a file it had seen is re-checked before any write.`);
    this.agent.requireReanchor(`The workspace changed outside this session since it was saved (${facts}); those changes are someone else's and must be preserved.`);
  }

  /** La transition explicite des consignes (#10, C6) : montrer la version de
   * la session et celle du disque, et ne basculer que sur choix humain. */
  private async reviewInstructions(): Promise<void> {
    const { ui } = this;
    const session = this.instructions();
    const loaded = loadAgentsMdDetails(this.workspace);
    const disk: SessionInstructions = { global: instruction(loaded.globalText), workspace: instruction(loaded.workspaceText) };
    const fp = (x: SessionInstructions["global"]) => (x ? x.sha256.slice(0, 12) : "absent");
    ui.status(`· instructions of this session: ~/.smolcoder/AGENTS.md ${fp(session.global)}, AGENTS.md ${fp(session.workspace)}`);
    if (sameInstructions(session, disk)) {
      ui.status("· the AGENTS.md files on disk are the ones this session uses");
      return;
    }
    ui.warn(`· on disk now: ${describeInstructionDrift(session, disk).join("; ")}`);
    for (const w of loaded.warnings) ui.status(`· ${w}`);
    const pick = await ui.select("AGENTS.md changed on disk. Switch this session to the files on disk?", [
      { label: "Reload from disk", hint: "explicit transition: the next request follows the new instructions" },
      { label: "Keep the session version", hint: "nothing changes for this session" },
    ]);
    if (pick !== 0) {
      ui.status("· instructions unchanged: this session keeps its version");
      return;
    }
    this.globalAgentsMd = loaded.globalText;
    this.workspaceAgentsMd = loaded.workspaceText;
    this.agent.setMode(this.agent.mode, this.sysPrompt(this.agent.mode));
    this.mission?.resume.setInstructions(this.instructionPrints());
    ui.status(`· instructions reloaded from disk (~/.smolcoder/AGENTS.md ${fp(disk.global)}, AGENTS.md ${fp(disk.workspace)})`);
  }

  /** The input loop. Returns after /exit (or after the host asked the UI to
   * hand back "/exit"). */
  async run(): Promise<void> {
    const { ui, agent, toolCtx, taskManager } = this;
    await this.bus.emit("session_start");
    for (;;) {
      const raw = await ui.readInput();
      const input = typeof raw === "string" ? raw : raw.text;
      const attachments = typeof raw === "string" ? [] : raw.attachments;

      if (!attachments.length && input.startsWith("/")) {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        const arg = rest[0];
        switch (cmd) {
          case "exit":
          case "quit":
          case "q":
            await this.shutdown();
            return;
          case "help":
            ui.println(this.help);
            break;
          case "models":
          case "model":
            await this.switchModel();
            break;
          case "mode":
            await this.setMode(arg);
            break;
          case "effort":
            await this.setEffort(arg);
            break;
          case "plan":
            if (toolCtx.plan.exists) ui.println(renderPlan(toolCtx.plan));
            else ui.status("· no plan yet — the agent creates one when it starts a multi-step task");
            break;
          case "tasks":
            ui.println(taskManager.list());
            break;
          case "logs":
            ui.println(taskManager.logs(arg ?? "", Number(rest[1]) || 50));
            break;
          case "stop":
            ui.println(taskManager.stop(arg ?? ""));
            break;
          case "compact":
            ui.startSpinner("compacting");
            try { await agent.compactNow(); }
            catch (err: any) { ui.error(String(err?.message ?? err)); }
            finally { ui.stopSpinner(); }
            break;
          case "context":
            const budget = agent.contextBudget();
            ui.status(
              `Context ${budget.prompt.toLocaleString()} / ${budget.window.toLocaleString()} tokens (${budget.source})\nReply reserve ${budget.reserve.toLocaleString()} · available ${budget.available.toLocaleString()} · ${agent.messages.length} messages · ${agent.tools.length} tools`
            );
            break;
          case "instructions":
            await this.reviewInstructions();
            break;
          case "clear":
            agent.resetTranscript();
            toolCtx.plan.reset();
            // #29 : le plan approuvé avec le contrat survit, comme le contrat.
            this.mission?.seedPlan(toolCtx.plan);
            ui.status("· conversation cleared");
            break;
          case "mission":
            if (!this.mission) ui.warn(`Unknown command /${cmd} — try /help`);
            else {
              ui.println(this.mission.markdown());
              const plan = this.mission.planMarkdown();
              if (plan) ui.println(plan);
            }
            break;
          case "approve":
            if (!this.mission) ui.warn(`Unknown command /${cmd} — try /help`);
            else await this.approveMission();
            break;
          case "resolve":
            if (!this.mission) ui.warn(`Unknown command /${cmd} — try /help`);
            else await this.resolveUncertain();
            break;
          default:
            ui.warn(`Unknown command /${cmd} — try /help`);
        }
        ui.refresh();
        continue;
      }

      try {
        await agent.runTurn(input, attachments);
        this.onTurnDone?.();
      } catch (err: any) {
        ui.error(`\n${err?.message ?? err}`);
        if (String(err?.message ?? "").toLowerCase().includes("does not support tools")) {
          ui.warn(
            "This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo)."
          );
        }
      }
    }
  }

  /** Idempotent: end-of-session hook, kill background tasks, close the UI,
   * then tell the host. */
  async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.agent.cancel();
    try {
      await this.bus.emit("session_end");
    } catch {
      /* best effort */
    }
    this.taskManager.killAll();
    this.releaseWriter();
    this.ui.close();
    this.onExit?.();
  }

  /** #10 : rend le verrou d'écriture du workspace (fin de session, arrêt du
   * hub, signal). Sans effet hors profil ou déjà rendu. */
  releaseWriter(): void {
    try {
      this.mission?.resume.release(this.toolCtx.plan);
    } catch {
      /* au mieux : un verrou non rendu est repris quand son processus n'est plus */
    }
  }

  private async switchModel(): Promise<void> {
    const { ui, agent } = this;
    let fresh: DetectedModel[];
    let idx: number | null;
    // The picker is also where other machines are added and managed; after
    // either, look again and reopen it so their models are right there.
    for (;;) {
      const hosts = loadConfig().hosts ?? [];
      ui.startSpinner("looking for models");
      fresh = await detectAll({ hosts });
      ui.stopSpinner();
      if (!fresh.length) ui.warn("No model server is answering right now.");
      const rows = [...modelOptions(fresh, this.chosen), FIND_ROW, ...(hosts.length ? [HOSTS_ROW] : [])];
      idx = await ui.select("Select model", rows);
      if (idx === null) return;
      if (idx < fresh.length) break;
      if (rows[idx] === FIND_ROW) await findModelsOnNetwork(ui);
      else await manageHosts(ui);
    }
    let next: DetectedModel;
    ui.startSpinner(`loading ${fresh[idx].id}`);
    try {
      next = await resolveContextWindow(fresh[idx], this.prefs.ctx);
    } catch (err: any) {
      ui.error(String(err?.message ?? err));
      return;
    } finally {
      ui.stopSpinner();
    }
    this.chosen = next;
    const p = makeProvider(next);
    p.setEffort(this.effort);
    agent.setProvider(p);
    this.ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
    this.persist();
    ui.println(sessionLine(next, agent.mode));
    if (next.note) ui.warn(`  ${next.note}`);
    const advice = effortAdvice(next, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  private async setMode(arg?: string): Promise<void> {
    const { ui, agent } = this;
    let next: Mode | undefined =
      arg === "ro"
        ? "ro"
        : arg === "edit" || arg === "write"
          ? "edit"
          : arg === "bypass" || arg === "yolo"
            ? "bypass"
            : undefined;
    if (!next) {
      const idx = await ui.select("Select mode", [
        { label: "read-only", hint: "read and search files only", current: agent.mode === "ro" },
        {
          label: "edit",
          hint: "edit files; run commands inside the workspace, ask y/n for anything outside it",
          current: agent.mode === "edit",
        },
        {
          label: "bypass permissions",
          hint: "full access, never asks for approval",
          current: agent.mode === "bypass",
        },
      ]);
      if (idx === null) return;
      next = MODE_ORDER[idx];
    }
    agent.setMode(next, this.sysPrompt(next));
    this.persist();
    this.noteBypassUnderMission();
  }

  private async setEffort(arg?: string): Promise<void> {
    const { ui, agent } = this;
    const levels: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];
    let next: Effort | null | undefined;
    if (arg && (levels as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await ui.select("Reasoning effort", [
        {
          label: "default",
          hint: this.chosen.reasoning?.default
            ? `the model's own default (${this.chosen.reasoning.default})`
            : "leave it to the model",
          current: this.effort === null,
        },
        { label: "off", hint: "no thinking — fastest, best for long tool loops", current: this.effort === "off" },
        { label: "low", hint: "brief reasoning", current: this.effort === "low" },
        { label: "medium", hint: "", current: this.effort === "medium" },
        { label: "high", hint: "most thorough — slow on local models", current: this.effort === "high" },
      ]);
      if (idx === null) return;
      next = idx === 0 ? null : (levels[idx] as Effort);
    }
    this.effort = next;
    agent.provider.setEffort(this.effort);
    this.persist();
    const label = agent.provider.effortLabel();
    ui.status(`· effort ${label ?? this.effort ?? "default"}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }
}
