export {};

interface PopupState {
  serverConnected: boolean;
  paired: boolean;
  pairingCode?: string;
  pageConnected: boolean;
  boundTabId?: number;
  lastError?: string;
}

const statusElement = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  const result = (await chrome.runtime.sendMessage({
    type: "bind_current_page",
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
  statusElement.textContent = state.pageConnected
    ? "当前 BOSS 标签页已连接"
    : state.serverConnected
      ? state.paired
        ? "扩展已配对，等待连接页面"
        : "等待在 JobPilot 设置页批准配对"
      : "正在等待本机 JobPilot";
  detail.textContent = state.pairingCode
    ? `配对码：${state.pairingCode}`
    : (state.lastError ??
      (state.boundTabId === undefined ? "" : `标签页 ${state.boundTabId}`));
  connectButton.disabled = !state.serverConnected || !state.paired;
  stopButton.disabled = !state.pageConnected;
}
