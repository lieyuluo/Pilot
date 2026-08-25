import type { BatchEvent } from "./batch-runner.ts";

export interface BatchEventBus {
  publish(event: BatchEvent): void;
  subscribe(listener: (event: BatchEvent) => void): () => void;
}

export function createBatchEventBus(): BatchEventBus {
  const listeners = new Set<(event: BatchEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
