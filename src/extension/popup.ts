export {};

interface PopupState {
  serverConnected: boolean;
  authorized: boolean;
  pageConnected: boolean;
  boundTabId?: number;
  lastError?: string;
  preparation: {
    state: "idle" | "running" | "ready" | "error";
    stage:
      | "connecting"
      | "authorizing"
      | "binding"
      | "calibrating"
      | "returning"
      | "ready";
    message: string;
    error?: string;
    warning?: string;
  };
}

const statusElement = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const statusPanel = document.querySelector<HTMLElement>("#connection-status")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  const result = (await chrome.runtime.sendMessage({
    type: "prepare_current_page",
  })) as { ok: boolean; error?: string };
  if (!result.ok) detail.textContent = result.error ?? "连接失败";
  await refresh();
});

stopButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "emergency_stop" });
  await refresh();
});

void refresh();
const refreshTimer = window.setInterval(() => void refresh(), 1_000);
window.addEventListener("unload", () => window.clearInterval(refreshTimer));

async function refresh(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({
    type: "get_extension_state",
  })) as PopupState;
  const preparation = state.preparation;
  statusElement.textContent = preparation.message;
  detail.textContent =
    preparation.error ??
    preparation.warning ??
    (preparation.state === "idle"
      ? "一次完成扩展授权、当前页面连接和只读检查。"
      : state.boundTabId === undefined
        ? ""
        : `已选择标签页 ${state.boundTabId}`);
  statusPanel.dataset.tone =
    preparation.state === "ready"
      ? "success"
      : preparation.state === "error"
        ? "danger"
        : preparation.state === "running"
          ? "active"
          : "neutral";
  statusPanel.setAttribute(
    "aria-busy",
    preparation.state === "running" ? "true" : "false",
  );
  connectButton.textContent = buttonLabel(preparation);
  connectButton.dataset.state = preparation.state;
  connectButton.disabled =
    preparation.state === "running" || preparation.state === "ready";
  stopButton.disabled = !state.pageConnected;
}

function buttonLabel(preparation: PopupState["preparation"]): string {
  if (preparation.state === "ready") return "页面已就绪";
  if (preparation.state === "error") return "重试连接与检查";
  if (preparation.state !== "running") return "连接并检查当前页面";
  return {
    connecting: "正在连接本机…",
    authorizing: "正在授权扩展…",
    binding: "正在连接当前页面…",
    calibrating: "正在检查页面…",
    returning: "正在返回搜索列表…",
    ready: "页面已就绪",
  }[preparation.stage];
}
