// Development-only real-browser regression probe. A new headless Chrome profile
// visits only our loopback fixture; it cannot attach to the user's Chrome session.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserAdapter } from '../extension/browser-adapter.mjs';
import { createPolicy } from '../extension/policy.mjs';
import { Controller } from '../extension/controller.mjs';
import { chromeExecutable } from './chrome-path.mjs';
const executable = await chromeExecutable();

const output = path.resolve(process.argv[2] || 'dist/browser-probe');
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lcc-regression-'));
const child = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, '--window-size=1470,900', 'about:blank'
], { stdio: 'ignore' });
const trace = [], results = [], callbacks = new Map(), listeners = [];
let socket, next = 0, rootSession, targetId, failed = false, pointerServer;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function send(method, params = {}, sessionId) {
  const id = ++next;
  const entry = { method, session: sessionId === rootSession ? 'root' : sessionId ? 'iframe' : 'browser' };
  if (method === 'DOM.getNodeForLocation' || method === 'Input.dispatchMouseEvent') entry.params = params;
  trace.push(entry);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { callbacks.delete(id); reject(new Error('Probe command timeout: ' + method)); }, 8000);
    callbacks.set(id, message => {
      clearTimeout(timer);
      if (message.error) { entry.error = message.error; reject(new Error(message.error.message)); }
      else {
        if (['DOM.getNodeForLocation', 'DOM.getFrameOwner', 'Page.getFrameTree', 'Target.getTargetInfo'].includes(method)) entry.result = message.result;
        if (method === 'Runtime.callFunctionOn' && params.functionDeclaration?.includes('function ownerMetrics')) entry.result = message.result.result?.value;
        if (method === 'Runtime.evaluate' && params.expression?.includes('function viewportMetrics')) entry.result = message.result.result?.value;
        resolve(message.result);
      }
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); break; } catch {}
    if (child.exitCode !== null) throw new Error('Headless Chrome exited');
    await pause(100);
  }
  assert.ok(port, 'Isolated Chrome must start');
  socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const callback = callbacks.get(message.id); callbacks.delete(message.id); callback?.(message); }
    else if (message.method && message.sessionId) {
      const source = { tabId: 7, ...(message.sessionId !== rootSession ? { sessionId: message.sessionId } : {}) };
      for (const listener of listeners) listener(source, message.method, message.params || {});
    }
  });
  ({ targetId } = await send('Target.createTarget', { url: 'http://127.0.0.1:19320/?mode=extended' }));
  ({ sessionId: rootSession } = await send('Target.attachToTarget', { targetId, flatten: true }));
  const api = {
    tabs: { async get() { return { id: 7 }; } }, // Simulate activeTab ending after navigation.
    debugger: { onEvent: { addListener(fn) { listeners.push(fn); } }, async attach() {}, async detach() {},
      async sendCommand(target, method, params) { return send(method, params, target.sessionId || rootSession); } }
  };
  const adapter = new BrowserAdapter(api), origin = 'http://127.0.0.1:19320', policy = createPolicy(origin, { mode: 'extended' });
  if (process.argv.includes('--legacy-point-checks')) {
    const evaluate = adapter.evaluate.bind(adapter);
    adapter.evaluate = (id, fn, args, deadline) => evaluate(id, fn, args[3] === 'measure-point' ? [...args.slice(0, 3), 'point', ...args.slice(4)] : args, deadline);
  }
  await adapter.attach(7);
  await pause(300); // Startup of this disposable fixture only; never wait/replay a write.
  const metadata = await adapter.tab(7); results.push({ case: 'metadata after activeTab', title: metadata.title || '', url: metadata.url });
  assert.ok(metadata.title.startsWith('Local Chrome Control '));
  let shot = await adapter.run('page_snapshot', { tab_id: 7 }, origin, Date.now() + 8000, async () => {}, {}, policy);
  assert.ok(shot.title.startsWith('Local Chrome Control '), 'Only the owned synthetic fixture is permitted');
  const action = async (method, label, value, frame) => {
    const target = shot.elements.find(e => e.label === label && (frame ? e.frame === frame : !e.frame));
    assert.ok(target, label);
    const progress = { dispatched: false };
    try {
      await adapter.run(method, { tab_id: 7, snapshot_id: shot.snapshot_id, ref: target.ref, ...(value === undefined ? {} : { value }) }, origin, Date.now() + 8000, async () => {}, progress, policy);
      shot = await adapter.run('page_snapshot', { tab_id: 7 }, origin, Date.now() + 8000, async () => {}, {}, policy);
      results.push({ case: method + ' ' + label, frame, passed: true, text_tail: shot.text.slice(-150) });
    } catch (error) { results.push({ case: method + ' ' + label, frame, passed: false, code: error.code, message: error.message, dispatched: progress.dispatched }); throw error; }
  };
  const same = shot.elements.find(e => e.label === 'Same frame input').frame;
  await action('page_fill', 'Same frame input', 'Same input', same);
  await action('page_click', '框架计数', undefined, same);
  const cross = shot.elements.find(e => e.label === 'Cross frame input').frame;
  await action('page_fill', 'Cross frame input', 'Cross input', cross);
  await action('page_click', '框架计数', undefined, cross);
  assert.match(shot.text, /跨源框架[\s\S]*框架计数1/);
  await fs.writeFile(path.join(output, 'snapshot.json'), JSON.stringify(shot, null, 2));
  const controller = new Controller(adapter, { async loadLedger() { return {}; }, async saveLedger() {} });
  await controller.grant({ id: 7, url: origin }, { mode: 'extended' });
  const lease = await controller.execute('tab_claim', { tab_id: 7, task_name: 'Disposable navigation regression' });
  await controller.execute('page_navigate', { tab_id: 7, lease_id: lease.lease_id, request_id: 'probe-cross-site-' + Date.now(), url: 'http://localhost:19321/second?mode=extended' });
  await pause(100);
  const navigated = await controller.execute('page_snapshot', { tab_id: 7, lease_id: lease.lease_id });
  assert.ok(navigated.title.includes('第二网站'));
  results.push({ case: 'controller confirms cross-site navigation and retains its lease', passed: true, title: navigated.title });
  await controller.execute('tab_release', { tab_id: 7, lease_id: lease.lease_id });
  pointerServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Strict pointer regression fixture</title><div style="height:1200px">Initial spacer</div><nav style="position:sticky;top:0;background:white"><button aria-label="Strict menu">Open menu</button><div role="dialog" hidden>Menu opened with trusted complete pointer events</div><pre></pre></nav><div style="height:2200px">Trailing spacer</div><script>let hovered=false,armed=false;const button=document.querySelector("button"),events=[];button.addEventListener("mouseenter",e=>{hovered=e.isTrusted;events.push("enter:"+e.isTrusted)});button.addEventListener("mousedown",e=>{armed=e.isTrusted&&hovered&&e.buttons===1;events.push("down:"+e.buttons)});button.addEventListener("mouseup",e=>events.push("up:"+e.buttons));button.addEventListener("click",e=>{if(armed&&e.isTrusted)document.querySelector("[role=dialog]").hidden=false;document.querySelector("pre").textContent=events.join(",")+",scrollY:"+scrollY});scrollTo(0,1800);</script>');
  });
  pointerServer.listen(0, '127.0.0.1'); await once(pointerServer, 'listening');
  const pointerOrigin = 'http://127.0.0.1:' + pointerServer.address().port;
  await adapter.run('page_navigate', { tab_id: 7, url: pointerOrigin }, origin, Date.now() + 8000, async () => {}, {}, policy);
  await pause(100);
  const pointerShot = await adapter.run('page_snapshot', { tab_id: 7 }, pointerOrigin, Date.now() + 8000, async () => {}, {}, policy);
  const button = pointerShot.elements.find(e => e.label === 'Strict menu'); assert.ok(button);
  await adapter.run('page_click', { tab_id: 7, snapshot_id: pointerShot.snapshot_id, ref: button.ref }, pointerOrigin, Date.now() + 8000, async () => {}, {}, policy);
  const opened = await adapter.run('page_snapshot', { tab_id: 7 }, pointerOrigin, Date.now() + 8000, async () => {}, {}, policy);
  await fs.writeFile(path.join(output, 'pointer-snapshot.json'), JSON.stringify(opened, null, 2));
  assert.ok(opened.text.includes('Menu opened with trusted complete pointer events')); assert.ok(opened.text.includes('enter:true')); assert.ok(opened.text.includes('down:1,up:0'));
  const newMetadata = await adapter.tab(7); assert.equal(newMetadata.title, 'Strict pointer regression fixture');
  results.push({ case: 'trusted hover/down/up opens strict menu; metadata follows navigation', passed: true, text: opened.text });
} catch (error) { failed = true; results.push({ case: 'probe stopped without replay', code: error.code, message: error.message }); }
finally {
  await fs.writeFile(path.join(output, 'trace.json'), JSON.stringify(trace, null, 2));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: !failed, results }, null, 2));
  pointerServer?.closeAllConnections(); pointerServer?.close();
  socket?.close(); child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), pause(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  await fs.rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: !failed, results, trace: path.join(output, 'trace.json') }, null, 2));
}
if (failed) process.exitCode = 1;
