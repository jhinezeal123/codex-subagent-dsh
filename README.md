# codex-subagent-dsh — DSH session làm subagent cho Codex

Biến **session DSH** (bền, xem lại được trong GUI, sống qua restart Codex) thành subagent gọi được
từ Codex. Thiết kế **bắt chước đúng bộ tool `multi_agent` native của Codex** để model không phải
học vocabulary mới, và dùng **hook `UserPromptSubmit`** làm kênh ngược để subagent báo cáo về cha.

Tách riêng khỏi `C:\Users\DELL\dsh-subagents` để cô lập, đóng gói, dễ quản lí.

## Bộ tool: 7 cái, ánh xạ 1-1 với native

| Tool của ta | Native của Codex | Việc |
|---|---|---|
| `dsh_subagent_spawn` | `spawn_agent` | Tạo subagent + giao việc đầu, **trả id ngay** (không chờ) |
| `dsh_subagent_followup` | `followup_task` | Giao việc mới, giữ ngữ cảnh, **mở turn mới** |
| `dsh_subagent_message` | `send_message` | Nhắn vào turn **đang chạy**, không mở turn mới, không cắt bước đang làm |
| `dsh_subagent_wait` | `wait_agent` | Chờ tới khi có báo cáo (long-poll, backoff 1→8s) |
| `dsh_subagent_interrupt` | `interrupt_agent` (+ `close_agent`) | `mode:"turn"` dừng turn · `mode:"agent"` dừng hẳn |
| `dsh_subagent_list` | `list_agents` | Danh sách + trạng thái · `reports_only:true` = hộp thư báo cáo |
| `dsh_subagent_history` | *(native không có)* | Đọc lịch sử từng turn/tool call — **lợi thế riêng của DSH** |

Mọi tool nhận **id hoặc name** (kể cả dạng `/dsh/<name>`, `/root/<name>`) — giống cách native gọi
subagent bằng canonical task name. `spawn` trả về cả `agent_id`, `nickname`, `canonical_task_name`,
`thread_id` theo đúng tên field của native.

MCP server còn gửi `instructions` trong `initialize` (bản đồ định tuyến: khi nào dùng native, khi nào
dùng ta) vì 7 description rời rạc không tạo thành "hệ thống" trong đầu model.

## Báo cáo về cha: 2 đường, đúng format native

Format envelope y hệt thứ Codex dạy model đọc cho subagent native:

```
Message Type: FINAL_ANSWER
Task name: <name đặt lúc spawn>
Sender: <session id>
Payload:
<câu trả lời cuối>
```

| Đường | Cơ chế | Dùng khi |
|---|---|---|
| **Push** (mặc định) | Hook `UserPromptSubmit` gọi `hook-reports.mjs` → bơm `additionalContext` vào turn mới | Cha không muốn chặn; báo cáo tự tới ở turn kế tiếp |
| **Pull** | `dsh_subagent_wait` → CLI `wait` long-poll → trả envelope | Cha cần kết quả *ngay bây giờ* |

Báo cáo chỉ giao **một lần**: ai đọc trước (hook hay wait) thì đường kia không thấy nữa. Watermark
`reportedSeq` nằm trong `web-index.json` nên **không cần tiến trình nền** — cha hỏi lúc nào tính lúc đó.

Ba kết cục của `wait` phân biệt rõ, không làm tròn thành "thành công":
`reported` (có báo cáo) · `nothing-new` (không ai còn chạy) · `unconfirmed` (hết giờ, **chưa** xác nhận — exit 3).

## Nối vào Codex (dán tay — repo này KHÔNG tự sửa config của bạn)

**1. MCP server** — sửa `[mcp_servers.dsh-agent]` trong `~/.codex/config.toml` trỏ về repo mới, và
thêm `tool_timeout_sec` (mặc định của Codex **không rõ nhưng >150s**, hết hạn là **lỗi cứng + kill
connection**, nên phải đặt tường minh):

```toml
[mcp_servers.dsh-agent]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\Documents\codex_subagent_dsh\dsh-agent-mcp.mjs']
startup_timeout_sec = 60
tool_timeout_sec = 900                      # 15 phút: đủ cho wait dài, tránh bị kill giữa chừng
default_tools_approval_mode = "approve"     # không thì approval_policy="never" sẽ chặn tool call
```

**2. Hook kênh ngược** — copy [`hooks.example.json`](hooks.example.json) thành `~/.codex/hooks.json`
(hoặc dán vào `.codex/hooks.json` của project), rồi mở `/hooks` trong Codex để **trust** (hook chưa
trust thì Codex không chạy; có `--dangerously-bypass-hook-trust` cho một lần).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": null,
        "hooks": [{ "type": "command",
                    "command": "node \"D:\\Documents\\codex_subagent_dsh\\hook-reports.mjs\"",
                    "commandWindows": "node \"D:\\Documents\\codex_subagent_dsh\\hook-reports.mjs\"",
                    "timeoutSec": 3, "additionalContextLimit": 0 }] }
    ]
  }
}
```

Hợp đồng này lấy từ schema sinh bởi chính Codex
(`codex-rs/hooks/schema/generated/user-prompt-submit.command.{input,output}.schema.json`): stdin là
`{cwd, hook_event_name, model, permission_mode, prompt, session_id, transcript_path, turn_id}`, stdout
nhận `hookSpecificOutput.additionalContext`. Đã đo: hook tự chạy mất **0.23s** khi chưa có báo cáo.

**3. (tuỳ chọn) `AGENTS.md`** — vì `multi_agent` của Codex đang bật (`stable true`), Codex sẽ ưu tiên
subagent của chính nó. Muốn nó chọn ta khi cần session bền, thêm vào `AGENTS.md`:

```md
Khi cần subagent sống lâu, xem lại được lịch sử, hoặc chạy bằng model khác: dùng MCP tool
`dsh_subagent_*` thay cho subagent native. Việc ngắn trong phiên thì dùng native.
```

## Số đo thật (không phải suy đoán)

| Việc | Trước | Sau |
|---|---|---|
| Hook `UserPromptSubmit` (không có báo cáo) | 5.4s + **crash** `uv\win\async.c` | **0.23s**, exit 0 |
| `dsh-agent host status` | 5.29s | **0.78s** |
| `dsh-agent reports --json` | 5.30s | **0.65s** |
| `dsh-agent list` | 1.97s | 1.97s (host phải quét 158 session — không tránh được) |
| `session/page` 1 session | 2.0s (kèm `session/list`) | **24-75ms** |
| `spawn` → `wait` → envelope | — | 6-10s (1 turn thật của model) |

Hai nguyên nhân gốc đã sửa:
1. `probe()` gọi `session/list` (host quét cả workspace, 0.5-5s) → đổi sang `session/page` (~75ms,
   vẫn phân biệt đúng `200` / `401` / host chết).
2. `readPage()` gọi `one()` → `list()` chỉ để lấy `asOfSeq`; nay lấy cursor từ chính lỗi
   `"session page through seq N is past cursor M"` mà host trả về (2 RPC × ~30ms thay vì 1 × 2s).

Và một bug thật: `process.exit()` sau `fetch` trên Windows làm libuv abort
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) — hook phải dùng `process.exitCode` rồi để
event loop tự cạn.

## Học từ native: copy gì, KHÔNG copy gì

**Copy:** tên & ngữ nghĩa tool; envelope `FINAL_ANSWER`; `spawn` trả ngay + `wait` chờ dài
("prefer longer waits (minutes) to avoid busy polling"); `send_message` tách khỏi `followup_task`;
định danh bằng id **hoặc** tên; khuyến cáo chia việc để mỗi subagent ghi vào **tập file rời nhau**.

**Không copy:**
- **4 concurrency slot** của Codex — DSH chạy ngoài hệ slot đó, không tốn slot nào của Codex.
- **`fork_turns` full-history** — DSH không có RPC fork session; ta chỉ nhận seed text (`context`).
- **Subagent lồng nhau** — con của ta không tự spawn con (native mới có).
- **Streaming realtime** — không có; muốn biết tiến độ thì đọc `history`.
- **Blocking-by-default** — `spawn` không chờ; `wait` có trần thời gian.

## Dùng tay (CLI)

```powershell
node dsh-agent.mjs new "Doc repo nay, tom tat kien truc trong 10 dong" --cwd D:\Documents\myrepo --label review
node dsh-agent.mjs list
node dsh-agent.mjs reports                    # bao cao chua doc (envelope native)
node dsh-agent.mjs reports --peek --json      # chi xem, khong tieu thu
node dsh-agent.mjs wait review --timeout 120000
node dsh-agent.mjs history review --limit 20 --offset 20
node dsh-agent.mjs steer review "Doi huong: tap trung phan auth"    # chen giua turn
node dsh-agent.mjs send review "Lam tiep phan test" --wait
node dsh-agent.mjs interrupt review "Dung het, tra loi ngan: xong"
node dsh-agent.mjs stop review                # dung han
node dsh-agent.mjs rm review                  # don rac (archive, khoi phuc duoc)
node dsh-agent.mjs host status | host stop
```

## Không phải bật gì cả

| Nấc | Khi nào | Làm gì |
|---|---|---|
| 1 | Bình thường | Dùng **cookie đã lưu** (`.web-cookie`) nói chuyện với GUI đang mở; cookie sống 30 ngày, qua cả restart GUI |
| 2 | Chưa có cookie | Đọc token `.web-token` (hoặc `$DSH_WEB_TOKEN`) → đổi cookie → lưu lại |
| 3 | Không host nào sống | **Tự dựng host riêng** (`dsh web --no-open --port 0`) và tự bắt token từ stdout — như bạn đọc token trên màn hình, chỉ khác là máy đọc hộ |

Host tự dựng dùng chung kho session với GUI; `host stop` chỉ tắt host **do tool dựng**, không bao giờ
đụng GUI bạn tự mở. Hai lệnh chạy song song không dựng 2 host (khoá `.web-host.json.lock`).

## File

| File | Vai trò |
|---|---|
| [dsh-agent-mcp.mjs](dsh-agent-mcp.mjs) | MCP server stdio: 7 tool + `instructions` + `notifications/progress` |
| [dsh-agent.mjs](dsh-agent.mjs) | CLI: `new/send/steer/interrupt/stop/wait/reports/history/list/status/host`, runner headless `__run` |
| [dsh-web.mjs](dsh-web.mjs) | Transport web: tìm/dựng host, token→cookie, `session/*`, `envelope()`, `reports()`, `resolve()` |
| [hook-reports.mjs](hook-reports.mjs) | Hook `UserPromptSubmit`: bơm báo cáo chưa đọc vào context cha |
| [hooks.example.json](hooks.example.json) | Mẫu hook để dán vào `~/.codex/hooks.json` |
| [mcp-test.mjs](mcp-test.mjs) | **Live eval** 8 bước cho tầng MCP (spawn→wait→envelope→hook path→progress→interrupt) |
| [hook-test.mjs](hook-test.mjs) | **Live eval** kênh ngược: rỗng → envelope → chỉ giao một lần |
| [e2e-real.mjs](e2e-real.mjs) | **E2E với Codex THẬT**: `CODEX_HOME` tạm (không đụng config của bạn) → Codex gọi MCP của ta → subagent chạy → hook bơm báo cáo vào turn sau |
| [web-e2e-test.mjs](web-e2e-test.mjs), [web-steer-test.mjs](web-steer-test.mjs), [web-cancel-test.mjs](web-cancel-test.mjs), [web-ops-test.mjs](web-ops-test.mjs) | E2E cũ: new→steer→history→rm, steer giữa turn, cancel, 3 thao tác chen ngang |
| `.web-cookie`, `.web-token`, `.web-host.json*` | Trạng thái host/cookie (**đừng chia sẻ, đã gitignore**) |
| `%DSH_HOME%\agents\web-index.json` | Nhớ subagent nào do tool tạo + watermark báo cáo |

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DSH_WEB_BASE` | `http://127.0.0.1:3080` | Ưu tiên host ở địa chỉ này |
| `DSH_WEB_TOKEN` | — | Token, thay cho file `.web-token` |
| `DSH_AGENTS_HOME` | `%DSH_HOME%\agents` | Nơi lưu index + trạng thái headless |
| `DSH_BIN` | tự dò bản `@deepseek-ai/dsh` mới nhất trên đĩa | Ghim `lib/bin.js` |
| `DSH_MCP_PROGRESS_MS` | `10000` | Nhịp progress notification (test hạ xuống 500) |

## Giới hạn đã biết

- **`notifications/progress` không tới model** (đo được: Codex gửi `progressToken`, UI hiện tiến độ,
  nhưng model không thấy gì). Đừng thiết kế luồng nghiệp vụ dựa vào nó — muốn báo tiến độ thì viết
  vào câu trả lời.
- `wait` quá ~2 phút chỉ nên dùng khi đã đặt `tool_timeout_sec`; hết hạn tool call = lỗi cứng, mất kết quả.
- `session/list` chậm dần theo số session (158 session → ~2s). `list`/`wait`/`status` đều đi qua nó;
  đường đọc báo cáo thì không.
- `steer` không cắt bước đang chạy (đúng thiết kế): tool call đang chạy vẫn xong, agent đổi hướng ở
  bước kế tiếp. Muốn cắt ngay thì `interrupt`.
- `rm` = **archive** (mềm). Xoá cứng thì xoá `%DSH_HOME%\sessions\<slug>\<id>\` khi host đã tắt.
- API web là **RPC nội bộ của host**, không phải surface có cam kết như `dsh headless`; DSH đổi shape
  thì lỗi hiện rõ (`gateway/…`) và vẫn còn đường `--headless`.
- Hook `additionalContext` bị "spill" ra đĩa nếu vượt ngưỡng token (`null` = 2500; ta đặt
  `additionalContextLimit: 0` = không spill, và tự cắt mỗi báo cáo ở 4000 ký tự).

## Tự kiểm tra

```powershell
node dsh-agent.mjs selftest     # đơn vị: so version, cửa sổ limit/offset, render lịch sử, answerFrom
node mcp-test.mjs               # live eval 8 bước (spawn thật, wait thật, hook path, progress, interrupt)
node hook-test.mjs              # live eval kênh ngược (payload stdin giả đúng schema Codex)
node e2e-real.mjs               # E2E với Codex thật trong CODEX_HOME tạm (3 phép kiểm, tự dọn)
node web-e2e-test.mjs           # new -> steer giua chung -> history -> rm
```

Kết quả E2E thật (`e2e-real.mjs`, chạy trên máy này):

```
1. Codex goi duoc MCP tool cua ta : PASS
2. Subagent DSH chay that         : PASS
3. Hook bom envelope vao turn 2   : PASS (thay so 6 chu so chi subagent biet)
```

Phép kiểm thứ 3 được làm chặt: subagent tự sinh một số 6 chữ số rồi trả về, Codex ở turn sau phải in
lại **nguyên văn envelope kèm đúng con số đó** — thứ duy nhất nó không thể biết nếu hook không bơm.

## Nguồn (đã đọc trực tiếp)

- Subagents: <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
- Hooks: <https://learn.chatgpt.com/docs/hooks.md> · schema: `codex-rs/hooks/schema/generated/`
- Prompt thật model thấy: `codex debug prompt-input` (block `<multi_agent_role>`, 2429 ký tự)
- Protocol: `codex app-server generate-json-schema --out <DIR>`
