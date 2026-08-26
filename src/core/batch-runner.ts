import { createHash, randomUUID } from "node:crypto";

import type { OpeningTemplate, SearchPlan } from "./config.ts";
import { evaluateCandidate, type CandidatePosition } from "./rules.ts";
import type { JobPilotStore, PositionSnapshot } from "../storage/store.ts";

export type PlatformContactState = "可沟通" | "平台已沟通" | "未知状态";
export type SendOpeningResult =
  "沟通成功" | "结果未知" | "明确未开始" | "内容不符";
export interface SendOpeningOutcome {
  result: SendOpeningResult;
  takeover?: {
    kind: "login" | "verification";
    reason: string;
  };
}
export type BatchState =
  | "空闲"
  | "扫描"
  | "规则评估"
  | "发起沟通"
  | "等待页面就绪"
  | "等待人工登录"
  | "人工接管"
  | "正在停止"
  | "已完成"
  | "已完成有异常"
  | "已失败";

export interface InspectedCandidate {
  candidate: CandidatePosition;
  contactState: PlatformContactState;
}

export interface SendOpeningRequest {
  operationId: string;
  commandId: string;
  candidate: CandidatePosition;
  message: string;
  messageHash: string;
}

export interface PlatformAdapter {
  scan(plan: SearchPlan): AsyncIterable<CandidatePosition>;
  inspect(candidate: CandidatePosition): Promise<InspectedCandidate>;
  sendOpening(
    request: SendOpeningRequest,
  ): Promise<SendOpeningResult | SendOpeningOutcome>;
  waitUntilReady?(onWaiting: () => void): Promise<void>;
  emergencyStop?(): Promise<void> | void;
}

export class HumanTakeoverRequired extends Error {
  constructor(
    message: string,
    public readonly kind: "login" | "verification" | "unsupported-page",
  ) {
    super(message);
    this.name = "HumanTakeoverRequired";
  }
}

export interface BatchRunRequest {
  batchId?: string;
  source?: "demo" | "boss";
  mode?: "demo" | "verification" | "full";
  plans: SearchPlan[];
  templates: OpeningTemplate[];
  maxContacts: number;
  maxCandidates: number;
}

export interface BatchSummary {
  state: Extract<BatchState, "已完成" | "已完成有异常" | "人工接管" | "已失败">;
  candidatesChecked: number;
  contactsSucceeded: number;
  creditsUsed?: number;
  unknownCount?: number;
  mismatchCount?: number;
  reason: string;
}

export interface BatchEvent {
  state: BatchState;
  message: string;
  candidatesChecked: number;
  contactsSucceeded: number;
  creditsUsed: number;
  unknownCount: number;
  mismatchCount: number;
  at: string;
}

interface BatchRunnerDependencies {
  store: JobPilotStore;
  adapter: PlatformAdapter;
  cooldownMs: number | (() => number);
  now?: () => Date;
  onEvent?: (event: BatchEvent) => void;
}

export interface BatchRunner {
  getState(): BatchState;
  requestStop(mode?: "普通" | "紧急"): void;
  run(request: BatchRunRequest): Promise<BatchSummary>;
}

export function createBatchRunner(
  dependencies: BatchRunnerDependencies,
): BatchRunner {
  const now = dependencies.now ?? (() => new Date());
  let state: BatchState = "空闲";
  let stopMode: "普通" | "紧急" | undefined;
  let running = false;
  let candidatesChecked = 0;
  let contactsSucceeded = 0;
  let creditsUsed = 0;
  let unknownCount = 0;
  let mismatchCount = 0;

  const emit = (nextState: BatchState, message: string): void => {
    state = nextState;
    dependencies.onEvent?.({
      state,
      message,
      candidatesChecked,
      contactsSucceeded,
      creditsUsed,
      unknownCount,
      mismatchCount,
      at: now().toISOString(),
    });
  };

  return {
    getState: () => state,
    requestStop(mode = "普通") {
      stopMode = mode;
      emit("正在停止", mode === "紧急" ? "正在紧急停止" : "将在当前操作后停止");
      if (mode === "紧急") {
        void dependencies.adapter.emergencyStop?.();
      }
    },
    async run(request) {
      if (running) {
        throw new Error("已有投递批次正在运行");
      }
      running = true;
      stopMode = undefined;
      candidatesChecked = 0;
      contactsSucceeded = 0;
      creditsUsed = 0;
      unknownCount = 0;
      mismatchCount = 0;
      let consecutiveFailures = 0;
      const batchId = request.batchId ?? randomUUID();
      const source = request.source ?? "demo";
      const seen = new Set<string>();

      try {
        const templates = new Map(
          request.templates
            .filter((item) => item.enabled)
            .map((item) => [item.id, item]),
        );
        const plans = request.plans
          .filter((plan) => plan.enabled)
          .sort((left, right) => right.priority - left.priority);

        for (const plan of plans) {
          const template = templates.get(plan.templateId);
          if (template === undefined) {
            continue;
          }
          emit("扫描", `正在执行搜索方案：${plan.name}`);

          for await (const candidate of dependencies.adapter.scan(plan)) {
            if (stopMode !== undefined) {
              return finish(
                "已完成",
                stopMode === "紧急" ? "已紧急停止" : "已停止",
              );
            }
            if (
              creditsUsed >= request.maxContacts ||
              candidatesChecked >= request.maxCandidates
            ) {
              return finish("已完成", "已达到批次上限");
            }

            candidatesChecked += 1;
            const identity = positionIdentity(candidate, source);
            if (identity === undefined) {
              continue;
            }
            if (seen.has(identity)) continue;
            seen.add(identity);
            if (dependencies.store.hasContacted(identity, source)) {
              continue;
            }

            const inspection = await dependencies.adapter.inspect(candidate);
            const currentCandidate = inspection.candidate;
            const currentIdentity = positionIdentity(currentCandidate, source);
            if (currentIdentity !== identity) continue;

            emit("规则评估", `正在评估：${currentCandidate.title}`);
            const evaluation = evaluateCandidate(currentCandidate, plan.rules, {
              now: now(),
            });
            if (!evaluation.eligible) {
              dependencies.store.saveSnapshot(
                snapshot(
                  currentCandidate,
                  identity,
                  "已排除",
                  now(),
                  evaluation.exclusions,
                ),
              );
              continue;
            }

            const contactState = inspection.contactState;
            if (contactState === "平台已沟通") {
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "平台已沟通", now()),
              );
              continue;
            }
            if (contactState === "未知状态") {
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "已跳过", now()),
              );
              consecutiveFailures += 1;
              if (consecutiveFailures >= 3) {
                emit("人工接管", "连续出现三个未知页面状态");
                return finish("人工接管", "连续出现三个未知页面状态");
              }
              continue;
            }

            emit(
              "发起沟通",
              `正在联系：${currentCandidate.company} · ${currentCandidate.title}`,
            );
            await dependencies.adapter.waitUntilReady?.(() => {
              emit("等待页面就绪", "批次页面不可见，等待恢复");
            });
            const message = renderTemplate(template.body, currentCandidate);
            const operationId = randomUUID();
            const commandId = randomUUID();
            const messageHash = createHash("sha256")
              .update(message)
              .digest("hex");
            dependencies.store.reserveContactOperation({
              operationId,
              commandId,
              batchId,
              source,
              identity,
              ...(currentCandidate.id === undefined
                ? {}
                : { platformJobId: currentCandidate.id }),
              ...(currentCandidate.url === undefined
                ? {}
                : { url: currentCandidate.url }),
              planId: plan.id,
              templateId: template.id,
              messageHash,
              messageLength: message.length,
              at: now().toISOString(),
            });
            creditsUsed += 1;
            dependencies.store.saveSnapshot(
              snapshot(currentCandidate, identity, "正在发起", now()),
            );
            dependencies.store.markContactOperationDispatched(
              operationId,
              now().toISOString(),
            );
            let result: SendOpeningResult;
            let takeoverAfterSend: SendOpeningOutcome["takeover"];
            let operationError: string | undefined;
            const operationStartedAt = Date.now();
            try {
              const outcome = await dependencies.adapter.sendOpening({
                operationId,
                commandId,
                candidate: currentCandidate,
                message,
                messageHash,
              });
              if (typeof outcome === "string") {
                result = outcome;
              } else {
                result = outcome.result;
                takeoverAfterSend = outcome.takeover;
              }
            } catch (error) {
              result = "结果未知";
              operationError =
                error instanceof Error ? error.message : "沟通操作发生未知错误";
            }
            dependencies.store.completeContactOperation(
              operationId,
              result,
              now().toISOString(),
            );
            dependencies.store.recordContactOperationDiagnostic({
              operationId,
              stage: "send-opening",
              outcome: result,
              ...(operationError === undefined
                ? {}
                : { errorCategory: errorCategory(operationError) }),
              durationMs: Math.max(0, Date.now() - operationStartedAt),
              at: now().toISOString(),
            });
            if (result === "结果未知") {
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "结果未知", now()),
              );
              unknownCount += 1;
              consecutiveFailures = 0;
              emit("发起沟通", "消息结果未知，已阻止该职位重发并继续批次");
            }
            if (result === "内容不符") {
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "内容不符", now()),
              );
              mismatchCount += 1;
              consecutiveFailures = 0;
            }
            if (result === "明确未开始") {
              creditsUsed -= 1;
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "明确未开始", now()),
              );
              consecutiveFailures += 1;
              if (consecutiveFailures >= 3) {
                return finish("人工接管", "连续三次沟通操作明确未开始");
              }
              continue;
            }
            if (result === "沟通成功") {
              dependencies.store.saveSnapshot(
                snapshot(currentCandidate, identity, "沟通成功", now()),
              );
              contactsSucceeded += 1;
              consecutiveFailures = 0;
            }
            if (takeoverAfterSend !== undefined) {
              throw new HumanTakeoverRequired(
                takeoverAfterSend.reason,
                takeoverAfterSend.kind,
              );
            }
            const cooldownMs =
              typeof dependencies.cooldownMs === "function"
                ? dependencies.cooldownMs()
                : dependencies.cooldownMs;
            if (cooldownMs > 0) {
              await delay(cooldownMs);
            }
          }
        }

        return finish("已完成", "没有更多候选职位");
      } catch (error) {
        if (error instanceof HumanTakeoverRequired) {
          const takeoverState =
            error.kind === "login" ? "等待人工登录" : "人工接管";
          emit(takeoverState, error.message);
          return finish("人工接管", error.message);
        }
        const message =
          error instanceof Error ? error.message : "批次发生未知错误";
        emit("已失败", message);
        return finish("已失败", message);
      } finally {
        running = false;
      }
    },
  };

  function finish(
    finalState: Extract<BatchState, "已完成" | "人工接管" | "已失败">,
    reason: string,
  ): BatchSummary {
    const actualState =
      finalState === "已完成" && (unknownCount > 0 || mismatchCount > 0)
        ? "已完成有异常"
        : finalState;
    emit(actualState, reason);
    return {
      state: actualState,
      candidatesChecked,
      contactsSucceeded,
      creditsUsed,
      unknownCount,
      mismatchCount,
      reason,
    };
  }
}

export function positionIdentity(
  candidate: CandidatePosition,
  source: "demo" | "boss" = "boss",
): string | undefined {
  if (candidate.id !== undefined && candidate.id.trim() !== "") {
    return `${source}:${candidate.id.trim()}`;
  }
  if (candidate.url !== undefined && candidate.url.trim() !== "") {
    try {
      const url = new URL(candidate.url);
      url.hash = "";
      const normalizedUrl = `${url.origin}${url.pathname}${url.search}`;
      return `${source}:url:${createHash("sha256").update(normalizedUrl).digest("hex")}`;
    } catch {
      return undefined;
    }
  }
  if (
    source === "demo" &&
    candidate.title.trim() !== "" &&
    candidate.company.trim() !== "" &&
    candidate.city !== undefined
  ) {
    const fingerprint = `${candidate.company.trim()}|${candidate.title.trim()}|${candidate.city.trim()}`;
    return `demo:fingerprint:${createHash("sha256").update(fingerprint).digest("hex")}`;
  }
  return undefined;
}

function snapshot(
  candidate: CandidatePosition,
  identity: string,
  status: PositionSnapshot["status"],
  processedAt: Date,
  exclusionReasons?: PositionSnapshot["exclusionReasons"],
): PositionSnapshot {
  return {
    identity,
    ...(candidate.id === undefined ? {} : { platformJobId: candidate.id }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    title: candidate.title,
    company: candidate.company,
    ...(candidate.city === undefined ? {} : { city: candidate.city }),
    ...(candidate.region === undefined ? {} : { region: candidate.region }),
    ...(candidate.salaryMinK === undefined
      ? {}
      : { salary: `${candidate.salaryMinK}K+` }),
    ...(candidate.experienceMinYears === undefined
      ? {}
      : { experience: `${candidate.experienceMinYears}年+` }),
    ...(candidate.education === undefined
      ? {}
      : { education: candidate.education }),
    ...(candidate.industry === undefined
      ? {}
      : { industry: candidate.industry }),
    ...(candidate.publishedAt === undefined
      ? {}
      : { publishedAt: candidate.publishedAt }),
    ...(candidate.description === undefined
      ? {}
      : { description: candidate.description }),
    status,
    ...(exclusionReasons === undefined ? {} : { exclusionReasons }),
    processedAt: processedAt.toISOString(),
  };
}

function renderTemplate(body: string, candidate: CandidatePosition): string {
  return body
    .replaceAll("{{职位名称}}", candidate.title)
    .replaceAll("{{公司名称}}", candidate.company);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCategory(message: string): string {
  if (/超时/.test(message)) return "timeout";
  if (/断开|连接/.test(message)) return "connection";
  if (/登录/.test(message)) return "login";
  if (/验证|风控|访问异常/.test(message)) return "verification";
  if (/页面|DOM|选择器/.test(message)) return "page-structure";
  return "adapter-error";
}
