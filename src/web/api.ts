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

export interface SearchPlan {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  templateId: string;
  rules: {
    titleKeywords: string[];
    cities: string[];
    regions?: string[];
    minSalaryK?: number | undefined;
    maxExperienceYears?: number | undefined;
    candidateEducation?:
      "不限" | "中专/高中" | "大专" | "本科" | "硕士" | "博士" | undefined;
    companyBlacklist: string[];
    industryBlacklist: string[];
    publishedWithinDays?: number | undefined;
    allowRemote: boolean;
  };
}

export interface OpeningTemplate {
  id: string;
  name: string;
  enabled: boolean;
  body: string;
}

export interface PositionSnapshot {
  identity: string;
  title: string;
  company: string;
  city?: string;
  status: string;
  exclusionReasons?: Array<{
    field:
      | "title"
      | "location"
      | "salary"
      | "experience"
      | "education"
      | "company"
      | "industry"
      | "publishedAt"
      | "remote";
    code: string;
  }>;
  processedAt: string;
}

export interface AppSettings {
  accountNote: string;
  adapterMode: "fake" | "boss";
  realSendEnabled: boolean;
  cooldownMs: number;
}

export type ExtensionCapability = "read" | "batch-send";

export interface ExtensionStatus {
  pairingState: "未配对" | "等待批准" | "已配对";
  connectionState: "未连接" | "扩展已连接" | "页面已连接";
  extensionVersion?: string;
  adapterVersion?: number;
  capabilities: ExtensionCapability[];
  readOnlyCalibrated: boolean;
  pendingPairing?: { requestId: string; code: string };
  page?: {
    tabId: number;
    url: string;
    active: boolean;
    visible: boolean;
    accountDisplayName?: string;
  };
}

export interface BatchSummary {
  state: "已完成" | "已完成有异常" | "人工接管" | "已失败";
  candidatesChecked: number;
  contactsSucceeded: number;
  creditsUsed?: number;
  unknownCount?: number;
  mismatchCount?: number;
  reason: string;
}

export interface PendingContactOperation {
  operationId: string;
  identity: string;
  title: string;
  company: string;
  messageHash: string;
  messageLength: number;
  updatedAt: string;
}

export interface SendSessionStatus {
  armed: boolean;
  validationSuccesses: number;
  pendingCount: number;
  qualified: boolean;
  creditsUsed: number;
  contactsSucceeded: number;
  unknownCount: number;
  mismatchCount: number;
  pending?: PendingContactOperation[];
}

export interface AppStatus {
  batchState: BatchState;
  sendSession?: SendSessionStatus;
  lastSummary?: BatchSummary;
}

let csrfToken: string | undefined;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    let token = csrfToken;
    if (token === undefined) {
      const sessionResponse = await assertResponse(await fetch("/api/session"));
      const session = (await sessionResponse.json()) as { csrfToken: string };
      token = session.csrfToken;
      csrfToken = token;
    }
    headers.set("x-jobpilot-csrf", token);
  }
  const response = await fetch(path, { ...init, headers });
  await assertResponse(response);
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function assertResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const payload = (await response.json().catch(() => undefined)) as
    { error?: string } | undefined;
  throw new Error(payload?.error ?? `请求失败（${response.status}）`);
}
