# 0.2.3 修复记录

本版补全 0.2.2 在当前 Chrome 复测中暴露的粘性菜单和跨站确认问题。跨进程 iframe 点击、滚动坐标与鼠标事件修复沿用 0.2.2；旧失败记录保留，没有重放不明写操作。

## 改动

- 点击只在准备阶段调用一次 scrollIntoView。异步检查和悬停后的检查使用纯测量，继续验证元素身份、可见性、遮挡及坐标变化，不再把粘性导航反复滚动到另一位置。真正移动或被遮挡的元素仍拒绝点击。
- activeTab 跨站不再提供 URL 时，URL 来自当前已连接目标的 Page.getFrameTree；标题来自 Target.getTargetInfo。导航期间 TargetInfo 的短暂空 URL 不会覆盖可用 URL。不枚举未授权标签页。
- Chrome 扩展 ID、五项安装权限、原生主机、三档范围与用户黑名单不变。重新加载按设计撤销旧标签页授权，需用户亲自点击授权。

## 验证

122 项自动测试通过，0 失败、0 跳过。新增用例验证纯测量不重复滚动、遮挡仍拒绝，以及 TargetInfo 空 URL 不覆盖已提交的页面 URL。

独立临时配置的真实 Chrome 回归通过同源与跨进程 iframe 填写和点击、Controller 跨站导航确认及租约连续使用、标题恢复，以及实际 CSS 粘性导航菜单。菜单要求可信悬停、按下 buttons=1、释放 buttons=0，最终展开。将同一适配器的纯测量替换为旧的重复滚动逻辑后，同一粘性菜单测试返回 ELEMENT_MOVED，保留了反例。

早期菜单测试用页面主世界覆写 scrollIntoView 统计调用，但适配器在隔离世界执行，因此该统计断言无效；菜单当时已展开。已改用实际 CSS 粘性布局测试，并保留原失败结果，未把失败历史改成通过。

上述独立配置不等于当前用户 Chrome 的 Native Messaging 验收。当前配置的实测、授权、安装与打包状态见工作区 validation-0.2.3/REPORT.md。公开仓库和商店未随这次本机修复发布。

实现依据：[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent)、[CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getNodeForLocation)。坐标与跨进程宿主行为另由本轮实际浏览器轨迹确认。
