import { LineDecoder } from './framing.mjs';
import { TOOLS } from './tools.mjs';
import { discover, bridgeCall, publicSession } from './bridge-client.mjs';
import { VERSION, errorObject, ControlError } from '../extension/protocol.mjs';

const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
let initialized = false;
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const asText = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
function validateToolArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ControlError('INVALID_ARGUMENT', '参数必须是对象。');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new ControlError('INVALID_ARGUMENT', '不支持的参数：' + key);
    const spec = tool.inputSchema.properties[key];
    const value = args[key];
    if (spec.type === 'string' && (typeof value !== 'string' || (spec.maxLength && value.length > spec.maxLength))) throw new ControlError('INVALID_ARGUMENT', key + ' 无效。');
    if (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < (spec.minimum || 0) || value > (spec.maximum ?? Infinity))) throw new ControlError('INVALID_ARGUMENT', key + ' 无效。');
    if (spec.enum && !spec.enum.includes(value)) throw new ControlError('INVALID_ARGUMENT', key + ' 必须是 ' + spec.enum.join('、') + ' 之一。');
  }
  for (const key of tool.inputSchema.required) if (args[key] === undefined) throw new ControlError('INVALID_ARGUMENT', '缺少参数：' + key);
}
async function handle(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') { rpcError(message?.id, -32600, 'Invalid Request'); return; }
  if (message.id === undefined) return; // Notifications never cause browser actions.
  const id = message.id;
  if (message.method === 'initialize') {
    initialized = true;
    result(id, {
      protocolVersion: SUPPORTED.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'local-chrome-control', version: VERSION },
      instructions: 'Only use when the user chooses Local Chrome Control. The user must authorize a tab in its Chrome popup. List sessions/tabs, claim a lease, then take a snapshot. Use only fresh snapshot refs. Follow all existing consent and safety rules. Never bypass another tool’s policy denial. Never automatically retry writes after timeout: inspect the page and request_status first. Release the lease when finished.'
    });
    return;
  }
  if (message.method === 'ping') { result(id, {}); return; }
  if (!initialized) { rpcError(id, -32002, 'Initialize first'); return; }
  if (message.method === 'tools/list') { result(id, { tools: TOOLS }); return; }
  if (message.method !== 'tools/call') { rpcError(id, -32601, 'Method not found'); return; }
  const tool = TOOLS.find(t => t.name === message.params?.name);
  if (!tool) { rpcError(id, -32602, 'Unknown tool'); return; }
  try {
    const args = message.params.arguments || {};
    validateToolArgs(tool, args);
    const data = tool.name === 'sessions_list' ? { sessions: (await discover()).map(publicSession) } : await bridgeCall(tool.name, args);
    if (tool.name === 'page_screenshot') {
      result(id, { content: [{ type: 'image', mimeType: data.mime_type, data: data.data },
        { type: 'text', text: JSON.stringify({ elapsed_ms: data.elapsed_ms }) }] });
    } else result(id, asText(data));
  } catch (error) {
    result(id, { ...asText(errorObject(error)), isError: true });
  }
}
const decoder = new LineDecoder(message => { void handle(message).catch(() => rpcError(message?.id, -32603, 'Internal error')); });
process.stdin.on('data', chunk => {
  try { decoder.push(chunk); } catch { rpcError(null, -32700, 'Parse error or oversized message'); process.exitCode = 1; process.stdin.destroy(); }
});
process.stdout.on('error', () => process.exit(0));
