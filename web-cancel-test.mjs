/**
 * Phép thử 2: session/cancel phải DỪNG NGAY turn đang chạy (khác steer).
 * Dùng: node web-cancel-test.mjs
 */
import { call, list } from './dsh-web.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const runningOf = async (id) => (await list()).find((s) => s.sessionId === id)?.running ?? false;

const created = await call('session/create', { request: { cwd: 'C:\\Users\\DELL\\.dsh' } });
const sessionId = created.sessionId;
log(`tao session ${sessionId}`);

await call('session/prompt', {
  request: {
    requestId: crypto.randomUUID(), sessionId, mode: 'queue', clientTimeZone: 'Asia/Bangkok',
    content: [{ type: 'text', text: 'Chạy lệnh PowerShell: Start-Sleep -Seconds 300 . Sau đó trả lời: SLEEP-DONE' }],
  },
});

const t0 = Date.now();
while (Date.now() - t0 < 60000) { if (await runningOf(sessionId)) break; await sleep(2000); }
log(`dang chay = ${await runningOf(sessionId)}`);

const tCancel = Date.now();
const res = await call('session/cancel', { request: { sessionId } });
log(`cancel tra ve: ${JSON.stringify(res)}`);

while (Date.now() - tCancel < 90000) { if (!(await runningOf(sessionId))) break; await sleep(1000); }
const stopped = !(await runningOf(sessionId));
log(`da dung = ${stopped} | sau ${Math.round((Date.now() - tCancel) / 1000)} giay (neu < 120 la da cat that)`);

const s = (await list()).find((x) => x.sessionId === sessionId);
const outline = s.projections?.values?.turnOutline ?? [];
log(`so turn = ${outline.length}, asOfSeq = ${s.projections?.asOfSeq}`);
for (const t of outline.slice(-2)) log(`  turn ${t.turn}: NGUOI=${String(t.prompt).slice(0, 80)} | AGENT=${String(t.response).slice(0, 120)}`);

// thử page với throughSeq = cursor that
const asOfSeq = s.projections?.asOfSeq;
if (asOfSeq !== undefined) {
  const page = await call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 3 } });
  log(`page(throughSeq=${asOfSeq}): ${page.records.length} record, hasMore=${page.hasMore}`);
  for (const r of page.records) log('   ', JSON.stringify(r.event ?? r).slice(0, 160));
}
