import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { on, once } from 'node:events';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PROXY_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.PROXY_TEST_PLAYWRIGHT).href : 'playwright');
const extension = resolve('extension');
const tempRoot = await realpath(tmpdir());
const permissionFixture = await mkdtemp(join(tempRoot, 'direct-proxy-test-'));
let subscriptionVersion = 1;
const saved = [];
const targets = [];
const sockets = new Set();
let plainHits = 0;
let authHits = 0;

async function listen(server) {
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  saved.push(server);
  return server.address().port;
}

const originPort = await listen(httpServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/subscription?clash=3&extend=1') {
    const type = subscriptionVersion === 1 ? 'http' : 'socks5';
    const expiry = Date.UTC(2027, 0, 10, 12) / 1000;
    response.setHeader('Subscription-Userinfo', `upload=0; download=${subscriptionVersion * 1073741824}; total=10737418240; expire=${expiry}`);
    response.end(`proxies:\n  - {name: Subscription ${subscriptionVersion}, type: ${type}, server: 127.0.0.1, port: ${plainPort}}`);
    return;
  }
  response.end('origin fixture');
}));
const target = `http://proxy-fixture.test:${originPort}`;
const plainPort = await listen(httpServer((request, response) => {
  if (!request.url.startsWith(`${target}/`)) { response.writeHead(404).end(); return; }
  if (request.url.endsWith('/http')) plainHits++;
  response.setHeader('Content-Type', 'text/plain');
  response.end('HTTP proxy fixture');
}));
const authValue = `Basic ${Buffer.from('test-user:test-password').toString('base64')}`;
const authPort = await listen(httpServer((request, response) => {
  if (!request.url.startsWith(`${target}/`)) { response.writeHead(404).end(); return; }
  if (request.headers['proxy-authorization'] !== authValue) {
    response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy-fixture"' }).end();
    return;
  }
  if (request.url.endsWith('/auth')) authHits++;
  response.setHeader('Content-Type', 'text/plain');
  response.end('Authenticated proxy fixture');
}));

const socksPort = await listen(tcpServer(socket => {
  let buffer = Buffer.alloc(0);
  let greeting = true;
  const handshake = data => {
    buffer = Buffer.concat([buffer, data]);
    if (greeting) {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
      if (buffer[0] !== 5) { socket.destroy(); return; }
      buffer = buffer.subarray(2 + buffer[1]);
      socket.write(Buffer.from([5, 0]));
      greeting = false;
    }
    if (buffer.length < 5) return;
    if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3) { socket.destroy(); return; }
    const offset = 5 + buffer[4];
    if (buffer.length < offset + 2) return;
    const host = buffer.toString('utf8', 5, offset);
    const port = buffer.readUInt16BE(offset);
    if (host !== 'proxy-fixture.test' || port !== originPort) { socket.destroy(); return; }
    targets.push(host);
    socket.off('data', handshake);
    const upstream = connect(originPort, '127.0.0.1');
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      upstream.write(buffer.subarray(offset + 2));
      socket.pipe(upstream).pipe(socket);
    });
  };
  socket.on('data', handshake);
}));

async function openExtension(path) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`,
      '--no-proxy-server', '--host-resolver-rules=MAP proxy-fixture.test 127.0.0.1'],
    viewport: { width: 1180, height: 800 }
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    context.setDefaultTimeout(7000);
    const page = await context.newPage();
    await page.goto(`${base}/popup.html`);
    await page.locator('#status').getByText('未启用', { exact: true }).waitFor();
    return { context, base, page, worker };
  } catch (error) { await context.close(); throw error; }
}

async function paste(page, content) {
  await page.locator('[data-view=add]').click();
  await page.getByRole('button', { name: '文件 / 文本', exact: true }).click();
  await page.locator('#import textarea').fill(content);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.locator('#feedback').getByText(/个可用/u).waitFor();
}

async function enable(page, name) {
  await page.locator('.node').filter({ hasText: name }).getByRole('button', { name: '启用', exact: true }).click();
  await page.locator('#active-node').getByText(name, { exact: true }).waitFor();
}

async function body(page, path) {
  await page.goto(`${target}/${path}`, { timeout: 10000 });
  return page.locator('body').innerText();
}

try {
  const { context, base, page, worker } = await openExtension(extension);
  try {
    const access = await worker.evaluate(async () => ({
      origins: (await chrome.permissions.getAll()).origins,
      authAccess: await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }),
    }));
    assert.deepEqual(access.origins, ['https://proxy-auth.invalid/*']);
    assert.equal(access.authAccess, false);
    await page.evaluate(() => chrome.action.openPopup());
    await page.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('#empty-nodes:not([hidden])'));
    const popup = await page.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      view.document.querySelector('#open-subscription').click();
      const active = view.document.activeElement;
      const width = view.document.documentElement.scrollWidth;
      view.close();
      return { name: active.name, width };
    });
    assert.deepEqual(popup, { name: 'url', width: 400 });
    await paste(page, `http://127.0.0.1:${plainPort}#Plain-Test\nsocks5://127.0.0.1:${socksPort}#SOCKS-Test\ntrojan://fixture#Trojan-Test`);
    await page.getByText('Trojan-Test · Trojan · Chrome 无法直连此协议').waitFor({ state: 'attached' });
    const traffic = await context.newPage();
    assert.equal(await body(traffic, 'before'), 'origin fixture');
    await enable(page, 'Plain-Test');
    assert.equal(await body(traffic, 'http'), 'HTTP proxy fixture');
    assert.equal(plainHits, 1);
    await enable(page, 'SOCKS-Test');
    assert.equal(await body(traffic, 'socks'), 'origin fixture');
    assert.ok(targets.length > 0);
    await page.evaluate(async () => {
      const { proxyLibrary } = await chrome.storage.local.get('proxyLibrary');
      const group = proxyLibrary.groups[0];
      const copies = Array.from({ length: 30 }, (_, index) => ({ ...group.nodes[0], id: `test-${index}`, name: `Node ${index}` }));
      await chrome.storage.local.set({ proxyLibrary: { ...proxyLibrary, groups: [{ ...group, nodes: [...group.nodes, ...copies] }] } });
    });
    await page.evaluate(() => chrome.action.openPopup());
    await page.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelectorAll('.node').length === 32);
    const bounds = await page.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      const content = view.document.querySelector('#panel-content');
      content.scrollTop = content.scrollHeight;
      const scroll = content.scrollTop;
      const width = view.document.documentElement.scrollWidth;
      const height = view.innerHeight;
      view.close();
      return { width, height, scroll };
    });
    assert.equal(bounds.width, 400);
    assert.ok(bounds.height <= 500 && bounds.scroll > 0);
    if (process.env.PROXY_TEST_ACTIVE_SCREENSHOT) {
      await page.setViewportSize({ width: 400, height: 460 });
      await page.screenshot({ path: process.env.PROXY_TEST_ACTIVE_SCREENSHOT });
    }
    await page.getByRole('button', { name: '停用', exact: true }).click();
    await page.locator('#status').getByText('未启用').waitFor();
    assert.equal(await body(traffic, 'after'), 'origin fixture');

    console.log('Passed: actual HTTP forwarding, SOCKS5 domain forwarding, popup switching, and restore.');
  } finally { await context.close(); }

  // Grant host permissions in the test manifest to avoid the native Chrome prompt in headless mode.
  await cp(extension, permissionFixture, { recursive: true });
  const manifestPath = join(permissionFixture, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push(...manifest.optional_host_permissions);
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const authorized = await openExtension(permissionFixture);
  try {
    const { base, context, page } = authorized;
    const tabCount = context.pages().length;
    await page.getByText('暂无可用节点', { exact: true }).waitFor();
    await page.setViewportSize({ width: 400, height: 575 });
    if (process.env.PROXY_TEST_POPUP_SCREENSHOT) {
      await page.screenshot({ path: process.env.PROXY_TEST_POPUP_SCREENSHOT });
    }
    await page.getByRole('button', { name: '导入订阅', exact: true }).click();
    const urlInput = page.locator('#subscription [name=url]');
    await page.locator('#subscription [name=url]:focus').waitFor();
    await urlInput.fill(`http://127.0.0.1:${originPort}/subscription?clash=3&extend=1`);
    await page.getByRole('button', { name: '导入订阅', exact: true }).click();
    await page.getByText('Subscription 1', { exact: true }).waitFor();
    await page.locator('[data-view=subscriptions]').click();
    await page.getByText('剩余 9 GB / 10 GB', { exact: true }).waitFor();
    await page.getByText('到期 2027-01-10', { exact: true }).waitFor();
    subscriptionVersion = 2;
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await page.getByText('剩余 8 GB / 10 GB', { exact: true }).waitFor();
    if (process.env.PROXY_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PROXY_TEST_SCREENSHOT });
    await page.locator('[data-view=nodes]').click();
    await page.getByText('Subscription 2', { exact: true }).waitFor();
    assert.equal(await page.getByText('Subscription 1', { exact: true }).count(), 0);
    await page.locator('[data-view=add]').click();
    await page.getByRole('button', { name: '文件 / 文本', exact: true }).click();
    await page.locator('#import input[type=file]').setInputFiles({ name: 'fixture.yaml', mimeType: 'text/yaml',
      buffer: Buffer.from(`proxies: [{name: File Node, type: http, server: 127.0.0.1, port: ${plainPort}}]`) });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.getByText('File Node', { exact: true }).waitFor();
    await page.locator('[data-view=add]').click();
    await page.getByRole('button', { name: '手动添加', exact: true }).click();
    await page.locator('#manual [name=name]').fill('Manual Node');
    await page.locator('#manual [name=host]').fill('127.0.0.1');
    await page.locator('#manual [name=port]').fill(String(plainPort));
    await page.getByRole('button', { name: '保存节点', exact: true }).click();
    await page.locator('.node').getByText('Manual Node', { exact: true }).waitFor();
    await page.locator('.group').filter({ has: page.getByRole('heading', { name: 'Manual Node' }) })
      .getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.locator('.node').getByText('Manual Node', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(context.pages().length, tabCount);
    assert.equal(page.url(), `${base}/popup.html`);
    await paste(page, `http://test-user:test-password@127.0.0.1:${authPort}#Auth-Test`);
    await enable(page, 'Auth-Test');
    const cdp = await context.newCDPSession(page);
    const { signal } = AbortSignal.timeout(7000);
    async function waitForWorkerStatus(status) {
      for await (const [{ versions }] of on(cdp, 'ServiceWorker.workerVersionUpdated', { signal })) {
        const worker = versions.find(version => version.scriptURL === `${base}/background.mjs`);
        if (worker?.runningStatus === status) return worker.versionId;
      }
    }
    const [versionId] = await Promise.all([waitForWorkerStatus('running'), cdp.send('ServiceWorker.enable')]);
    await Promise.all([waitForWorkerStatus('stopped'), cdp.send('ServiceWorker.stopWorker', { versionId })]);
    assert.equal(await body(await context.newPage(), 'auth'), 'Authenticated proxy fixture');
    await cdp.detach();
    assert.equal(authHits, 1);
    console.log('Passed: popup shortcut, URL focus, subscription import and refresh, and real HTTP 407 authentication after the service worker stops, with pre-granted host permissions.');
  } catch (error) {
    console.error(await authorized.page.locator('body').innerText());
    throw error;
  } finally { await authorized.context.close(); }
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all(saved.map(server => new Promise(done => server.close(done))));
  const cleanup = await realpath(permissionFixture);
  const child = relative(tempRoot, cleanup);
  if (!child.startsWith('direct-proxy-test-') || isAbsolute(child) || /[\\/]/u.test(child)) throw new Error('Unexpected test directory.');
  await rm(cleanup, { recursive: true });
}
