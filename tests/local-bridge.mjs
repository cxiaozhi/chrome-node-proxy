import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PROXY_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.PROXY_TEST_PLAYWRIGHT).href : 'playwright');
const extension = resolve(process.env.PROXY_TEST_EXTENSION ?? 'extension');
const files = resolve('bridge');
const useRegistration = process.argv.includes('--check-extension-id');
const measure = process.env.PROXY_TEST_MEASURE === '1';
const legacyWorker = process.env.PROXY_TEST_LEGACY_WORKER === '1';
function openBrowser() {
  return chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server'],
  });
}

async function extensionOrigin(context) {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
  return new URL(worker.url());
}

if (useRegistration) {
  const context = await openBrowser();
  try { console.log((await extensionOrigin(context)).hostname); }
  finally { await context.close(); }
  process.exit(0);
}
const root = await realpath(tmpdir());
const fixture = await mkdtemp(join(root, 'direct-proxy-protocol-test-'));
const sockets = new Set();
let context;
let fixtureProcess;
let origin;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function allocatePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(done => server.close(done));
  return port;
}

async function probe(port) {
  for (let tries = 0; tries < 60; tries++) {
    const connected = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return true;
    await new Promise(done => setTimeout(done, 50));
  }
  return false;
}

try {
  let received = 0;
  let latencyRequests = 0;
  origin = createHttp((req, res) => {
    if (req.url === '/latency-test') {
      latencyRequests++;
      setTimeout(() => res.writeHead(204).end(), 750);
      return;
    }
    if (req.url.startsWith('/protocol-')) received++;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('fixture response');
  });
  origin.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const httpPort = await listen(origin);
  if (measure) process.env.DIRECT_PROXY_TEST_URL = `http://127.0.0.1:${httpPort}/latency-test`;
  context = await openBrowser();
  const base = await extensionOrigin(context);
  const ssPort = await allocatePort();
  let vmPort;
  do { vmPort = await allocatePort(); } while (vmPort === ssPort);
  const uuid = '4a078407-69af-498e-b7c7-ca79391c924a';
  const cipher = 'aes-128-gcm';
  const password = 'fixture-only';
  const config = { mode: 'direct', 'allow-lan': false, 'log-level': 'info', listeners: [
    { name: 'local-ss-fixture', type: 'shadowsocks', listen: '127.0.0.1', port: ssPort, cipher, password },
    { name: 'local-vm-fixture', type: 'vmess', listen: '127.0.0.1', port: vmPort, users: [{ username: 'test', uuid, alterId: 0 }] }
  ] };
  await writeFile(join(fixture, 'test.json'), JSON.stringify(config));
  fixtureProcess = spawn(join(files, 'mihomo.exe'), ['-d', fixture, '-f', join(fixture, 'test.json')], { windowsHide: true });
  let diagnostics = '';
  fixtureProcess.stdout.on('data', data => { diagnostics += data; });
  fixtureProcess.stderr.on('data', data => { diagnostics += data; });
  assert.ok(await probe(ssPort) && await probe(vmPort), `SS=${ssPort} VMess=${vmPort}
${diagnostics}`);
  let page = await context.newPage();
  context.setDefaultTimeout(9000);
  await page.goto(`chrome-extension://${base.hostname}/popup.html`);
  await page.locator('[data-view=add]').click();
  await page.getByRole('button', { name: '文件 / 文本', exact: true }).click();
  await page.locator('#import textarea').fill(`proxies:\n  - {name: SS Fixture, type: ss, server: 127.0.0.1, port: ${ssPort}, cipher: ${cipher}, password: ${password}}\n  - {name: VMess Fixture, type: vmess, server: 127.0.0.1, port: ${vmPort}, uuid: ${uuid}, cipher: auto, alterId: 0}`);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByText('SS Fixture', { exact: true }).waitFor();
  const imported = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
  assert.equal(imported.value.groups[0].nodes.length, 2);
  assert.ok(imported.value.groups[0].nodes.every(node => !('proxy' in node)));
  const loaded = await context.newPage();
  let oldPort;
  for (const [index, name] of ['SS Fixture', 'VMess Fixture'].entries()) {
    await page.locator('.node').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: '启用', exact: true }).click();
    await page.locator('#active-node').getByText(name, { exact: true }).waitFor();
    const settings = await page.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
    const endpoint = settings.value.rules.singleProxy;
    assert.equal(endpoint.scheme, 'socks5');
    assert.equal(endpoint.host, '127.0.0.1');
    if (oldPort) assert.notEqual(endpoint.port, oldPort);
    oldPort = endpoint.port;
    await loaded.goto(`http://localhost:${httpPort}/protocol-${index}`, { timeout: 8000 });
    // Chrome normally bypasses localhost. Disable that bypass on the test profile only.
    await page.evaluate(async () => {
      const { value } = await chrome.proxy.settings.get({ incognito: false });
      await chrome.proxy.settings.set({ scope: 'regular_only', value: { ...value, rules: { ...value.rules, bypassList: ['<-loopback>'] } } });
    });
    await loaded.goto(`http://localhost:${httpPort}/protocol-${index}-tunneled`, { timeout: 8000 });
    assert.equal(await loaded.locator('body').innerText(), 'fixture response');
  }
  assert.equal(received, 4);
  if (measure) {
    const settings = () => page.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
    assert.equal(Boolean(imported.value.groupMeasurement), !legacyWorker);
    await page.getByRole('button', { name: '测速 SS Fixture', exact: true }).click();
    await page.locator('.delay[data-result=ready]').waitFor();
    await page.evaluate(async () => {
      const { proxyLibrary } = await chrome.storage.local.get('proxyLibrary');
      const [group] = proxyLibrary.groups;
      for (let index = 2; index < 46; index++) {
        group.nodes.push({ ...group.nodes[index % 2], id: `fixture-${index}`, name: `Fixture ${index}` });
      }
      await chrome.storage.local.set({ proxyLibrary });
    });
    await page.getByText('46 个节点', { exact: true }).waitFor();
    const disable = () => page.getByRole('button', { name: '停用', exact: true }).click();
    const enable = name => page.locator('.node').filter({ has: page.getByText(name, { exact: true }) })
      .getByRole('button', { name: '启用', exact: true }).click();
    const pending = () => page.locator('.delay[data-result=waiting]').count();
    await disable();
    await page.locator('#status').getByText('未启用', { exact: true }).waitFor();
    await page.getByRole('button', { name: '整组测速', exact: true }).click();
    await page.locator('.delay[data-result=waiting]').first().waitFor();
    await enable('SS Fixture');
    await page.locator('#active-node').getByText('SS Fixture', { exact: true }).waitFor({ timeout: 3500 });
    assert.ok(await pending() > 0, 'The node must be enabled before latency testing finishes.');
    const ss = await settings();
    assert.equal(ss.value.rules.singleProxy.scheme, 'socks5');
    await page.evaluate(async () => {
      const { value } = await chrome.proxy.settings.get({ incognito: false });
      await chrome.proxy.settings.set({ scope: 'regular_only', value: { ...value, rules: { ...value.rules, bypassList: ['<-loopback>'] } } });
    });
    await loaded.goto(`http://localhost:${httpPort}/protocol-during-test`, { timeout: 4000 });
    assert.equal(await loaded.locator('body').innerText(), 'fixture response');
    assert.equal(received, 5);
    await enable('VMess Fixture');
    await page.locator('#active-node').getByText('VMess Fixture', { exact: true }).waitFor({ timeout: 3500 });
    assert.notEqual((await settings()).value.rules.singleProxy.port, ss.value.rules.singleProxy.port);
    await disable();
    await page.locator('#status').getByText('未启用', { exact: true }).waitFor({ timeout: 3500 });
    assert.ok(await pending() > 0, 'The node must be stopped before latency testing finishes.');
    const before = await settings();
    if (!legacyWorker) {
      await page.close();
      page = await context.newPage();
      await page.goto(`chrome-extension://${base.hostname}/popup.html`);
    }
    await page.waitForFunction(() => document.querySelectorAll('.delay[data-result=ready]').length === 46, null, { timeout: 35000 });
    assert.ok(latencyRequests >= 47);
    assert.deepEqual(await settings(), before);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.delay[data-result=ready]').length === 46);
    if (process.env.PROXY_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PROXY_TEST_SCREENSHOT });
    console.log(`Passed: one node and a group of 46, ${legacyWorker ? 'legacy worker protocol' : 'background job survives panel close'}, starts, carries traffic, switches and stops the proxy while measuring.`);
  } else {
    await page.getByRole('button', { name: '停用', exact: true }).click();
    await page.locator('#status').getByText('未启用', { exact: true }).waitFor();
  }
  console.log('Passed: Chrome → native host → Mihomo → local Shadowsocks and VMess servers, then stop.');
} catch (error) {
  for (const page of (context?.pages() ?? []).filter(page => page.url().endsWith('/popup.html'))) {
    console.error(await page.locator('#feedback').textContent().catch(() => ''));
  }
  throw error;
} finally {
  await context?.close();
  if (fixtureProcess?.exitCode === null) { fixtureProcess.kill(); await once(fixtureProcess, 'exit'); }
  for (const socket of sockets) socket.destroy();
  if (origin) await new Promise(done => origin.close(done));
  const child = relative(root, await realpath(fixture));
  if (!child.startsWith('direct-proxy-protocol-test-') || isAbsolute(child) || /[\\/]/u.test(child)) throw new Error('Unexpected test directory.');
  await rm(fixture, { recursive: true });
}
