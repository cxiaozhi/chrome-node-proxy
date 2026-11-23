import { displayHost, MAX_BYTES, subscriptionPermission, subscriptionUrl } from './nodes.mjs';

const protocolName = scheme => ({ ss: 'Shadowsocks', vmess: 'VMess' })[scheme] ?? scheme.toUpperCase();
const byId = id => document.getElementById(id);
let current = null;
let busy = false;
let view = 'nodes';
let deleting = null;
let pendingIds = new Set();
let legacyMeasurement = null;
const LEGACY_BATCH_SIZE = 6;
const dateFormat = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short' });

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || '扩展暂时没有响应，请重试。');
  return response.value;
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}

function button(text, className, click, disabled = false) {
  const item = element('button', className, text);
  item.type = 'button';
  item.disabled = disabled;
  item.addEventListener('click', click);
  return item;
}

function feedback(message, error = false) {
  const target = byId('feedback');
  target.hidden = !message;
  target.textContent = message;
  target.dataset.error = String(error);
}

function summary(result) {
  const parts = [`${result.imported} 个可用`];
  if (result.unsupported) parts.push(`${result.unsupported} 个不支持`);
  if (result.invalid) parts.push(`${result.invalid} 个无效`);
  if (result.duplicates) parts.push(`${result.duplicates} 个重复`);
  return parts.join(' · ');
}

async function run(action, operation = null) {
  if (busy) return;
  busy = true;
  if (operation) feedback(operation);
  try {
    const value = await action();
    feedback(typeof value === 'string' ? value : value ? summary(value) : '');
  } catch (error) { feedback(error.message, true); }
  finally {
    busy = false;
    await reload();
  }
}

async function allow(origins) {
  if (!await chrome.permissions.request({ origins })) throw new Error('请允许 Chrome 访问所需网站。');
}

function connect(node) {
  void run(async () => {
    if (node.needsAuth) await allow(['http://*/*', 'https://*/*']);
    await send('connect', { id: node.id });
  });
}

function renderStatus(nodes) {
  const status = byId('status');
  const active = nodes.find(node => node.id === current.activeId);
  const idle = current.localStopped ? '组件已停' : current.ownsSettings ? '待停用' : current.canControl ? '未启用' : '被占用';
  status.dataset.state = active ? 'active' : current.canControl && !current.ownsSettings ? 'idle' : 'blocked';
  status.textContent = active ? '已启用' : idle;
  const activeLabel = byId('active-node');
  activeLabel.hidden = !active;
  activeLabel.textContent = activeLabel.title = active?.name ?? '';
  byId('disconnect').hidden = !current.ownsSettings;
}

function measurementRun() {
  return legacyMeasurement ?? current.testRun;
}

function measure(selection) {
  if (measurementRun()?.ids) return;
  if (current.groupMeasurement) {
    void run(() => send('measure', selection));
    return;
  }
  // An unpacked extension can load new popup files while its previous worker is still registered.
  const nodes = selection.groupId ? current.groups.find(group => group.id === selection.groupId)?.nodes ?? [] :
    current.groups.flatMap(group => group.nodes).filter(node => node.id === selection.id);
  const ids = nodes.filter(node => node.canMeasure).map(node => node.id);
  if (!ids.length) return;
  void run(async () => {
    legacyMeasurement = { ids, groupId: selection.groupId, done: 0, total: ids.length };
    render();
    try {
      for (let offset = 0; offset < ids.length; offset += LEGACY_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + LEGACY_BATCH_SIZE);
        await send('measure', { ids: batch });
        legacyMeasurement.done += batch.length;
        await reload();
      }
    } finally { legacyMeasurement = null; }
  }, '正在测速…');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${bytes.toLocaleString('zh-CN', { maximumFractionDigits: index ? 2 : 0 })} ${units[index]}`;
}

function renderUsage(group) {
  if (group.usage?.total == null && group.usage?.expiresAt == null) {
    return element('p', 'meta usage', group.usageChecked ? '服务商未提供流量或到期信息' : '更新订阅以查看流量和到期时间');
  }
  const row = element('div', 'usage');
  const { remaining, total, expiresAt } = group.usage;
  if (remaining != null) row.append(element('span', 'usage-traffic', `剩余 ${formatBytes(remaining)} / ${formatBytes(total)}`));
  else if (total > 0) row.append(element('span', 'usage-traffic', `总量 ${formatBytes(total)}`));
  else if (total === 0) row.append(element('span', 'usage-traffic', '不限量'));
  if (expiresAt != null) row.append(element('span', '', `到期 ${dateFormat.format(expiresAt)}`));
  return row;
}

function renderDelay(node) {
  const pending = pendingIds.has(node.id);
  const measurement = node.measurement;
  const failed = measurement && measurement.ms == null;
  const label = pending ? '…' : !measurement ? '—' : failed ? '失败' : `${measurement.ms} ms`;
  const delay = element('span', 'delay', label);
  delay.dataset.result = pending ? 'waiting' : !measurement ? 'idle' : failed ? 'failed' : 'ready';
  delay.title = pending ? '正在测速' : !measurement ? '尚未测速' : failed ? '未能通过此节点访问测速地址' : '通过此节点访问测速地址的延迟';
  return delay;
}

function renderNode(node) {
  const isActive = current.activeId === node.id;
  const row = element('div', 'node');
  row.dataset.active = String(isActive);
  const info = element('div', 'node-info');
  const title = element('div', 'node-name', node.name);
  title.title = node.name;
  const protocol = protocolName(node.scheme);
  const endpoint = element('div', 'endpoint', node.needsAuth ? `${protocol} · 认证` : protocol);
  endpoint.title = `${displayHost(node.host)}:${node.port}`;
  info.append(title, endpoint);
  const actions = element('div', 'node-actions');
  if (node.canMeasure) {
    actions.append(renderDelay(node));
    const test = button('测速', 'secondary', () => measure({ id: node.id }), Boolean(measurementRun()?.ids));
    test.setAttribute('aria-label', `测速 ${node.name}`);
    actions.append(test);
  }
  actions.append(isActive ? element('span', 'active-label', '使用中') :
    button('启用', 'secondary', () => connect(node), !current.canControl));
  row.append(info, actions);
  return row;
}

function renderGroup(group, { nodes = [], unsupported = [], subscription = false } = {}) {
  const article = element('article', 'group');
  const header = element('div', 'group-header');
  const info = element('div', 'group-info');
  const name = element('h3', '', group.name);
  name.title = group.name;
  info.append(name, element('p', 'meta', `${group.nodes.length} 个可用`));
  const actions = element('div', 'group-actions');
  const testRun = measurementRun();
  if (!subscription && group.nodes.some(node => node.canMeasure)) {
    const testingGroup = testRun?.groupId === group.id;
    const label = testingGroup ? `${testRun.done}/${testRun.total}` : '整组测速';
    actions.append(button(label, 'secondary', () => measure({ groupId: group.id }), Boolean(testRun?.ids)));
  }
  if (subscription) actions.append(button('更新', 'secondary', () => void run(async () => {
    await allow([group.permission]);
    return send('refresh', { id: group.id });
  }, '正在更新…')));
  if (subscription || group.kind !== 'subscription') {
    const containsActive = group.nodes.some(node => node.id === current.activeId);
    const remove = button('删除', 'secondary', () => { deleting = group.id; render(); }, containsActive);
    if (containsActive) remove.title = '先停用此组节点';
    actions.append(remove);
  }
  header.append(info, actions);
  article.append(header);
  if (subscription) article.append(renderUsage(group));
  if (deleting === group.id) {
    const confirmation = element('div', 'remove-confirm');
    confirmation.append(element('span', '', '删除这组节点？'),
      button('取消', 'secondary', () => { deleting = null; render(); }),
      button('确认删除', 'danger', () => void run(async () => {
        await send('remove', { id: group.id });
        deleting = null;
        return '已删除。';
      })));
    article.append(confirmation);
  }
  article.append(...nodes.map(renderNode));
  if (unsupported.length || group.invalid || group.providers || group.retainedActive) {
    const details = element('details', 'details');
    const notes = [];
    if (unsupported.length) notes.push(`${unsupported.length} 个节点不支持`);
    if (group.invalid) notes.push(`${group.invalid} 个无效`);
    if (group.providers) notes.push(`${group.providers} 个外部 provider`);
    if (group.retainedActive) notes.push('保留上次使用的节点');
    details.append(element('summary', '', notes.join(' · ')));

    if (unsupported.length) {
      const list = element('ul');
      for (const item of unsupported) list.append(element('li', '', `${item.name ? `${item.name} · ` : ''}${item.type} · ${item.reason}`));
      details.append(list);
    }
    if (group.providers) details.append(element('p', '', '请分别导入外部 provider 的订阅地址或节点文件。'));
    article.append(details);
  }
  return article;
}

function render() {
  if (!current) return;
  const nodes = current.groups.flatMap(group => group.nodes);
  const testRun = measurementRun();
  pendingIds = new Set(testRun?.ids?.slice(testRun.done) ?? []);
  renderStatus(nodes);
  if (view === 'subscriptions') {
    const subscriptions = current.groups.filter(group => group.kind === 'subscription');
    byId('subscriptions').replaceChildren(...(subscriptions.length ? subscriptions.map(group =>
      renderGroup(group, { subscription: true, unsupported: group.unsupported })) : [element('p', 'empty', '暂无订阅')]));
  }
  if (view !== 'nodes') return;
  const search = byId('search').value.trim().toLowerCase();
  const match = values => values.some(value => value.toLowerCase().includes(search));
  const articles = current.groups.flatMap(group => {
    const all = !search || match([group.name]);
    const filtered = all ? group.nodes : group.nodes.filter(node => match([node.name, node.scheme, node.host]));
    const unsupported = all ? group.unsupported : group.unsupported.filter(node => match([node.name, node.type]));
    return all || filtered.length || unsupported.length ? [renderGroup(group, { nodes: filtered, unsupported })] : [];
  });
  byId('node-toolbar').hidden = !current.groups.length;
  byId('node-count').textContent = `${nodes.length} 个节点`;
  byId('groups').replaceChildren(...articles);
  if (search && !articles.length) byId('groups').append(element('p', 'empty', '无匹配节点'));
  byId('empty-nodes').hidden = Boolean(current.groups.length);
  byId('test-error').textContent = testRun?.error ?? '';
  byId('test-error').hidden = !testRun?.error;
}

let loadRevision = 0;
async function reload() {
  const revision = ++loadRevision;
  try {
    const state = await send('state');
    if (revision !== loadRevision) return;
    current = state;
    render();
  } catch (error) { if (revision === loadRevision) feedback(error.message, true); }
}

const views = document.querySelectorAll('[data-view]');
function showView(name) {
  if (name !== view) deleting = null;
  view = name;
  for (const tab of views) {
    const active = tab.dataset.view === name;
    tab.setAttribute('aria-pressed', String(active));
    byId(`${tab.dataset.view}-view`).hidden = !active;
  }
  byId('panel-content').scrollTop = 0;
  render();
}
for (const tab of views) tab.addEventListener('click', () => { feedback(''); showView(tab.dataset.view); });

const forms = document.querySelectorAll('[data-form]');
function showForm(name) {
  for (const tab of forms) {
    const selected = tab.dataset.form === name;
    tab.setAttribute('aria-pressed', String(selected));
    byId(tab.dataset.form).hidden = !selected;
  }
}
for (const tab of forms) tab.addEventListener('click', () => showForm(tab.dataset.form));

function openSubscription() {
  feedback('');
  showView('add');
  showForm('subscription');
  byId('subscription').elements.url.focus();
}
byId('open-subscription').addEventListener('click', openSubscription);
byId('add-subscription').addEventListener('click', openSubscription);
byId('disconnect').addEventListener('click', () => void run(() => send('disconnect')));
byId('search').addEventListener('input', render);

const subscription = byId('subscription');
subscription.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const data = new FormData(subscription);
    const url = subscriptionUrl(data.get('url'));
    await allow([subscriptionPermission(url)]);
    const result = await send('subscribe', { url: url.href, name: data.get('name') });
    subscription.reset();
    subscription.querySelector('details').open = false;
    showView('nodes');
    return result;
  }, '正在导入…');
});
const importer = byId('import');
importer.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const { file, text } = importer.elements;
    const selected = file.files[0];
    if (selected?.size > MAX_BYTES) throw new Error('配置文件超过 2 MB。');
    const result = await send('import', { text: selected ? await selected.text() : text.value, name: selected?.name });
    importer.reset();
    showView('nodes');
    return result;
  }, '正在导入…');
});
const manual = byId('manual');
const updateScheme = () => {
  const { scheme, port, username, password } = manual.elements;
  const socks = scheme.value.startsWith('socks');
  byId('credentials').hidden = socks;
  username.disabled = password.disabled = socks;
  port.value = { http: 80, https: 443, socks4: 1080, socks5: 1080 }[scheme.value];
};
manual.elements.scheme.addEventListener('change', updateScheme);
manual.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const result = await send('manual', { node: Object.fromEntries(new FormData(manual)) });
    manual.reset();
    updateScheme();
    showView('nodes');
    return result;
  });
});
chrome.storage.onChanged.addListener(() => { if (!busy) void reload(); });
chrome.proxy.settings.onChange.addListener(() => { if (!busy) void reload(); });
void reload();
