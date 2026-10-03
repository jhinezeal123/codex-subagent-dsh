# Review — 2026-10-03

Repo hoạt động với DSH host hiện tại trên Windows / Node 24.15.0: live eval MCP
và hook đều pass. Kiểm chứng bổ sung chạy trực tiếp MCP trong phiên, Codex E2E,
các thao tác điều khiển và headless. Chưa xác nhận mọi phiên bản DSH.

## Thay đổi trong PR

- Hook hiển thị tối đa 3 báo cáo nhưng trước đây đánh dấu toàn bộ là đã đọc.
  `reports({ limit: 3 })` giữ phần chưa giao trong hàng đợi và dừng quét khi đủ
  báo cáo, giảm RPC trong lượt có nhiều kết quả.
- Báo cáo trước đây tìm câu trả lời trên toàn bộ trang lịch sử, có thể lấy câu
  trả lời của turn đang chạy hoặc turn cũ khi turn mới bị huỷ. Giờ chỉ lấy câu
  trả lời giữa hai mốc kết thúc của turn đang được báo cáo.
- HTTP 401 trước đây retry đệ quy không giới hạn. Giờ retry tối đa một lần và
  đóng response body trước khi thử lại.
- Headless `--wait` trước đây trả về ngay nếu hết 90 giây khởi động mà chưa có
  session id, dù runner vẫn đang chạy. Giờ tiếp tục chờ runner hoàn thành.
- Các live test steer/cancel/ops giờ có assertion và archive session trong
  `finally`; dùng RPC page hiện tại, không chỉ in kết quả quan sát.
- Codex E2E dùng thư mục tạm riêng cho mỗi lượt và truyền rõ `DSH_AGENTS_HOME`
  vào MCP server. Chỉ pass khi mã ngẫu nhiên trong hook khớp đúng báo cáo của
  session vừa tạo; không lấy một số bất kỳ trong output làm bằng chứng.

## Kiểm chứng

- `npm test`: regression offline với HTTP server giả lập, cookie và index tạm.
  Kiểm tra hook giao 3 + 2 báo cáo không mất/không lặp; không lấy câu trả lời
  sai turn; HTTP 401 gọi endpoint đúng hai lần rồi trả lỗi.
- `npm run selftest`: pass cả headless helper và web helper.
- `npm run test:mcp`: pass 8 bước với model/DSH thật.
- `npm run test:hook`: pass với model/DSH thật.
- `npm run test:codex`: Codex thật gọi MCP, DSH tạo mã ngẫu nhiên và hook đưa
  đúng mã đó vào lượt Codex tiếp theo. Pass 3/3.
- `npm run test:e2e`, `test:steer`, `test:cancel`, `test:ops`: pass.
- `npm run test:headless`: pass tạo agent với `--wait`, followup giữ session
  và mã đã nhớ, interrupt cắt lệnh ngủ 300 giây rồi hoàn thành turn mới.
- `git diff --check`: pass.

Live eval cần đặt `DSH_AGENTS_HOME` sang thư mục tạm riêng cho tiến trình test.
Lượt MCP đầu dùng kho chung không nhận được báo cáo dù lịch sử session đã có
`PONG` và `turn/end`; lượt chạy với kho riêng pass. Kho riêng tránh hook của
phiên Codex khác tiêu thụ báo cáo test.

MCP đã kết nối trong phiên hiện tại cũng tạo session, giữ mã qua followup,
nhận steer và interrupt rồi hoàn thành prompt thay thế. Tuy nhiên MCP này trỏ
tới `C:\Users\DELL\dsh-subagents`, không phải checkout của PR; vì vậy test MCP
và Codex E2E của repo được chạy riêng để xác minh code trong PR.

## Điểm cần xử lý tiếp

- `web-index.json` dùng read/modify/write không có khoá. Hai tiến trình đọc báo
  cáo đồng thời có thể giao trùng; ghi index đồng thời có thể mất cập nhật.
  Vì vậy cam kết “chỉ giao một lần” hiện chỉ đáng tin với truy cập tuần tự.
- `hook-install.mjs --write` backup rồi thay toàn bộ file hook hiện có, không
  merge cấu hình cũ. Thông báo nói hook cũ vẫn được giữ dễ gây hiểu nhầm.
- `e2e-real.mjs` có đường dẫn Codex mặc định của một máy (có thể đổi bằng
  `CODEX_BIN`); README và một số test có chữ tiếng Việt bị lỗi encoding,
  làm giảm tính portable và khả năng đọc.
