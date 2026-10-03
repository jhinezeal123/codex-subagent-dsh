/**
 * Phép thử quyết định: giao việc dài qua API của web host, rồi STEER giữa lúc nó
 * đang chạy — để chứng minh web host làm được đúng thứ bạn cần ở đầu cuộc trò chuyện:
 * "nhận prompt mới ngay, không phải chờ làm hết".
 *
 * Dùng: node web-steer-test.mjs [cwd]
 */
import { call, list } from './dsh-web.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const text = (t) => [{ type: 'text', text: t }];
const cwd = process.argv[2] || 'C:\\Users\\DELL\\.dsh';

const runningOf = async (id) => (await list()).find((s) => s.sessionId === id)?.running ?? false;
const waitFor = async (id, want, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await runningOf(id)) === want) return true;
    await sleep(2000);
  }
  return false;
};

// 1) tạo session mới — nó sẽ hiện trong GUI của bạn
const created = await call('session/create', { request: { cwd } });
const sessionId = created.sessionId;
log(`tao session ${sessionId} (cwd ${cwd}) — mo GUI se thay no`);

// 2) giao việc dài
await call('session/prompt', {
  request: {
    requestId: crypto.randomUUID(), sessionId, mode: 'queue', clientTimeZone: 'Asia/Bangkok',
    content: text('Chạy lệnh PowerShell: Start-Sleep -Seconds 120 . Khi lệnh xong, trả lời đúng một từ: SLEEP-DONE'),
  },
});
log('da giao viec dai (mode=queue)');

const started = await waitFor(sessionId, true, 60000);
log(`session dang chay = ${started}`);
if (!started) { log('KHONG chay duoc -> dung'); process.exitCode = 1; }

// 3) STEER giữa lúc đang chạy
const steer = await call('session/prompt', {
  request: {
    requestId: crypto.randomUUID(), sessionId, mode: 'steer', clientTimeZone: 'Asia/Bangkok',
    content: text('DỪNG ngay việc đang làm, đừng chờ lệnh ngủ xong. Trả lời đúng một từ: STEER-OK'),
  },
});
log(`steer tra ve: ${JSON.stringify(steer)}`);

// 4) chờ kết thúc rồi đọc lịch sử thật
const ended = await waitFor(sessionId, false, 120000);
const page = await call('session/page', { request: { sessionId, throughSeq: -1, maxMessages: 20 } });
log(`da ket thuc = ${ended}`);
const found = (JSON.stringify(page).match(/"text":"[^"]{1,160}"/g) ?? []).slice(-8);
log('cac doan text cuoi trong lich su:');
for (const t of found) log('   ', t);
