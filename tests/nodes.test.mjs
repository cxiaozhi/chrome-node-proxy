import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionUsage, parseImport, makeNode, subscriptionPermission, subscriptionUrl } from '../extension/nodes.mjs';

test('Clash YAML keeps usable endpoints and reports protocol or option limitations', () => {
  const result = parseImport(`proxies:
  - {name: 安全代理, type: http, server: proxy.example, port: 8443, tls: true, username: user, password: '0007'}
  - {name: 本地格式, type: socks5, server: '::1', port: 1080}
  - {name: 密码 SOCKS, type: socks5, server: proxy.example, port: 1080, username: user}
  - {name: 不校验证书, type: http, server: proxy.example, port: 80, skip-cert-verify: true}
  - {name: SS Node, type: ss, server: proxy.example, port: 9000, password: sample}
proxy-providers:
  extra: {type: http, url: 'https://example.com/sub'}
`);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].scheme, 'https');
  assert.equal(result.nodes[0].password, '0007');
  assert.equal(result.nodes[1].host, '::1');
  assert.deepEqual(result.unsupported.map(node => node.type), ['SOCKS5', 'HTTP', 'Shadowsocks']);
  assert.equal(result.providers, 1);
});

test('plain and Base64 link lists handle UTF-8, IPv6, explicit ports, and duplicates', () => {
  const list = `http://u%40x:p%3Aa@proxy.example:8080#%E6%B5%8B%E8%AF%95
https://proxy.example:80
socks5://[::1]:1080#局域网
socks5://[::1]
trojan://sample#Other
http:///missing-authority
broken`;
  const result = parseImport(Buffer.from(list).toString('base64url'));
  assert.equal(result.nodes[0].name, '测试');
  assert.equal(result.nodes[0].username, 'u@x');
  assert.equal(result.nodes[0].password, 'p:a');
  assert.equal(result.nodes[1].port, 80);
  assert.equal(result.nodes[2].name, '局域网');
  assert.equal(result.unsupported[0].type, 'Trojan');
  assert.equal(result.invalid, 2);
  assert.equal(result.duplicates, 1);
});

test('unsupported-only lists and provider-only configurations give distinct results', () => {
  assert.equal(parseImport('ss://sample#A\nvmess://sample\nvless://sample').unsupported.length, 3);
  assert.throws(() => parseImport('proxy-providers: {a: {type: http}}'), /proxy-providers/u);
  assert.throws(() => parseImport('html page without any nodes'), /找不到节点/u);
});

test('manual validation and subscription permission scope', () => {
  assert.throws(() => makeNode({ scheme: 'socks5', host: 'proxy.example', username: 'user' }), /不支持账号密码/u);
  assert.throws(() => makeNode({ scheme: 'http', host: 'proxy.example', port: 65536 }), /端口/u);
  assert.equal(makeNode({ scheme: 'https', host: '例子.example' }).host, 'xn--fsqu00a.example');
  const url = subscriptionUrl('https://example.com:8443/path?token=secret#fragment');
  assert.equal(url.hash, '');
  assert.equal(subscriptionPermission(url), 'https://example.com/*');
  assert.throws(() => subscriptionUrl('file:///tmp/config.yaml'), /HTTP/u);
});

test('retains usable Shadowsocks and VMess nodes while filtering unrelated config', () => {
  const result = parseImport(`proxies:
  - {name: SS, type: ss, server: example.test, port: 1443, cipher: aes-128-gcm, password: '0123', private-key: ignored}
  - {name: VM, type: vmess, server: example.test, port: 2443, uuid: 4a078407-69af-498e-b7c7-ca79391c924a, network: ws, ws-opts: {path: /edge, headers: {Host: client.example}, unrelated: ignored}}
  - {name: Dependent, type: ss, dialer-proxy: DIRECT, server: example.test, port: 1443, cipher: aes-128-gcm, password: abc}
`);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.nodes[0].proxy.password, '0123');
  assert.equal(result.nodes[0].proxy['private-key'], undefined);
  assert.deepEqual(result.nodes[1].proxy['ws-opts'], { path: '/edge', headers: { Host: 'client.example' } });
  const ss = `ss://${Buffer.from('aes-128-gcm:p:a').toString('base64url')}@example.test:1443#SS`;
  const vm = `vmess://${Buffer.from(JSON.stringify({ add: 'example.test', port: 2443,
    id: '4a078407-69af-498e-b7c7-ca79391c924a', ps: 'VM', net: 'ws', path: '/edge' })).toString('base64')}`;
  const links = parseImport(`${ss}\n${vm}`).nodes;
  assert.equal(links[0].proxy.password, 'p:a');
  assert.equal(links[1].proxy['ws-opts'].path, '/edge');
});


test('reads provider quota without inventing missing or expired values', () => {
  assert.deepEqual(parseSubscriptionUsage(' Upload=50; download=80; total=100; expire=1800000000 '),
    { remaining: 0, total: 100, expiresAt: 1800000000000 });
  assert.deepEqual(parseSubscriptionUsage('total=0; expire=0'), { remaining: null, total: 0, expiresAt: null });
  assert.deepEqual(parseSubscriptionUsage('download=80; total=100; expire=invalid'), { remaining: null, total: 100, expiresAt: null });
  assert.equal(parseSubscriptionUsage(null), null);
  assert.equal(parseSubscriptionUsage('total=9007199254740993; expire=-1'), null);
});
