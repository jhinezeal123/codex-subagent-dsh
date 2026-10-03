#!/usr/bin/env node
/**
 * hook-install.mjs — sinh (và tuỳ chọn ghi) `hooks.json` cho kênh ngược, với
 * đường dẫn TUYỆT ĐỐI của chính máy đang chạy. Nhờ vậy repo không phải hard-code
 * `C:\Users\<tên>\...` trong file mẫu.
 *
 *   node hook-install.mjs            # in ra JSON + hướng dẫn (KHÔNG ghi gì)
 *   node hook-install.mjs --write    # ghi ~/.codex/hooks.json (có backup nếu đã tồn tại)
 *   node hook-install.mjs --project  # ghi <cwd>/.codex/hooks.json (hook theo project)
 *   node hook-install.mjs --json      # chỉ in JSON trần, cho script khác dùng
 *
 * Shape này đã được kiểm chứng thật: hook `UserPromptSubmit` + `additionalContext`
 * chạy được với Codex (xem e2e-real.mjs — Codex turn sau in lại nguyên văn envelope
 * kèm số 6 chữ số chỉ subagent biết).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(REPO, 'hook-reports.mjs');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const hooksJson = {
  description: 'dsh-agent: day bao cao cua subagent DSH vao context cua Codex (kenh nguoc). Sau khi ghi thi mo /hooks trong Codex de trust.',
  hooks: {
    UserPromptSubmit: [
      {
        matcher: null,
        hooks: [
          {
            type: 'command',
            command: `node "${HOOK}"`,
            commandWindows: `node "${HOOK}"`,
            timeoutSec: 3,
            additionalContextLimit: 0,
          },
        ],
      },
    ],
  },
};

const text = `${JSON.stringify(hooksJson, null, 2)}\n`;

if (has('--json')) {
  process.stdout.write(text);
} else if (has('--write') || has('--project')) {
  const dir = has('--project') ? path.join(process.cwd(), '.codex') : path.join(os.homedir(), '.codex');
  const file = path.join(dir, 'hooks.json');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const bak = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, bak);
    console.log(`da backup ban cu -> ${bak}`);
    console.log('(Codex merge hook tu MOI nguon: file nay cong them, khong thay the hook cu)');
  }
  fs.writeFileSync(file, text);
  console.log(`da ghi ${file}`);
  console.log('Buoc cuoi: mo Codex, go /hooks de TRUST hook nay (chua trust thi Codex khong chay).');
} else {
  const target = path.join(os.homedir(), '.codex', 'hooks.json');
  console.log(`# Hook cho kenh nguoc cua dsh-agent`);
  console.log(`# Duong dan trong file da tro dung may nay: ${HOOK}`);
  console.log(`# Ghi vao: ${target}`);
  console.log(`#   node hook-install.mjs --write      (hoac --project cho <repo>/.codex/hooks.json)`);
  console.log('# Sau khi ghi: mo Codex, go /hooks de trust.\n');
  process.stdout.write(text);
}
