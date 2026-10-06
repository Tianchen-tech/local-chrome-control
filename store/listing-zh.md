# 商店资料草稿

名称：本地 Chrome 控制 · Local Chrome Control
发布者：Tianchen Shen
支持邮箱：world8866171@gmail.com
默认语言：简体中文
建议分类：工具（以后台实际分类为准）
收费：免费
可见性：Public / 公开、可搜索
地区：所有支持地区
网站：https://tianchen-tech.github.io/local-chrome-control/
支持：https://tianchen-tech.github.io/local-chrome-control/setup.html
隐私：https://tianchen-tech.github.io/local-chrome-control/privacy.html

## 详细描述

本地 Chrome 控制帮助 Codex 等兼容 MCP 客户端读取和操作你手动授权的 Chrome 标签页。

【安装要求】第一版仅支持 macOS。需另行安装 Node.js 22.22.2 或更新版本、本机连接程序，并配置兼容 MCP 客户端。仅安装此 Chrome 扩展不能开始控制。请先阅读安装指南。

支持主页面内容读取、普通表单填写、按钮点击、下拉选择、滚动和截图。你在扩展弹窗中逐个授权标签页，可随时停止；跨网站导航会收回授权。任务租约、新鲜页面引用和操作请求 ID 用于减少并发控制及重复执行。

第一版不支持密码输入、文件上传、复杂 iframe 或 Shadow DOM 控件，也不绕过验证码和登录限制。

控制消息通过本机连接程序传递。返回给 MCP 客户端的网页内容、截图和操作输入可能被客户端发送给其模型服务商，请阅读隐私政策。我们不运营网页数据收集服务器，不出售数据，不投放广告。

这是独立项目，与 Google 或 OpenAI 无隶属关系。

## 权限 / 单一用途说明（由发布者核对后填写）

单一用途：让兼容本机 MCP 客户端读取和操作用户在弹窗中明确授权的标签页。
- activeTab：获取用户点击扩展后的当前标签页信息，用于明确授权目标。
- debugger：通过 Chrome 调试接口读取已授权页面 DOM、执行输入/点击/滚动和截图；控制器限制到被授权及持有租约的标签页。
- nativeMessaging：连接用户安装的本机连接程序，向兼容 MCP 客户端提供浏览器工具。
- storage：保存授权/操作状态和去重记录，以便扩展后台恢复及查询不确定的操作结果。
- alarms：在本机连接意外断开后安排延迟重连，帮助扩展后台恢复连接。
远程代码：扩展执行代码全部随包提供，无远程脚本或动态远程代码加载。

## 数据使用披露草稿

处理网站内容（页面文字/结构、普通表单内容、请求截图）及授权页面元数据（标题、来源/URL），按用户请求返回给本机 MCP 客户端。应结合后台当前分类核对 Website content，以及 Web history 对 URL/标题的定义；不能填“完全不处理用户数据”。无广告、销售、信用评估或与用途无关的数据处理。

扩展未请求 Chrome history API，但这不等于它不处理当前授权页面 URL。开发者须亲自核对后台数据分类及 Limited Use 等认证，本文不替发布者作法律认证。
