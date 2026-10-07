# Windows 预览验证记录

2026-10-07，运行代码提交 [064938f](https://github.com/Tianchen-tech/local-chrome-control/commit/064938f07e2593bca0a459e15f94c840804fd33c) 的 [GitHub Actions #37700309934](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37700309934) 四组任务全部成功。随后只更新了预览说明和插件描述；最终发布提交的工作流可在 PR 中查阅。

| 平台 | Node | 自动测试 | 真实隔离 Chrome 回归 |
| --- | --- | --- | --- |
| macos-latest | 22.22.2 | 129 通过、3 个 Windows 项跳过 | 通过 |
| macos-latest | 24 | 129 通过、3 个 Windows 项跳过 | 通过 |
| windows-latest | 22.22.2 | 132 通过、0 跳过 | 通过 |
| windows-latest | 24 | 132 通过、0 跳过 | 通过 |

Windows runner 为 Microsoft Windows Server 2025。Node 24 的浏览器证据为 Windows Chrome 154.0.8037.58、Mac Chrome 152.0.7977.83。所有任务还通过语法/清单检查、只读安装预览与源码 ZIP 打包。

Windows 专项测试实际检查 NTFS 所有权/ACL与共享文件拒绝、HKCU 两种注册表视图的登记/冲突/撤销、批处理 origin/parent-window 转发、含 LF 长度字节的二进制 stdio，以及真实 MCP → 命名管道 → 本机主机传输。注册表使用专用测试 key，Chrome 消息由测试 Controller 模拟。

浏览器探针另开临时 Chrome 配置，只访问自有 loopback 合成页面。使用产品 BrowserAdapter，经真实 CDP 验证同源/跨进程 iframe 填写和点击（计数各为 1）、Controller 跨站跳转和租约连续使用、粘性菜单的可信 hover/down/up/click，以及导航后的标题。API 入口由测试适配层提供，不是完整扩展安装测试。探针激活自己的标签页，等待页面与框架就绪，再发出一次输入；只读观察不会重复输入，最后只关闭自己创建的浏览器。

## 已修复的 CI 失败

失败记录保留在 Actions，不重写为成功结果：

- [首次运行](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37697877501)：Windows CRLF 导致偏好测试的导入移除失败；系统 PowerShell 5.1 继承 PowerShell 7 模块路径；隔离浏览器跨进程点击未落入子框架。
- [模块诊断](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37698541572)：确认需显式加载系统 Security 模块，跨框架问题不能通过点击后多等快照解决。
- [指针诊断](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37699045125)：Windows 132 项测试通过；浏览器探针仍有启动读取和进程退出等待问题。
- [就绪改进](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37699925724)：Mac 两组全部通过；Windows 暴露首次 PowerShell 10 秒冷启动和 Chrome 2 秒元数据读取超时。
- [修复后通过](https://github.com/Tianchen-tech/local-chrome-control/actions/runs/37700309934)：系统模块明确加载；PowerShell 有界冷启动等待 30 秒；探针可在启动/导航期间再次读取，输入不重发。四组任务全部通过。

## 仍需本机试用

Windows 10/11 的个人配置，特别是普通非管理员账户或学校管理的 Chrome，需要按 [安装与验收](WINDOWS.md)实际加载 extension、确认主机就绪、亲自授权合成标签页，再通过 MCP 验证控制与撤销。CI 使用的 runner 身份和临时配置不覆盖这些环境。正式 Gmail/Notion/Slack 等网站兼容性也不由合成页面证明。本次没有发布 Chrome 商店版本或合并 main。
