## 0.3.0 Windows 适配预览

此分支供解压加载测试，使用固定开发公钥产生测试扩展 ID；不代表商店条目已绑定或发布。原 0.1.1 商店准备资料保留在 main 分支，正式商店身份仍须单独绑定验收。

提供只读、标准、扩展三档控制模式，以及富文本输入、菜单角色、开放 Shadow DOM 和 iframe。最高档默认允许当前授权标签页访问所有普通网站和跨源框架，可选填域名黑名单；无需填写网址白名单。黑名单会记住供下次授权使用，不自动授予标签页访问。最低 Chrome 125。正式网站兼容性仍需验收。[使用与验收说明](docs/CONTROL-MODES-0.2.1.md)。

0.2.3 修复了滚动页面中的跨进程 iframe 命中检查、完整鼠标事件顺序、粘性导航反复滚动和跨站标题恢复，见 [修复记录](docs/FIXES-0.2.3.md)。

Windows 本机连接与隔离 Chrome 回归已通过 Mac/Windows × Node 22/24 的四组 CI。个人 Chrome 的扩展加载与授权连接仍需本机验收。下载 [0.3.0 预览 ZIP](https://github.com/Tianchen-tech/local-chrome-control/releases/tag/v0.3.0-windows-preview.1)，按 [Windows 安装与验收](docs/WINDOWS.md)试用；[CI 记录](docs/WINDOWS-CI.md)列出验证边界。

# 本地 Chrome 控制

Windows 测试预览版 0.3.0，面向 macOS 与 Windows 10/11，最低 Chrome 125。Windows 自动验证环境为 Windows Server 2025；Windows 10/11 个人配置验收待完成。读取页面、点击、填表、选择下拉选项和截图，通过独立的本机连接程序接入 Codex。

历史版本 0.1.1 的 74 项开发测试通过，并完成部分真实 Chrome 基础操作验收，这些历史结果可参照 main 分支的 0.1.1 发布准备。这些历史结果不等于新控制模式和所有复杂网站已验收。当前版本的实测状态见本分支 GitHub Actions 与 docs/WINDOWS.md。

## 工作方式

Publisher: Tianchen Shen · Public support: world8866171@gmail.com

Codex → 本机 MCP 程序 → 当前用户本机 IPC（Mac：Unix socket；Windows：命名管道） → Chrome Native Messaging → 手动授权的标签页。

运行时只有 Node.js 标准库，不需要 npm 安装运行依赖，不开放 HTTP 控制端口，不修改代理。模型请求和网站访问仍依赖网络。网页内容作为工具结果交给 Codex 时，遵循 Codex 的数据处理方式；本地通信不表示模型推理也在本机。

## 已实现

- 用户在扩展弹窗选择模式并点击“允许控制此标签页”。只读、标准仅限当前网站；扩展默认允许普通网站，用黑名单排除。浏览器内部页和扩展商店不可控。
- 列出授权标签页、获取任务独占控制权、读取正文和元素引用、点击、填写普通输入框、选择原生下拉框、同站跳转、当前视口截图。
- 滚动页面或页面内的滚动区域（真实滚轮事件，可触发懒加载）。按滚动方向识别可滚动的祖先，返回实际移动的容器；多个容器同时移动时，reached_end 为 null，不据此断言到达边界。
- 按单个键（Enter、Esc、Tab、方向键、翻页键、空格及单个字母数字符号，可加 Shift），以及插入 Unicode 文本或逐字输入。不支持 Ctrl/Cmd 组合键。支持已确认的原生控件、富文本、开放 Shadow DOM 与范围内框架；封闭 Shadow DOM 或无法确认实际编辑目标时拒绝输入。密码框与未定位的页面焦点只允许 Tab/Escape，不允许字符、编辑或提交键。
- 控制状态、错误码与逐步耗时。浏览器指令截止时间为 8 秒，截图为 12 秒；连接端另设 10 / 14 秒等待边界。超时不代表网页动作已取消。
- 写操作先持久化唯一请求编号。已完成请求返回原结果；失联或状态不明时不自动重复执行。聚焦和滚动到元素也可能触发网页行为，进入这些准备动作后失败即记录结果不明。只有纯校验阶段拒绝才返回 executed: false。
- Chrome 的停止调试按钮、扩展的停止按钮、关闭标签页、到期、跳到模式范围以外或黑名单网站会撤销授权；最高档的正常跨站跳转保留授权。断线重连仅恢复本地通信，不撤销用户的停止决定。
- 多个 Chrome 配置各有连接 ID；不同任务不能同时取得同一标签页的控制权。
- 扩展连接时上报支持的操作。Chrome 运行的扩展比本项目旧（例如从其他目录加载）时返回 EXTENSION_OUTDATED 并给出应加载的目录；npm run doctor 列出缺少的操作。

## 当前范围

支持主页面、开放 Shadow DOM 和模式范围内的 iframe。文件上传、密码填写、封闭 Shadow DOM 和特殊浏览器页面不支持。动态网页需要新快照；遇到验证码或安全提示由用户处理。页面中的提示不是操作授权。截图可能包含黑名单框架的可见像素，黑名单不等于图像遮盖功能。

## 安装前检查

进入项目目录，运行 npm run install:preview 查看将创建的文件和所需权限；不会修改系统。

Windows 详细步骤见 [安装与撤销](docs/WINDOWS.md)。这个版本使用安装目录中的绝对路径。移动或解压到新位置后先运行 npm run prepare:local，再重新配置本地连接程序和 MCP。

## 本地验证

- npm ci：只安装测试依赖 jsdom。
- npm test：权限、独占控制、防重复、DOM 引用、消息传输、MCP 协议和模拟故障测试。
- npm run check：语法、扩展清单、工具结构检查。
- npm run doctor：只读检查已安装的本机连接和连接状态。
- npm run fixture：启动只在本机监听的验收页。
- npm run package：用 Node 标准库生成可移植源码安装包及 SHA-256，不依赖系统 zip。
- npm run setup:windows：Windows 安装预览；显式加 --install 或 --uninstall 才安装或撤销。
- npm run verify:browser：独立临时 Chrome 配置的合成回归。

真实浏览器验收步骤见 [Windows 验收步骤](docs/WINDOWS.md)。不要把模拟传输的毫秒耗时当作真实 Chrome 性能。

连接出错时见 [Windows 说明](docs/WINDOWS.md)，先区分本地连接、标签页授权和网页操作。

## 数据与权限

Chrome 所需权限：activeTab、debugger、nativeMessaging、storage、alarms。debugger 是较强的 Chrome 权限，平台本身允许更多访问；本项目在代码中额外限制到用户授权的标签页、网站来源和工具白名单。安装前应审核代码与权限，授予标签页访问不代表授权所有表单提交、付款或协议操作。

不请求 cookies、history、所有网站 host_permissions；不暴露任意 JavaScript 执行接口。不在诊断日志记录网页正文、填写值、截图、URL 或控制密钥。

Chrome 扩展本地存储还保存用户最近选择的模式、有效期和域名黑名单，供下次授权预填；这些偏好不会恢复或新建访问授权。写操作记录保留操作 ID、参数摘要、状态、时间及简短结果；下次写入时清理超过 24 小时、且所属授权已结束的记录，最多 5000 条。仍在授权中的标签页记录不清理，因为它们还可能被重放；达到上限时拒绝新写入，不静默删除近期去重记录。截图为当前视口的 JPEG，按 CSS 像素缩放，以减小体积。浏览器工作进程重启后，待确认操作标记为不明，标签页需要重新授权。

## 参考接口

- [Chrome 调试接口](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome 本机通信](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome 扩展后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Codex MCP 接入](https://learn.chatgpt.com/docs/extend/mcp)
- [MCP stdio 协议](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
