// Tool registry. Eight tools with flat parameters — no
// nested objects or arrays: small models mangle them), an example call inside
// every description (small models imitate better than they infer), and the
// mode decides which schemas are sent. The agent rechecks mode at execution.

import { Plan, PlanHooks, readProposal } from "../plan";
import { ToolSpec } from "../providers/types";
import { editFile, listFiles, readFile, renderRead, writeFile } from "./fs-tools";
import { isFicheRef, readInstalledFiche } from "../fiches";
import { syntaxCheck } from "./check";
import { ExecOptions, runCommand } from "./shell";
import { CommandLogs, isLogRef, logReadOnly } from "./command-log";
import type { ReadTracker } from "./read-tracker";
import type { Executor } from "../harness/executor";
import { TaskManager } from "./tasks";
import { PathRules, resolveInWorkspace, SandboxError } from "../sandbox";
import { truncateMiddle } from "../util";
import { searchFilesBounded } from "./search-worker";

export type Mode = "ro" | "edit" | "bypass";

export const MODE_LABELS: Record<Mode, string> = {
  ro: "read-only",
  edit: "edit",
  bypass: "bypass permissions",
};

const TOOL_RESULT_CAP = 10000; // chars — final safety net over per-tool caps

/** Profil mission (#29) : l'outil plan sait aussi proposer le plan
 * d'implémentation que l'hôte approuve avec le contrat. Hors --mission, son
 * schéma est celui d'avant #29, à l'octet près. */
function missionPlanSpec(base: ToolSpec): ToolSpec {
  const props = base.parameters.properties as Record<string, any>;
  return {
    ...base,
    description:
      base.description +
      ' Mission contract: before the host approves it, propose the implementation plan the host will approve with it: {"action":"propose","steps":"step 1\\nstep 2","files":"src/a.js\\ntest/a.test.js","risks":"...","proofs":"1: how criterion 1 will be proven\\n2: ..."} — steps in the order of the work, files to create or modify, risks and technical constraints, one proof line per acceptance criterion (by its number). After approval the plan is a guide, not a cage: changing it or writing another file is allowed and shown to the host — say why in "reason".',
    parameters: {
      ...base.parameters,
      properties: {
        ...props,
        action: { ...props.action, enum: [...props.action.enum, "propose"] },
        files: { type: "string", description: 'Files to create or modify, one path per line, relative to the workspace (for "propose")' },
        risks: { type: "string", description: 'Risks and technical constraints, one per line (for "propose")' },
        proofs: { type: "string", description: 'Expected proof per acceptance criterion, one line "N: proof" each (for "propose")' },
        reason: { type: "string", description: "Why the plan changes after the host approved it (optional)" },
      },
    },
  };
}

export function buildToolSpecs(mode: Mode, opts: { mission?: boolean } = {}): ToolSpec[] {
  const specs = buildBaseSpecs(mode);
  return opts.mission ? specs.map((s) => (s.name === "plan" ? missionPlanSpec(s) : s)) : specs;
}

function buildBaseSpecs(mode: Mode): ToolSpec[] {
  const read: ToolSpec[] = [
    {
      name: "read_file",
      description:
        'Read a text file in the workspace. Example: {"path": "src/app.js"}. Long files are returned in chunks; pass "offset" (a line number) to continue reading.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          offset: { type: "number", description: "Line number to start from (optional)" },
          limit: { type: "number", description: "Max lines to return (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description:
        'List files and folders in the workspace. Example: {} for everything, or {"path": "src"} for one folder. Folders end with "/".',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list (optional, default: whole workspace)" },
        },
      },
    },
    {
      name: "search",
      description:
        'Search inside files for a pattern (regular expression; plain text also works). Example: {"pattern": "TODO"}. Returns file:line: matching text.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex to find" },
          path: { type: "string", description: "Folder to search in (optional)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "plan",
      description:
        'Plan runnable increments, kept across compaction. Create: {"action":"set","steps":"wire entry point; run build; add movement and test"}. Finish current step: {"action":"done"} (or supply step). Save exact APIs, error and next edit before a long investigation: {"action":"checkpoint","text":"..."} (max 1000 chars, replaces current step notes). Append: {"action":"add","text":"..."}. Show: {"action":"show"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "done", "add", "show", "checkpoint"] },
          steps: { type: "string", description: 'The steps, one per line; semicolon lists also accepted (only for "set")' },
          step: { type: "number", description: 'Step number to mark done (optional, for "done")' },
          text: { type: "string", description: 'Step to append or working checkpoint' },
        },
        required: ["action"],
      },
    },
  ];

  const write: ToolSpec[] = [
    {
      name: "write_file",
      description:
        'Create a new file or completely overwrite an existing one. Example: {"path": "src/new.js", "content": "..."}. Parent folders are created automatically. To change part of an existing file, prefer edit_file.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          content: { type: "string", description: "The full file content" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        'Replace text inside an existing file. Copy old_text EXACTLY from the file (a few lines, enough to be unique), and give the replacement as new_text. Example: {"path": "src/app.js", "old_text": "const x = 1;", "new_text": "const x = 2;"}',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          old_text: { type: "string", description: "Exact text currently in the file" },
          new_text: { type: "string", description: "Text to replace it with" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  ];

  const exec: ToolSpec[] = [
    {
      name: "run_command",
      description:
        'Run a shell command in the workspace and wait for it to finish. Example: {"command": "npm test"}. Times out after 120s — for servers or watchers use the task tool instead.',
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
    {
      name: "task",
      description:
        'Manage background tasks (things that keep running, like dev servers). action "start" runs a command in the background: {"action": "start", "command": "npm run dev"}. action "logs" shows recent output: {"action": "logs", "task_id": "t1"}. action "list" shows all tasks. action "stop" kills one: {"action": "stop", "task_id": "t1"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "list", "logs", "stop"] },
          command: { type: "string", description: 'Command to run (only for "start")' },
          task_id: { type: "string", description: 'Task id like "t1" (for "logs" and "stop")' },
        },
        required: ["action"],
      },
    },
  ];

  if (mode === "ro") return read;
  return [...read, ...write, ...exec];
}

export interface ToolContext {
  workspace: string;
  taskManager: TaskManager;
  plan: Plan;
  /** Records for the compaction state note. */
  filesTouched: Set<string>;
  commandsRun: string[];
  /** Internal per-request cap; never a model-supplied tool argument. */
  resultCharLimit?: number;
  /** Profil mission : fixés par la décision d'accès pour cet appel, jamais
   * par un argument du modèle. Absents = comportement courant. */
  exec?: ExecOptions;
  protect?: PathRules;
  /** La couture d'exécution de run_command et des vérifications automatiques,
   * fixée par l'hôte ; absente = l'adaptateur hôte. Les tâches et le terminal
   * reçoivent la leur à leur construction. */
  executor?: Executor;
  /** Fiches de méthode installées (#30) : le dossier que read_file sert pour
   * `fiche:<nom>`, fixé par l'hôte à l'ouverture de la session quand
   * l'index figure dans le prompt ; absent = aucune exception. */
  fichesDir?: string;
  /** Profil mission : trace chaque lecture de fiche avant de la servir ;
   * une trace impossible lève, et la fiche n'est pas servie. */
  onFicheRead?: (name: string, sha256: string) => void;
  /** Journaux complets des sorties de commande raccourcies (#19), que
   * read_file sert sous `log:<n>` ; fixés par l'hôte (l'agent les crée),
   * absents = aucun journal gardé, `log:<n>` reste un chemin ordinaire. */
  logs?: CommandLogs;
  /** Péremption de lecture (#19) : ce que l'agent a vu de chaque fichier,
   * comparé au disque juste avant une écriture. Fixé par l'hôte (l'agent le
   * crée) ; absent = aucun signal. */
  reads?: ReadTracker;
  /** Profil mission (#29) : ce que l'hôte fait d'un plan structuré (le
   * valider, le journaliser, le lier au contrat). Fixé par l'hôte ; absent,
   * l'outil plan est celui d'avant #29 et `propose` n'existe pas. */
  planHooks?: PlanHooks;
}

/** Le motif qu'un modèle donne d'un changement de plan, ou null. */
function reasonOf(args: Record<string, any>): string | null {
  return typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 500) : null;
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<string> {
  try {
    let result: string;
    switch (name) {
      case "read_file": {
        const maxChars = ctx.resultCharLimit ? ctx.resultCharLimit - 256 : undefined;
        if (ctx.fichesDir && isFicheRef(args.path)) {
          // L'exception nommée : une fiche installée, lue par l'hôte, jamais
          // un autre fichier hors du workspace.
          const fiche = readInstalledFiche(ctx.fichesDir, args.path);
          if (!fiche.ok) return `Error: ${fiche.error}`;
          ctx.onFicheRead?.(fiche.name, fiche.sha256);
          result = renderRead(fiche.content, args, maxChars);
        } else if (ctx.logs && isLogRef(args.path)) {
          // Le journal complet d'une sortie raccourcie (#19), gardé en
          // mémoire par la session : lecture ciblée, jamais un fichier.
          const log = ctx.logs.get(args.path);
          if (log === undefined) {
            return `Error: "${String(args.path).trim()}" is not a command log kept by this session (only the last ${ctx.logs.kept} shortened outputs are kept). Run the command again if you need its output.`;
          }
          result = renderRead(log, { ...args, path: String(args.path).trim() }, maxChars);
        } else {
          result = readFile(ctx.workspace, args, maxChars, ctx.reads?.hooks());
        }
        break;
      }
      case "list_files":
        result = listFiles(ctx.workspace, args);
        break;
      case "search":
        result = await searchFilesBounded(ctx.workspace, args, signal, undefined, ctx.protect);
        break;
      case "plan": {
        const action = args.action ?? (typeof args.steps === "string" ? "set" : undefined);
        const hooks = ctx.planHooks;
        if (action === "propose" && hooks) {
          // Profil mission (#29) : le plan structuré, validé et journalisé par
          // l'hôte avant d'être posé sur la checklist.
          const read = readProposal(args);
          if ("error" in read) return `Error: ${read.error}`;
          const out = hooks.propose(read.content, reasonOf(args));
          if (!out.ok) return `Error: ${out.message}`;
          ctx.plan.adopt(out.content);
          result = out.message;
          break;
        }
        const before = hooks ? ctx.plan.content() : null;
        if (action === "set") result = ctx.plan.set(typeof args.steps === "string" ? args.steps : "");
        else if (action === "done")
          result = ctx.plan.markDone(args.step === undefined ? undefined : Number(args.step));
        else if (action === "add") result = ctx.plan.add(String(args.text ?? ""));
        else if (action === "checkpoint") result = ctx.plan.checkpoint(String(args.text ?? ""));
        else if (action === "show") result = ctx.plan.modelView();
        else
          return 'Error: action must be one of "set", "done", "add", "show", "checkpoint". Example: {"action": "done"}';
        // Profil mission (#29) : un plan structuré qui change, l'hôte le sait.
        const after = before ? ctx.plan.content() : null;
        if (hooks && before && after && (action === "set" || action === "add") && !result.startsWith("Error")) {
          result += hooks.changed(before, after, reasonOf(args));
        }
        break;
      }
      case "write_file":
        if (ctx.fichesDir && isFicheRef(args.path)) return ficheReadOnly(args.path);
        if (ctx.logs && isLogRef(args.path)) return logReadOnly(args.path);
        result = writeFile(ctx.workspace, args, ctx.reads?.hooks());
        if (!result.startsWith("Error")) {
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      case "edit_file":
        if (ctx.fichesDir && isFicheRef(args.path)) return ficheReadOnly(args.path);
        if (ctx.logs && isLogRef(args.path)) return logReadOnly(args.path);
        result = editFile(ctx.workspace, args, ctx.reads?.hooks());
        if (!result.startsWith("Error")) {
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      case "run_command":
        if (typeof args.command !== "string" || !args.command.trim()) {
          return 'Error: command is required. Example: {"command": "npm test"}';
        }
        // Rendu à la taille du contexte (#19) : aucune coupe ultérieure au
        // milieu, et le journal complet gardé si la sortie est raccourcie.
        result = await runCommand(args.command, ctx.workspace, signal, ctx.exec, ctx.executor, {
          ...(ctx.resultCharLimit ? { maxChars: ctx.resultCharLimit - 256 } : {}),
          ...(ctx.logs ? { logs: ctx.logs } : {}),
        });
        ctx.commandsRun.push(`${args.command} → ${result.split("\n").at(-1)}`);
        if (ctx.commandsRun.length > 50) ctx.commandsRun.splice(0, ctx.commandsRun.length - 50);
        break;
      case "task": {
        const action = args.action;
        if (action === "start") {
          if (typeof args.command !== "string" || !args.command.trim()) {
            return 'Error: "start" needs a command. Example: {"action": "start", "command": "npm run dev"}';
          }
          ctx.commandsRun.push(`[bg] ${args.command}`);
          result = await ctx.taskManager.startWithEarlyOutput(args.command, ctx.exec);
        } else if (action === "logs") {
          result = ctx.taskManager.logs(String(args.task_id ?? ""), Number(args.lines) || 50);
        } else if (action === "stop") {
          result = ctx.taskManager.stop(String(args.task_id ?? ""));
        } else if (action === "list") {
          result = ctx.taskManager.list();
        } else {
          return 'Error: action must be one of "start", "list", "logs", "stop". Example: {"action": "list"}';
        }
        break;
      }
      default:
        return `Error: unknown tool "${name}". Available tools are listed in your tool definitions — use one of those.`;
    }
    return truncateMiddle(result, TOOL_RESULT_CAP);
  } catch (err: any) {
    if (err instanceof SandboxError) return `Error: ${err.message}`;
    return `Error: ${err?.message ?? String(err)}`;
  }
}

/** Une fiche installée ne s'écrit jamais : le modèle écrit dans le workspace. */
export function ficheReadOnly(p: unknown): string {
  return `Error: "${String(p)}" names an installed method sheet, which is read-only. Write to a workspace path instead.`;
}

/** Post-write hook: parse what was just written and coach on the first
 * syntax error. A one-line warning riding on the success message is the
 * cheapest possible feedback loop for a local model. */
function afterWrite(workspace: string, relPath: string): string {
  try {
    const abs = resolveInWorkspace(workspace, relPath);
    const warning = syntaxCheck(abs, relPath, workspace);
    return warning ? `
Warning: ${warning} Fix this before moving on (use edit_file).` : "";
  } catch {
    return "";
  }
}

/** The command a call would run, if it is an exec call (edit mode may gate it;
 * bypass never asks; in ro mode the tool does not exist). */
export function commandOf(name: string, args: Record<string, any>): string | null {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "task" && args.action === "start") return String(args.command ?? "");
  return null;
}
