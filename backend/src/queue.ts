import PQueue from "p-queue";
import { config } from "./config.js";

/**
 * Jobs are admitted to the queue on click and then run concurrently up to
 * PLAN_CONCURRENCY. (Production upgrade path: swap this for BullMQ + Redis for
 * durability across restarts — same enqueue/process shape.)
 */
export const planQueue = new PQueue({ concurrency: config.planConcurrency });

export function enqueuePlan(task: () => Promise<void>): void {
  void planQueue.add(task);
}
