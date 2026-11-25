import { controlError, isClashEnabled, readProxy, setClashEnabled, withProxyLock } from "./proxy.mjs";

chrome.runtime.onInstalled.addListener(() => {
  void withProxyLock(async () => {
    const settings = await readProxy();
    if (!controlError(settings) && !isClashEnabled(settings)) await setClashEnabled(false);
  }).catch(console.error);
});

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
