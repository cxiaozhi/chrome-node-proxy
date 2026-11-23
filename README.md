# 直连代理 · Chrome 扩展

在 Chrome 里导入、启用、切换和停用代理节点。Shadowsocks 和 VMess 由 Chrome 启动 Windows 后台组件处理，无需打开 Clash。

## 从仓库安装

1. 在 `chrome://extensions/` 启用「开发者模式」，点击「加载已解压的扩展程序」，选择仓库的 `extension` 目录。
2. 在 Windows x64 上运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\Build.ps1`，使用系统自带的 .NET Framework 编译 `DirectProxyHost.exe`。
3. 双击 `bridge\Install.cmd`，安装脚本会下载并校验 Mihomo，然后为当前 Windows 用户登记本机组件。HTTP、HTTPS 和免认证 SOCKS 节点可直接使用。Shadowsocks、VMess 和节点测速需要本机组件。
4. 打开工具栏的「直连代理」，在「添加」里导入自己的配置。

## 使用现有安装包

1. 解压 `direct-proxy-chrome-v1.4.1.zip`。打开 `chrome://extensions/`，启用「开发者模式」，点击「加载已解压的扩展程序」，选择含 `manifest.json` 的目录。
2. 测速需要 1.3.0 的 Windows 本机组件。安装或升级组件时，解压单独的 `direct-proxy-windows-setup.zip`，双击 `Install.cmd`。安装脚本从 MetaCubeX 官方发布下载并校验 Windows x64 Mihomo 1.19.34，在当前 Windows 账户内登记本机组件。
3. 点击 Chrome 工具栏的「直连代理」。在「添加」导入订阅或文件，在「节点」启用或测速，在「订阅」查看流量、到期日期和更新订阅。

1.2.1 起使用固定的 Chrome 扩展 ID。首次从使用旧 ID 的版本切换时，新扩展需要导入一次订阅。后续更新可覆盖 Chrome 正在使用的扩展目录，再点「重新加载」。

## 延迟、流量和到期时间

- 在「节点」点节点旁的「测速」，或点组标题旁的「整组测速」。通过各代理访问测速地址，显示毫秒延迟。关闭弹窗后测速继续，当前节点照常使用。
- 订阅卡片显示服务商返回的剩余流量、总量和到期日。点「更新」刷新。服务商未返回的字段会留空。

## 支持范围

| 节点 | 使用方式 |
| --- | --- |
| HTTP / HTTPS | Chrome 直连，带密码的节点启用时申请网站访问权限。 |
| 无需认证的 SOCKS4 / SOCKS5 | Chrome 直连。 |
| Shadowsocks / VMess | 支持订阅、Clash YAML 和常见分享链接。带 Shadowsocks 传输插件的节点可用 YAML 导入，支持 `obfs` 和 `v2ray-plugin`。VMess 支持 TCP、WebSocket、gRPC、HTTP 和 H2。 |
| 其他协议 | 导入时显示为不支持。 |

「文件 / 文本」导入 Clash YAML 或逐行节点链接。「手动添加」支持填入直连代理服务器。`proxy-providers` 中的订阅可分别导入。

本机组件只为当前扩展启用的节点启动 Mihomo。它使用仅监听回环地址的 SOCKS5 端口，无需管理员权限。启用和停用只改变当前 Chrome 配置的代理设置，Chrome 重启后会恢复上次启用的本机节点。订阅和节点凭据保存在 Chrome 扩展的本地存储中。

## 验证

- `node --test tests/nodes.test.mjs` 检查节点解析。
- `node tests/browser.mjs` 验证导入、切换、HTTP 认证和停用。需要本地可解析的 Playwright 和 Chromium。
- `node tests/local-bridge.mjs` 用本机 Shadowsocks 和 VMess 模拟服务器验证实际浏览器流量。运行前需要将同版本 Mihomo 放在 `bridge`，并通过安装脚本登记测试扩展 ID。

YAML 解析器为 js-yaml 4.2.0，许可证位于 `extension/vendor/LICENSE`。Mihomo 来自 MetaCubeX 官方 v1.19.34 发布，许可证位于 `bridge/MIHOMO-LICENSE`。
