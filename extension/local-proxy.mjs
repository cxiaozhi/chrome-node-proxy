const HOST = 'com.directproxy.bridge';

export function startLocalProxy(proxy, onClose) {
  return new Promise((resolve, reject) => {
    const connection = chrome.runtime.connectNative(HOST);
    const session = { alive: true, server: null, close };
    let ready = false;
    const timeout = setTimeout(() => fail('本机代理启动超时。'), 12000);

    function close() {
      if (!session.alive) return;
      session.alive = false;
      clearTimeout(timeout);
      connection.disconnect();
    }

    function fail(message) {
      close();
      reject(new Error(message));
    }

    connection.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? '';
      session.alive = false;
      clearTimeout(timeout);
      if (ready) onClose(session);
      else reject(new Error(/not found|forbidden|access|permission/iu.test(message)
        ? '请先运行 Windows 本机组件安装程序，再启用节点。' : '本机组件已退出。请重新安装组件后重试。'));
    });
    connection.onMessage.addListener(result => {
      if (ready) return;
      if (!result?.ok || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
        fail(result?.error ?? '本机代理返回无效端口。');
        return;
      }
      ready = true;
      clearTimeout(timeout);
      session.server = { scheme: 'socks5', host: '127.0.0.1', port: result.port };
      resolve(session);
    });
    connection.postMessage({ action: 'start', proxy });
  });
}

export async function measureLocalProxies(proxies) {
  let response;
  try { response = await chrome.runtime.sendNativeMessage(HOST, { action: 'test', proxies }); }
  catch {
    const error = new Error('请安装新版 Windows 本机组件后测速。');
    error.code = 'helper';
    throw error;
  }
  if (!response?.ok || !Array.isArray(response.results) || response.results.length !== proxies.length) {
    const error = new Error('无法启动测速。');
    error.code = 'test';
    throw error;
  }
  return response.results.map(delay => Number.isInteger(delay) && delay >= 0 && delay <= 65535 ? delay : null);
}
