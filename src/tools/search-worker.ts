import { isMainThread, parentPort, workerData, Worker } from "worker_threads";
import { searchFiles } from "./fs-tools";
import type { PathRules } from "../sandbox";

if (!isMainThread) parentPort!.postMessage(searchFiles(workerData.root, workerData.args, workerData.protect));

/** A pathological regex can be terminated without freezing the agent/UI.
 * `protect` (profil mission) : fichiers jamais lus, fixés par la décision
 * d'accès de l'hôte, jamais par un argument du modèle. */
export function searchFilesBounded(root: string, args: Record<string, any>, signal?: AbortSignal, timeoutMs = 5000, protect?: PathRules): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Error: search cancelled");
  return new Promise((resolve) => {
    const worker = new Worker(__filename, { workerData: { root, args, protect } });
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => finish("Error: search cancelled");
    const timer = setTimeout(() => finish("Error: search timed out. Use a simpler pattern or search a smaller folder."), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", finish);
    worker.once("error", (err) => finish(`Error: search failed: ${err.message}`));
    worker.once("exit", (code) => { if (!settled) finish(`Error: search worker exited (${code})`); });
  });
}
