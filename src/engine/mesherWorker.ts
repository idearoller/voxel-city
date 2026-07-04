import { collectTransferables, runMesherJob, type MesherJobRequest } from './mesherProtocol';

/**
 * Vite-native module worker (`new Worker(new URL('./mesherWorker.ts', ...), { type: 'module' })`
 * — see `MesherScheduler.ts`). Deliberately tiny: all the actual meshing
 * logic lives in `runMesherJob` (shared verbatim with the synchronous
 * fallback scheduler), so this file is just the postMessage plumbing.
 *
 * `self` is cast rather than typed via the `webworker` lib because this
 * project's single tsconfig also includes `DOM` (for `main.ts`/`Engine.ts`)
 * and the two lib sets declare conflicting globals — the cast avoids a
 * second tsconfig purely for one file.
 */
const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<MesherJobRequest>): void => {
  const result = runMesherJob(event.data);
  ctx.postMessage(result, collectTransferables(result.buffers));
};
