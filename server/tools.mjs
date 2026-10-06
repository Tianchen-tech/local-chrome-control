const session = { session_id: { type: 'string', description: '多个 Chrome 配置连接时，使用 sessions_list 返回的 ID。' } };
const tab = { ...session, tab_id: { type: 'integer', minimum: 0 }, lease_id: { type: 'string', description: 'tab_claim 返回的控制权 ID。' } };
const target = { ...tab, snapshot_id: { type: 'string' }, ref: { type: 'string', description: '最近一次 page_snapshot 返回的元素引用。' } };
const mutation = { request_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,96}$', description: '每次新操作使用唯一 ID；结果不明时查询状态，不自动重试。' } };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, readOnly, destructive = false) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: name.startsWith('page_') }
});
export const TOOLS = [
  tool('sessions_list', '列出本机 Chrome 扩展连接。不会读取浏览历史或未授权标签页。', schema({}), true),
  tool('status', '查看连接、已授权标签页数量与操作耗时，不包含网页正文。', schema(session), true),
  tool('tabs_list', '只列出用户在扩展弹窗中明确授权的标签页。', schema(session), true),
  tool('tab_claim', '为当前任务独占一个已授权标签页；10 分钟无操作后过期。另一个任务占用时返回 TAB_BUSY。', schema({ ...session, tab_id: tab.tab_id, task_name: { type: 'string', maxLength: 80 } }, ['tab_id', 'task_name']), false),
  tool('tab_release', '释放任务控制权，保留用户标签页和扩展授权。', schema(tab, ['tab_id', 'lease_id']), false),
  tool('page_snapshot', '读取主页面可见文字和交互元素。密码、隐藏字段及浏览器存储不会读取。返回新 snapshot_id；操作必须引用它。focused 是当前键盘焦点（null 表示页面本身）。', schema(tab, ['tab_id', 'lease_id']), true),
  tool('page_screenshot', '截取已授权标签页的当前视口，返回按 CSS 像素缩放的 JPEG；不截取桌面或其他标签页。', schema(tab, ['tab_id', 'lease_id']), true),
  tool('page_click', '点击最近快照中的元素。根据用户意图操作；付款、协议及敏感数据提交仍遵守当前确认规则。结果不明时禁止自动重复点击。', schema({ ...target, ...mutation }, ['tab_id', 'lease_id', 'snapshot_id', 'ref', 'request_id']), false, true),
  tool('page_fill', '填写普通输入框或文本域，支持空字符串清空。用户必须已授权向此网站填写这些数据。第一版不填写密码或上传文件。', schema({ ...target, ...mutation, value: { type: 'string', maxLength: 20000 } }, ['tab_id', 'lease_id', 'snapshot_id', 'ref', 'value', 'request_id']), false, true),
  tool('page_select', '选择原生下拉框中快照已列出的 option value。自定义下拉框使用快照和点击。', schema({ ...target, ...mutation, value: { type: 'string', maxLength: 500 } }, ['tab_id', 'lease_id', 'snapshot_id', 'ref', 'value', 'request_id']), false, true),
  tool('page_scroll', '用真实滚轮事件滚动，可触发懒加载。按请求方向追踪实际滚动区域；传 ref 时从该元素处滚动。返回位置和是否到底；多个区域同时变化时 reached_end 为 null。新内容需重新读取快照。', schema({ ...target,
    ref: { type: 'string', description: '可选。最近快照中的元素，在其所在的滚动区域内滚动。' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 20000, description: '可选。滚动像素数。' } },
    ['tab_id', 'lease_id', 'direction']), false),
  tool('page_press_key', '按一次键：Enter、Escape、Tab、Backspace、Delete、Space、方向键、Home、End、PageUp、PageDown（可加 Shift），或单个字符。仅向已确认的主页面原生控件发送；传 ref 可先聚焦。Shadow DOM、内嵌框架和无法确认的焦点拒绝按键；未知焦点及密码框只允许 Tab/Escape。发送前重新检查焦点；聚焦也可能触发页面事件，结果不明时禁止自动重复。滚动用 page_scroll，填写文字用 page_fill。不支持 Ctrl/Cmd。', schema({ ...target, ...mutation,
    ref: { type: 'string', description: '可选。最近快照中的元素，先聚焦它再按键。' },
    key: { type: 'string', maxLength: 20, description: '例如 Enter、Escape、Shift+Tab、ArrowDown、k、?' } },
    ['tab_id', 'lease_id', 'key', 'request_id']), false, true),
  tool('page_navigate', '在已授权网站的同一 origin 内跳转。其他网站需要用户手动打开并授权；不接受浏览器内部页。', schema({ ...tab, ...mutation, url: { type: 'string', maxLength: 4000 } }, ['tab_id', 'lease_id', 'url', 'request_id']), false, true),
  tool('request_status', '查询写操作是否已完成或结果不明，不会重复执行操作。not_found 也不代表可以安全重试。', schema({ ...session, ...mutation }, ['request_id']), true)
];
