# 0.2.2 修复记录

修复前真实 Chrome 验收发现：跨源 iframe 可以填写但点击失败、Amazon 分类菜单点击无展开、跨站后授权标签页标题为空。修复前记录保留在工作区 validation-0.2.1/live-2026-10-07-final/，没有覆盖不明操作记录。

## 修复

- 框架点击：把视口中的点击坐标转换成文档坐标后执行 DOM 命中检查；实际输入继续使用视口坐标。外层滚动时不再命中另一个框架或找不到节点。
- 跨进程框架：根目标的命中检查会停在 iframe 宿主。现在要求命中准确的宿主 backend node 和父框架，内部目标仍通过子框架隔离上下文检查。不会放宽到允许整个父框架，遮挡节点和不匹配宿主仍被拒绝。
- 鼠标点击：发送移动、左键按下（buttons=1）、释放（buttons=0）的完整顺序，悬停后重新检查目标位置和遮挡。鼠标按下后仍在 finally 释放；不明请求不重放。
- 标题：Chrome activeTab 跨来源停止提供 URL/标题时，使用已有调试连接的 Target.getTargetInfo 恢复当前目标的元数据，不枚举其他标签页，不增加权限。
- 诊断：浏览器指令失败可返回固定指令名称，便于定位；不返回或记录 Chrome 原始错误、网页 URL、输入值或账号信息。

## 验证

119 项自动测试通过，包含滚动坐标、精确宿主命中、遮挡拒绝、悬停后位置变化不按下、鼠标丢失响应仍释放、标题恢复仅用于已有连接、错误信息不泄漏页面数据。

独立临时 Chrome 配置的真实浏览器回归通过同源和跨进程 iframe 填写及点击，计数均从 0 变为 1；同时通过要求可信悬停、mousedown.buttons=1、mouseup.buttons=0 才展开的菜单，以及导航后标题更新。使用真实浏览器引擎和本项目适配器，不是模拟 DOM；它不等于用户当前配置或 Amazon 正式网页已复测。

scripts/probe-browser.mjs 创建新的临时 headless Chrome 配置，只访问本机合成页面，记录指令轨迹并在结束后移除临时配置。失败后停止，不重放写入。scripts/live-modes.mjs 用于用户亲自授权后的当前配置验收。

用户当前 Chrome 的安装与复测状态见工作区 validation-0.2.2/REPORT.md。Chrome 扩展 ID、五项安装权限、原生主机和三档控制范围保持不变。公开仓库与商店上传包未在本次修复中发布。

实现依据：[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent)、[CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getNodeForLocation)、[Chrome debugger 的框架和 flat sessions](https://developer.chrome.com/docs/extensions/reference/api/debugger)。坐标差异和 OOP 宿主命中行为还由本轮真实 Chrome 指令轨迹验证。
