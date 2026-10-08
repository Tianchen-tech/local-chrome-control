# Windows 预览版 0.3.0

原发布基线已通过 Mac/Windows × Node 22.22.2/24 四组 GitHub Actions。当前分支增加 Windows 可重复 ACL 设置、无控制台的可执行启动器和具体连接错误提示，测试集共 136 项。Windows 11 个人 Chrome 已完成扩展加载、手动标准模式授权及 MCP 到页面的实际控制验收。[验证记录](WINDOWS-CI.md)区分发布基线、本机验证和仍未覆盖的范围。本版仍为开发预览。

## 环境与安装

面向 Windows 10/11、NTFS 本地磁盘、Google Chrome 125+、[Node.js](https://nodejs.org/en/download) 22.22.2 或更新版本。安装使用 Windows PowerShell 5.1 和系统 .NET Framework 4 的 C# 编译器，生成本机 native-host.exe；运行时不需要启动批处理中的 chcp。无需管理员权限，不修改执行策略、系统代理或浏览器安全参数。组织策略禁用本机主机或所需系统程序时，应由组织管理员按正常流程处理。

本次修复位于 [codex/windows-support 分支源码 ZIP](https://github.com/Tianchen-tech/local-chrome-control/archive/refs/heads/codex/windows-support.zip)。[原预览发布页](https://github.com/Tianchen-tech/local-chrome-control/releases/tag/v0.3.0-windows-preview.1)的 ZIP 和校验值保持原样，不包含后续修复。将源码解压到稳定的本地目录，例如 C:\Users\你的用户名\plugins\local-chrome-control，在含 package.json 的目录打开 PowerShell。测试覆盖含中文、空格、百分号、感叹号与 & 的源码路径。不要放在网络共享，不要在安装后移动目录。Windows 本机运行目录（默认 %LOCALAPPDATA%\LocalChromeControl）不能含 cmd 控制字符，如 %、!、&，因为 Chrome 也可能经 cmd 启动可执行主机。特殊用户名导致默认路径不合要求时，需将 LOCAL_CHROME_CONTROL_DIR 设为当前用户拥有的普通本地目录，并在 Chrome 与 MCP 的启动环境中一致设置；不要绕过检查。

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

- native-host.exe 与 native-host.exe.cs：本机编译的二进制转发启动器及其源文件。
- NativeMessagingHosts\com.localchrome.control.json：Chrome 主机清单。
- 十二位连接 ID 的 .json 文件：当前连接描述与认证密钥，不可公开分享。

系统 Windows PowerShell Security 模块按绝对系统路径加载，避免继承 PowerShell 7 模块路径而加载错误版本；首次安全检查允许最多 30 秒冷启动等待，超时仍拒绝连接。运行目录和密钥文件设置为当前用户与 SYSTEM 可访问的 NTFS ACL；读取连接前检查所有权与 ACL。拒绝重新解析点、网络共享和权限异常的描述文件。不依赖 Windows 中不存在的 process.getuid，也不把 Unix chmod 当作 Windows 访问控制。

注册表只登记当前用户 HKCU\Software\Google\Chrome\NativeMessagingHosts\com.localchrome.control，兼顾 32/64 位注册表视图，不写 HKLM。主机由 Chrome 按需启动，没有开机服务。正常断线删除连接描述，Windows 内核释放命名管道；异常进程退出后的旧描述被忽略，不据此自动重放写操作。

旧版本升级仅在清单及 native-host.cmd 内容都匹配当前 Node 和项目路径时自动迁移。旧批处理文件保留但不再登记。先在扩展弹窗停止控制并退出 Chrome，再更新安装目录，以便替换正在使用的可执行文件。

## 连接错误排查

弹窗现在区分 HOST_NOT_FOUND、HOST_FORBIDDEN、HOST_START_FAILED、HOST_EXITED 和 HOST_PROTOCOL_ERROR。先运行 doctor 检查登记和扩展 ID。安装后重新加载扩展；仍显示 HOST_NOT_FOUND 时，从 Chrome 菜单选择“退出”，确认后台进程结束，再重新启动并点“重新连接”。本机试用在完整重启 Chrome 后恢复连接，先前失败进程没有日志，未确认其确切根因。

如果仍失败，按照 [Chrome Native Messaging 调试说明](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#debug-native-messaging)，在 Chrome 完全退出后以 `chrome.exe --enable-logging --log-level=1` 启动，检查日志里的主机清单查找、读取及程序路径错误。日志可能包含其他浏览器信息，分享前只保留相关诊断行。组织策略拒绝访问时不要改用其他身份或放宽运行目录 ACL。

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

Windows 专属测试在 Windows 才执行：实际 NTFS ACL 隔离与重复设置；两种注册表视图的安装、冲突保护与撤销；保留旧批处理回归；可执行主机的普通和无控制台后台启动、origin/parent-window 参数及包含 LF 长度字节的二进制 stdio。它们只用独立临时目录与专用测试注册表 key，不覆盖已安装主机。verify:browser 另建临时 Chrome 配置访问自有 loopback 页面，不控制个人 Chrome 配置。

.github/workflows/windows-compatibility.yml 已在公开仓库运行并通过四组测试，详见 [CI 验证记录](WINDOWS-CI.md)。完整 Windows 验收仍需上述本机浏览器步骤。传输测试在真实 Windows 命名管道与主机之间模拟 Chrome 消息；浏览器探针使用真实 Chrome 与产品 BrowserAdapter，但调试 API 的入口由测试适配层提供。这两层自动测试不能代替 Chrome 实际加载扩展并启动已登记主机的完整验收。

撤销当前用户连接程序：

```powershell
node .\scripts\windows-setup.mjs --uninstall
```

只移除本项目的两种注册表视图登记、主机清单、可执行启动器及其源文件，拒绝删除指向无关清单的同名登记。先在扩展弹窗停止连接并退出 Chrome，再卸载；扩展和 MCP 项在各自管理界面移除。迁移时保留的旧批处理文件不再生效。不要删除其他扩展或修改安全策略。

## 实现依据

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)：Windows 当前用户注册表、双视图查找、origin 与 parent-window 参数、二进制 stdio。
- [Chromium Windows 主机启动源码](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/messaging/launch_context_win.cc)：可执行主机可能直接启动，也可能经 cmd；本分支使用本机编译的未签名 exe。
- [Node net IPC](https://github.com/nodejs/node/blob/main/doc/api/net.md)：Windows 命名管道与 Unix socket 的生命周期差异。
