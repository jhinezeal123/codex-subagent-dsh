# dsh-agent — DSH subagent như một tool cho Codex/GPT

Biến các khả năng bạn yêu cầu thành lệnh CLI + MCP tool cho Codex.

| Yêu cầu | Lệnh CLI | MCP tool |
|---|---|---|
| Tạo subagent mới | `dsh-agent new "<task>"` | `dsh_subagent_new` |
| Tiếp tục, **giữ nguyên ngữ cảnh** | `dsh-agent send <id> "<msg>"` | `dsh_subagent_send` |
| **Chen vào giữa turn, không bỏ việc đang làm** | `dsh-agent steer <id> "<msg>"` | `dsh_subagent_steer` |
| Interrupt: dừng ngay + prompt mới | `dsh-agent interrupt <id> "<msg>"` | `dsh_subagent_interrupt` |
| Interrupt: dừng hẳn | `dsh-agent stop <id>` | `dsh_subagent_stop` |
| Xem lịch sử (limit/offset) | `dsh-agent history <id> --limit N --offset M` | `dsh_subagent_history` |
| Danh sách / trạng thái | `dsh-agent list [--all]`, `status <id>` | `dsh_subagent_list` |
| Dọn subagent rác | `dsh-agent rm <id>` / `unarchive <id>` | `dsh_subagent_rm` / `dsh_subagent_unarchive` |

## Không phải bật gì cả

Gõ lệnh là chạy. Tool tự lo phần kết nối, theo 3 nấc:

| Nấc | Khi nào | Làm gì |
|---|---|---|
| 1 | Bình thường | Dùng **cookie đã lưu** (`.web-cookie`) nói chuyện với GUI bạn đang mở. Cookie sống 30 ngày và **vẫn dùng được sau khi restart GUI**, vì secret ký cookie nằm trong credentials store chứ không phải trong RAM. |
| 2 | Chưa có cookie | Đọc token trong `.web-token` (hoặc `$DSH_WEB_TOKEN`) → đổi lấy cookie → lưu lại. |
| 3 | Không có host nào sống | **Tự khởi động host riêng** (`dsh web --no-open --port 0`) rồi **tự bắt token từ stdout của nó** — đúng cách bạn đọc token trên màn hình terminal, chỉ khác là máy đọc hộ. |

Nấc 3 nghĩa là bạn **không cần mở GUI trước**, và **không phải dán token** bao giờ nữa. Host tự dựng
dùng chung kho session với GUI, nên subagent vẫn hiện trong GUI khi bạn mở lên sau. Ưu tiên vẫn là
GUI (nếu nó sống) để bạn vừa xem vừa gõ tay vào cùng một host.

Quản lý host tự dựng: `dsh-agent host status` · `host start` · `host stop` (không bao giờ đụng vào GUI bạn tự mở).
Hai lệnh chạy song song không dựng 2 host (có khoá `.web-host.json.lock`).

## Hai đường chạy

| | **WEB** (mặc định) | **HEADLESS** (dự phòng, `--headless`) |
|---|---|---|
| Cách nói chuyện | HTTP vào web host, tự dựng nếu chưa có | spawn `dsh headless --json`, prompt qua stdin |
| Agent | sống trong RAM host (`agentInRam: true`) | dựng lại từ log mỗi lượt |
| `steer` | **có thật** (`mode=steer` → `agent.steer()`) | không có |
| `stop`/`interrupt` | `session/cancel` — dừng ~1-5s, log ghi `aborted:user` | `taskkill /T /F` process tree |
| Lịch sử | `session/page`: tool call + arguments + result | NDJSON do runner tee ra |
| Nhìn thấy trong GUI | **có** — session bình thường, xem/gõ tay/Stop được | không |
| Dùng khi | luôn luôn, nếu máy còn chạy được `dsh web` | web hỏng / muốn tiết kiệm RAM |

## File

| File | Vai trò |
|---|---|
| [dsh-agent.mjs](dsh-agent.mjs) | CLI + runner headless (`__run`) + dispatch 2 đường. |
| [dsh-web.mjs](dsh-web.mjs) | Transport web: tìm/dựng host, token→cookie, `session/*`, `workspace/archiveSession`. |
| [dsh-agent-mcp.mjs](dsh-agent-mcp.mjs) | MCP server stdio, 9 tool cho Codex. |
| [web-e2e-test.mjs](web-e2e-test.mjs) | E2E: new → steer giữa chừng → history → rm. |
| [web-steer-test.mjs](web-steer-test.mjs), [web-cancel-test.mjs](web-cancel-test.mjs), [web-ops-test.mjs](web-ops-test.mjs) | Test riêng cho steer / cancel / 3 thao tác chen ngang. |
| `.web-cookie` | Cookie theo từng host. **Đừng chia sẻ.** |
| `.web-host.json`, `.web-host.log` | Host do tool tự dựng: pid, port, token, log. |
| `.web-token` | Token `dsh web` (tuỳ chọn, chỉ dùng ở nấc 2). |
| `%DSH_HOME%\agents\web-index.json` | Nhớ subagent nào do tool tạo. |

## Cách hoạt động (đường WEB)

RPC nội bộ của host, qua HTTP:

| Method | Việc |
|---|---|
| `session/list` | mọi session + `running` + projections |
| `session/create` | tạo session mới (hiện trong GUI), hoặc adopt session cũ qua `sessionId` |
| `session/prompt` | gửi việc; `mode:"queue"` xếp hàng, `mode:"steer"` → `agent.steer()` |
| `session/cancel` | dừng turn đang chạy, **giữ hàng đợi** |
| `session/page` | lịch sử: `user/message`, `assistant/message`, `tool/call`, `tool/result`, `turn/end` |
| `workspace/archiveSession` | ẩn session khỏi danh sách (= menu Archive của GUI). DSH **không có xoá cứng**. |

Đo thực tế: steer được nhận lúc `running=true` và **không** tạo turn thứ hai — một `Start-Sleep 40`
vẫn chạy xong rồi agent trả lời theo hướng mới. `stop` cắt `Start-Sleep 300` trong **1-5 giây**,
log ghi `turn/end (aborted:user)`. Gửi việc cho session đã archive thì tool tự unarchive trước.

## Dùng tay

```powershell
dsh-agent new "Doc repo nay va tom tat kien truc trong 10 dong" --cwd D:\Documents\myrepo --label review
dsh-agent list
dsh-agent status session-91ed4074-17e7-49e2-96cc-6925e555dfd9
dsh-agent history <id> --limit 20                 # 20 muc moi nhat
dsh-agent history <id> --limit 20 --offset 20     # trang truoc
dsh-agent steer <id> "Doi huong: tap trung vao phan auth"     # chen giua turn
dsh-agent send <id> "Lam tiep phan test" --wait    # xep hang, cho xong
dsh-agent interrupt <id> "Dung het, tra loi ngan gon: xong" --wait
dsh-agent stop <id>
dsh-agent rm <id>                                  # don rac (archive)
dsh-agent host status | host stop
dsh-agent new "..." --headless                     # ep duong cu
```

`new`/`send`/`steer` mặc định **chạy nền** (trả về ngay) — đúng kiểu tool cho model. `--wait` khi muốn chặn.

**Id quyết định đường đi**: `session-<uuid>` (web host tạo) đi đường web; `s-xxxxxx` (subagent cũ của
đường headless) tự đi đường headless — `status`/`history`/`send` dùng được cho cả hai.

## Nối vào Codex

Đã có trong `C:\Users\DELL\.codex\config.toml` (bản gốc: `config.toml.bak-dsh-agent`):

```toml
[mcp_servers.dsh-agent]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\DELL\dsh-subagents\dsh-agent-mcp.mjs']
startup_timeout_sec = 60
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DSH_WEB_BASE` | `http://127.0.0.1:3080` | Ưu tiên host ở địa chỉ này. |
| `DSH_WEB_TOKEN` | — | Token, thay cho file `.web-token`. |
| `DSH_AGENTS_HOME` | `%DSH_HOME%\agents` | Nơi lưu index + trạng thái headless. |
| `DSH_BIN` | tự dò bản `@deepseek-ai/dsh` mới nhất **có trên đĩa** | Ghim `lib/bin.js`. |

## Giới hạn đã biết

- Nấc 3 tốn thêm **một tiến trình `dsh web`** (kèm MCP server của profile web) khi GUI không chạy. Xong việc thì `dsh-agent host stop`.
- API web là **RPC nội bộ của host**, không phải surface có cam kết như `dsh headless`. Bản đang chạy `0.2.0-rc.2`; nếu DSH đổi shape thì lỗi hiện rõ (`gateway/…`) và vẫn còn `--headless`.
- `steer` **không huỷ bước đang chạy** (đúng thiết kế): tool call đang chạy vẫn xong, agent đổi hướng ở bước kế tiếp. Muốn cắt ngay thì `stop`/`interrupt`.
- `rm` = **archive** (mềm, khôi phục được). Muốn xoá cứng thì xoá thư mục `%DSH_HOME%\sessions\<slug>\<id>\` khi host đã tắt — host đang chạy vẫn nhớ session trong RAM tới lần khởi động sau.
- `--wait` poll `session/list` mỗi 2s; đừng chạy hàng trăm subagent song song.
- Đường headless: `send`/`interrupt` lúc đang chạy = huỷ turn rồi nạp prompt mới; `DSH_BIN` không tự tải bản mới.

## Tự kiểm tra

```powershell
dsh-agent selftest              # so sánh version, cửa sổ limit/offset, meta, dò dsh + render lịch sử web
node .\web-e2e-test.mjs         # new -> steer giua chung -> history -> rm (tao session that)
node .\web-steer-test.mjs       # chứng minh steer giữa turn
node .\web-cancel-test.mjs      # chứng minh stop cắt turn đang chạy
node .\web-ops-test.mjs         # steer / interrupt / stop qua CLI thật
```
