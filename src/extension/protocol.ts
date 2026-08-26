import type { PlatformContactState } from "../core/batch-runner.ts";
import type { CandidatePosition } from "../core/rules.ts";

export const EXTENSION_PROTOCOL_VERSION = 2;
export const BOSS_ADAPTER_VERSION = 3;
export const EXTENSION_MESSAGE_LIMIT_BYTES = 64 * 1024;
export const JOBPILOT_EXTENSION_ID = "gfaoagnbbaihijgmenfnhfphjiebngio";
export const JOBPILOT_EXTENSION_ORIGIN = `chrome-extension://${JOBPILOT_EXTENSION_ID}`;

export type ExtensionCapability = "read" | "batch-send";

export interface BoundBossPage {
  tabId: number;
  url: string;
  active: boolean;
  visible: boolean;
  accountDisplayName?: string;
  accountFingerprint?: string;
}

interface ExtensionCommandBase {
  commandId: string;
  connectionId: string;
  expectedTabId: number;
  expectedUrl: string;
  deadline: string;
}

export interface CalibrationCommand extends ExtensionCommandBase {
  type: "calibrate";
  searchUrl: string;
}

export interface ScanPlanCommand extends ExtensionCommandBase {
  type: "scan-plan";
  searchUrl: string;
}

export interface InspectPositionCommand extends ExtensionCommandBase {
  type: "inspect-position";
  candidate: CandidatePosition;
}

export interface SendOpeningCommand extends ExtensionCommandBase {
  type: "send-opening";
  operationId: string;
  candidate: CandidatePosition;
  message: string;
  messageHash: string;
}

export type ExtensionCommand =
  | CalibrationCommand
  | ScanPlanCommand
  | InspectPositionCommand
  | SendOpeningCommand;

export interface CalibrationResult {
  candidatesRecognized: number;
  currentUrl: string;
  contactState: PlatformContactState;
}

export interface ScanPlanResult {
  candidates: CandidatePosition[];
  currentUrl: string;
}

export interface InspectPositionResult {
  candidate: CandidatePosition;
  contactState: PlatformContactState;
  currentUrl: string;
}

export interface SendOpeningExecutionResult {
  result: "沟通成功" | "结果未知" | "明确未开始" | "内容不符";
  irreversibleStarted: boolean;
  currentUrl: string;
  evidence?: {
    baselineOutgoingCount: number;
    finalOutgoingCount: number;
    confirmation?: "matched-message" | "boss-success-dialog";
    matchedMessageHash?: string;
  };
  takeover?: {
    kind: "login" | "verification";
    reason: string;
  };
  error?: string;
}

export type ExtensionToServerMessage =
  | {
      type: "hello";
      protocolVersion: number;
      extensionVersion: string;
      adapterVersion: number;
      instanceId: string;
      capabilities: ExtensionCapability[];
      challengeProof?: string;
    }
  | { type: "heartbeat" }
  | { type: "bind_page"; tab: BoundBossPage }
  | { type: "page_state"; tab: BoundBossPage }
  | {
      type: "command_result";
      commandId: string;
      outcome: "ok" | "error" | "takeover";
      data?: unknown;
      error?: string;
    }
  | { type: "emergency_stop"; reason?: string };

export type ServerToExtensionMessage =
  | {
      type: "challenge";
      protocolVersion: number;
      nonce: string;
    }
  | {
      type: "pairing_required";
      requestId: string;
      code: string;
    }
  | {
      type: "pairing_accepted";
      pairingSecret: string;
      connectionId: string;
    }
  | { type: "ready"; connectionId: string }
  | { type: "page_bound"; connectionId: string; tabId: number }
  | { type: "command"; command: ExtensionCommand }
  | { type: "disarm"; reason: string }
  | { type: "error"; code: string; message: string };

export type ExtensionPairingState = "未配对" | "等待批准" | "已配对";
export type ExtensionConnectionState = "未连接" | "扩展已连接" | "页面已连接";

export interface ExtensionStatus {
  pairingState: ExtensionPairingState;
  connectionState: ExtensionConnectionState;
  extensionVersion?: string;
  adapterVersion?: number;
  capabilities: ExtensionCapability[];
  readOnlyCalibrated: boolean;
  pendingPairing?: {
    requestId: string;
    code: string;
  };
  page?: BoundBossPage;
}
