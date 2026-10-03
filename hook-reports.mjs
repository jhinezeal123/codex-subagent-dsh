#!/usr/bin/env node
/**
 * hook-reports.mjs — hook `UserPromptSubmit` của Codex: kênh NGƯỢC để subagent
 * DSH báo cáo về cho cha.
 *
 * Codex gọi script này mỗi lần người dùng mở turn mới, đưa JSON payload qua stdin
 * (schema `user-prompt-submit.command.input`: cwd, hook_event_name, model,
 * permission_mode, prompt, session_id, transcript_path, turn_id) và đọc JSON ở
 * stdout (schema `user-prompt-submit.command.output`). Trường duy nhất ta cần:
 *
 *   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
 *                             "additionalContext": "<báo cáo>" } }
 *
 * Nguyên tắc: hook KHÔNG được làm chậm hay chặn turn của cha.
 *   - chưa từng giao việc cho subagent nào -> thoát ngay (không gọi host)
 *   - host lỗi / bất kỳ lỗi nào -> im lặng, exit 0
 *   - không có báo cáo -> không in gì (không bơm rác vào context)
 *   - có báo cáo -> in envelope y như sub-agent native, đã cắt bớt độ dài
 *   - KHÔNG gọi process.exit() sau khi đã fetch: trên Windows nó làm libuv abort
 *     (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), biến hook thành
 *     lỗi cứng. Dùng process.exitCode rồi để event loop tự cạn.
 *
 * Cài đặt: copy `hooks.example.json` thành `~/.codex/hooks.json` rồi mở `/hooks`
 * trong Codex để trust (hook chưa trust thì Codex không chạy).
 */
import process from 'node:process';
import { entries, envelope, reports, up } from './dsh-web.mjs';

const MAX_REPORTS = 3; // nhiều hơn thì để dành cho lần sau (context là tài nguyên)
const MAX_CHARS = 4000; // mỗi báo cáo; additionalContextLimit trong hooks.json lo phần còn lại

process.exitCode = 0; // mọi đường ra đều là "thành công" — hook hỏng không được phá turn

// Drain stdin: Codex ghi payload vào pipe, không đọc thì pipe đầy và hook treo.
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => { void run(); });
setTimeout(() => void run(), 50); // stdin đã đóng sẵn (chạy tay) thì chạy luôn

let started = false;
async function run() {
  if (started) return;
  started = true;
  try {
    if (entries().length === 0) return; // chưa giao việc cho subagent nào
    if (!(await up({ autoStart: false, fast: true }))) return; // hook không được dựng host
    const rows = await reports({ markRead: true });
    if (!rows.length) return;
    const text = rows
      .slice(0, MAX_REPORTS)
      .map((r) => envelope(r))
      .map((t) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n…(cat bot)` : t))
      .join('\n\n');
    const more = rows.length > MAX_REPORTS ? `\n\n(con ${rows.length - MAX_REPORTS} bao cao nua — goi dsh_subagent_list voi reports_only=true)` : '';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${text}${more}` },
    }));
  } catch {
    // Nuốt mọi lỗi: hook hỏng không được phép làm hỏng turn của cha.
  }
}
