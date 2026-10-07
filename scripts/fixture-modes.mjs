import http from 'node:http';
import { VERSION } from '../extension/protocol.mjs';
const portA = 19320, portB = 19321;
const css = `body{font:16px/1.5 system-ui;margin:0;background:#eef4f5;color:#193c43}main{max-width:1120px;margin:28px auto;padding:0 24px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:28px}small{color:#617b80}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{padding:20px;background:white;border:1px solid #d5e3e5;border-radius:14px;margin-bottom:16px}label{display:block;margin:6px 0}input,textarea,[contenteditable]{box-sizing:border-box;border:1px solid #b8d1d5;border-radius:7px;padding:10px;min-height:40px;width:100%;font:16px/1.5 system-ui}[contenteditable]{white-space:pre-wrap;min-height:105px}button,[role=menuitem],[role=tab],[role=option],[role=link]{display:inline-block;margin:6px 4px 6px 0;padding:8px 13px;border:0;border-radius:7px;background:#ddf3eb;color:#007566;cursor:pointer}iframe{width:100%;height:230px;border:1px solid #c0d7db;border-radius:9px}pre{white-space:pre-wrap;background:#f1f6f7;padding:12px;border-radius:8px;font-size:13px}.badge{background:#087e77;color:white;padding:6px 12px;border-radius:20px}a{color:#087e77}`;
function page(url, isB) {
  const mode = url.searchParams.get('mode') || 'standard';
  const name = { readonly: '只读', standard: '标准', extended: '扩展' }[mode] || '标准';
  if (url.pathname === '/frame') return `<!doctype html><meta charset="utf-8"><style>${css}body{background:white;margin:15px}input{width:80%}</style><h3>${isB ? '跨源框架' : '同源框架'}</h3><input aria-label="${isB ? 'Cross frame input' : 'Same frame input'}" placeholder="仅供合成测试"><button onclick="this.nextElementSibling.textContent=String(Number(this.nextElementSibling.textContent)+1)">框架计数</button><span>0</span>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Chrome Control ${VERSION} · ${isB ? '第二网站' : name + '合成验收'}</title><style>${css}</style><main><header><div><small>LOCAL CHROME CONTROL · ${VERSION}</small><h1>${isB ? '已到达第二个测试网站' : '控制模式与复杂页面验收'}</h1></div><span class="badge">${name}模式测试页</span></header><p>这是合成页面，不含真实账户、消息或支付操作。请在扩展弹窗里选择对应模式授权。</p><div class="grid"><div><section class="card"><h2>普通表单与富文本</h2><label>普通输入<input aria-label="普通输入" placeholder="普通输入"></label><label>消息正文<div role="textbox" contenteditable="true" aria-label="消息正文" tabindex="0">初始草稿</div></label><button id="count">增加计数</button><strong id="clicks">0</strong><pre id="events">尚未输入</pre></section><section class="card"><h2>菜单与标签页</h2><div role="menuitem" id="menu">菜单动作</div><div role="tab">标签动作</div><div role="option">选项动作</div><div role="link">链接动作</div><p id="menu-result">等待操作</p></section><section class="card"><h2>开放 Shadow DOM</h2><div id="shadow"></div><p>另有一个封闭根的合成密码目标，用于检查错误输入被拦截。</p><div id="closed" contenteditable="true" tabindex="0" aria-label="封闭根测试目标"></div></section></div><div><section class="card"><h2>同源 iframe</h2><iframe title="同源测试框架" src="/frame"></iframe></section><section class="card"><h2>跨源 iframe</h2><iframe title="跨源测试框架" src="http://localhost:${portB}/frame"></iframe></section><section class="card"><h2>跨站连续操作</h2><p>选择扩展模式，黑名单留空即可。无需填写允许跳转或内嵌网站。</p><a href="http://localhost:${portB}/second?mode=extended">前往第二个测试网站</a><p><small>只读与标准模式不能直接跳到未授权来源。页面刷新、模式变化后需重新获取元素快照。</small></p></section></div></div></main><script>
let clicks=0, inputs=0; document.querySelector('#count').onclick=()=>document.querySelector('#clicks').textContent=++clicks;
for(const el of document.querySelectorAll('[role=menuitem],[role=tab],[role=option],[role=link]')) el.onclick=()=>document.querySelector('#menu-result').textContent=el.textContent+'已点击';
document.querySelector('[contenteditable][role=textbox]').addEventListener('input',e=>{document.querySelector('#events').textContent='富文本 input 事件：'+(++inputs)+'\\n浏览器真实输入：'+e.isTrusted+'\\n当前正文：'+e.currentTarget.innerText;});
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'}); shadow.innerHTML='<style>input{padding:10px;border:1px solid #b8d1d5;border-radius:7px;width:85%}button{padding:8px}</style><label>影子输入 <input aria-label="影子输入"></label><button>影子按钮</button><span>0</span>';
shadow.querySelector('button').onclick=()=>shadow.querySelector('span').textContent=String(Number(shadow.querySelector('span').textContent)+1);
const closed=document.querySelector('#closed').attachShadow({mode:'closed',delegatesFocus:true}); closed.innerHTML='<input type="password" aria-label="Synthetic password" value="synthetic-only">';
</script></html>`;
}
for (const port of [portA, portB]) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(url, port === portB));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Synthetic fixture: http://127.0.0.1:${port}/`));
  server.on('error', error => { console.error(error.message); process.exit(1); });
}
