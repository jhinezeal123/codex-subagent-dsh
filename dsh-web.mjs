#!/usr/bin/env node
/**
 * dsh-web — nói chuyện với DSH web host ĐANG CHẠY qua HTTP API của chính nó.
 *
 * Vì sao tồn tại: web host đã là một tiến trình thường trú, giữ agent trong RAM,
 * và phơi sẵn session/list, session/create, session/prompt (mode queue|steer),
 * session/cancel "giữ hàng đợi", session/page (lịch sử). Không cần plugin,
 * không cần daemon mới — chỉ cần token của `dsh web`.
 *
 * ponytail: chỉ HTTP + fetch, không thư viện, không Websocket (polling đủ dùng).
 *
 * Chuẩn bị token: mở URL mà `dsh web` in ra (dạng http://127.0.0.1:3080/?token=XXX),
 * lưu XXX vào file .web-token cạnh script này.
 *
 * Dùng:
 *   node dsh-web.mjs list
 *   node dsh-web.mjs call session/list '{}'
 *   node dsh-web.mjs call session/page '{"request":{"sessionId":"...","throughSeq":-1,"maxMessages":10}}'
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = process.env.DSH_WEB_TOKEN_FILE || path.join(DIR, '.web-token');
const COOKIE_FILE = process.env.DSH_WEB_COOKIE_FILE || path.join(DIR, '.web-cookie');
const STATE_FILE = process.env.DSH_WEB_STATE_FILE || path.join(DIR, '.web-host.json');
const HOST_LOG = path.join(DIR, '.web-host.log');
const DEFAULT_BASE = 'http://127.0.0.1:3080';

/**
 * Runtime = cặp {base, cookie}, tự tìm theo 3 nấc — KHÔNG cần thao tác tay:
 *   1. cookie đã lưu (secret ký cookie nằm trong credentials store, nên cookie
 *      30 ngày vẫn dùng được sau khi host restart — không cần token mới);
 *   2. token trong env `DSH_WEB_TOKEN` hoặc file `.web-token` -> đổi lấy cookie;
 *   3. tự khởi động host riêng (`dsh web --no-open --port 0`) rồi BẮT token từ
 *      stdout của chính nó — đúng cách bạn đọc token trên màn hình terminal.
 */
let RUNTIME = null;
let DSH_BIN = process.env.DSH_BIN || null;

/** CLI truyền vào đường dẫn `lib/bin.js` đã dò được (tránh dò trùng 2 nơi). */
export function configure({ dshBin } = {}) {
  if (dshBin) DSH_BIN = dshBin;
}

const readCookieJar = () => { try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch { return {}; } };
const saveCookieJar = (jar) => fs.writeFileSync(COOKIE_FILE, `${JSON.stringify(jar, null, 2)}\n`);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (o) => fs.writeFileSync(STATE_FILE, `${JSON.stringify(o, null, 2)}\n`);
const authorityOf = (base) => base.replace(/^https?:\/\//, '');

function readTokenFile() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}

/**
 * Các base đáng thử. Ưu tiên GUI bạn tự mở (3080) trước host riêng của tool:
 * cùng một host thì bạn vừa xem vừa gõ tay vào session được, không bị 2 host
 * cùng giữ agent của một session.
 */
function candidateBases() {
  const list = [];
  if (process.env.DSH_WEB_BASE) list.push(process.env.DSH_WEB_BASE);
  list.push(DEFAULT_BASE);
  const st = readState();
  if (st.base) list.push(st.base);
  return [...new Set(list.map((b) => b.replace(/\/+$/, '')))];
}

/**
 * 200 = host sống và cookie dùng được; 401 = host sống nhưng cookie sai; 0 = không có host.
 *
 * Dùng `session/page` chứ KHÔNG dùng `session/list`: list phải quét toàn workspace
 * (đo được 0.5-5s với 158 session), còn page ~75ms. Session id cố tình không tồn
 * tại — host vẫn trả HTTP 200 kèm `ok:false`, đủ để biết cookie hợp lệ.
 */
async function probe(base, cookie) {
  try {
    const res = await fetch(`${base}/api/session/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe',
        method: 'session/page',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-probe' }, throughSeq: 0, maxMessages: 1 } } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 401 ? 401 : (res.status < 500 ? 200 : res.status);
  } catch { return 0; }
}

/** Đổi token lấy cookie (token chỉ dùng đúng ở bước này). */
async function login(base, token) {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('dsh-auth-'));
  return raw ? raw.split(';')[0] : null;
}

/** Chờ host tự in URL có token ra log rồi bắt lấy. */
async function waitForTokenUrl(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const text = fs.existsSync(HOST_LOG) ? fs.readFileSync(HOST_LOG, 'utf8') : '';
    const m = text.match(/https?:\/\/[^\s"']*\?token=[A-Za-z0-9_-]+/);
    if (m) return m[0];
    if (Date.now() - t0 > timeoutMs) throw new Error(`host khong in URL trong ${Math.round(timeoutMs / 1000)}s — xem ${HOST_LOG}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Nấc 3: tự dựng host riêng, lấy token từ stdout của nó. */
async function startOwnHost() {
  if (!DSH_BIN) throw new Error(`khong biet duong dan dsh de tu khoi dong host (dat DSH_BIN, hoac chay qua dsh-agent.mjs)`);
  // Khoá: 2 lệnh chạy song song (vd Codex gọi 2 tool) không được dựng 2 host.
  const lock = `${STATE_FILE}.lock`;
  const fresh = () => { try { return Date.now() - fs.statSync(lock).mtimeMs < 300000; } catch { return false; } };
  if (fs.existsSync(lock) && fresh()) {
    for (let i = 0; i < 360; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const rt = await ready({ autoStart: false }).catch(() => null);
      if (rt) return rt;
    }
    fs.rmSync(lock, { force: true }); // khoá treo -> tu chiem
  }
  fs.writeFileSync(lock, String(process.pid));
  try {
    const st = readState();
    if (st.pid) { try { process.kill(st.pid); } catch { /* host cu da chet */ } }
    fs.writeFileSync(HOST_LOG, '');
    const out = fs.openSync(HOST_LOG, 'a');
    const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--port', '0'], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.unref();
    const url = new URL(await waitForTokenUrl(180000));
    const base = `${url.protocol}//${url.host}`;
    const token = url.searchParams.get('token');
    const cookie = await login(base, token);
    if (!cookie) throw new Error(`host ${base} da len nhung khong doi duoc cookie`);
    const jar = readCookieJar();
    jar[authorityOf(base)] = cookie;
    saveCookieJar(jar);
    saveState({ pid: child.pid, base, token, startedAt: new Date().toISOString() });
    return { base, cookie, started: true };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Tìm host dùng được (mặc định có tự dựng host nếu chưa có gì). */
export async function ready({ autoStart = true, fast = false } = {}) {
  if (RUNTIME) return RUNTIME;
  const jar = readCookieJar();
  for (const base of candidateBases()) { // 1. cookie đã lưu
    const c = jar[authorityOf(base)];
    if (!c) continue;
    // fast: TIN cookie đang có, khỏi probe. Probe = gọi `session/list`, mà host
    // quét 158 session mất ~1.2s -> quá đắt cho hook (ngân sách vài giây).
    // Cookie hỏng thì `call()` gặp 401 và tự chạy lại ready() đầy đủ đúng 1 lần.
    if (fast) { RUNTIME = { base, cookie: c }; return RUNTIME; }
    if (await probe(base, c) === 200) { RUNTIME = { base, cookie: c }; return RUNTIME; }
  }
  const token = (process.env.DSH_WEB_TOKEN || '').trim() || readTokenFile(); // 2. token -> cookie
  const tokens = [token, readState().token].filter(Boolean);
  if (tokens.length) {
    for (const base of candidateBases()) {
      if (await probe(base, null) === 0) continue;
      for (const t of tokens) {
        const c = await login(base, t);
        if (c && await probe(base, c) === 200) {
          const next = readCookieJar();
          next[authorityOf(base)] = c;
          saveCookieJar(next);
          RUNTIME = { base, cookie: c };
          return RUNTIME;
        }
      }
    }
  }
  if (autoStart) { RUNTIME = await startOwnHost(); return RUNTIME; } // 3. tự dựng host
  throw new Error(`khong ket noi duoc DSH web host (da thu: ${candidateBases().join(', ')})`);
}

/** Thông tin host đang dùng, để in ra cho người dùng. */
export async function hostInfo() {
  const rt = await ready({ autoStart: false });
  const st = readState();
  return { base: rt.base, ours: st.base === rt.base, pid: st.base === rt.base ? st.pid : null, state: st };
}

/** Dừng host do tool tự dựng (KHÔNG đụng GUI bạn tự mở). */
export function stopOwnHost() {
  const st = readState();
  if (!st.pid) return { stopped: false, reason: 'khong co host nao do tool dung' };
  try { process.kill(st.pid); } catch { /* đã chết */ }
  saveState({});
  RUNTIME = null;
  return { stopped: true, pid: st.pid, base: st.base };
}

/** Gọi 1 endpoint RPC. args là object có ĐÚNG tên tham số của hàm phía host. */
export async function call(method, args = {}, retried = false) {
  const rt = await ready();
  const body = {
    type: 'client-request',
    rpcId: `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    payload: { args },
  };
  const res = await fetch(`${rt.base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: rt.cookie },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { // cookie hỏng -> tìm lại từ đầu đúng 1 lần
    await res.body?.cancel();
    RUNTIME = null;
    if (retried) throw new Error('HTTP 401: DSH authentication failed after retry');
    await ready();
    return call(method, args, true);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const msg = JSON.parse(text);
  if (!msg.result?.ok) throw new Error(`${msg.result?.error?.code ?? 'loi'}: ${msg.result?.error?.message ?? text.slice(0, 300)}`);
  return msg.result.value;
}

/** Danh sách session đang có trong GUI (kèm trạng thái sống). */
export async function list() {
  const { items } = await call('session/list', { _request: {} });
  return items;
}

// ------------------------------------------------------- backend subagent
// Tầng trên của transport: các thao tác mà CLI/MCP cần. Session id của web host
// CHÍNH LÀ id subagent (nó cũng là id bạn thấy trong GUI).

const AGENTS_HOME = process.env.DSH_AGENTS_HOME
  || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'agents');
const INDEX = path.join(AGENTS_HOME, 'web-index.json');

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; }
}
function writeIndex(obj) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Host có dùng được không (dùng để CLI tự chọn đường web hay headless). */
export async function up({ autoStart = true, fast = false } = {}) {
  try {
    await ready({ autoStart, fast });
    return true;
  } catch {
    return false;
  }
}

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const textBlock = (t) => [{ type: 'text', text: t }];

export async function create(cwd) {
  return call('session/create', { request: { cwd } });
}

/** mode: 'queue' = chờ hết turn hiện tại; 'steer' = vào thẳng turn đang chạy. */
export async function prompt(sessionId, text, mode = 'queue') {
  // session từng bị archive thì agent bị chặn chạy; gửi việc = ngầm khôi phục.
  await unarchive(sessionId).catch(() => {});
  return call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode,
      content: textBlock(text),
      ...localZone() === undefined ? {} : { clientTimeZone: localZone() },
    },
  });
}

export async function cancel(sessionId) {
  return call('session/cancel', { request: { sessionId } });
}

/**
 * Ẩn session khỏi danh sách (đúng cơ chế menu "Archive session" của GUI).
 * DSH không có xoá cứng: archive = soft delete, khôi phục được trong GUI, và
 * agent của session đó bị chặn chạy tiếp cho tới khi unarchive.
 */
export async function archive(sessionId) {
  return call('workspace/archiveSession', { request: { sessionId, stopActivity: true } });
}

export async function unarchive(sessionId) {
  return call('workspace/unarchiveSession', { request: { sessionId } });
}

export async function one(sessionId) {
  return (await list()).find((s) => s.sessionId === sessionId);
}

export async function isRunning(sessionId) {
  return (await one(sessionId))?.running ?? false;
}

/** Chờ tới khi session không còn chạy. Trả về true nếu đã dừng. */
export async function waitIdle(sessionId, timeoutMs = 3 * 60 * 60 * 1000, onTick) {
  const t0 = Date.now();
  for (;;) {
    if (!(await isRunning(sessionId))) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    if (onTick) onTick();
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const textOf = (content) => (Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '');

/** Đọc 1 trang lịch sử (message-aligned), mới nhất ở cuối. */
/**
 * Đọc trang record cuối của session. KHÔNG gọi `session/list` để lấy asOfSeq:
 * list() phải quét toàn bộ workspace (~2s với 158 session), còn session/page chỉ
 * ~30-70ms. Host tự trả cursor khi throughSeq vượt quá ("past cursor 2273") — dùng
 * luôn con số đó thay vì đi hỏi list(). Session không tồn tại -> ném `session/not-found`.
 */
export async function readPage(sessionId, maxMessages = 30) {
  const body = (throughSeq) => ({
    request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: Math.max(1, maxMessages) },
  });
  try {
    return await call('session/page', body(Number.MAX_SAFE_INTEGER));
  } catch (e) {
    const m = /past cursor (\d+)/.exec(e?.message ?? '');
    if (!m) throw e;
    return call('session/page', body(Number(m[1])));
  }
}

/** Câu trả lời cuối cùng trong 1 danh sách record (record bọc trong {event}). */
export function answerFrom(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]?.event ?? records[i];
    if (r?.type === 'assistant/message') {
      const t = textOf(r.data?.message?.content);
      if (t.trim()) return t;
    }
  }
  return '';
}

/** Trả lời cuối cùng của agent (dùng cho --wait). */
export async function lastAnswer(sessionId) {
  const { records } = await readPage(sessionId, 30).catch(() => ({ records: [] }));
  return answerFrom(records);
}

const clip = (s, n) => {
  const one = String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
const looksInjected = (t) => /^Current runtime context|^<system-reminder>|^This is an automatically generated checkpoint/.test(String(t ?? ''));

/** Đổi 1 record của session/page thành 1 dòng người đọc được (null = bỏ). */
export function renderRecord(record, verbose = false) {
  const r = record?.event ?? record; // session/page bọc event trong {event: ...}
  if (!r?.type) return null;
  const d = r.data ?? {};
  const t = new Date(r.time || Date.now()).toLocaleTimeString('vi-VN', { hour12: false });
  switch (r.type) {
    case 'user/message': {
      const text = textOf(d.content);
      if (!text.trim() || looksInjected(text)) return null;
      return `nguoi: ${clip(text, 400)}`;
    }
    case 'assistant/message': {
      const parts = Array.isArray(d.message?.content) ? d.message.content : [];
      const reasoning = parts.filter((p) => p?.type === 'reasoning').map((p) => p.text).join(' ');
      const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
      const rows = [];
      if (verbose && reasoning.trim()) rows.push(`thinking: ${clip(reasoning, 300)}`);
      if (text.trim()) rows.push(`assistant: ${clip(text, 500)}`);
      return rows.length ? rows.join('\n') : null;
    }
    case 'tool/call': return `tool: ${d.name}(${clip(d.arguments, 300)})`;
    case 'tool/result': return `  ↳ ${clip(textOf(d.message?.content) || d.message?.source?.kind || 'ok', 300)}`;
    case 'turn/end': return `── turn ${d.turn} ket thuc${d.reason?.kind ? ` (${d.reason.kind}${d.reason.reason?.kind ? `:${d.reason.reason.kind}` : ''})` : ''}`;
    case 'error': return `error: ${clip(JSON.stringify(d), 300)}`;
    default: return verbose ? `${t} ${r.type}` : null;
  }
}

/** Ghi nhớ subagent do tool tạo (để `list` biết cái nào là của mình). */
export function remember(sessionId, info) {
  const idx = readIndex();
  idx[sessionId] = { ...info, createdAt: info.createdAt ?? new Date().toISOString() };
  writeIndex(idx);
}

/** Quên một subagent (khi đã archive/xoá). */
export function forget(sessionId) {
  const idx = readIndex();
  if (!(sessionId in idx)) return false;
  delete idx[sessionId];
  writeIndex(idx);
  return true;
}

/** Danh sách subagent do tool tạo (mới nhất trước). */
export function entries() {
  return Object.entries(readIndex())
    .map(([sessionId, info]) => ({ sessionId, ...info }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ------------------------------------------------------------- báo cáo lên cha
/**
 * Nhận id HOẶC tên: model hay gọi tên thay vì id (native Codex cũng cho gọi
 * `target` bằng canonical task name). Chấp nhận cả `/root/x`, `/dsh/x`, `x`.
 * Không khớp gì thì trả nguyên input để host tự báo lỗi (đừng đoán bừa).
 */
export function resolve(target) {
  if (!target) return target;
  const idx = readIndex();
  if (idx[target]) return target;
  const want = String(target).toLowerCase().replace(/^\/(root|dsh)\//, '');
  const hit = Object.entries(idx).find(([, i]) => String(i.label ?? '').toLowerCase() === want)
    ?? Object.entries(idx).find(([, i]) => String(i.label ?? '').toLowerCase().startsWith(want));
  return hit ? hit[0] : target;
}

/**
 * Bọc 1 báo cáo theo ĐÚNG format mà Codex dùng cho sub-agent native của nó
 * (`<multi_agent_role>`: "You will receive messages in the analysis channel in the
 * form: Message Type / Task name / Sender / Payload"). Nhờ vậy model đọc báo cáo
 * của ta bằng đúng phản xạ nó đã có, không phải học format mới.
 */
export function envelope(r) {
  const payload = String(r.answer ?? '').trim() || '(khong co cau tra loi)';
  return `Message Type: FINAL_ANSWER\nTask name: ${r.label || r.id}\nSender: ${r.id}\nPayload:\n${payload}`;
}

/**
 * Báo cáo CHƯA ĐỌC: subagent đã kết thúc ít nhất 1 turn mới kể từ lần báo trước.
 * Watermark `reportedSeq` nằm trong index nên KHÔNG cần tiến trình nền: cha hỏi
 * lúc nào thì tính lúc đó (Codex hook gọi vào đây mỗi lần mở turn).
 */
export async function reports({ ids = null, markRead = true, limit = Infinity } = {}) {
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error('report limit must be a non-negative integer');
  }
  const idx = readIndex();
  if (Object.keys(idx).length === 0) return []; // chưa giao việc cho ai -> khỏi gọi host
  const wanted = ids ? ids.map((i) => resolve(i)) : null;
  const out = [];
  for (const [sessionId, info] of Object.entries(idx)) {
    if (out.length >= limit) break;
    if (wanted && !wanted.includes(sessionId)) continue;
    // Không dùng session/list: chậm (~2s) và không cần. Session đã archive/xoá thì
    // readPage ném `session/not-found` -> coi như không còn gì để báo.
    const { records } = await readPage(sessionId, 80).catch(() => ({ records: [] }));
    let lastEnd = null;
    for (const rec of records) {
      const r = rec?.event ?? rec;
      if (r?.type === 'turn/end') lastEnd = r;
    }
    if (lastEnd === null || lastEnd.seq <= (info.reportedSeq ?? 0)) continue;
    // Only use messages from the completed turn. A later turn can already be
    // running, and an interrupted turn must not inherit an older answer.
    const endIndex = records.findLastIndex((rec) => (rec?.event ?? rec) === lastEnd);
    let startIndex = endIndex - 1;
    while (startIndex >= 0 && (records[startIndex]?.event ?? records[startIndex])?.type !== 'turn/end') startIndex -= 1;
    out.push({
      id: sessionId,
      label: info.label ?? null,
      turn: lastEnd.data?.turn ?? null,
      reason: lastEnd.data?.reason?.kind ?? null,
      answer: answerFrom(records.slice(startIndex + 1, endIndex)),
    });
    if (markRead) idx[sessionId] = { ...info, reportedSeq: lastEnd.seq, reportedAt: new Date().toISOString() };
  }
  if (markRead && out.length) writeIndex(idx);
  return out;
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      const items = await list();
      for (const s of items) {
        console.log(`${s.running ? 'CHAY ' : '     '} ${s.sessionId}  ${s.cwd}  ${s.projections?.values?.title ?? ''}`);
      }
      console.log(`(${items.length} session)`);
    } else if (cmd === 'tail') {
      // Lịch sử kiểu tail: lấy từ projections.turnOutline của session/list
      const [id, n] = [rest[0], Number(rest[1] ?? 3)];
      const s = (await list()).find((x) => x.sessionId === id);
      if (!s) throw new Error(`khong thay session ${id}`);
      const outline = s.projections?.values?.turnOutline ?? [];
      for (const t of outline.slice(-n)) {
        console.log(`--- turn ${t.turn} (seq ${t.seq}) ---`);
        console.log(`NGUOI: ${String(t.prompt ?? '').slice(0, 400)}`);
        console.log(`AGENT: ${String(t.response ?? '').slice(0, 600)}`);
      }
      console.log(`(session ${id}: running=${s.running}, ${outline.length} turn)`);
    } else if (cmd === 'host') {
      // Quản lý host: status | start | stop
      const sub = rest[0] ?? 'status';
      if (sub === 'stop') console.log(JSON.stringify(stopOwnHost(), null, 2));
      else if (sub === 'start') {
        const rt = await ready();
        console.log(JSON.stringify({ base: rt.base, started: rt.started === true, reused: rt.started !== true }, null, 2));
      } else {
        const info = await hostInfo().catch((e) => ({ error: String(e.message ?? e) }));
        console.log(JSON.stringify({ ...info, status: info.error ? 'down' : 'up' }, null, 2));
      }
    } else if (cmd === 'call') {
      // JSON có thể truyền trực tiếp, hoặc qua stdin bằng '-' (Windows/PowerShell hay phá quote)
      const raw = rest[1] === '-' || (rest[1] === undefined && !process.stdin.isTTY) ? fs.readFileSync(0, 'utf8') : rest[1];
      const out = await call(rest[0], raw ? JSON.parse(raw) : {});
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('dung: node dsh-web.mjs list | call <method> [json-args|-]');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}
