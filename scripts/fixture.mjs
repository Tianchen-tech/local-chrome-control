import http from 'node:http';
const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Local Chrome Control 验收页</title>' +
  '<style>body{font:16px system-ui;max-width:720px;margin:60px auto;color:#17343b}input,select,button{font:inherit;padding:10px;margin:8px}section{padding:24px;background:#edf7f4;border-radius:16px}label{display:block}output{display:block;margin-top:20px;white-space:pre-wrap}</style>' +
  '<h1>本地控制验收</h1><p>这是本机测试页，表单不会向外部网站发送数据。</p><section>' +
  '<form id="form"><label>测试称呼<input name="name" aria-label="测试称呼" placeholder="输入测试文字"></label>' +
  '<label>测试套餐<select name="plan" aria-label="测试套餐"><option value="100">100 Mbps</option><option value="500">500 Mbps</option></select></label>' +
  '<label><input type="checkbox" name="wifi">包含 WiFi</label><button type="submit">提交测试</button></form>' +
  '<output id="result" aria-live="polite">尚未提交</output><p id="count">提交次数：0</p></section>' +
  '<script>let count=0;document.getElementById("form").addEventListener("submit",e=>{e.preventDefault();count++;const data=new FormData(e.target);document.getElementById("result").textContent=JSON.stringify(Object.fromEntries(data),null,2);document.getElementById("count").textContent="提交次数："+count;});</script></html>';
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page);
});
server.listen(0, '127.0.0.1', () => console.log('测试页：http://127.0.0.1:' + server.address().port + '/'));
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
