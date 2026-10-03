#!/usr/bin/env node
/**
 * dsh-agent-mcp — MCP server (stdio) biến DSH session thành "subagent" cho Codex.
 *
 * THIẾT KẾ: bắt chước đúng bộ tool `multi_agent` native của Codex
 * (namespace `functions.collaboration.*`, xem `codex debug prompt-input`):
 *
 *   native spawn_agent     -> dsh_subagent_spawn
 *   native followup_task   -> dsh_subagent_followup
 *   native send_message    -> dsh_subagent_message
 *   native wait_agent      -> dsh_subagent_wait
 *   native interrupt_agent -> dsh_subagent_interrupt
 *   native list_agents     -> dsh_subagent_list
 *   (native không có)      -> dsh_subagent_history   [lợi thế riêng của DSH]
 *
 * Báo cáo trả về đúng envelope mà Codex dạy model đọc cho sub-agent native:
 *   Message Type: FINAL_ANSWER
 *   Task name: <tên>   Sender: <id>   Payload: <nội dung>
 *
 * stdout CHỈ chứa JSON-RPC frame; mọi output của CLI được capture rồi trả về
 * trong tool result. Không phụ thuộc SDK nào: MCP stdio = JSON-RPC 2.0, mỗi
 * frame một dòng.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { envelope } from './dsh-web.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-agent.mjs');
const PROTOCOL = '2024-11-05';
/** Nhịp phát progress; hạ xuống thấp trong test (DSH_MCP_PROGRESS_MS=500). */
const PROGRESS_MS = Math.max(100, Number(process.env.DSH_MCP_PROGRESS_MS ?? 10000) || 10000);

/** Ghi chú định tuyến: model đọc 7 description rời sẽ không thấy "hệ thống". */
const INSTRUCTIONS = `dsh-agent: DSH session đóng vai subagent cho Codex.

Bộ tool này SONG SONG với multi_agent native. Chọn đúng bên:
- Việc ngắn, trong cùng phiên, không cần xem lại  -> sub-agent NATIVE (spawn_agent...).
- Việc dài hơi, cần session BỀN (sống qua restart Codex), cần đọc lại toàn bộ
  lịch sử, cần mở lại trong GUI DSH, hoặc cần model khác -> dsh_subagent_*.

Primitive (ánh xạ 1-1 với native):
- Tạo việc:      dsh_subagent_spawn
- Nói với agent: dsh_subagent_followup (mở turn mới) | dsh_subagent_message (vào turn đang chạy)
- Vòng đời:      dsh_subagent_wait | dsh_subagent_interrupt
- Đọc:           dsh_subagent_list | dsh_subagent_history

Quy tắc:
1. Không đoán id. Không chắc thì gọi dsh_subagent_list trước. Mọi tool nhận cả
   id lẫn name đã đặt lúc spawn (kể cả dạng /dsh/<name> hoặc /root/<name>).
2. Giao việc xong thì gọi dsh_subagent_wait (chờ phút, đừng poll liên tục), hoặc
   để báo cáo tự tới qua hook UserPromptSubmit. Mỗi báo cáo chỉ được giao MỘT
   lần: ai đọc trước (wait hay hook) thì người kia không thấy nữa.
3. Mỗi subagent chỉ nên có MỘT người điều khiển tại một thời điểm: đừng gửi
   song song followup và message cho cùng một agent.
4. Báo cáo chỉ nghĩa là "agent nói đã xong", KHÔNG phải bằng chứng đã đúng. Cần
   chắc thì đọc dsh_subagent_history hoặc tự kiểm chứng artifact.
5. Không có resume sau interrupt mode="agent"; tool này không tạo subagent lồng
   nhau (native mới có); không có streaming realtime — dùng wait.
6. Việc sửa code: chia sao cho mỗi subagent ghi vào tập file RỜI NHAU (native
   cũng dặn "disjoint write set") — hai agent sửa cùng file là tự tạo conflict.
7. wait có trần thời gian thật: hết giờ nó trả "unconfirmed" (chưa xác nhận),
   KHÔNG phải thất bại, và KHÔNG huỷ subagent. Chờ quá ~2 phút chỉ nên làm khi
   server đã đặt "tool_timeout_sec" đủ lớn (Codex kill tool call khi hết hạn và
   trả lỗi cứng).
8. progress notification của MCP chỉ hiện trên UI, model KHÔNG thấy. Muốn báo
   tiến độ cho người dùng thì viết vào chính câu trả lời của bạn.

Không làm gì: không sửa file giúp bạn, không chạy lệnh trong repo của bạn, không
verify kết quả thay bạn.`;

const TOOLS = [
  {
    name: 'dsh_subagent_spawn',
    description:
      'Tạo subagent DSH mới (native: spawn_agent) và giao việc đầu tiên; chạy nền, trả id ngay, KHÔNG chờ xong. '
      + 'Use when việc dài hơi / cần session bền xem lại được trong GUI / cần model riêng. '
      + 'NOT for: giao thêm việc cho agent đã có (dùng dsh_subagent_followup), hay việc ngắn trong phiên (sub-agent native rẻ hơn).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Việc cần giao, viết như giao cho người: mục tiêu, ranh giới, cách kiểm, cần trả về gì.' },
        cwd: { type: 'string', description: 'Thư mục làm việc của subagent; mặc định thư mục hiện tại của Codex.' },
        name: { type: 'string', description: 'Tên ngắn dễ đọc (native: task name), dùng làm Task name trong báo cáo.' },
        context: { type: 'string', description: 'Bối cảnh seed cho session trắng. DSH KHÔNG fork được session nên chỉ nhận text (hoặc "none").' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_subagent_followup',
    description:
      'Giao việc MỚI cho subagent đã có (native: followup_task): giữ nguyên ngữ cảnh và MỞ một turn mới. '
      + 'NOT for: nhắn vào turn đang chạy (dùng dsh_subagent_message).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent (hoặc name đã đặt lúc spawn).' },
        task: { type: 'string', description: 'Việc mới.' },
        wait: { type: 'boolean', description: 'true = chờ xong rồi trả báo cáo (mặc định false: xếp hàng rồi trả ngay).' },
      },
      required: ['id', 'task'],
    },
  },
  {
    name: 'dsh_subagent_message',
    description:
      'Nhắn vào turn ĐANG CHẠY (native: send_message): subagent nhận ở bước kế tiếp, đổi hướng ngay, không mở turn mới và không huỷ bước đang làm. '
      + 'NOT for: agent đang rảnh (dùng dsh_subagent_followup) hoặc muốn dừng việc đang làm (dùng dsh_subagent_interrupt).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent.' },
        message: { type: 'string', description: 'Nội dung cần chèn ngay. Viết rõ ràng: người cũng đọc được dòng này.' },
      },
      required: ['id', 'message'],
    },
  },
  {
    name: 'dsh_subagent_wait',
    description:
      'Chờ tới khi có báo cáo của subagent (native: wait_agent). Nên chờ DÀI (phút) thay vì gọi liên tục. '
      + 'Trả về báo cáo của agent xong trước theo envelope FINAL_ANSWER. '
      + 'Ba kết cục phân biệt: reported (có báo cáo) / nothing-new (không ai còn chạy, không có gì mới) / unconfirmed (hết giờ, CHƯA xác nhận — không phải thất bại). '
      + 'NOT for: hỏi trạng thái tức thì (dùng dsh_subagent_list).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Chỉ chờ những subagent này. Bỏ trống = chờ bất kỳ subagent nào do tool tạo.' },
        timeout_ms: { type: 'number', description: 'Trần chờ, mặc định 120000 (2 phút), tối đa 600000 (10 phút).' },
      },
    },
  },
  {
    name: 'dsh_subagent_interrupt',
    description:
      'Dừng việc subagent đang làm (native: interrupt_agent). mode="turn" (mặc định) = huỷ turn hiện tại, GIỮ agent để giao việc tiếp; mode="agent" = dừng hẳn agent/session. '
      + 'Kèm message = giao việc mới ngay sau khi dừng. '
      + 'NOT for: đổi hướng mà không muốn mất bước đang làm (dùng dsh_subagent_message).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id subagent.' },
        mode: { type: 'string', enum: ['turn', 'agent'], description: 'turn = chỉ huỷ turn đang chạy (mặc định); agent = dừng hẳn.' },
        message: { type: 'string', description: 'Tuỳ chọn: việc mới gửi ngay sau khi dừng.' },
        wait: { type: 'boolean', description: 'true = chờ việc mới chạy xong.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dsh_subagent_list',
    description:
      'Liệt kê subagent DSH kèm trạng thái (native: list_agents). Gọi cái này TRƯỚC khi dùng id bạn không chắc. '
      + 'reports_only=true: chỉ trả BÁO CÁO CHƯA ĐỌC theo envelope native — đây là thứ hook UserPromptSubmit gọi để đẩy báo cáo vào context; không có báo cáo thì trả về rỗng. '
      + 'NOT for: đọc nội dung công việc (dùng dsh_subagent_history) hay chờ kết quả (dùng dsh_subagent_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true = gồm mọi session trong GUI, không chỉ subagent do tool tạo.' },
        reports_only: { type: 'boolean', description: 'true = chỉ trả báo cáo chưa đọc (dùng cho hook).' },
        mark_read: { type: 'boolean', description: 'Với reports_only: true (mặc định) = đánh dấu đã đọc; false = chỉ xem.' },
      },
    },
  },
  {
    name: 'dsh_subagent_history',
    description:
      'Đọc lịch sử làm việc của subagent: từng turn, tool call, tool result, câu trả lời. Hỗ trợ limit/offset kiểu tail. '
      + 'NOT for: kiểm tra xong/chưa xong (dùng dsh_subagent_list hoặc dsh_subagent_wait); không có streaming realtime.',
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
];

/**
 * title + annotations: Codex surface cho UI và cho quyết định approval. Khai đúng
 * sự thật: chỉ `history` là thuần đọc; `wait`/`list` TIÊU THỤ báo cáo (có ghi);
 * `interrupt` phá huỷ trạng thái đang chạy.
 */
const ANNOTATIONS = {
  dsh_subagent_spawn: { title: 'Spawn DSH subagent', readOnlyHint: false, destructiveHint: false },
  dsh_subagent_followup: { title: 'Give follow-up task to DSH subagent', readOnlyHint: false, destructiveHint: false },
  dsh_subagent_message: { title: 'Message a running DSH subagent', readOnlyHint: false, destructiveHint: false },
  dsh_subagent_wait: { title: 'Wait for a DSH subagent report', readOnlyHint: false, destructiveHint: false },
  dsh_subagent_interrupt: { title: 'Interrupt or stop a DSH subagent', readOnlyHint: false, destructiveHint: true },
  dsh_subagent_list: { title: 'List DSH subagents', readOnlyHint: false, destructiveHint: false },
  dsh_subagent_history: { title: 'Read DSH subagent history', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};
for (const t of TOOLS) {
  const a = ANNOTATIONS[t.name];
  t.title = a.title;
  t.annotations = a;
}

/** Chạy CLI, tuỳ chọn gọi onTick mỗi 10s để phát progress cho client. */function runCli(args, { onTick } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = onTick ? setInterval(onTick, PROGRESS_MS) : null;
    const done = (r) => { if (timer) clearInterval(timer); resolve(r); };
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => done({ code: 1, out: '', err: String(e) }));
    child.on('close', (code) => done({ code, out, err }));
  });
}

/** wait/reports trả JSON có cấu trúc -> render lại thành envelope native. */
function renderJson(out) {
  let j;
  try { j = JSON.parse(out); } catch { return null; }
  if (j?.outcome === 'nothing-new') return { text: '(khong co bao cao moi: khong con subagent nao dang chay)', empty: true };
  if (j?.outcome === 'unconfirmed') {
    return { text: `(chua xac nhan: het ${Math.round((j.waitedMs ?? 0) / 1000)}s ma chua co bao cao — subagent VAN CO THE dang chay)`, unconfirmed: true };
  }
  if (Array.isArray(j?.reports)) {
    if (!j.reports.length) return { text: '', empty: true };
    return { text: j.reports.map((r) => envelope(r)).join('\n\n') };
  }
  return null;
}

async function callTool(name, args, ctx = {}) {
  const a = args ?? {};
  const tick = ctx.onTick;
  switch (name) {
    case 'dsh_subagent_spawn': {
      const seeded = a.context && a.context !== 'none' ? `Boi canh:\n${a.context}\n\nViec:\n${a.task}` : a.task;
      const argv = ['new', seeded];
      if (a.cwd) argv.push('--cwd', a.cwd);
      if (a.name) argv.push('--label', a.name);
      return runCli(argv, { onTick: tick });
    }
    case 'dsh_subagent_followup': {
      const argv = ['send', a.id, a.task];
      if (a.wait) argv.push('--wait');
      return runCli(argv, { onTick: tick });
    }
    case 'dsh_subagent_message':
      return runCli(['steer', a.id, a.message], { onTick: tick });
    case 'dsh_subagent_wait': {
      const ids = Array.isArray(a.ids) ? a.ids.filter(Boolean) : [];
      const timeout = Math.min(Math.max(Number(a.timeout_ms ?? 120000) || 120000, 1000), 600000);
      const r = await runCli(['wait', ...ids, '--timeout', String(timeout), '--json'], { onTick: tick });
      if (r.code === 0 || r.code === 3) {
        const j = renderJson(r.out);
        if (j !== null) return { code: 0, out: j.text, err: r.err, unconfirmed: j.unconfirmed === true };
      }
      return r;
    }
    case 'dsh_subagent_interrupt': {
      if (a.mode === 'agent') {
        const argv = ['stop', a.id];
        if (a.wait) argv.push('--wait');
        return runCli(argv, { onTick: tick });
      }
      const argv = ['interrupt', a.id];
      if (a.message) argv.push(a.message);
      if (a.wait) argv.push('--wait');
      return runCli(argv, { onTick: tick });
    }
    case 'dsh_subagent_list': {
      if (a.reports_only === true) {
        const argv = ['reports', '--json'];
        if (a.mark_read === false) argv.push('--peek');
        const r = await runCli(argv, { onTick: tick });
        const j = renderJson(r.out);
        // Không có báo cáo -> trả rỗng để hook không bơm rác vào context.
        if (j !== null) return { code: 0, out: j.empty ? '' : j.text, err: r.err, empty: j.empty === true };
        return r;
      }
      const argv = ['list'];
      if (a.all) argv.push('--all');
      return runCli(argv, { onTick: tick });
    }
    case 'dsh_subagent_history': {
      const argv = ['history', a.id, '--limit', String(a.limit ?? 30), '--offset', String(a.offset ?? 0)];
      if (a.all) argv.push('--all');
      return runCli(argv, { onTick: tick });
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
        serverInfo: { name: 'dsh-agent', version: '0.2.0' },
        instructions: INSTRUCTIONS,
      });
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      const token = params?._meta?.progressToken;
      let n = 0;
      // Codex có notification `item/mcpToolCall/progress` -> phát progress để TUI
      // không trông như treo khi wait chờ vài phút.
      const onTick = token === undefined ? undefined : () => {
        n += 1;
        send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: token, progress: n, message: `${name}: van dang chay (${Math.round((n * PROGRESS_MS) / 1000)}s)…` },
        });
      };
      const r = await callTool(name, args, { onTick });
      const text = [r.out.trim(), r.err.trim()].filter(Boolean).join('\n');
      // exit 3 = "chưa xác nhận" (hết giờ chờ) — KHÔNG phải lỗi.
      const isError = r.code !== 0 && r.unconfirmed !== true;
      reply({ content: text ? [{ type: 'text', text }] : [], isError });
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
