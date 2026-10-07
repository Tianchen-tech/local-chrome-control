# Windows 预览版 0.3.0

Windows 适配已实现，但尚未在 Windows 实机运行。当前验证来自 macOS 的跨平台逻辑测试、MCP/本机主机传输回归和独立 Chrome 浏览器回归。Windows 专属 NTFS 权限、注册表、批处理启动测试在 Mac 上明确跳过。不要把这份预览包当作已完成 Windows 验收的商店版本。

## 环境与安装

面向 Windows 10/11、NTFS 本地磁盘、Google Chrome 125+、[Node.js](https://nodejs.org/en/download) 22.22.2 或更新版本。安装流程使用系统自带 Windows PowerShell 5.1 与 cmd.exe。无需管理员权限，不修改执行策略、系统代理或浏览器安全参数。组织策略禁用本机主机、PowerShell 或 cmd.exe 时，应由组织管理员按正常流程处理。

将 ZIP 解压到稳定的本地目录，例如 C:\Users\你的用户名\plugins\local-chrome-control。源码目录中的普通中文、空格、百分号和感叹号已做生成测试；命令行实际启动仍须 Windows 测试确认。不要放在网络共享，不要在安装后移动目录。Windows 本机运行目录（默认 %LOCALAPPDATA%\LocalChromeControl）不能含 cmd 控制字符，如 %、!、&；这是 Chrome 先经 cmd 启动 .cmd 的边界。特殊用户名导致默认路径不合要求时，需将 LOCAL_CHROME_CONTROL_DIR 设为当前用户拥有的普通本地目录，并在 Chrome 与 MCP 的启动环境中一致设置；不要绕过检查。

在该目录打开 PowerShell，先预览：

```powershell
node .\scripts\windows-setup.mjs
```

预览只列出路径、扩展 ID、权限、MCP 配置与注册表位置，不修改系统。确认后安装：

```powershell
node .\scripts\windows-setup.mjs --install
node .\scripts\doctor.mjs
```

安装会保留原扩展密钥与 ID，重新生成当前 Windows 机器的 MCP 绝对路径，然后登记当前用户的 Chrome 本机主机。已有无关主机占用相同名字时拒绝覆盖。

在 Chrome 打开 chrome://extensions，开启开发者模式，选择“加载已解压的扩展程序”并选本项目 extension 文件夹。扩展 ID 应为 afkdbekkfjphihnmmhhiahdncbkhogpd。固定扩展，打开它，确认“本地连接已就绪”。工具栏的授权按钮必须由用户点击。

MCP 接入使用安装预览输出的 mcp_command 与 mcp_args，作为 STDIO server 填入客户端。也可在先运行安装流程之后，按客户端支持的本地插件导入方式安装项目。不要直接使用别人电脑的 .mcp.json 路径；压缩包里的配置是可移植模板，安装命令会生成本机配置。

## 本机连接与数据

Windows 的链路是 MCP → 命名管道 → Native Messaging → 手动授权的标签页。管道命名空间为 \\.\pipe\LocalChromeControl-*，没有新增 TCP/HTTP 控制服务。用户目录和会话共同参与命名，连接还必须通过随机 256 位密钥认证。网页控制范围、黑名单、租约和请求去重不变。

文件位于 %LOCALAPPDATA%\LocalChromeControl：

- native-host.cmd：原生主机启动脚本。
- NativeMessagingHosts\com.localchrome.control.json：Chrome 主机清单。
- 十二位连接 ID 的 .json 文件：当前连接描述与认证密钥，不可公开分享。

运行目录和密钥文件设置为当前用户与 SYSTEM 可访问的 NTFS ACL；读取连接前检查所有权与 ACL。拒绝重新解析点、网络共享和权限异常的描述文件。不依赖 Windows 中不存在的 process.getuid，也不把 Unix chmod 当作 Windows 访问控制。

注册表只登记当前用户 HKCU\Software\Google\Chrome\NativeMessagingHosts\com.localchrome.control，兼顾 32/64 位注册表视图，不写 HKLM。主机由 Chrome 按需启动，没有开机服务。正常断线删除连接描述，Windows 内核释放命名管道；异常进程退出后的旧描述被忽略，不据此自动重放写操作。

## 验收与撤销

先在自有页面验证，不测试真实邮件发送或购物：

```powershell
node .\scripts\fixture-modes.mjs
```

打开输出的 127.0.0.1:19320/?mode=extended，选扩展模式、保持 localhost 与 127.0.0.1 未被排除，再点击“允许控制此标签页”。用本插件读取快照，填写普通输入和富文本，点击同源/跨源 iframe 的计数按钮，确认每个计数为 1，再跨站到第二测试页面继续填写和截图。遇到不明写结果先 request_status 加新快照，不重复点击。

测试依赖及开发回归：

```powershell
npm ci
npm test
npm run check
npm run verify:browser
```

Windows 专属测试在 Windows 才执行：实际 NTFS ACL 隔离；两种注册表视图的安装、冲突保护与撤销；Chrome 形状的 origin/parent-window 参数经批处理启动主机并保留二进制 stdio。它们只用独立临时目录与专用测试注册表 key，不覆盖已安装主机。verify:browser 另建临时 Chrome 配置访问自有 loopback 页面，不控制个人 Chrome 配置。

.github/workflows/windows-compatibility.yml 已准备 Mac/Windows × Node 22.22.2/24 的测试矩阵；本轮未上传或触发远程工作流，其结果尚未取得。完整 Windows 验收仍需上述本机浏览器步骤，CI 的模拟 Chrome 传输不能代替真实扩展加载。

撤销当前用户连接程序：

```powershell
node .\scripts\windows-setup.mjs --uninstall
```

只移除本项目的两种注册表视图登记、主机清单和启动脚本，拒绝删除指向无关清单的同名登记。先在扩展弹窗正常停止连接，再卸载；扩展和 MCP 项在各自管理界面移除。不要删除其他扩展或修改安全策略。

## 实现依据

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)：Windows 当前用户注册表、双视图查找、origin 与 parent-window 参数、二进制 stdio。
- [Chromium Windows 主机启动源码](https://chromium.googlesource.com/chromium/src/+/50cc9e6c48e086e783d02f8d24a573686782d22d/chrome/browser/extensions/api/messaging/native_process_launcher_win.cc)：非 exe 主机经 cmd.exe 启动。本预览使用 .cmd，尚未提供签名 exe。
- [Node net IPC](https://github.com/nodejs/node/blob/main/doc/api/net.md)：Windows 命名管道与 Unix socket 的生命周期差异。
