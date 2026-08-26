import {
  AlertTriangle,
  Archive,
  CircleStop,
  Download,
  FileText,
  Gauge,
  ListFilter,
  OctagonX,
  Play,
  Save,
  Settings,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type AppSettings,
  type AppStatus,
  type BatchState,
  type ExtensionStatus,
  type OpeningTemplate,
  type PositionSnapshot,
  type SearchPlan,
  type SendSessionStatus,
} from "./api.ts";

type View = "overview" | "plans" | "templates" | "snapshots" | "settings";

const navigation: Array<{ id: View; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "总览", icon: Gauge },
  { id: "plans", label: "搜索方案", icon: ListFilter },
  { id: "templates", label: "开场模板", icon: FileText },
  { id: "snapshots", label: "职位快照", icon: Archive },
  { id: "settings", label: "设置", icon: Settings },
];

const defaultStatus: AppStatus = { batchState: "空闲" };

export function App() {
  const [view, setView] = useState<View>("overview");
  const [plans, setPlans] = useState<SearchPlan[]>([]);
  const [templates, setTemplates] = useState<OpeningTemplate[]>([]);
  const [snapshots, setSnapshots] = useState<PositionSnapshot[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus>();
  const [status, setStatus] = useState<AppStatus>(defaultStatus);
  const [events, setEvents] = useState<
    Array<{ state: BatchState; message: string; at: string }>
  >([]);
  const [selectedPlans, setSelectedPlans] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const confirmDialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    try {
      const [
        nextPlans,
        nextTemplates,
        nextSnapshots,
        nextSettings,
        nextStatus,
        nextExtensionStatus,
      ] = await Promise.all([
        api<SearchPlan[]>("/api/plans"),
        api<OpeningTemplate[]>("/api/templates"),
        api<PositionSnapshot[]>("/api/snapshots?limit=100"),
        api<AppSettings>("/api/settings"),
        api<AppStatus>("/api/status"),
        api<ExtensionStatus>("/api/extension/status"),
      ]);
      setPlans(nextPlans);
      setTemplates(nextTemplates);
      setSnapshots(nextSnapshots);
      setSettings(nextSettings);
      setStatus(nextStatus);
      setExtensionStatus(nextExtensionStatus);
      setSelectedPlans((current) =>
        current.length > 0
          ? current
          : nextPlans.filter((plan) => plan.enabled).map((plan) => plan.id),
      );
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, []);

  useEffect(() => {
    void load();
    const stream = new EventSource("/api/events");
    const onBatch = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as {
        state: BatchState;
        message: string;
        at: string;
      };
      setStatus((current) => ({ ...current, batchState: payload.state }));
      setEvents((current) => [payload, ...current].slice(0, 12));
      if (
        ["已完成", "已完成有异常", "人工接管", "已失败"].includes(payload.state)
      ) {
        void load();
      }
    };
    stream.addEventListener("batch", onBatch as EventListener);
    return () => stream.close();
  }, [load]);

  const active = ![
    "空闲",
    "已完成",
    "已完成有异常",
    "人工接管",
    "已失败",
  ].includes(status.batchState);
  const enabledPlans = plans.filter((plan) => selectedPlans.includes(plan.id));

  const runBatch = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (
        settings?.adapterMode === "boss" &&
        status.sendSession?.armed !== true
      ) {
        await api("/api/send/session", {
          method: "POST",
          body: JSON.stringify({ confirmed: true }),
        });
      }
      await api("/api/batches", {
        method: "POST",
        body: JSON.stringify({
          planIds: selectedPlans,
          accountConfirmed: true,
        }),
      });
      confirmDialog.current?.close();
      setStatus((current) => ({ ...current, batchState: "扫描" }));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const endSendSession = async () => {
    try {
      await api("/api/send/session", { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const stop = async (mode: "普通" | "紧急") => {
    try {
      await api("/api/batches/stop", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      setStatus((current) => ({ ...current, batchState: "正在停止" }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            JP
          </div>
          <div>
            <strong>JobPilot</strong>
            <span>本地求职控制台</span>
          </div>
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <span
            className={`status-dot state-${statusTone(status.batchState)}`}
            aria-hidden="true"
          />
          <div>
            <span>当前状态</span>
            <strong>{status.batchState}</strong>
          </div>
        </div>
      </aside>

      <main>
        <header className="operation-bar">
          <div className="operation-state">
            <span
              className={`status-dot state-${statusTone(status.batchState)}`}
              aria-hidden="true"
            />
            <div>
              <span>投递批次</span>
              <strong>{status.batchState}</strong>
            </div>
          </div>
          <div className="operation-actions">
            {status.sendSession?.armed && (
              <button
                className="button quiet"
                onClick={() => void endSendSession()}
              >
                结束发送会话
              </button>
            )}
            <button
              className="button quiet"
              disabled={!active}
              onClick={() => void stop("普通")}
            >
              <CircleStop size={17} />
              普通停止
            </button>
            <button
              className="button danger-quiet"
              disabled={!active}
              onClick={() => void stop("紧急")}
            >
              <OctagonX size={17} />
              紧急停止
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>关闭</button>
          </div>
        )}

        <div className="page-content">
          {view === "overview" && (
            <Overview
              plans={plans}
              selectedPlans={selectedPlans}
              setSelectedPlans={setSelectedPlans}
              status={status}
              settings={settings}
              extensionStatus={extensionStatus}
              events={events}
              active={active}
              openConfirm={() => confirmDialog.current?.showModal()}
              reload={load}
            />
          )}
          {view === "plans" && (
            <Plans plans={plans} templates={templates} reload={load} />
          )}
          {view === "templates" && (
            <Templates templates={templates} reload={load} />
          )}
          {view === "snapshots" && (
            <Snapshots snapshots={snapshots} reload={load} />
          )}
          {view === "settings" && settings && (
            <SettingsView
              settings={settings}
              extensionStatus={extensionStatus}
              sendSession={status.sendSession}
              reload={load}
            />
          )}
        </div>
      </main>

      <dialog ref={confirmDialog} className="confirm-dialog">
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <div className="dialog-heading">
            <span>启动投递批次</span>
            <button
              className="icon-button"
              aria-label="关闭"
              onClick={() => confirmDialog.current?.close()}
            >
              ×
            </button>
          </div>
          <p>
            {settings?.adapterMode === "boss" && !status.sendSession?.armed
              ? "本次确认将建立仅对当前 JobPilot 进程有效的发送会话，并启动首个批次。"
              : "将使用当前发送会话手动启动一个新批次，不再逐个确认职位。"}
          </p>
          <dl className="batch-summary">
            <div>
              <dt>搜索方案</dt>
              <dd>
                {enabledPlans.map((plan) => plan.name).join("、") || "未选择"}
              </dd>
            </div>
            <div>
              <dt>页面账号名称</dt>
              <dd>
                {extensionStatus?.page?.accountDisplayName ?? "账号无法识别"}
              </dd>
            </div>
            <div>
              <dt>平台模式</dt>
              <dd>
                {settings?.adapterMode === "boss"
                  ? "Boss 真实页面"
                  : "本地演示"}
              </dd>
            </div>
            <div>
              <dt>批次边界</dt>
              <dd>
                沟通额度{" "}
                {settings?.adapterMode === "boss" &&
                !status.sendSession?.qualified
                  ? 1
                  : 20}{" "}
                个 / 检查 200 个
              </dd>
            </div>
            <div>
              <dt>开场模板</dt>
              <dd>
                {enabledPlans
                  .map(
                    (plan) =>
                      templates.find((item) => item.id === plan.templateId)
                        ?.name,
                  )
                  .filter(Boolean)
                  .join("、") || "未绑定"}
              </dd>
            </div>
            <div>
              <dt>待核实职位</dt>
              <dd>{status.sendSession?.pendingCount ?? 0} 个</dd>
            </div>
          </dl>
          <div className="warning-copy">
            <AlertTriangle size={18} />
            <span>
              已发送的消息无法撤回；结果未知会占用额度、阻止该职位重发，并继续处理其他职位。
            </span>
          </div>
          <div className="dialog-actions">
            <button
              className="button quiet"
              onClick={() => confirmDialog.current?.close()}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || enabledPlans.length === 0}
              onClick={() => void runBatch()}
            >
              <Play size={17} />
              {busy
                ? "正在启动…"
                : settings?.adapterMode === "boss" && !status.sendSession?.armed
                  ? "授权并启动"
                  : "开始批次"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function Overview(props: {
  plans: SearchPlan[];
  selectedPlans: string[];
  setSelectedPlans: (ids: string[]) => void;
  status: AppStatus;
  settings: AppSettings | null;
  extensionStatus: ExtensionStatus | undefined;
  events: Array<{ state: BatchState; message: string; at: string }>;
  active: boolean;
  openConfirm: () => void;
  reload: () => Promise<void>;
}) {
  const eligiblePlans = props.plans.filter((plan) => plan.enabled);
  const sendSession = props.status.sendSession;
  const [inspectedOperations, setInspectedOperations] = useState<Set<string>>(
    () => new Set(),
  );
  const inspectPending = async (operationId: string) => {
    try {
      const result = await api<{ contactState: string }>(
        `/api/contact-operations/${operationId}/inspect`,
        { method: "POST" },
      );
      setInspectedOperations((current) => new Set(current).add(operationId));
      window.alert(
        `已在连接的 Boss 标签页打开并核对职位，当前平台状态：${result.contactState}。请查看会话后再选择结论。`,
      );
    } catch (caught) {
      window.alert(messageOf(caught));
    }
  };
  const resolvePending = async (
    operationId: string,
    resolution: "人工确认已发送" | "人工确认未发送",
  ) => {
    try {
      await api(`/api/contact-operations/${operationId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      });
      await props.reload();
    } catch (caught) {
      window.alert(messageOf(caught));
    }
  };
  const togglePlan = (id: string) => {
    props.setSelectedPlans(
      props.selectedPlans.includes(id)
        ? props.selectedPlans.filter((item) => item !== id)
        : [...props.selectedPlans, id],
    );
  };
  return (
    <>
      <PageHeading
        title="控制台"
        description="选择搜索方案，确认当前账号，然后启动一个有明确边界的投递批次。"
      />
      <section className="dispatch-panel">
        <div className="dispatch-copy">
          <span className="section-label">下一批</span>
          <h2>
            本批最多使用{" "}
            {props.settings?.adapterMode === "boss" && !sendSession?.qualified
              ? 1
              : 20}{" "}
            个沟通额度
          </h2>
          <p>按方案优先级依次检查，达到 200 个候选职位或触发停机条件时结束。</p>
        </div>
        <button
          className="button primary start-button"
          disabled={
            props.active ||
            props.selectedPlans.length === 0 ||
            (props.settings?.adapterMode === "boss" &&
              (props.extensionStatus?.connectionState !== "页面已连接" ||
                !props.extensionStatus.readOnlyCalibrated ||
                !props.extensionStatus.capabilities.includes("batch-send")))
          }
          onClick={props.openConfirm}
        >
          <Play size={18} />
          启动批次
        </button>
        <div className="plan-picker" aria-label="本批次搜索方案">
          {eligiblePlans.length === 0 ? (
            <div className="empty-inline">
              尚无已启用的搜索方案。请先前往“搜索方案”完成配置。
            </div>
          ) : (
            eligiblePlans.map((plan) => (
              <label key={plan.id} className="check-row">
                <input
                  type="checkbox"
                  checked={props.selectedPlans.includes(plan.id)}
                  onChange={() => togglePlan(plan.id)}
                />
                <span>
                  <strong>{plan.name}</strong>
                  <small>
                    优先级 {plan.priority} · 模板 {plan.templateId}
                  </small>
                </span>
              </label>
            ))
          )}
        </div>
      </section>

      <div className="overview-columns">
        <section className="plain-section">
          <div className="section-heading">
            <div>
              <span className="section-label">运行准备</span>
              <h2>启动前检查</h2>
            </div>
          </div>
          <ul className="readiness-list">
            <ReadinessItem
              label="账号备注"
              value={props.settings?.accountNote ?? "未设置"}
              ready={Boolean(props.settings?.accountNote)}
            />
            <ReadinessItem
              label="搜索方案"
              value={`${eligiblePlans.length} 个已启用`}
              ready={eligiblePlans.length > 0}
            />
            <ReadinessItem
              label="开场模板"
              value="由搜索方案绑定"
              ready={eligiblePlans.length > 0}
            />
            <ReadinessItem
              label="运行模式"
              value={
                props.settings?.adapterMode === "boss"
                  ? "Boss 真实页面"
                  : "本地演示"
              }
              ready={
                props.settings?.adapterMode === "fake" ||
                (props.extensionStatus?.connectionState === "页面已连接" &&
                  props.extensionStatus.readOnlyCalibrated &&
                  props.extensionStatus.capabilities.includes("batch-send"))
              }
            />
            {props.settings?.adapterMode === "boss" && (
              <>
                <ReadinessItem
                  label="发送会话"
                  value={sendSession?.armed ? "当前进程已授权" : "启动时确认"}
                  ready={Boolean(sendSession?.armed)}
                />
                <ReadinessItem
                  label="批次资格"
                  value={
                    sendSession?.qualified
                      ? "完整批次"
                      : `${sendSession?.validationSuccesses ?? 0}/5 次验证成功`
                  }
                  ready={Boolean(sendSession?.qualified)}
                />
                <ReadinessItem
                  label="本进程累计"
                  value={`${sendSession?.creditsUsed ?? 0} 额度 · ${sendSession?.unknownCount ?? 0} 未知 · ${sendSession?.mismatchCount ?? 0} 内容不符`}
                  ready={(sendSession?.unknownCount ?? 0) === 0}
                />
              </>
            )}
          </ul>
        </section>
        <section className="plain-section activity-section">
          <div className="section-heading">
            <div>
              <span className="section-label">最近活动</span>
              <h2>批次事件</h2>
            </div>
            <span className="state-chip">{props.status.batchState}</span>
          </div>
          {props.events.length === 0 ? (
            <div className="empty-state">
              <Gauge size={26} />
              <strong>还没有运行事件</strong>
              <span>启动演示批次后，状态变化会实时出现在这里。</span>
            </div>
          ) : (
            <ol className="event-list">
              {props.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <span
                    className={`event-mark state-${statusTone(event.state)}`}
                  />
                  <div>
                    <strong>{event.state}</strong>
                    <span>{event.message}</span>
                  </div>
                  <time>{formatTime(event.at)}</time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {(sendSession?.pending?.length ?? 0) > 0 && (
        <section className="plain-section">
          <div className="section-heading">
            <div>
              <span className="section-label">人工核实</span>
              <h2>待核实职位</h2>
            </div>
          </div>
          <ol className="event-list">
            {sendSession!.pending!.map((item) => (
              <li key={item.operationId}>
                <div>
                  <strong>
                    {item.company} · {item.title}
                  </strong>
                  <span>
                    消息摘要 {item.messageHash.slice(0, 12)} ·{" "}
                    {item.messageLength} 字
                  </span>
                </div>
                <div className="heading-actions">
                  <button
                    className="button quiet"
                    disabled={props.active}
                    onClick={() => void inspectPending(item.operationId)}
                  >
                    打开并核对
                  </button>
                  <button
                    className="button quiet"
                    disabled={
                      props.active || !inspectedOperations.has(item.operationId)
                    }
                    onClick={() =>
                      void resolvePending(item.operationId, "人工确认已发送")
                    }
                  >
                    确认已发送
                  </button>
                  <button
                    className="button quiet"
                    disabled={
                      props.active || !inspectedOperations.has(item.operationId)
                    }
                    onClick={() =>
                      void resolvePending(item.operationId, "人工确认未发送")
                    }
                  >
                    确认未发送
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function Plans({
  plans,
  templates,
  reload,
}: {
  plans: SearchPlan[];
  templates: OpeningTemplate[];
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<SearchPlan | null>(plans[0] ?? null);
  useEffect(() => {
    if (editing === null && plans[0]) setEditing(plans[0]);
  }, [plans, editing]);
  const save = async () => {
    if (!editing) return;
    await api(`/api/plans/${editing.id}`, {
      method: "PUT",
      body: JSON.stringify(editing),
    });
    await reload();
  };
  return (
    <>
      <PageHeading
        title="搜索方案"
        description="只有明确不符合硬性规则的职位会被排除；缺失或无法解析的字段继续放行。"
      />
      <div className="editor-layout">
        <section className="entity-list" aria-label="搜索方案列表">
          {plans.map((plan) => (
            <button
              key={plan.id}
              className={
                editing?.id === plan.id ? "entity-row selected" : "entity-row"
              }
              onClick={() => setEditing(structuredClone(plan))}
            >
              <span>
                <strong>{plan.name}</strong>
                <small>
                  {plan.rules.titleKeywords.join("、")} ·{" "}
                  {plan.rules.cities.join("、")}
                </small>
              </span>
              <span
                className={plan.enabled ? "enabled-label" : "disabled-label"}
              >
                {plan.enabled ? "启用" : "停用"}
              </span>
            </button>
          ))}
        </section>
        {editing && (
          <section className="editor-panel">
            <div className="section-heading">
              <div>
                <span className="section-label">编辑方案</span>
                <h2>{editing.name}</h2>
              </div>
              <button className="button primary" onClick={() => void save()}>
                <Save size={17} />
                保存
              </button>
            </div>
            <div className="form-grid">
              <Field label="方案名称">
                <input
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </Field>
              <Field label="优先级">
                <input
                  type="number"
                  value={editing.priority}
                  onChange={(e) =>
                    setEditing({ ...editing, priority: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="岗位关键词（逗号分隔）">
                <input
                  value={editing.rules.titleKeywords.join(", ")}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      rules: {
                        ...editing.rules,
                        titleKeywords: splitList(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="城市（逗号分隔）">
                <input
                  value={editing.rules.cities.join(", ")}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      rules: {
                        ...editing.rules,
                        cities: splitList(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="最低月薪 K">
                <input
                  type="number"
                  value={editing.rules.minSalaryK ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      rules: {
                        ...editing.rules,
                        minSalaryK: optionalNumber(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="最高可接受经验年限">
                <input
                  type="number"
                  value={editing.rules.maxExperienceYears ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      rules: {
                        ...editing.rules,
                        maxExperienceYears: optionalNumber(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="开场模板">
                <select
                  value={editing.templateId}
                  onChange={(e) =>
                    setEditing({ ...editing, templateId: e.target.value })
                  }
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="最近 N 天">
                <input
                  type="number"
                  value={editing.rules.publishedWithinDays ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      rules: {
                        ...editing.rules,
                        publishedWithinDays: optionalNumber(e.target.value),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              <span>
                <strong>启用此方案</strong>
                <small>启用后可在总览页加入投递批次。</small>
              </span>
            </label>
          </section>
        )}
      </div>
    </>
  );
}

function Templates({
  templates,
  reload,
}: {
  templates: OpeningTemplate[];
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<OpeningTemplate | null>(
    templates[0] ?? null,
  );
  useEffect(() => {
    if (editing === null && templates[0]) setEditing(templates[0]);
  }, [templates, editing]);
  const preview = useMemo(
    () =>
      editing?.body
        .replaceAll("{{职位名称}}", "Go 后端开发工程师")
        .replaceAll("{{公司名称}}", "示例公司") ?? "",
    [editing],
  );
  const save = async () => {
    if (editing) {
      await api(`/api/templates/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify(editing),
      });
      await reload();
    }
  };
  return (
    <>
      <PageHeading
        title="开场模板"
        description="模板只使用你确认的固定文字与职位、公司占位符，不自动虚构经历。"
      />
      <div className="editor-layout">
        <section className="entity-list">
          {templates.map((template) => (
            <button
              key={template.id}
              className={
                editing?.id === template.id
                  ? "entity-row selected"
                  : "entity-row"
              }
              onClick={() => setEditing({ ...template })}
            >
              <span>
                <strong>{template.name}</strong>
                <small>{template.body.slice(0, 34)}…</small>
              </span>
              <span
                className={
                  template.enabled ? "enabled-label" : "disabled-label"
                }
              >
                {template.enabled ? "启用" : "停用"}
              </span>
            </button>
          ))}
        </section>
        {editing && (
          <section className="editor-panel">
            <div className="section-heading">
              <div>
                <span className="section-label">编辑模板</span>
                <h2>{editing.name}</h2>
              </div>
              <button className="button primary" onClick={() => void save()}>
                <Save size={17} />
                保存
              </button>
            </div>
            <Field label="模板名称">
              <input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <Field label="模板正文">
              <textarea
                rows={8}
                value={editing.body}
                onChange={(e) =>
                  setEditing({ ...editing, body: e.target.value })
                }
              />
            </Field>
            <div className="template-preview">
              <span>实际效果预览</span>
              <p>{preview}</p>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              <span>
                <strong>启用此模板</strong>
                <small>停用模板不会被任何批次使用。</small>
              </span>
            </label>
          </section>
        )}
      </div>
    </>
  );
}

function Snapshots({
  snapshots,
  reload,
}: {
  snapshots: PositionSnapshot[];
  reload: () => Promise<void>;
}) {
  const clearOld = async () => {
    if (!window.confirm("删除 30 天前的职位快照？对应职位将失去历史去重能力。"))
      return;
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await api("/api/snapshots", {
      method: "DELETE",
      body: JSON.stringify({ processedBefore: cutoff }),
    });
    await reload();
  };
  const exportSnapshots = async () => {
    const data = await api<PositionSnapshot[]>("/api/snapshots?limit=500");
    saveJsonFile(`jobpilot-snapshots-${dateStamp()}.json`, {
      exportedAt: new Date().toISOString(),
      snapshots: data,
    });
  };
  return (
    <>
      <PageHeading
        title="职位快照"
        description="本地保留处理状态以防重复沟通；不会保存聊天内容或招聘者个人资料。"
        action={
          <div className="heading-actions">
            <button
              className="button quiet"
              onClick={() => void exportSnapshots()}
            >
              <Download size={16} />
              导出快照
            </button>
            <button className="button quiet" onClick={() => void clearOld()}>
              清理 30 天前
            </button>
          </div>
        }
      />
      <section className="table-shell">
        {snapshots.length === 0 ? (
          <div className="empty-state">
            <Archive size={26} />
            <strong>还没有职位快照</strong>
            <span>演示或真实批次处理职位后会显示在这里。</span>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>职位</th>
                  <th>公司</th>
                  <th>城市</th>
                  <th>状态</th>
                  <th>排除原因</th>
                  <th>处理时间</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((item) => (
                  <tr key={item.identity}>
                    <td>
                      <strong>{item.title}</strong>
                      <small>{item.identity}</small>
                    </td>
                    <td>{item.company}</td>
                    <td>{item.city ?? "未知"}</td>
                    <td>
                      <span
                        className={`status-label state-${snapshotTone(item.status)}`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="snapshot-reasons">
                      {item.status === "已排除" &&
                      item.exclusionReasons !== undefined &&
                      item.exclusionReasons.length > 0
                        ? item.exclusionReasons
                            .map(formatExclusionReason)
                            .join("；")
                        : "—"}
                    </td>
                    <td>{formatDateTime(item.processedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function SettingsView({
  settings,
  extensionStatus: initialExtensionStatus,
  sendSession,
  reload,
}: {
  settings: AppSettings;
  extensionStatus: ExtensionStatus | undefined;
  sendSession: SendSessionStatus | undefined;
  reload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [extensionStatus, setExtensionStatus] = useState(
    initialExtensionStatus,
  );
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationNotice, setCalibrationNotice] = useState<{
    tone: "neutral" | "success" | "danger";
    text: string;
  }>();
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => setDraft({ ...settings, realSendEnabled: false }),
    [settings],
  );
  useEffect(
    () => setExtensionStatus(initialExtensionStatus),
    [initialExtensionStatus],
  );
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await api<ExtensionStatus>("/api/extension/status");
        if (active) setExtensionStatus(status);
      } catch {
        // A full-page reload reports local-service errors in the main banner.
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    void refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const save = async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(draft) });
    await reload();
  };
  const exportConfiguration = async () => {
    const data = await api<unknown>("/api/export/configuration");
    saveJsonFile(`jobpilot-configuration-${dateStamp()}.json`, data);
  };
  const exportOperationLog = async () => {
    const data = await api<unknown>("/api/export/operations");
    saveJsonFile(`jobpilot-operation-log-${dateStamp()}.json`, data);
  };
  const importConfiguration = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      await api("/api/import/configuration", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await reload();
      window.alert("配置导入完成；同 ID 的方案和模板已更新。");
    } catch (caught) {
      window.alert(messageOf(caught));
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };
  const refreshExtensionStatus = async () => {
    const status = await api<ExtensionStatus>("/api/extension/status");
    setExtensionStatus(status);
    return status;
  };
  const approvePairing = async () => {
    const pending = extensionStatus?.pendingPairing;
    if (!pending) return;
    setCalibrating(true);
    setCalibrationNotice(undefined);
    try {
      await api(`/api/extension/pairings/${pending.requestId}/approve`, {
        method: "POST",
      });
      await refreshExtensionStatus();
      setCalibrationNotice({
        tone: "success",
        text: "扩展已配对。请在已登录的 BOSS 标签页中打开扩展并连接当前页面。",
      });
    } catch (caught) {
      setCalibrationNotice({ tone: "danger", text: messageOf(caught) });
    } finally {
      setCalibrating(false);
    }
  };
  const calibrateBoss = async () => {
    setCalibrating(true);
    setCalibrationNotice(undefined);
    try {
      const result = await api<{
        calibrated: true;
        candidatesRecognized: number;
      }>("/api/calibration/boss", {
        method: "POST",
      });
      await Promise.all([reload(), refreshExtensionStatus()]);
      setCalibrationNotice({
        tone: "success",
        text: `只读校准通过，识别到 ${result.candidatesRecognized} 个候选职位。`,
      });
    } catch (caught) {
      setCalibrationNotice({
        tone: "danger",
        text: `${messageOf(caught)} 请确认已连接的 BOSS 页面仍处于登录状态。`,
      });
    } finally {
      setCalibrating(false);
    }
  };
  const disconnectPage = async () => {
    try {
      await api("/api/extension/disconnect", { method: "POST" });
      await refreshExtensionStatus();
      setCalibrationNotice({ tone: "neutral", text: "已解除页面连接。" });
    } catch (caught) {
      setCalibrationNotice({ tone: "danger", text: messageOf(caught) });
    }
  };
  const resetPairing = async () => {
    if (!window.confirm("重置后需要重新核对配对码，确认继续吗？")) return;
    try {
      await api("/api/extension/pairing/reset", { method: "POST" });
      await refreshExtensionStatus();
      setCalibrationNotice({ tone: "neutral", text: "扩展配对已重置。" });
    } catch (caught) {
      setCalibrationNotice({ tone: "danger", text: messageOf(caught) });
    }
  };
  const resetQualification = async () => {
    if (
      !window.confirm(
        "这会清除本机永久保存的真实发送资格，后续需要重新完成 5 次验证批次。确认继续吗？",
      )
    )
      return;
    try {
      await api("/api/send/qualification/reset", { method: "POST" });
      await reload();
      setCalibrationNotice({ tone: "neutral", text: "本机发送资格已重置。" });
    } catch (caught) {
      setCalibrationNotice({ tone: "danger", text: messageOf(caught) });
    }
  };
  return (
    <>
      <PageHeading
        title="设置"
        description="页面连接、发送资格和操作账本都只保存在本机；每次进程启动仍需重新授权发送。"
        action={
          <div className="heading-actions">
            <button
              className="button quiet"
              onClick={() => void exportOperationLog()}
            >
              <Download size={16} />
              导出操作账本
            </button>
            <button
              className="button quiet"
              onClick={() => void exportConfiguration()}
            >
              <Download size={16} />
              导出配置
            </button>
            <button
              className="button quiet"
              onClick={() => importInput.current?.click()}
            >
              <Upload size={16} />
              导入配置
            </button>
            <button className="button primary" onClick={() => void save()}>
              <Save size={17} />
              保存设置
            </button>
            <input
              ref={importInput}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              onChange={(event) =>
                void importConfiguration(event.target.files?.[0])
              }
            />
          </div>
        }
      />
      <div className="settings-stack">
        <section className="settings-section">
          <div>
            <SlidersHorizontal size={20} />
            <h2>运行身份</h2>
            <p>批次启动前会再次展示该备注，帮助确认当前登录账号。</p>
          </div>
          <div>
            <Field label="账号备注">
              <input
                value={draft.accountNote}
                onChange={(e) =>
                  setDraft({ ...draft, accountNote: e.target.value })
                }
              />
            </Field>
            <Field label="成功沟通最短间隔（毫秒）">
              <input
                type="number"
                min="0"
                max="60000"
                value={draft.cooldownMs}
                onChange={(e) =>
                  setDraft({ ...draft, cooldownMs: Number(e.target.value) })
                }
              />
              {draft.adapterMode === "boss" && (
                <small>
                  真实页面不可低于 5000 毫秒；更小的值只用于本地演示。
                </small>
              )}
            </Field>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <Gauge size={20} />
            <h2>平台模式</h2>
            <p>
              真实页面按验证批次逐步取得资格；本地演示不会写入 Boss 去重账本。
            </p>
          </div>
          <div className="segmented">
            <button
              className={draft.adapterMode === "fake" ? "selected" : ""}
              onClick={() =>
                setDraft({
                  ...draft,
                  adapterMode: "fake",
                  realSendEnabled: false,
                })
              }
            >
              本地演示
            </button>
            <button
              className={draft.adapterMode === "boss" ? "selected" : ""}
              onClick={() => setDraft({ ...draft, adapterMode: "boss" })}
            >
              Boss 真实页面
            </button>
          </div>
        </section>
        <section className="settings-section risk-section">
          <div>
            <AlertTriangle size={20} />
            <h2>Chrome 扩展与页面连接</h2>
            <p>
              JobPilot
              不再启动或控制浏览器。登录由本人完成，扩展只连接你明确选择的一个
              BOSS 标签页。
            </p>
          </div>
          <div className="toggle-stack">
            <ol className="extension-steps">
              <li>
                运行构建后，在 Chrome 扩展页加载 <code>dist/extension</code>。
              </li>
              <li>
                建议新建一个仅用于求职的 Chrome 配置文件，并由本人登录 BOSS。
              </li>
              <li>打开扩展；首次连接时核对下方配对码并批准。</li>
              <li>在目标 BOSS 标签页中点击“连接当前页面”，再校准读取能力。</li>
            </ol>
            <div className="extension-status-grid" aria-live="polite">
              <span>扩展配对</span>
              <strong>{extensionStatus?.pairingState ?? "正在读取…"}</strong>
              <span>本机连接</span>
              <strong>{extensionStatus?.connectionState ?? "正在读取…"}</strong>
              <span>页面能力</span>
              <strong>
                {extensionStatus?.capabilities.includes("read")
                  ? extensionStatus.capabilities.includes("batch-send")
                    ? "读取 + 批次发送"
                    : "只读"
                  : "尚未报告"}
              </strong>
            </div>
            {extensionStatus?.pendingPairing && (
              <div className="pairing-panel">
                <div>
                  <span>请与扩展弹窗核对配对码</span>
                  <strong>{extensionStatus.pendingPairing.code}</strong>
                </div>
                <button
                  className="button primary"
                  disabled={calibrating}
                  onClick={() => void approvePairing()}
                >
                  批准此扩展
                </button>
              </div>
            )}
            {extensionStatus?.page && (
              <div className="bound-page">
                <div>
                  <strong>已连接 BOSS 页面</strong>
                  <small title={extensionStatus.page.url}>
                    {extensionStatus.page.url}
                  </small>
                </div>
                <button
                  className="button quiet"
                  onClick={() => void disconnectPage()}
                >
                  解除页面连接
                </button>
              </div>
            )}
            <button
              className="button quiet calibration-button"
              disabled={
                calibrating || extensionStatus?.connectionState !== "页面已连接"
              }
              onClick={() => void calibrateBoss()}
            >
              <Gauge size={16} />
              {calibrating ? "正在校准…" : "校准页面读取"}
            </button>
            {calibrationNotice && (
              <div
                className={`calibration-notice ${calibrationNotice.tone}`}
                role="status"
              >
                {calibrationNotice.text}
              </div>
            )}
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={extensionStatus?.readOnlyCalibrated ?? false}
                disabled
                readOnly
              />
              <span>
                <strong>只读校准已经通过</strong>
                <small>
                  只对当前已连接页面有效；页面断开或重新配对后需重新校准。
                </small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={
                  extensionStatus?.capabilities.includes("batch-send") ?? false
                }
                disabled
                readOnly
              />
              <span>
                <strong>扩展支持原子批次发送</strong>
                <small>
                  每个联系人只下发一个持久化命令；不可逆动作不会自动重试。
                </small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={sendSession?.qualified ?? false}
                disabled
                readOnly
              />
              <span>
                <strong>
                  {sendSession?.qualified
                    ? "本机已取得完整批次资格"
                    : `验证进度 ${sendSession?.validationSuccesses ?? 0}/5`}
                </strong>
                <small>
                  待核对结果 {sendSession?.pendingCount ?? 0}
                  个；存在待核对项时不会晋级。
                </small>
              </span>
            </label>
            {((sendSession?.validationSuccesses ?? 0) > 0 ||
              sendSession?.qualified) && (
              <button
                className="button danger-quiet"
                onClick={() => void resetQualification()}
              >
                重置本机发送资格
              </button>
            )}
            {extensionStatus?.pairingState === "已配对" && (
              <button
                className="button danger-quiet"
                onClick={() => void resetPairing()}
              >
                重置扩展配对
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function ReadinessItem({
  label,
  value,
  ready,
}: {
  label: string;
  value: string;
  ready: boolean;
}) {
  return (
    <li>
      <span className={ready ? "readiness-mark ready" : "readiness-mark"}>
        {ready ? "✓" : "!"}
      </span>
      <span>
        <strong>{label}</strong>
        <small>{value}</small>
      </span>
    </li>
  );
}

function statusTone(
  state: BatchState,
): "neutral" | "active" | "warning" | "danger" | "success" {
  if (state === "已完成") return "success";
  if (state === "已失败") return "danger";
  if (
    state === "已完成有异常" ||
    state === "人工接管" ||
    state === "等待人工登录" ||
    state === "等待页面就绪" ||
    state === "正在停止"
  )
    return "warning";
  if (state === "空闲") return "neutral";
  return "active";
}
function snapshotTone(status: string) {
  if (status === "沟通成功") return "success";
  if (status === "结果未知" || status === "内容不符") return "danger";
  if (status === "已排除" || status === "已跳过") return "neutral";
  return "warning";
}

function formatExclusionReason(
  reason: NonNullable<PositionSnapshot["exclusionReasons"]>[number],
): string {
  const labels: Record<string, string> = {
    "title:keyword-mismatch": "职位关键词不匹配",
    "location:city-mismatch": "城市不符合方案",
    "location:region-mismatch": "区域不符合方案",
    "remote:not-allowed": "不接受远程职位",
    "salary:below-minimum": "薪资低于最低要求",
    "experience:above-maximum": "经验要求超过上限",
    "education:above-candidate": "学历要求过高",
    "company:blacklisted": "公司在黑名单中",
    "industry:blacklisted": "行业在黑名单中",
    "publishedAt:too-old": "发布时间超过期限",
  };
  return labels[`${reason.field}:${reason.code}`] ?? "不符合硬性规则";
}
function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function optionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
function saveJsonFile(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
