import { createHash } from "node:crypto";

import type { OpeningTemplate, SearchPlan } from "./config.ts";
import { evaluateCandidate, type CandidatePosition } from "./rules.ts";
import type { JobPilotStore, PositionSnapshot } from "../storage/store.ts";

export type PlatformContactState = "可沟通" | "已沟通" | "未知状态";
export type SendOpeningResult = "已确认" | "结果未知" | "明确失败";
export type BatchState =
  | "空闲"
  | "扫描"
  | "规则评估"
  | "发起沟通"
  | "等待人工登录"
  | "人工接管"
  | "正在停止"
  | "已完成"
  | "已失败";

export interface PlatformAdapter {
  scan(plan: SearchPlan): AsyncIterable<CandidatePosition>;
  currentContactState(
    candidate: CandidatePosition,
  ): Promise<PlatformContactState>;
  sendOpening(
    candidate: CandidatePosition,
    message: string,
  ): Promise<SendOpeningResult>;
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
  plans: SearchPlan[];
  templates: OpeningTemplate[];
  maxContacts: number;
  maxCandidates: number;
}

export interface BatchSummary {
  state: Extract<BatchState, "已完成" | "人工接管" | "已失败">;
  candidatesChecked: number;
  contactsSucceeded: number;
  reason: string;
}

export interface BatchEvent {
  state: BatchState;
  message: string;
  candidatesChecked: number;
  contactsSucceeded: number;
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

  const emit = (nextState: BatchState, message: string): void => {
    state = nextState;
    dependencies.onEvent?.({
      state,
      message,
      candidatesChecked,
      contactsSucceeded,
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
      let consecutiveFailures = 0;

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
              contactsSucceeded >= request.maxContacts ||
              candidatesChecked >= request.maxCandidates
            ) {
              return finish("已完成", "已达到批次上限");
            }

            candidatesChecked += 1;
            const identity = positionIdentity(candidate);
            if (identity === undefined) {
              continue;
            }
            if (dependencies.store.hasContacted(identity)) {
              continue;
            }

            emit("规则评估", `正在评估：${candidate.title}`);
            const evaluation = evaluateCandidate(candidate, plan.rules, {
              now: now(),
            });
            if (!evaluation.eligible) {
              dependencies.store.saveSnapshot(
                snapshot(candidate, identity, "已排除", now()),
              );
              continue;
            }

            const contactState =
              await dependencies.adapter.currentContactState(candidate);
            if (contactState === "已沟通") {
              dependencies.store.saveSnapshot(
                snapshot(candidate, identity, "沟通成功", now()),
              );
              continue;
            }
            if (contactState === "未知状态") {
              dependencies.store.saveSnapshot(
                snapshot(candidate, identity, "已跳过", now()),
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
              `正在联系：${candidate.company} · ${candidate.title}`,
            );
            dependencies.store.saveSnapshot(
              snapshot(candidate, identity, "正在发起", now()),
            );
            const result = await dependencies.adapter.sendOpening(
              candidate,
              renderTemplate(template.body, candidate),
            );
            if (result === "结果未知") {
              dependencies.store.saveSnapshot(
                snapshot(candidate, identity, "结果未知", now()),
              );
              emit("人工接管", "消息发送结果无法确认");
              return finish("人工接管", "消息发送结果无法确认");
            }
            if (result === "明确失败") {
              dependencies.store.saveSnapshot(
                snapshot(candidate, identity, "明确失败", now()),
              );
              consecutiveFailures += 1;
              if (consecutiveFailures >= 3) {
                return finish("已失败", "连续三次操作失败");
              }
              continue;
            }

            dependencies.store.saveSnapshot(
              snapshot(candidate, identity, "沟通成功", now()),
            );
            contactsSucceeded += 1;
            consecutiveFailures = 0;
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
    emit(finalState, reason);
    return { state: finalState, candidatesChecked, contactsSucceeded, reason };
  }
}

export function positionIdentity(
  candidate: CandidatePosition,
): string | undefined {
  if (candidate.id !== undefined && candidate.id.trim() !== "") {
    return `boss:${candidate.id.trim()}`;
  }
  if (candidate.url !== undefined && candidate.url.trim() !== "") {
    try {
      const url = new URL(candidate.url);
      url.hash = "";
      const normalizedUrl = `${url.origin}${url.pathname}${url.search}`;
      return `url:${createHash("sha256").update(normalizedUrl).digest("hex")}`;
    } catch {
      return undefined;
    }
  }
  if (
    candidate.title.trim() !== "" &&
    candidate.company.trim() !== "" &&
    candidate.city !== undefined
  ) {
    const fingerprint = `${candidate.company.trim()}|${candidate.title.trim()}|${candidate.city.trim()}`;
    return `fingerprint:${createHash("sha256").update(fingerprint).digest("hex")}`;
  }
  return undefined;
}

function snapshot(
  candidate: CandidatePosition,
  identity: string,
  status: PositionSnapshot["status"],
  processedAt: Date,
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
