# Review — 2026-10-03

Repo hoạt động với DSH host hiện tại trên Windows / Node 24.15.0: live eval MCP
và hook đều pass. Đây là xác nhận cho đường web đang dùng, chưa xác nhận mọi
phiên bản DSH hoặc đường headless.

## Thay đổi trong PR

- Hook hiển thị tối đa 3 báo cáo nhưng trước đây đánh dấu toàn bộ là đã đọc.
  `reports({ limit: 3 })` giữ phần chưa giao trong hàng đợi và dừng quét khi đủ
  báo cáo, giảm RPC trong lượt có nhiều kết quả.
- Báo cáo trước đây tìm câu trả lời trên toàn bộ trang lịch sử, có thể lấy câu
  trả lời của turn đang chạy hoặc turn cũ khi turn mới bị huỷ. Giờ chỉ lấy câu
  trả lời giữa hai mốc kết thúc của turn đang được báo cáo.
- HTTP 401 trước đây retry đệ quy không giới hạn. Giờ retry tối đa một lần và
  đóng response body trước khi thử lại.

## Kiểm chứng

- `npm test`: regression offline với HTTP server giả lập, cookie và index tạm.
  Kiểm tra hook giao 3 + 2 báo cáo không mất/không lặp; không lấy câu trả lời
  sai turn; HTTP 401 gọi endpoint đúng hai lần rồi trả lỗi.
- `npm run selftest`: pass cả headless helper và web helper.
- `npm run test:mcp`: pass 8 bước với model/DSH thật.
- `npm run test:hook`: pass với model/DSH thật.
- `git diff --check`: pass.

Live eval cần đặt `DSH_AGENTS_HOME` sang thư mục tạm riêng cho tiến trình test.
Lượt MCP đầu dùng kho chung không nhận được báo cáo dù lịch sử session đã có
`PONG` và `turn/end`; lượt chạy với kho riêng pass. Kho riêng tránh hook của
phiên Codex khác tiêu thụ báo cáo test.

Chưa chạy `e2e-real.mjs` (Codex thật), các bài steer/cancel dài, hoặc toàn bộ
luồng headless trong review này.

## Điểm cần xử lý tiếp

- `web-index.json` dùng read/modify/write không có khoá. Hai tiến trình đọc báo
  cáo đồng thời có thể giao trùng; ghi index đồng thời có thể mất cập nhật.
  Vì vậy cam kết “chỉ giao một lần” hiện chỉ đáng tin với truy cập tuần tự.
- `hook-install.mjs --write` backup rồi thay toàn bộ file hook hiện có, không
  merge cấu hình cũ. Thông báo nói hook cũ vẫn được giữ dễ gây hiểu nhầm.
- `e2e-real.mjs` ghim đường dẫn Codex của một máy; README và một số test có
  chữ tiếng Việt bị lỗi encoding, làm giảm tính portable và khả năng đọc.
