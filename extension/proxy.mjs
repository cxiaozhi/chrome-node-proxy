const localProxy = { scheme: "http", host: "127.0.0.1", port: 7890 };

export const readProxy = () => chrome.proxy.settings.get({ incognito: false });
export const withProxyLock = (callback) => navigator.locks.request("browser-proxy", callback);

export function controlError(settings) {
  if (settings.levelOfControl === "controlled_by_other_extensions") return "另一个扩展正在控制 Chrome 代理。";
  if (settings.levelOfControl === "not_controllable") return "Chrome 代理由浏览器策略控制。";
  return "";
}

export function isClashEnabled(settings) {
  const proxy = settings.value?.rules?.singleProxy;
  return settings.levelOfControl === "controlled_by_this_extension" &&
    settings.value?.mode === "fixed_servers" && proxy?.host === localProxy.host &&
    proxy.port === localProxy.port && (proxy.scheme ?? "http") === localProxy.scheme;
}

export async function setClashEnabled(enabled) {
  const issue = controlError(await readProxy());
  if (issue) throw new Error(issue);
  const value = enabled ? { mode: "fixed_servers", rules: { singleProxy: localProxy } } : { mode: "direct" };
  await chrome.proxy.settings.set({ value, scope: "regular" });
  const current = await readProxy();
  const applied = enabled ? isClashEnabled(current) :
    current.levelOfControl === "controlled_by_this_extension" && current.value?.mode === "direct";
  if (!applied) throw new Error(controlError(current) || "Chrome 未应用代理设置。");
}
