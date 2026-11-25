import { controlError, isClashEnabled, readProxy, setClashEnabled, withProxyLock } from "./proxy.mjs";

async function updateToolbarIcon(settings) {
  const enabled = isClashEnabled(settings);
  const icon = enabled ? "icon" : "icon-off";
  await chrome.action.setIcon({ path: { 16: `icons/${icon}-16.png`, 48: `icons/${icon}-48.png` } });
  await chrome.action.setTitle({ title: enabled ? "Clash 浏览器代理（已启用）" : "Clash 浏览器代理（未启用）" });
}

function syncToolbarIcon() {
  void withProxyLock(async () => {
    await updateToolbarIcon(await readProxy());
  }).catch(console.error);
}

chrome.runtime.onInstalled.addListener(() => {
  void withProxyLock(async () => {
    const settings = await readProxy();
    if (!controlError(settings) && !isClashEnabled(settings)) await setClashEnabled(false);
  }).catch(console.error);
  syncToolbarIcon();
});

chrome.runtime.onStartup.addListener(syncToolbarIcon);
chrome.proxy.settings.onChange.addListener(syncToolbarIcon);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.action !== "toggle-clash" || sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("popup.html")) return;
  void (async () => {
    try {
      await withProxyLock(async () => {
        await setClashEnabled(!isClashEnabled(await readProxy()));
      });
      reply({ ok: true });
    } catch (error) {
      reply({ ok: false, message: error.message });
    }
  })();
  return true;
});
