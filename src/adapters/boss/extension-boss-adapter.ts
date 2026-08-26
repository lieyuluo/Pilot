import type { PlatformAdapter } from "../../core/batch-runner.ts";
import type { SearchPlan } from "../../core/config.ts";
import type { ExtensionBridge } from "../../extension/bridge.ts";
import type { CalibrationResult } from "../../extension/protocol.ts";

export interface ExtensionBossAdapter extends PlatformAdapter {
  calibrate(plan: SearchPlan): Promise<CalibrationResult>;
}

export function createExtensionBossAdapter(
  bridge: ExtensionBridge,
): ExtensionBossAdapter {
  return {
    calibrate: (plan) => bridge.calibrate(plan),
    async *scan(plan) {
      const result = await bridge.scan(plan);
      yield* result.candidates;
    },
    async inspect(candidate) {
      const result = await bridge.inspect(candidate);
      return { candidate: result.candidate, contactState: result.contactState };
    },
    async sendOpening(request) {
      const execution = await bridge.sendOpening(request);
      return execution.takeover === undefined
        ? execution.result
        : { result: execution.result, takeover: execution.takeover };
    },
    waitUntilReady(onWaiting) {
      return bridge.waitUntilPageReady(onWaiting);
    },
    emergencyStop() {
      bridge.emergencyStop();
    },
  };
}
