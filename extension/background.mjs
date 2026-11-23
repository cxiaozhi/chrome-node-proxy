import { measureLocalProxies, startLocalProxy } from './local-proxy.mjs';
import { canMeasure, makeNode, MAX_BYTES, measurementProxy, nodeKey, normalizeHost, parseImport, parseSubscriptionUsage, subscriptionPermission, subscriptionUrl } from './nodes.mjs';

const STORAGE_KEY = 'proxyLibrary';
const DELAY_KEY = 'nodeDelays';
const MAX_TESTS = 6;
const TEST_STATE_KEY = 'delayRun';
let testRun = null;
const ANY_SITE = ['http://*/*', 'https://*/*'];
const SCOPE = 'regular_only';
const OWN = 'controlled_by_this_extension';
const AVAILABLE = 'controllable_by_this_extension';
const emptyLibrary = { groups: [], activeId: null };
let mutations = Promise.resolve();
let localSession = null;
const authAttempts = new Map();

async function readLibrary() {
  return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? emptyLibrary;
}

function writeLibrary(library) {
  return chrome.storage.local.set({ [STORAGE_KEY]: library });
}

function allNodes(library) {
  return library.groups.flatMap(group => group.nodes);
}

function findNode(library, id) {
  return allNodes(library).find(node => node.id === id);
}

function matchServer(server, node) {
  if (server?.scheme !== node.scheme || server.port !== node.port) return false;
  try { return normalizeHost(server.host) === node.host; }
  catch { return false; }
}

function releaseLocalProxy() {
  const previous = localSession;
  localSession = null;
  previous?.close();
}

function configuredNode(library, settings) {
  if (settings.levelOfControl !== OWN || settings.value?.mode !== 'fixed_servers') return null;
  const node = findNode(library, library.activeId);
  const server = settings.value.rules?.singleProxy;
  const target = node?.proxy ? library.localProxy : node;
  return target && matchServer(server, target) ? node : null;
}

function activeNode(library, settings) {
  const node = configuredNode(library, settings);
  if (!node?.proxy) return node;
  return localSession?.alive && matchServer(localSession.server, library.localProxy) ? node : null;
}

function localProxyClosed(session) {
  if (session !== localSession) return;
  localSession = null;
  void updateBadge().catch(() => {});
}

async function state() {
  const [library, settings, delays] = await Promise.all([readLibrary(), chrome.proxy.settings.get({ incognito: false }),
    chrome.storage.session.get([DELAY_KEY, TEST_STATE_KEY])]);
  const current = activeNode(library, settings);
  return {
    activeId: current?.id ?? null,
    groupMeasurement: true,
    testRun: testRun ?? delays[TEST_STATE_KEY] ?? null,
    localStopped: !current && Boolean(configuredNode(library, settings)?.proxy),
    ownsSettings: settings.levelOfControl === OWN,
    canControl: [OWN, AVAILABLE].includes(settings.levelOfControl),
    groups: library.groups.map(group => ({
      id: group.id, name: group.name, kind: group.kind, updatedAt: group.updatedAt,
      permission: group.url ? subscriptionPermission(subscriptionUrl(group.url)) : null,
      retainedActive: group.retainedActive ?? false,
      usage: group.usage ?? null, usageChecked: Object.hasOwn(group, 'usage'),
      unsupported: group.unsupported, invalid: group.invalid, duplicates: group.duplicates, providers: group.providers,
      nodes: group.nodes.map(({ username, password, proxy, ...node }) => ({
        ...node, needsAuth: Boolean(username || password), canMeasure: canMeasure(node),
        measurement: delays[DELAY_KEY]?.[node.id] ?? null
      }))
    }))
  };
}

async function connect(id) {
  const library = await readLibrary();
  const node = findNode(library, id);
  if (!node) throw new Error('找不到这个节点。');
  if ((node.username || node.password) && !await chrome.permissions.contains({ origins: ANY_SITE })) {
    throw new Error('需要接收网站的代理认证请求。请重新连接并授权。');
  }
  const settings = await chrome.proxy.settings.get({ incognito: false });
  if (![OWN, AVAILABLE].includes(settings.levelOfControl)) throw new Error('代理设置由其他扩展或浏览器策略控制。');
  const candidate = node.proxy ? await startLocalProxy(node.proxy, localProxyClosed) : null;
  const { scheme, host, port } = candidate?.server ?? node;
  const next = { ...library, activeId: id, localProxy: candidate?.server ?? null };
  let changedSettings = false;
  try {
    await writeLibrary(next);
    await chrome.proxy.settings.set({ scope: SCOPE, value: {
      mode: 'fixed_servers', rules: { singleProxy: { scheme, host, port } }
    } });
    changedSettings = true;
    const effective = await chrome.proxy.settings.get({ incognito: false });
    if (!configuredNode(next, effective) || candidate?.alive === false) throw new Error('Chrome 无法应用此节点。');
  } catch (error) {
    candidate?.close();
    if (changedSettings) {
      if (settings.levelOfControl === OWN) await chrome.proxy.settings.set({ scope: SCOPE, value: settings.value });
      else await chrome.proxy.settings.clear({ scope: SCOPE });
    }
    await writeLibrary(library);
    throw error;
  }
  releaseLocalProxy();
  localSession = candidate;
  void updateBadge().catch(() => {});
}

async function restoreLocalProxy() {
  if (localSession?.alive) return;
  const [library, settings] = await Promise.all([readLibrary(), chrome.proxy.settings.get({ incognito: false })]);
  const node = configuredNode(library, settings);
  if (node?.proxy) await connect(node.id);
}

async function disconnect() {
  const library = await readLibrary();
  await chrome.proxy.settings.clear({ scope: SCOPE });
  releaseLocalProxy();
  await writeLibrary({ ...library, activeId: null, localProxy: null });
}

async function saveGroup({ result, kind, name, url, replaceId }) {
  const library = await readLibrary();
  const old = replaceId ? library.groups.find(group => group.id === replaceId) :
    url ? library.groups.find(group => group.url === url) : null;
  if (replaceId && !old) throw new Error('这个订阅已删除。');
  const oldNodes = new Map(old?.nodes.map(node => [nodeKey(node), node.id]));
  const nodes = result.nodes.map(node => ({ ...node, id: oldNodes.get(nodeKey(node)) ?? crypto.randomUUID() }));
  const previousActive = old?.nodes.find(node => node.id === library.activeId);
  const retainedActive = Boolean(previousActive && !nodes.some(node => node.id === previousActive.id));
  if (retainedActive) nodes.push(previousActive);
  const group = { ...result, nodes, kind, id: old?.id ?? crypto.randomUUID(), name: old?.name ?? name,
    ...(url ? { url } : {}), retainedActive, updatedAt: Date.now() };
  const groups = old ? library.groups.map(item => item.id === old.id ? group : item) : [group, ...library.groups];
  await writeLibrary({ ...library, groups });
  return { groupId: group.id, imported: result.nodes.length, unsupported: result.unsupported.length, invalid: result.invalid,
    duplicates: result.duplicates, retainedActive, providers: result.providers };
}

async function removeGroup(id) {
  const library = await readLibrary();
  const group = library.groups.find(item => item.id === id);
  if (!group) return;
  const settings = await chrome.proxy.settings.get({ incognito: false });
  if (group.nodes.some(node => node.id === activeNode(library, settings)?.id)) throw new Error('请先停用此组正在使用的节点。');
  const clearActive = group.nodes.some(node => node.id === library.activeId);
  if (clearActive) {
    await chrome.proxy.settings.clear({ scope: SCOPE });
    releaseLocalProxy();
  }
  await writeLibrary({ ...library, groups: library.groups.filter(item => item.id !== id),
    activeId: clearActive ? null : library.activeId, localProxy: clearActive ? null : library.localProxy ?? null });
}

async function download(url) {
  if (!await chrome.permissions.contains({ origins: [subscriptionPermission(url)] })) throw new Error('需要此订阅域名的访问权限。');
  let response;
  try {
    response = await fetch(url.href, { redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(18000) });
  } catch { throw new Error('订阅下载失败。请检查网络，或使用最终订阅地址后重试。'); }
  if (!response.ok) throw new Error(`订阅服务器返回 HTTP ${response.status}。`);
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('订阅为空或超过 2 MB。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error('订阅超过 2 MB。');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  return { ...parseImport(text + decoder.decode()), usage: parseSubscriptionUsage(response.headers.get('subscription-userinfo')) };
}

function mutate(action) {
  const pending = mutations.then(action);
  mutations = pending.catch(() => {});
  return pending;
}

async function measureBatch(nodes) {
  try { return await measureLocalProxies(nodes.map(measurementProxy)); }
  catch (error) {
    if (error.code !== 'test' || nodes.length === 1) throw error;
    return Promise.all(nodes.map(async node => {
      try { return (await measureLocalProxies([measurementProxy(node)]))[0]; }
      catch (nodeError) {
        if (nodeError.code === 'helper') throw nodeError;
        return null;
      }
    }));
  }
}

async function runMeasurements(nodes, run) {
  let error = null;
  try {
    await chrome.storage.session.remove(TEST_STATE_KEY);
    for (let offset = 0; offset < nodes.length; offset += MAX_TESTS) {
      const batch = nodes.slice(offset, offset + MAX_TESTS);
      const values = await measureBatch(batch);
      const at = Date.now();
      const results = Object.fromEntries(batch.map((node, index) => [node.id, { ms: values[index], at }]));
      const { [DELAY_KEY]: previous = {} } = await chrome.storage.session.get(DELAY_KEY);
      const liveIds = new Set(allNodes(await readLibrary()).map(node => node.id));
      const retained = Object.fromEntries(Object.entries({ ...previous, ...results }).filter(([id]) => liveIds.has(id)));
      run.done += batch.length;
      await chrome.storage.session.set({ [DELAY_KEY]: retained, [TEST_STATE_KEY]: { done: run.done } });
    }
  } catch (cause) { error = cause.message; }
  finally {
    testRun = null;
    await chrome.storage.session.set({ [TEST_STATE_KEY]: { error, done: run.done, finished: true } });
  }
}

async function measureNodes({ groupId, id, ids }) {
  const library = await readLibrary();
  const requestedIds = new Set(id ? [id] : Array.isArray(ids) ? ids : []);
  const candidates = groupId ? library.groups.find(group => group.id === groupId)?.nodes ?? [] :
    allNodes(library).filter(node => requestedIds.has(node.id));
  const nodes = candidates.filter(node => node && canMeasure(node));
  if (!nodes.length) throw new Error('没有可测速的节点。');
  if (testRun) throw new Error('已有测速正在进行。');
  const run = { ids: nodes.map(node => node.id), groupId: groupId ?? null, done: 0, total: nodes.length };
  testRun = run;
  const job = runMeasurements(nodes, run);
  if (groupId || id) void job.catch(() => {});
  else await job;
}

async function handle(message) {
  switch (message.type) {
    case 'state': await mutations; return state();
    case 'measure': return measureNodes(message);
    case 'connect': return mutate(() => connect(message.id));
    case 'disconnect': return mutate(disconnect);
    case 'remove': return mutate(() => removeGroup(message.id));
    case 'manual': {
      const node = makeNode(message.node);
      return mutate(() => saveGroup({ kind: 'manual', name: node.name,
        result: { nodes: [node], unsupported: [], invalid: 0, duplicates: 0, providers: 0 } }));
    }
    case 'import': {
      const result = parseImport(message.text);
      const name = String(message.name ?? '').trim().slice(0, 120) || '粘贴导入';
      return mutate(() => saveGroup({ result, kind: 'import', name }));
    }
    case 'subscribe':
    case 'refresh': {
      const previous = message.type === 'refresh' ? (await readLibrary()).groups.find(group => group.id === message.id) : null;
      if (message.type === 'refresh' && !previous?.url) throw new Error('找不到这个订阅。');
      const url = subscriptionUrl(previous?.url ?? message.url);
      const result = await download(url);
      const name = String(message.name ?? '').trim().slice(0, 120) || url.hostname;
      return mutate(() => saveGroup({ result, kind: 'subscription', name, url: url.href, replaceId: previous?.id }));
    }
    default: throw new Error('未知操作。');
  }
}

async function getAuth(details) {
  if (!details.isProxy || !details.challenger ||
      !await chrome.permissions.contains({ origins: ANY_SITE })) return {};
  const [library, settings] = await Promise.all([readLibrary(), chrome.proxy.settings.get({ incognito: false })]);
  const node = activeNode(library, settings);
  if (!node || node.proxy || !(node.username || node.password) ||
      details.challenger.port !== node.port || normalizeHost(details.challenger.host) !== node.host) return {};
  const now = Date.now();
  for (const [id, expires] of authAttempts) if (expires <= now) authAttempts.delete(id);
  if (authAttempts.has(details.requestId)) return { cancel: true };
  authAttempts.set(details.requestId, now + 60000);
  return { authCredentials: { username: node.username, password: node.password } };
}

// Keep registration synchronous so an auth challenge can wake a stopped service worker.
// The manifest's reserved .invalid host lets Chrome register before optional access is granted.
chrome.webRequest.onAuthRequired.addListener((details, respond) => {
  getAuth(details).then(respond, () => respond({}));
}, { urls: ANY_SITE }, ['asyncBlocking']);

async function updateBadge() {
  const { activeId } = await state();
  await Promise.all([chrome.action.setBadgeText({ text: activeId ? 'ON' : '' }),
    chrome.action.setBadgeBackgroundColor({ color: '#0e7359' })]);
}

chrome.proxy.settings.onChange.addListener(() => void updateBadge().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) void updateBadge().catch(() => {});
});
function resumeProxy() {
  void mutate(restoreLocalProxy).catch(() => {}).finally(() => updateBadge().catch(() => {}));
}

chrome.runtime.onStartup.addListener(resumeProxy);
resumeProxy();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u, 1)[0] !== chrome.runtime.getURL('popup.html') || !message || typeof message !== 'object') return false;
  handle(message).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
  return true;
});
