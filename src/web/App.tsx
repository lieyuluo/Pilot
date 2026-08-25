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
  type OpeningTemplate,
  type PositionSnapshot,
  type SearchPlan,
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
      ] = await Promise.all([
        api<SearchPlan[]>("/api/plans"),
        api<OpeningTemplate[]>("/api/templates"),
        api<PositionSnapshot[]>("/api/snapshots?limit=100"),
        api<AppSettings>("/api/settings"),
        api<AppStatus>("/api/status"),
      ]);
      setPlans(nextPlans);
      setTemplates(nextTemplates);
      setSnapshots(nextSnapshots);
      setSettings(nextSettings);
      setStatus(nextStatus);
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
      if (["已完成", "人工接管", "已失败"].includes(payload.state)) {
        void load();
      }
    };
    stream.addEventListener("batch", onBatch as EventListener);
    return () => stream.close();
  }, [load]);

  const active = !["空闲", "已完成", "已失败"].includes(status.batchState);
  const enabledPlans = plans.filter((plan) => selectedPlans.includes(plan.id));

  const runBatch = async () => {
    setBusy(true);
    setError(undefined);
    try {
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
              events={events}
              active={active}
              openConfirm={() => confirmDialog.current?.showModal()}
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
            <SettingsView settings={settings} reload={load} />
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
          <p>确认后将直接处理所有达标职位，不再逐个预览。</p>
          <dl className="batch-summary">
            <div>
              <dt>搜索方案</dt>
              <dd>
                {enabledPlans.map((plan) => plan.name).join("、") || "未选择"}
              </dd>
            </div>
            <div>
              <dt>账号备注</dt>
              <dd>{settings?.accountNote ?? "未设置"}</dd>
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
              <dd>成功沟通 20 个 / 检查 200 个</dd>
            </div>
          </dl>
          <div className="warning-copy">
            <AlertTriangle size={18} />
            <span>已发送的消息无法撤回；结果不明时系统会立即暂停。</span>
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
              {busy ? "正在启动…" : "确认并启动"}
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
  events: Array<{ state: BatchState; message: string; at: string }>;
  active: boolean;
  openConfirm: () => void;
}) {
  const eligiblePlans = props.plans.filter((plan) => plan.enabled);
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
          <h2>最多成功沟通 20 个职位</h2>
          <p>按方案优先级依次检查，达到 200 个候选职位或触发停机条件时结束。</p>
        </div>
        <button
          className="button primary start-button"
          disabled={props.active || props.selectedPlans.length === 0}
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
                Boolean(props.settings?.realSendEnabled)
              }
            />
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
  reload,
}: {
  settings: AppSettings;
  reload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [calibrating, setCalibrating] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(settings), [settings]);
  const save = async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(draft) });
    await reload();
  };
  const exportConfiguration = async () => {
    const data = await api<unknown>("/api/export/configuration");
    saveJsonFile(`jobpilot-configuration-${dateStamp()}.json`, data);
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
  const calibrateBoss = async () => {
    setCalibrating(true);
    try {
      const result = await api<{
        calibrated: true;
        candidatesRecognized: number;
      }>("/api/calibration/boss", {
        method: "POST",
      });
      await reload();
      window.alert(
        `只读校准通过，识别到 ${result.candidatesRecognized} 个候选职位。真实发送仍保持关闭。`,
      );
    } catch (caught) {
      window.alert(
        `${messageOf(caught)}\n\n如果专用浏览器已经打开，请在其中手动登录后再次点击校准。`,
      );
    } finally {
      setCalibrating(false);
    }
  };
  return (
    <>
      <PageHeading
        title="设置"
        description="账号状态、运行模式和真实发送开关都保存在本机，不进入仓库或配置导出。"
        action={
          <div className="heading-actions">
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
            </Field>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <Gauge size={20} />
            <h2>平台模式</h2>
            <p>真实模式仍需完成只读校准并显式解锁发送。</p>
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
            <h2>真实发送闸门</h2>
            <p>
              启用后，达标职位会在确认批次后直接发送消息。该动作可能违反平台协议。
            </p>
          </div>
          <div className="toggle-stack">
            <button
              className="button quiet calibration-button"
              disabled={calibrating}
              onClick={() => void calibrateBoss()}
            >
              <Gauge size={16} />
              {calibrating ? "正在打开并检查…" : "打开专用浏览器并只读校准"}
            </button>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.readOnlySmokePassed}
                disabled
                readOnly
              />
              <span>
                <strong>只读校准已经通过</strong>
                <small>
                  系统确认登录、搜索和职位列表结构仍受支持；页面变化后需重新校准。
                </small>
              </span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.realSendEnabled}
                disabled={
                  !draft.readOnlySmokePassed || draft.adapterMode !== "boss"
                }
                onChange={(e) =>
                  setDraft({ ...draft, realSendEnabled: e.target.checked })
                }
              />
              <span>
                <strong>解锁真实发送</strong>
                <small>不会自动启动批次，但允许启动按钮执行真实沟通。</small>
              </span>
            </label>
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
  if (state === "人工接管" || state === "等待人工登录" || state === "正在停止")
    return "warning";
  if (state === "空闲") return "neutral";
  return "active";
}
function snapshotTone(status: string) {
  if (status === "沟通成功") return "success";
  if (status === "结果未知" || status === "明确失败") return "danger";
  if (status === "已排除" || status === "已跳过") return "neutral";
  return "warning";
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
