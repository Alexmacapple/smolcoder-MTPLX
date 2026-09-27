#!/usr/bin/env node
// smolcoder — a smol, zero-config CLI coding agent for local models.
//
// Interactive: an opencode-style inline TUI. No upfront questions — the last
// (or first) detected model is picked automatically; switch with /models,
// cycle modes with shift+tab, set reasoning effort with /effort.
// Web: smol --web serves a browser UI with a workspace sidebar — many
// projects and sessions side by side, started from anywhere.
// Headless: smol -p "prompt" for people and automations.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent } from "./agent";
import { loadConfig } from "./config";
import { authorizeHeadless, Mission, MISSION_EXIT_CODE, MissionError, missionExitCode, missionReport } from "./harness/mission";
import { keepHostProbesOutOf } from "./harness/host-probe";
import { BYPASS_UNDER_MISSION, decisionReport, POLICY_SUSPENDED_EXIT_CODE, PolicySuspension } from "./harness/policy";
import { VERDICT_EXIT_CODE, verdictExitCode, verdictSummary } from "./harness/proofs";
import { isolationLine, missionExecutor } from "./harness/sandbox-executor";
import { ContextManager } from "./context";
import { EventBus } from "./events";
import { terminalLogo } from "./logo";
import { Plan } from "./plan";
import { buildSystemPrompt, loadAgentsMdDetails } from "./prompt";
import { installFiches, packageSkillsDir, loadHostFiches } from "./fiches";
import { Effort } from "./providers/types";
import {
  effortAdvice,
  makeProvider,
  noBackendsMessage,
  prepareModel,
  reportCompactions,
  Session,
  SessionPrefs,
  sessionLine,
  setupWithoutLocalModels,
} from "./session";
import { Mode, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { Tui } from "./tui/tui";
import { UI } from "./ui";
import { c } from "./util";
import { askHubToOpen, pingHub, readHubRecord, WebHub } from "./web/hub";

const VERSION = require("../package.json").version as string;
const DEFAULT_WEB_PORT = 7433;

interface CliArgs {
  workspace: string;
  /** A folder was given on the command line (vs. defaulting to the cwd). */
  workspaceGiven?: boolean;
  mode?: Mode;
  model?: string;
  ctx?: number;
  print?: string;
  verify?: string;
  verifyAttempts?: number;
  /** Profil renforcé : fichier de contrat de mission (hors du workspace). */
  mission?: string;
  /** Approbation headless de l'appelant : l'empreinte exacte du contrat. */
  approve?: string;
  /** Nouvelle approbation headless des entrées du vérificateur (#9) :
   * l'empreinte exacte de ce qui sera figé. */
  approveVerifiers?: string;
  effort?: Effort | null; // null = explicit "default"
  web?: boolean;
  webPort?: number;
  /** Copie docs/skills/ du fork dans ~/.smolcoder/fiches, puis s'arrête (#30). */
  installFiches?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--mode" || a === "-m") {
      const v = argv[++i];
      if (v === "ro" || v === "read-only" || v === "readonly") args.mode = "ro";
      else if (v === "edit" || v === "e" || v === "write" || v === "w") args.mode = "edit";
      else if (v === "bypass" || v === "bypass-permissions" || v === "b" || v === "yolo" || v === "y")
        args.mode = "bypass";
      else {
        console.error(`Unknown mode "${v}". Use ro, edit, or bypass.`);
        process.exit(1);
      }
    } else if (a === "--bypass" || a === "--bypass-permissions" || a === "--yolo") args.mode = "bypass";
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--ctx") {
      args.ctx = Number(argv[++i]);
      if (!Number.isSafeInteger(args.ctx) || args.ctx < 1024) {
        console.error("--ctx must be a whole number of at least 1024 tokens.");
        process.exit(1);
      }
    }
    else if (a === "--effort") {
      const v = argv[++i];
      if (v === "off" || v === "low" || v === "medium" || v === "high") args.effort = v;
      else if (v === "default") args.effort = null;
      else {
        console.error(`Unknown effort "${v}". Use off, low, medium, high, or default.`);
        process.exit(1);
      }
    } else if (a === "--verify") {
      args.verify = argv[++i];
      if (!args.verify?.trim()) throw new Error('--verify needs an acceptance command');
    } else if (a === "--verify-attempts") {
      args.verifyAttempts = Number(argv[++i]);
      if (!Number.isSafeInteger(args.verifyAttempts) || args.verifyAttempts < 1) throw new Error('--verify-attempts must be a positive whole number');
    } else if (a === "--mission") {
      args.mission = argv[++i];
      if (!args.mission?.trim()) {
        console.error("--mission needs a contract file (JSON, outside the workspace).");
        process.exit(1);
      }
    } else if (a === "--approve") {
      args.approve = argv[++i];
      if (!/^[0-9a-f]{64}$/.test(args.approve ?? "")) {
        console.error("--approve needs the contract fingerprint: 64 hexadecimal characters, as printed by smol --mission.");
        process.exit(1);
      }
    } else if (a === "--approve-verifiers") {
      args.approveVerifiers = argv[++i];
      if (!/^[0-9a-f]{64}$/.test(args.approveVerifiers ?? "")) {
        console.error("--approve-verifiers needs the verifier fingerprint: 64 hexadecimal characters, as printed in the [mission] line (verifiers.current).");
        process.exit(1);
      }
    } else if (a === "--install-fiches") args.installFiches = true;
    else if (a === "--print" || a === "-p") args.print = argv[++i];
    else if (a === "--web") {
      args.web = true;
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) args.webPort = Number(argv[++i]);
    } else if (!a.startsWith("-")) {
      args.workspace = path.resolve(a);
      args.workspaceGiven = true;
    } else {
      console.error(`Unknown option "${a}". Try smol --help.`);
      process.exit(1);
    }
  }
  return args;
}

const HELP = `
${c.bold("smolcoder")} v${VERSION} — a smol, zero-config coding agent for local models.

Detects Ollama and LM Studio on this computer automatically — any port, Docker
containers included. Models on other machines: /models → "Find models on
another machine" searches your network or takes an address, and remembers it.

${c.bold("Usage:")}
  smol [workspace] [options]

${c.bold("Options:")}
  -m, --mode <ro|edit|bypass>  ro: read files only. edit: read/write files and run
                               commands inside the workspace; anything reaching
                               outside it asks y/n. bypass: no approvals at all.
  --model <name>               pick a model by (partial) name
  --ctx <tokens>               force a context window (Ollama: sends num_ctx)
  --verify <command>           headless acceptance gate; automatically repair failures
  --verify-attempts <count>     maximum acceptance checks (default 6; requires --verify)
  --mission <contract.json>    reinforced profile: a mission contract (kept outside the
                               workspace) must be approved before any write or command;
                               its budgets.maxSteps is a step budget kept across runs
  --approve <fingerprint>      headless approval of that exact contract (requires -p and
                               --mission); in the terminal or web UI, type /approve.
                               Without approval a -p run stops with exit code 3.
                               Approval also freezes the verifier inputs (tests, their
                               configuration, the scripts that run them); a -p run
                               whose required criteria are not all verified exits 5
  --approve-verifiers <fp>     headless approval of the verifier inputs as they are now
                               (fingerprint from the [mission] line), after they changed
                               The profile's access policy (policy.json, next to the
                               contract in ~/.smolcoder/harness/) decides every tool,
                               check and web-terminal line; a -p run whose next step
                               needs a human decision stops with exit code 4
  --install-fiches             copy the method sheets of this smol's clone (docs/skills/)
                               into ~/.smolcoder/fiches, then exit; new sessions on any
                               workspace list them and read_file serves "fiche:<name>"
  --effort <level>             reasoning effort: off, low, medium, high, default
  --web [port]                 browser UI (default port ${DEFAULT_WEB_PORT}): a sidebar of your
                               workspaces and sessions, an embedded browser and
                               terminal panel. Run it from anywhere; a second
                               smol --web adds its folder to the running UI.
  -p, --print "<prompt>"       headless: run a single prompt and exit
  -h, --help                   this help
  -v, --version                version

${c.bold("Keys:")}
  shift+tab   cycle mode (read-only → edit → bypass permissions)
  /           slash commands (autocomplete menu)
  esc         cancel a running turn · clear the input
  ctrl+c ×2   quit

${c.bold("Slash commands:")}
  /models     switch model         /tasks        background tasks
  /mode       set mode             /logs <id>    task output
  /effort     reasoning effort     /stop <id>    kill a task
  /context    context usage        /clear        reset conversation
  /compact    compact now          /exit         quit
`;

/** Node fires 'exit' on normal termination but NOT on a killing signal, so
 * background tasks (dev servers) survive a closed terminal (SIGHUP) or `kill`
 * (SIGTERM) unless we handle those explicitly. Runs synchronous cleanup then
 * re-exits so the 'exit' path is still reached. */
function installSignalCleanup(cleanup: () => void): void {
  let done = false;
  const run = (code: number) => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => run(143));
  process.on("SIGHUP", () => run(129));
  process.on("SIGINT", () => run(130));
}

/** The SMOL banner that opens every interactive session. */
function printLogo(): void {
  for (const line of terminalLogo(process.stdout.columns || 80, VERSION)) console.log(line);
}

function prefsOf(args: CliArgs): SessionPrefs {
  return { mode: args.mode, model: args.model, ctx: args.ctx, effort: args.effort };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.installFiches) {
    runInstallFiches();
    return;
  }
  if (args.verify && (!args.print || args.web)) throw new Error('--verify requires a headless -p run');
  if (args.verifyAttempts !== undefined && !args.verify) throw new Error('--verify-attempts requires --verify');
  if (args.approve !== undefined && !args.mission) {
    console.error("--approve requires --mission <contract file>.");
    process.exit(1);
  }
  if (args.approve !== undefined && (args.print === undefined || args.web)) {
    console.error("--approve is the headless caller's approval: it requires a -p run. In the terminal or web UI, type /approve.");
    process.exit(1);
  }
  if (args.approveVerifiers !== undefined && (!args.mission || args.print === undefined || args.web)) {
    console.error("--approve-verifiers is the headless caller's approval of the verifier inputs: it requires -p and --mission. In the terminal or web UI, type /approve.");
    process.exit(1);
  }
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) {
    console.error(`Workspace folder does not exist: ${args.workspace}`);
    process.exit(1);
  }
  // Profil mission (#18) : les sondes de l'hôte (détection des modèles,
  // contrôle syntaxique) ne cherchent jamais un programme dans ce workspace.
  if (args.mission) keepHostProbesOutOf(args.workspace);
  const mission = args.mission ? prepareMission(args) : null;

  if (args.print !== undefined) await runHeadless(args, mission);
  else if (args.web) await runWeb(args);
  else await runInteractive(args, mission);
}

/** Installation explicite des fiches de méthode (#30) : une seule source,
 * docs/skills/ du clone dont ce binaire fait partie. Sortie 1 sur refus. */
function runInstallFiches(): void {
  try {
    const r = installFiches(packageSkillsDir());
    const home = os.homedir();
    console.log(
      `Installed ${r.fiches.length} method sheets into ${r.dir.replace(home, "~")} from ${r.source.replace(home, "~")}: ` +
        `${r.fiches.map((f) => f.name).join(", ")}.\n` +
        "New sessions list them in their prompt; sessions already open keep their current prompt."
    );
  } catch (err: any) {
    console.error(`Method sheets not installed: ${err?.message ?? err}`);
    process.exit(1);
  }
}

/** Profil mission : contrat validé et proposé dans le stockage hôte avant
 * toute autre chose. Contrat invalide : sortie 1 ; stockage hôte dans un
 * état qui interdit de décider (illisible, schéma inconnu…) : sortie 3. */
function prepareMission(args: CliArgs): Mission {
  try {
    return Mission.prepare({ source: args.mission!, workspace: args.workspace });
  } catch (err: any) {
    console.error(String(err?.message ?? err));
    if (err instanceof MissionError && err.state) {
      process.stderr.write(`[mission] ${JSON.stringify({ state: err.state, contract: path.resolve(args.mission!) })}\n`);
      process.exit(MISSION_EXIT_CODE);
    }
    process.exit(1);
  }
}

// ---- headless (-p) ---------------------------------------------------------

async function runHeadless(args: CliArgs, mission: Mission | null): Promise<void> {
  const ui = new UI();
  if (mission) {
    // Décidé avant de chercher un modèle : sans approbation valable, rien ne
    // tourne, rien n'attend de réponse, la sortie est non nulle.
    const gate = authorizeHeadless(mission, args.approve, { verify: args.verify, approveVerifiers: args.approveVerifiers });
    process.stderr.write(`[mission] ${JSON.stringify(gate.report)}\n`);
    if (!gate.ok) {
      ui.println(mission.markdown());
      ui.error(gate.message);
      ui.close();
      process.exitCode = MISSION_EXIT_CODE;
      return;
    }
    ui.status(`· ${gate.message}`);
    // #9 : le run part, mais aucun contrôle décisif ne passera tant que les
    // entrées du vérificateur ne sont pas celles que l'hôte a figées.
    const v = gate.verifiers;
    if (v && v.state !== "frozen") {
      ui.warn(
        `· verifier inputs ${v.state === "changed" ? `changed since approval (${v.changes.slice(0, 10).join(", ")}${v.changes.length > 10 ? ", …" : ""})` : `not frozen (${v.reason})`}: ` +
          `acceptance cannot pass until they are restored${v.current ? `, or the host approves them as they are: --approve-verifiers ${v.current}` : ""}`
      );
    }
  }
  const bus = new EventBus();
  const cfg = loadConfig();
  const chosen = await prepareModel(prefsOf(args), cfg);
  if (!chosen) {
    ui.println(noBackendsMessage());
    ui.close();
    process.exit(1);
  }
  const mode = args.mode ?? cfg.lastMode ?? "edit";

  const shell = pickShell();
  const provider = makeProvider(chosen);
  provider.setEffort(args.effort !== undefined ? args.effort : (cfg.effort ?? null));
  // Profil mission (#16) : toutes les commandes passent par le backend isolé,
  // qui refuse tout s'il est absent ou inopérant. Hors profil, rien ne change.
  const isolation = mission ? missionExecutor(mission) : undefined;
  const taskManager = new TaskManager(args.workspace, isolation);
  const toolCtx: ToolContext = {
    workspace: args.workspace,
    taskManager,
    plan: new Plan(),
    filesTouched: new Set(),
    commandsRun: [],
    ...(isolation ? { executor: isolation } : {}),
  };
  const ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
  const agents = loadAgentsMdDetails(args.workspace);
  for (const w of agents.warnings) ui.status(`· ${w}`);
  if (agents.text) ui.status(`· Instructions loaded: ${agents.sources.join(" + ")} (${agents.text.split("\n").length} lines)`);
  // Fiches de méthode installées (#30) : index dans le prompt, `fiche:<nom>`
  // servi par read_file ; sans installation, rien ne change.
  const fiches = loadHostFiches(args.workspace, agents.workspaceText);
  for (const w of fiches.warnings) ui.status(`· ${w}`);
  if (fiches.dir) {
    toolCtx.fichesDir = fiches.dir;
    ui.status(`· Method sheets: ${fiches.count} installed (${fiches.dir.replace(os.homedir(), "~")})`);
  }
  const systemPrompt = buildSystemPrompt({
    workspace: args.workspace,
    mode,
    shellLabel: shell.label,
    globalAgentsMd: agents.globalText,
    workspaceAgentsMd: agents.workspaceText,
    fichesIndex: fiches.index,
  });
  const agent = new Agent(provider, mode, systemPrompt, toolCtx, ctxMgr, bus, ui, false, 1000,
    args.verify ? { command: args.verify, maxAttempts: args.verifyAttempts } : undefined, mission);
  reportCompactions(bus, ui);
  process.on("exit", () => taskManager.killAll());
  installSignalCleanup(() => taskManager.killAll());

  ui.println(sessionLine(chosen, mode));
  if (chosen.note) ui.warn(`  ${chosen.note}`);
  if (mission && mode === "bypass") ui.status(BYPASS_UNDER_MISSION);
  if (isolation) {
    const listen = isolation.listening();
    process.stderr.write(`[isolation] ${JSON.stringify({ ...isolation.status, ...(listen.length ? { listen } : {}) })}\n`);
    ui.status(isolationLine(isolation.status, listen));
  }
  const effortSetting = args.effort !== undefined ? args.effort : (cfg.effort ?? null);
  ui.status(`  effort ${provider.effortLabel() ?? effortSetting ?? "default"}`);
  const advice = effortAdvice(chosen, effortSetting);
  if (advice) ui.warn(`  ${advice}`);
  try {
    await agent.runTurn(args.print!);
    if (agent.outcome !== "completed") process.exitCode = 1;
  } catch (err: any) {
    ui.error(`\n${err?.message ?? err}`);
    process.exitCode = 1;
    // Profil mission : une décision « ask » sans humain suspend le run avec
    // une sortie dédiée, jamais une autorisation par défaut.
    if (err instanceof PolicySuspension) {
      process.exitCode = POLICY_SUSPENDED_EXIT_CODE;
      process.stderr.write(`[policy] ${JSON.stringify(decisionReport(err.decision))}\n`);
    }
  }
  // Profil mission (#9) : la sortie suit le verdict, constaté après le tour —
  // 0 seulement quand chaque critère requis est `passed` sur les fichiers
  // actuels et que le rapport est écrit ; 4 (suspension) et 3 (contrat)
  // priment.
  const verdict = mission ? agent.missionVerdict : null;
  if (mission) {
    if (verdict) process.stderr.write(`[verdict] ${JSON.stringify(verdictSummary(verdict.report, verdict.files?.json ?? null))}\n`);
    if (process.exitCode !== POLICY_SUSPENDED_EXIT_CODE) process.exitCode = verdict?.files ? verdictExitCode(verdict.report) : VERDICT_EXIT_CODE;
  }
  const missionEnd = mission ? mission.status() : null;
  if (mission && missionEnd) {
    const code = missionExitCode(missionEnd);
    if (code !== null) {
      process.exitCode = code;
      process.stderr.write(`[mission] ${JSON.stringify(missionReport(mission, missionEnd))}\n`);
    }
  }
  const st = agent.lastTurnStats;
  if (st) {
    const vr = agent.verificationResult;
    // Machine-readable summary for scripts/benchmarks comparing backends.
    process.stderr.write(
      `[stats] ${JSON.stringify({
        backend: chosen.backend,
        outcome: agent.outcome,
        // Profil mission : jamais un vert périmé — une réussite dont la preuve
        // ne tient plus sur les fichiers actuels n'est pas `passed`.
        verification: vr ? { attempts: vr.attempts, passed: vr.passed && !(verdict?.report.stale ?? false) } : null,
        ...(verdict ? { verdict: verdict.report.task.state } : {}),
        model: chosen.id,
        durationMs: st.durationMs,
        modelCalls: st.modelCalls,
        toolCalls: st.toolCalls,
        generatedTokens: st.generatedTokens,
        thinkingTokensEst: Math.round(st.thinkingChars / 4),
        genTokPerSec: st.genSeconds > 0 ? Math.round(st.generatedTokens / st.genSeconds) : null,
        promptTokensLast: st.promptTokensLast,
        contextWindow: chosen.contextWindow,
        planDone: toolCtx.plan.exists ? `${toolCtx.plan.doneCount}/${toolCtx.plan.steps.length}` : null,
        ...(mission && missionEnd ? { mission: missionReport(mission, missionEnd) } : {}),
      })}\n`
    );
  }
  taskManager.killAll();
  ui.close();
}

// ---- interactive TUI -------------------------------------------------------

async function runInteractive(args: CliArgs, mission: Mission | null): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      'Interactive mode needs a terminal. For headless use, run: smol -p "your prompt" — or serve a browser UI with --web'
    );
    process.exit(1);
  }

  printLogo();
  const cfg = loadConfig();
  process.stdout.write(c.dim("· looking for Ollama and LM Studio…"));
  let chosen = await prepareModel(prefsOf(args), cfg, (label) => {
    process.stdout.write("\r\x1b[2K" + c.dim(`· ${label}…`));
  });
  process.stdout.write("\r\x1b[2K");

  const tui = new Tui();
  if (!chosen) {
    // Nothing on this computer: open the TUI early and offer to look on the
    // network. Until a session exists, esc/ctrl+c while it searches quits.
    tui.onCancel = () => {
      tui.close();
      process.exit(130);
    };
    tui.start();
    chosen = await setupWithoutLocalModels(tui, prefsOf(args));
    if (!chosen) {
      tui.close();
      console.log(noBackendsMessage());
      process.exit(1);
    }
  }

  const session = new Session(tui, { workspace: args.workspace, chosen, prefs: prefsOf(args), cfg, help: HELP, mission, surface: "terminal" });
  session.onExit = () => process.exit(0);
  process.on("exit", () => session.taskManager.killAll());
  installSignalCleanup(() => {
    session.taskManager.killAll();
    try {
      tui.close(); // restore the raw-mode terminal on signal death
    } catch {
      /* best effort */
    }
  });

  tui.start();
  session.announce();
  tui.println("");
  await session.run();
}

// ---- web hub (--web) -------------------------------------------------------

/** The home folder or a drive root is not a project: launching there opens
 * the hub with the sidebar and lets the user pick a workspace. */
function isHomeOrRoot(p: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const r = path.resolve(p);
  return norm(r) === norm(os.homedir()) || path.dirname(r) === r;
}

async function runWeb(args: CliArgs): Promise<void> {
  console.log(`${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim("v" + VERSION + " · web")}`);
  const port = args.webPort ?? DEFAULT_WEB_PORT;
  const workspace = args.workspace;
  const autoStart = !!args.workspaceGiven || !isHomeOrRoot(workspace);

  // A hub is already running: hand it this folder instead of starting another.
  const rec = readHubRecord();
  if (rec && (args.webPort === undefined || rec.port === port) && (await pingHub(rec))) {
    if (args.mission) {
      // Le hub en marche ne peut pas recevoir de contrat : refus explicite
      // plutôt qu'une session ouverte sans le profil demandé.
      console.error(`--mission needs its own web UI, and one is already running on port ${rec.port}. Stop it, or start another: smol --web ${rec.port + 1} ${workspace} --mission ${args.mission}`);
      process.exit(1);
    }
    if (!autoStart) {
      // Home or a drive root is not a project: open the hub sidebar without
      // registering the folder as a workspace or starting a session.
      console.log(`\n  opened the running web UI:\n  http://127.0.0.1:${rec.port}/?k=${rec.token}\n`);
      return;
    }
    const r = await askHubToOpen(rec, workspace, autoStart);
    if (r) {
      const url = `http://127.0.0.1:${rec.port}/?k=${rec.token}${r.id ? "#" + r.id : ""}`;
      console.log(
        `\n  ${autoStart ? "started a session for" : "added"} ${workspace} in the running web UI:\n  ${url}\n`
      );
      return;
    }
  }

  const prefs = { ...prefsOf(args), ...(args.mission ? { mission: { source: path.resolve(args.mission), workspace } } : {}) };
  const hub = new WebHub({ port, prefs, help: HELP, version: VERSION });
  try {
    await hub.start();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Pick another with: smol --web ${port + 1}`);
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", () => hub.shutdownSync());
  installSignalCleanup(() => hub.shutdownSync());

  if (autoStart) hub.openSession(workspace);
  console.log(
    `\n  smolcoder web UI:  ${hub.url()}\n  ${
      autoStart ? `workspace ${workspace}` : "pick a workspace in the sidebar"
    } · ctrl+c stops the server\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
