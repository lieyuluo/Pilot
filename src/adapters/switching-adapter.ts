import type { PlatformAdapter } from "../core/batch-runner.ts";
import type { JobPilotStore } from "../storage/store.ts";

interface SwitchingAdapterOptions {
  store: JobPilotStore;
  fake: PlatformAdapter;
  boss: PlatformAdapter;
}

export function createSwitchingAdapter(
  options: SwitchingAdapterOptions,
): PlatformAdapter {
  let active: PlatformAdapter | undefined;
  const choose = (): PlatformAdapter => {
    const settings = options.store.getSetting<{ adapterMode: "fake" | "boss" }>(
      "app",
      { adapterMode: "fake" },
    );
    return settings.adapterMode === "boss" ? options.boss : options.fake;
  };
  return {
    async *scan(plan) {
      active = choose();
      try {
        yield* active.scan(plan);
      } finally {
        active = undefined;
      }
    },
    currentContactState(candidate) {
      return (active ?? choose()).currentContactState(candidate);
    },
    sendOpening(candidate, message) {
      return (active ?? choose()).sendOpening(candidate, message);
    },
    emergencyStop() {
      return (active ?? choose()).emergencyStop?.();
    },
  };
}
