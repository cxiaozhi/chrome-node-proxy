import { load, JSON_SCHEMA } from './vendor/js-yaml.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 3500;
const DEFAULT_PORTS = new Map([['http', 80], ['https', 443], ['socks4', 1080], ['socks5', 1080]]);
const LABELS = new Map([['ss', 'Shadowsocks'], ['ssr', 'ShadowsocksR'], ['vmess', 'VMess'],
  ['vless', 'VLESS'], ['trojan', 'Trojan'], ['hy2', 'Hysteria2'], ['hysteria2', 'Hysteria2'],
  ['hysteria', 'Hysteria'], ['tuic', 'TUIC'], ['wireguard', 'WireGuard'], ['anytls', 'AnyTLS']]);

export function displayHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

export function normalizeHost(value) {
  const text = String(value ?? '').trim();
  if (!text || /[\s/@?#\\%]/u.test(text)) throw new Error('代理主机格式无效。');
  const address = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
  if (address.startsWith('[') && !address.endsWith(']')) throw new Error('代理主机格式无效。');
  let host;
  try { host = new URL(`http://${address}/`).hostname; }
  catch { throw new Error('代理主机格式无效。'); }
  return host.replace(/^\[|\]$/g, '');
}

export function makeNode({ name, scheme, host, port, username, password, reason }) {
  scheme = String(scheme ?? '').trim().toLowerCase();
  if (scheme === 'socks') scheme = 'socks5';
  if (!DEFAULT_PORTS.has(scheme)) throw new Error('Chrome 无法直连此代理协议。');
  if (reason) throw new Error(reason);
  host = normalizeHost(host);
  const portText = String(port ?? DEFAULT_PORTS.get(scheme));
  port = Number(portText);
  if (!/^\d{1,5}$/u.test(portText) || port < 1 || port > 65535) throw new Error('端口须为 1–65535。');
  if (![username, password].every(value => value == null || ['string', 'number'].includes(typeof value))) {
    throw new Error('代理认证字段必须为文本。');
  }
  username = String(username ?? '');
  password = String(password ?? '');
  if ((username || password) && scheme.startsWith('socks')) throw new Error('Chrome 的 SOCKS 代理不支持账号密码。');
  if (username.length > 1024 || password.length > 1024) throw new Error('代理认证字段过长。');
  name = String(name ?? '').trim().slice(0, 120) || `${displayHost(host)}:${port}`;
  return { name, scheme, host, port, username, password };
}

const CORE_FIELDS = {
  ss: ['cipher', 'password', 'udp', 'uot', 'uot-version', 'plugin', 'plugin-opts'],
  vmess: ['uuid', 'alterId', 'cipher', 'udp', 'network', 'tls', 'servername', 'skip-cert-verify',
    'alpn', 'client-fingerprint', 'ws-opts', 'grpc-opts', 'http-opts', 'h2-opts', 'global-padding',
    'authenticated-length', 'packet-encoding']
};
const CORE_OPTIONS = {
  'plugin-opts': ['mode', 'host', 'port', 'path', 'tls', 'skip-cert-verify', 'mux', 'headers'],
  'ws-opts': ['path', 'headers', 'max-early-data', 'early-data-header-name', 'v2ray-http-upgrade', 'v2ray-http-upgrade-fast-open'],
  'grpc-opts': ['grpc-service-name', 'grpc-mode'],
  'http-opts': ['method', 'path', 'headers'],
  'h2-opts': ['host', 'path']
};

function coreValue(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string')) return [...value];
  throw new Error('节点字段格式无效');
}

function coreOptions(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('节点传输配置无效');
  if (keys.some(key => key === 'headers') && value.headers &&
      (typeof value.headers !== 'object' || Array.isArray(value.headers))) throw new Error('节点请求头格式无效');
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, key === 'headers'
    ? Object.fromEntries(Object.entries(value.headers ?? {}).map(([name, item]) => [name, coreValue(item)]))
    : coreValue(value[key])]));
}

function coreNode(entry, scheme) {
  const host = normalizeHost(entry.server);
  const port = Number(entry.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('节点端口无效');
  if (entry['dialer-proxy']) throw new Error('该节点依赖其他代理');
  if (scheme === 'ss' && entry.plugin && !['obfs', 'v2ray-plugin'].includes(entry.plugin)) {
    throw new Error('此 Shadowsocks 插件暂不支持');
  }
  if (scheme === 'vmess' && !['tcp', 'ws', 'grpc', 'http', 'h2'].includes(entry.network ?? 'tcp')) {
    throw new Error('此 VMess 传输方式暂不支持');
  }
  const proxy = { type: scheme, server: host, port };
  for (const key of CORE_FIELDS[scheme]) {
    if (entry[key] == null) continue;
    proxy[key] = Object.hasOwn(CORE_OPTIONS, key) ? coreOptions(entry[key], CORE_OPTIONS[key]) : coreValue(entry[key]);
  }
  if (scheme === 'ss' && (typeof proxy.cipher !== 'string' || typeof proxy.password !== 'string')) {
    throw new Error('缺少 Shadowsocks 加密方式或密码');
  }
  if (scheme === 'vmess') {
    if (typeof proxy.uuid !== 'string' || !proxy.uuid) throw new Error('缺少 VMess UUID');
    proxy.cipher ??= 'auto';
    proxy.alterId = Number(proxy.alterId ?? 0);
    if (!Number.isInteger(proxy.alterId) || proxy.alterId < 0) throw new Error('VMess alterId 无效');
  }
  if (new TextEncoder().encode(JSON.stringify(proxy)).length > 24000) throw new Error('节点配置过长');
  const name = String(entry.name ?? '').trim().slice(0, 120) || `${displayHost(host)}:${port}`;
  return { name, scheme, host, port, proxy };
}

function decodeBase64(value) {
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(decoded, char => char.charCodeAt(0)));
}

function coreLink(line, scheme) {
  const body = line.slice(scheme.length + 3);
  if (scheme === 'vmess') {
    const data = JSON.parse(decodeBase64(body.split('#')[0]));
    const network = data.net || 'tcp';
    if (network === 'tcp' && data.type && data.type !== 'none') throw new Error('VMess TCP 伪装暂不支持');
    return coreNode({ name: data.ps, server: data.add, port: data.port, uuid: data.id, alterId: data.aid,
      cipher: data.scy || 'auto', network, tls: data.tls === 'tls', servername: data.sni || undefined,
      'ws-opts': network === 'ws' ? { path: data.path || '/', headers: data.host ? { Host: data.host } : {} } : undefined,
      'grpc-opts': network === 'grpc' ? { 'grpc-service-name': data.path || '' } : undefined,
      'h2-opts': network === 'h2' ? { host: data.host ? data.host.split(',') : [], path: data.path || '/' } : undefined,
      'http-opts': network === 'http' ? { path: [data.path || '/'], headers: data.host ? { Host: data.host.split(',') } : {} } : undefined
    }, scheme);
  }
  const [beforeFragment, label] = body.split('#', 2);
  const [address, query] = beforeFragment.split('?', 2);
  const endpoint = address.includes('@') ? address : decodeBase64(address);
  const separator = endpoint.lastIndexOf('@');
  if (separator < 0) throw new Error('Shadowsocks 节点地址无效');
  const auth = decodeURIComponent(endpoint.slice(0, separator));
  const credentials = auth.includes(':') ? auth : decodeBase64(auth);
  const delimiter = credentials.indexOf(':');
  if (delimiter <= 0) throw new Error('Shadowsocks 认证信息无效');
  const target = endpoint.slice(separator + 1).match(/^(\[[^\]]+\]|[^:/]+):(\d+)\/?$/u);
  if (!target) throw new Error('Shadowsocks 节点地址无效');
  if (new URLSearchParams(query).has('plugin')) throw new Error('带插件的 Shadowsocks 请用 Clash YAML 导入');
  return coreNode({ name: decodedName(label ?? ''), server: target[1], port: target[2],
    cipher: credentials.slice(0, delimiter), password: credentials.slice(delimiter + 1) }, scheme);
}

export function nodeKey(node) {
  if (node.proxy) return JSON.stringify(node.proxy, (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
  return JSON.stringify([node.scheme, node.host, node.port, node.username, node.password]);
}

function decodedName(fragment) {
  try { return decodeURIComponent(fragment).trim().slice(0, 120); }
  catch { return ''; }
}

function fromLink(line) {
  const match = line.match(/^([\w+-]+):\/\//u);
  if (!match) throw new Error('缺少代理协议。');
  const scheme = match[1].toLowerCase();
  if (Object.hasOwn(CORE_FIELDS, scheme)) {
    try { return coreLink(line, scheme); }
    catch (error) { return { unsupported: true, type: LABELS.get(scheme), name: decodedName(line.split('#')[1] ?? ''),
      reason: /^Shadowsocks|^VMess|^带插件/u.test(error.message) ? error.message : '节点链接格式无效' }; }
  }
  if (!DEFAULT_PORTS.has(scheme) && scheme !== 'socks') {
    return { unsupported: true, type: LABELS.get(scheme) ?? scheme.toUpperCase().slice(0, 40), name: decodedName(line.split('#').at(1) ?? ''), reason: 'Chrome 无法直连此协议' };
  }
  const effectiveScheme = scheme === 'socks' ? 'socks5' : scheme;
  // Use the HTTP URL parser for hostname normalization, then read the original port.
  const body = line.slice(match[0].length);
  const authority = body.split(/[/?#]/u)[0].split('@').at(-1);
  if (!/^(?:\[[^\]]+\]|[^:\s]+)(?::\d+)?$/u.test(authority)) throw new Error('代理地址格式无效。');
  const port = authority.match(/:(\d+)$/u)?.[1] ?? DEFAULT_PORTS.get(effectiveScheme);
  const url = new URL(`http://${body}`);
  if (!['', '/'].includes(url.pathname) || url.search || body.includes('\\')) {
    throw new Error('代理链接只能包含服务器、认证信息和节点名称。');
  }
  return makeNode({ name: decodedName(url.hash.slice(1)), scheme: effectiveScheme, host: url.hostname, port,
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
}

function fromClash(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('无效的节点条目。');
  let scheme = String(entry.type ?? '').trim().toLowerCase();
  if (scheme === 'http' && entry.tls === true) scheme = 'https';
  const name = typeof entry.name === 'string' ? entry.name.slice(0, 120) : '';
  const type = LABELS.get(scheme) ?? (scheme.toUpperCase().slice(0, 40) || '未知协议');
  if (Object.hasOwn(CORE_FIELDS, scheme)) {
    try { return coreNode(entry, scheme); }
    catch (error) { return { unsupported: true, type, name, reason: error.message }; }
  }
  if (!DEFAULT_PORTS.has(scheme) && scheme !== 'socks') {
    return { unsupported: true, type, name, reason: 'Chrome 无法直连此协议' };
  }
  let reason;
  if (scheme.startsWith('socks') && entry.tls) reason = 'Chrome 不支持套用 TLS 的 SOCKS 代理。';
  if (entry['skip-cert-verify'] === true || entry.sni || entry.servername || entry.headers || entry['dialer-proxy'] ||
      (entry['ip-version'] && entry['ip-version'] !== 'dual')) {
    reason = '此节点需要 Chrome 无法应用的 TLS、转发或连接选项。';
  }
  try {
    return makeNode({ name, scheme, host: entry.server, port: entry.port,
      username: entry.username, password: entry.password, reason });
  } catch (error) {
    return { unsupported: true, type, name, reason: error.message };
  }
}

function decodeSubscription(text) {
  const flat = text.replace(/\s+/gu, '');
  if (flat.length < 12 || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(flat)) return null;
  try {
    const bytes = Uint8Array.from(atob(flat.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded.split(/\r?\n/u).some(line => /^\s*[\w+-]+:\/\//u.test(line)) ? decoded : null;
  } catch { return null; }
}

export function parseImport(input) {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > MAX_BYTES) throw new Error('单次导入最多 2 MB。');
  const text = input.replace(/^\uFEFF/u, '').trim();
  if (!text) throw new Error('请输入节点链接，或选择一个配置文件。');
  const decoded = decodeSubscription(text) ?? text;
  const lines = decoded.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const asLinks = lines.some(line => /^[\w+-]+:\/\//u.test(line));
  let rows = lines;
  let providers = 0;
  if (!asLinks) {
    let yaml;
    try { yaml = load(text, { schema: JSON_SCHEMA, maxDepth: 40 }); }
    catch { throw new Error('YAML 格式无效。'); }
    rows = Array.isArray(yaml) ? yaml : yaml?.proxies;
    providers = Object.keys(yaml?.['proxy-providers'] ?? {}).length;
    if (!Array.isArray(rows)) {
      if (providers) throw new Error('此配置只有 proxy-providers。请分别导入其中的订阅地址或节点文件。');
      throw new Error('找不到节点。请提供 Clash YAML 的 proxies 列表或代理链接。');
    }
  }
  if (rows.length > MAX_NODES) throw new Error(`单次最多导入 ${MAX_NODES} 个节点。`);
  const nodes = [];
  const unsupported = [];
  const keys = new Set();
  let invalid = 0;
  let duplicates = 0;
  for (const row of rows) {
    try {
      const item = asLinks ? fromLink(row) : fromClash(row);
      if (item.unsupported) { unsupported.push(item); continue; }
      const key = nodeKey(item);
      if (keys.has(key)) { duplicates++; continue; }
      keys.add(key);
      nodes.push(item);
    } catch { invalid++; }
  }
  if (!nodes.length && !unsupported.length) throw new Error('没有识别到有效的代理节点。');
  return { nodes, unsupported, invalid, duplicates, providers };
}

export function subscriptionUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); }
  catch { throw new Error('请输入完整的订阅网址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('订阅网址须为 HTTP 或 HTTPS，且网址中不能包含基本认证凭据。');
  }
  url.hash = '';
  return url;
}

export function subscriptionPermission(url) {
  return `${url.protocol}//${url.hostname}/*`;
}

// Providers return byte counters and a Unix expiry date in Subscription-Userinfo.
export function parseSubscriptionUsage(header) {
  const counters = new Map();
  for (const field of (header ?? '').split(';')) {
    const entry = field.match(/^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/iu);
    if (!entry) continue;
    const value = Number(entry[2]);
    if (Number.isSafeInteger(value)) counters.set(entry[1].toLowerCase(), value);
  }
  const { total, upload, download, expire } = Object.fromEntries(counters);
  const remaining = total > 0 && upload != null && download != null ? Math.max(0, total - upload - download) : null;
  const expiresAt = expire > 0 && expire < 253402300800 ? expire * 1000 : null;
  return remaining == null && total == null && expiresAt == null ? null : { remaining, total: total ?? null, expiresAt };
}

export function canMeasure(node) {
  return ['ss', 'vmess', 'http', 'https', 'socks5'].includes(node.scheme);
}

export function measurementProxy(node) {
  if (node.proxy) return node.proxy;
  const proxy = { type: node.scheme === 'https' ? 'http' : node.scheme, server: node.host, port: node.port };
  if (node.scheme === 'https') proxy.tls = true;
  if (node.username) proxy.username = node.username;
  if (node.password) proxy.password = node.password;
  return proxy;
}
