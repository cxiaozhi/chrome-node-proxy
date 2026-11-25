import { controlError, isClashEnabled, readProxy } from "./proxy.mjs";

const toggle = document.getElementById("clash-toggle");
const status = document.getElementById("status");
let updating = false;

async function render(error = "") {
  try {
    const settings = await readProxy();
    const enabled = isClashEnabled(settings);
    const issue = controlError(settings);
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.disabled = Boolean(issue);
    status.toggleAttribute("data-error", Boolean(issue || error));
    status.textContent = issue || error || (enabled ? "已启用。Clash 的系统代理可以保持关闭。" :
      settings.value?.mode === "direct" ? "已关闭。Chrome 当前直连。" : "尚未启用 Clash 浏览器代理。");
  } catch {
    toggle.disabled = true;
    status.setAttribute("data-error", "");
    status.textContent = "无法读取 Chrome 代理设置。";
  }
}

toggle.addEventListener("click", async () => {
  if (updating) return;
  updating = true;
  let error = "";
  try {
    const result = await chrome.runtime.sendMessage({ action: "toggle-clash" });
    if (!result?.ok) throw new Error(result?.message || "无法切换 Chrome 代理。");
  } catch (cause) {
    error = cause.message || "无法切换 Chrome 代理。";
  } finally {
    updating = false;
    await render(error);
  }
});

chrome.proxy.settings.onChange.addListener(() => {
  if (!updating) void render();
});
void render();
