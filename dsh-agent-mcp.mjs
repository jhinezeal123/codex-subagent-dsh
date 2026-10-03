#!/usr/bin/env node
/**
 * dsh-agent-mcp — MCP server (stdio) bọc CLI dsh-agent thành tool cho Codex/GPT.
 *
 * stdout CHỈ chứa JSON-RPC frame; mọi output của CLI được capture rồi trả về
 * trong tool result. Không phụ thuộc SDK nào: MCP stdio = JSON-RPC 2.0, mỗi
 * frame một dòng.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-agent.mjs');
const PROTOCOL = '2024-11-05';

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ code: 1, out: '', err: String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const TOOLS = [
  {
    name: 'dsh_subagent_new',
    description: 'Tạo một DSH subagent mới và giao việc cho nó. Chạy nền: trả về id ngay, KHÔNG chờ xong. Theo dõi bằng dsh_subagent_history/status.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Việc cần giao cho subagent (tiếng Việt hoặc tiếng Anh).' },
        cwd: { type: 'string', description: 'Thư mục làm việc của subagent; mặc định là thư mục hiện tại.' },
        label: { type: 'string', description: 'Nhãn ngắn để dễ nhận biết trong danh sách.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_subagent_send',
    description: 'Gửi tin nhắn tiếp theo cho subagent đã có, GIỮ NGUYÊN ngữ cảnh. Mặc định xếp hàng: subagent nhận sau khi làm xong turn đang chạy. Dùng dsh_subagent_steer nếu muốn chen vào giữa turn.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent (dạng session-xxxx…).' },
        message: { type: 'string', description: 'Nội dung gửi.' },
        wait: { type: 'boolean', description: 'true = chờ tới khi xong và trả về câu trả lời cuối.' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'dsh_subagent_steer',
    description: 'Chen tin nhắn vào GIỮA turn đang chạy: subagent nhận ngay ở bước kế tiếp và đổi hướng, KHÔNG huỷ bước đang làm. Dùng khi cần chỉnh hướng giữa chừng mà không muốn mất việc. (Cần web GUI đang chạy.)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent.' },
        message: { type: 'string', description: 'Nội dung cần chèn ngay.' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'dsh_subagent_interrupt',
    description: 'Interrupt subagent đang chạy: dừng việc nó đang làm NGAY (không chờ turn xong). Nếu kèm message thì prompt mới được gửi ngay sau khi dừng.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent.' },
        message: { type: 'string', description: 'Tuỳ chọn: prompt mới gửi ngay sau khi interrupt.' },
        wait: { type: 'boolean', description: 'true = chờ prompt mới chạy xong.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dsh_subagent_stop',
    description: 'Dừng subagent đang chạy (giữ nguyên session để gửi tiếp sau).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id subagent.' } },
      required: ['id'],
    },
  },
  {
    name: 'dsh_subagent_history',
    description: 'Xem lịch sử làm việc của subagent (từng run, tool call, tool result, câu trả lời). Hỗ trợ limit/offset để lấy N mục gần nhất.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent.' },
        limit: { type: 'number', description: 'Số mục lấy ra (mặc định 30).' },
        offset: { type: 'number', description: 'Bỏ qua bao nhiêu mục tính từ mới nhất (0 = mới nhất).' },
        all: { type: 'boolean', description: 'true = hiện cả dòng status/thinking.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dsh_subagent_list',
    description: 'Liệt kê các subagent hiện có kèm trạng thái (running/idle/stopped/error).',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'true = gồm cả subagent đã dừng.' } } },
  },
];

async function callTool(name, args) {
  const a = args ?? {};
  switch (name) {
    case 'dsh_subagent_new': {
      const argv = ['new', a.task];
      if (a.cwd) argv.push('--cwd', a.cwd);
      if (a.label) argv.push('--label', a.label);
      return runCli(argv);
    }
    case 'dsh_subagent_send': {
      const argv = ['send', a.id, a.message];
      if (a.wait) argv.push('--wait');
      return runCli(argv);
    }
    case 'dsh_subagent_steer': {
      return runCli(['steer', a.id, a.message]);
    }
    case 'dsh_subagent_stop': {
      return runCli(['stop', a.id]);
    }
    case 'dsh_subagent_interrupt': {
      const argv = ['interrupt', a.id];
      if (a.message) argv.push(a.message);
      if (a.wait) argv.push('--wait');
      return runCli(argv);
    }
    case 'dsh_subagent_history': {
      const argv = ['history', a.id, '--limit', String(a.limit ?? 30), '--offset', String(a.offset ?? 0)];
      if (a.all) argv.push('--all');
      return runCli(argv);
    }
    case 'dsh_subagent_list': {
      const argv = ['list'];
      if (a.all) argv.push('--all');
      return runCli(argv);
    }
    default: return { code: 1, out: '', err: `unknown tool: ${name}` };
  }
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-agent', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      const r = await callTool(name, args);
      const text = [r.out.trim(), r.err.trim()].filter(Boolean).join('\n');
      reply({ content: [{ type: 'text', text: text || '(khong co output)' }], isError: r.code !== 0 });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'shutdown':
      reply({});
      process.exit(0);
      return;
    default:
      // notification (khong co id) thi bo qua im lang
      if (id !== undefined) fail(-32601, `method not found: ${method}`);
  }
}

let buf = '';
let pending = 0;
let ended = false;
const maybeExit = () => { if (ended && pending === 0) process.exit(0); };

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    pending += 1;
    // Chỉ thoát khi mọi request đã trả lời xong: stdin đóng ngay sau khi gửi
    // (pipe, script test) không được cắt ngang tool call đang chạy.
    Promise.resolve(handle(frame)).catch(() => {}).finally(() => { pending -= 1; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
