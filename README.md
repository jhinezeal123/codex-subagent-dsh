# codex-subagent-dsh â€” DSH session lÃ m subagent cho Codex

Biáº¿n **session DSH** (bá»n, xem láº¡i Ä‘Æ°á»£c trong GUI, sá»‘ng qua restart Codex) thÃ nh subagent gá»i Ä‘Æ°á»£c
tá»« Codex. Thiáº¿t káº¿ **báº¯t chÆ°á»›c Ä‘Ãºng bá»™ tool `multi_agent` native cá»§a Codex** Ä‘á»ƒ model khÃ´ng pháº£i
há»c vocabulary má»›i, vÃ  dÃ¹ng **hook `UserPromptSubmit`** lÃ m kÃªnh ngÆ°á»£c Ä‘á»ƒ subagent bÃ¡o cÃ¡o vá» cha.

Repo Ä‘á»™c láº­p, tá»± chá»©a (khÃ´ng phá»¥ thuá»™c package ngoÃ i, chá»‰ cáº§n Node â‰¥ 20), Ä‘á»ƒ dá»… cÃ´ láº­p vÃ  Ä‘Ã³ng gÃ³i.

## Bá»™ tool: 7 cÃ¡i, Ã¡nh xáº¡ 1-1 vá»›i native

| Tool cá»§a ta | Native cá»§a Codex | Viá»‡c |
|---|---|---|
| `dsh_subagent_spawn` | `spawn_agent` | Táº¡o subagent + giao viá»‡c Ä‘áº§u, **tráº£ id ngay** (khÃ´ng chá») |
| `dsh_subagent_followup` | `followup_task` | Giao viá»‡c má»›i, giá»¯ ngá»¯ cáº£nh, **má»Ÿ turn má»›i** |
| `dsh_subagent_message` | `send_message` | Nháº¯n vÃ o turn **Ä‘ang cháº¡y**, khÃ´ng má»Ÿ turn má»›i, khÃ´ng cáº¯t bÆ°á»›c Ä‘ang lÃ m |
| `dsh_subagent_wait` | `wait_agent` | Chá» tá»›i khi cÃ³ bÃ¡o cÃ¡o (long-poll, backoff 1â†’8s) |
| `dsh_subagent_interrupt` | `interrupt_agent` (+ `close_agent`) | `mode:"turn"` dá»«ng turn Â· `mode:"agent"` dá»«ng háº³n |
| `dsh_subagent_list` | `list_agents` | Danh sÃ¡ch + tráº¡ng thÃ¡i Â· `reports_only:true` = há»™p thÆ° bÃ¡o cÃ¡o |
| `dsh_subagent_history` | *(native khÃ´ng cÃ³)* | Äá»c lá»‹ch sá»­ tá»«ng turn/tool call â€” **lá»£i tháº¿ riÃªng cá»§a DSH** |

Má»i tool nháº­n **id hoáº·c name** (ká»ƒ cáº£ dáº¡ng `/dsh/<name>`, `/root/<name>`) â€” giá»‘ng cÃ¡ch native gá»i
subagent báº±ng canonical task name. `spawn` tráº£ vá» cáº£ `agent_id`, `nickname`, `canonical_task_name`,
`thread_id` theo Ä‘Ãºng tÃªn field cá»§a native.

MCP server cÃ²n gá»­i `instructions` trong `initialize` (báº£n Ä‘á»“ Ä‘á»‹nh tuyáº¿n: khi nÃ o dÃ¹ng native, khi nÃ o
dÃ¹ng ta) vÃ¬ 7 description rá»i ráº¡c khÃ´ng táº¡o thÃ nh "há»‡ thá»‘ng" trong Ä‘áº§u model.

## BÃ¡o cÃ¡o vá» cha: 2 Ä‘Æ°á»ng, Ä‘Ãºng format native

Format envelope y há»‡t thá»© Codex dáº¡y model Ä‘á»c cho subagent native:

```
Message Type: FINAL_ANSWER
Task name: <name Ä‘áº·t lÃºc spawn>
Sender: <session id>
Payload:
<cÃ¢u tráº£ lá»i cuá»‘i>
```

| ÄÆ°á»ng | CÆ¡ cháº¿ | DÃ¹ng khi |
|---|---|---|
| **Push** (máº·c Ä‘á»‹nh) | Hook `UserPromptSubmit` gá»i `hook-reports.mjs` â†’ bÆ¡m `additionalContext` vÃ o turn má»›i | Cha khÃ´ng muá»‘n cháº·n; bÃ¡o cÃ¡o tá»± tá»›i á»Ÿ turn káº¿ tiáº¿p |
| **Pull** | `dsh_subagent_wait` â†’ CLI `wait` long-poll â†’ tráº£ envelope | Cha cáº§n káº¿t quáº£ *ngay bÃ¢y giá»* |

BÃ¡o cÃ¡o chá»‰ giao **má»™t láº§n**: ai Ä‘á»c trÆ°á»›c (hook hay wait) thÃ¬ Ä‘Æ°á»ng kia khÃ´ng tháº¥y ná»¯a. Watermark
`reportedSeq` náº±m trong `web-index.json` nÃªn **khÃ´ng cáº§n tiáº¿n trÃ¬nh ná»n** â€” cha há»i lÃºc nÃ o tÃ­nh lÃºc Ä‘Ã³.

Ba káº¿t cá»¥c cá»§a `wait` phÃ¢n biá»‡t rÃµ, khÃ´ng lÃ m trÃ²n thÃ nh "thÃ nh cÃ´ng":
`reported` (cÃ³ bÃ¡o cÃ¡o) Â· `nothing-new` (khÃ´ng ai cÃ²n cháº¡y) Â· `unconfirmed` (háº¿t giá», **chÆ°a** xÃ¡c nháº­n â€” exit 3).

## Ná»‘i vÃ o Codex (dÃ¡n tay â€” repo nÃ y KHÃ”NG tá»± sá»­a config cá»§a báº¡n)

**1. MCP server** â€” sá»­a `[mcp_servers.dsh-agent]` trong `~/.codex/config.toml` trá» vá» repo má»›i, vÃ 
thÃªm `tool_timeout_sec` (máº·c Ä‘á»‹nh cá»§a Codex **khÃ´ng rÃµ nhÆ°ng >150s**, háº¿t háº¡n lÃ  **lá»—i cá»©ng + kill
connection**, nÃªn pháº£i Ä‘áº·t tÆ°á»ng minh):

```toml
[mcp_servers.dsh-agent]
command = 'C:\Program Files\nodejs\node.exe'
args = ['<REPO>\dsh-agent-mcp.mjs']
startup_timeout_sec = 60
tool_timeout_sec = 900                      # 15 phÃºt: Ä‘á»§ cho wait dÃ i, trÃ¡nh bá»‹ kill giá»¯a chá»«ng
default_tools_approval_mode = "approve"     # khÃ´ng thÃ¬ approval_policy="never" sáº½ cháº·n tool call
```

**2. Hook kÃªnh ngÆ°á»£c** â€” sinh file hook vá»›i Ä‘Æ°á»ng dáº«n Ä‘Ãºng mÃ¡y báº¡n, rá»“i **trust** nÃ³ (hook chÆ°a trust
thÃ¬ Codex khÃ´ng cháº¡y; cÃ³ `--dangerously-bypass-hook-trust` cho má»™t láº§n):

```powershell
node hook-install.mjs            # in ra JSON, KHÃ”NG ghi gÃ¬
node hook-install.mjs --write    # ghi ~/.codex/hooks.json (tá»± backup báº£n cÅ©)
node hook-install.mjs --project  # hoáº·c ghi <repo>/.codex/hooks.json
```

Sau Ä‘Ã³ má»Ÿ Codex, gÃµ `/hooks` Ä‘á»ƒ trust. [`hooks.example.json`](hooks.example.json) lÃ  báº£n máº«u chá»‰ Ä‘á»ƒ
xem shape ([`hook-install.mjs`](hook-install.mjs) sinh ra y há»‡t, chá»‰ khÃ¡c Ä‘Æ°á»ng dáº«n tuyá»‡t Ä‘á»‘i):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": null,
        "hooks": [{ "type": "command",
                    "command": "node \"<DUONG_DAN_TOI_REPO>\\hook-reports.mjs\"",
                    "commandWindows": "node \"<DUONG_DAN_TOI_REPO>\\hook-reports.mjs\"",
                    "timeoutSec": 3, "additionalContextLimit": 0 }] }
    ]
  }
}
```

Há»£p Ä‘á»“ng nÃ y láº¥y tá»« schema sinh bá»Ÿi chÃ­nh Codex
(`codex-rs/hooks/schema/generated/user-prompt-submit.command.{input,output}.schema.json`): stdin lÃ 
`{cwd, hook_event_name, model, permission_mode, prompt, session_id, transcript_path, turn_id}`, stdout
nháº­n `hookSpecificOutput.additionalContext`. ÄÃ£ Ä‘o: hook tá»± cháº¡y máº¥t **0.23s** khi chÆ°a cÃ³ bÃ¡o cÃ¡o.

**3. (tuá»³ chá»n) `AGENTS.md`** â€” vÃ¬ `multi_agent` cá»§a Codex Ä‘ang báº­t (`stable true`), Codex sáº½ Æ°u tiÃªn
subagent cá»§a chÃ­nh nÃ³. Muá»‘n nÃ³ chá»n ta khi cáº§n session bá»n, thÃªm vÃ o `AGENTS.md`:

```md
Khi cáº§n subagent sá»‘ng lÃ¢u, xem láº¡i Ä‘Æ°á»£c lá»‹ch sá»­, hoáº·c cháº¡y báº±ng model khÃ¡c: dÃ¹ng MCP tool
`dsh_subagent_*` thay cho subagent native. Viá»‡c ngáº¯n trong phiÃªn thÃ¬ dÃ¹ng native.
```

## Sá»‘ Ä‘o tháº­t (khÃ´ng pháº£i suy Ä‘oÃ¡n)

| Viá»‡c | TrÆ°á»›c | Sau |
|---|---|---|
| Hook `UserPromptSubmit` (khÃ´ng cÃ³ bÃ¡o cÃ¡o) | 5.4s + **crash** `uv\win\async.c` | **0.23s**, exit 0 |
| `dsh-agent host status` | 5.29s | **0.78s** |
| `dsh-agent reports --json` | 5.30s | **0.65s** |
| `dsh-agent list` | 1.97s | 1.97s (host pháº£i quÃ©t 158 session â€” khÃ´ng trÃ¡nh Ä‘Æ°á»£c) |
| `session/page` 1 session | 2.0s (kÃ¨m `session/list`) | **24-75ms** |
| `spawn` â†’ `wait` â†’ envelope | â€” | 6-10s (1 turn tháº­t cá»§a model) |

Hai nguyÃªn nhÃ¢n gá»‘c Ä‘Ã£ sá»­a:
1. `probe()` gá»i `session/list` (host quÃ©t cáº£ workspace, 0.5-5s) â†’ Ä‘á»•i sang `session/page` (~75ms,
   váº«n phÃ¢n biá»‡t Ä‘Ãºng `200` / `401` / host cháº¿t).
2. `readPage()` gá»i `one()` â†’ `list()` chá»‰ Ä‘á»ƒ láº¥y `asOfSeq`; nay láº¥y cursor tá»« chÃ­nh lá»—i
   `"session page through seq N is past cursor M"` mÃ  host tráº£ vá» (2 RPC Ã— ~30ms thay vÃ¬ 1 Ã— 2s).

VÃ  má»™t bug tháº­t: `process.exit()` sau `fetch` trÃªn Windows lÃ m libuv abort
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) â€” hook pháº£i dÃ¹ng `process.exitCode` rá»“i Ä‘á»ƒ
event loop tá»± cáº¡n.

## Há»c tá»« native: copy gÃ¬, KHÃ”NG copy gÃ¬

**Copy:** tÃªn & ngá»¯ nghÄ©a tool; envelope `FINAL_ANSWER`; `spawn` tráº£ ngay + `wait` chá» dÃ i
("prefer longer waits (minutes) to avoid busy polling"); `send_message` tÃ¡ch khá»i `followup_task`;
Ä‘á»‹nh danh báº±ng id **hoáº·c** tÃªn; khuyáº¿n cÃ¡o chia viá»‡c Ä‘á»ƒ má»—i subagent ghi vÃ o **táº­p file rá»i nhau**.

**KhÃ´ng copy:**
- **4 concurrency slot** cá»§a Codex â€” DSH cháº¡y ngoÃ i há»‡ slot Ä‘Ã³, khÃ´ng tá»‘n slot nÃ o cá»§a Codex.
- **`fork_turns` full-history** â€” DSH khÃ´ng cÃ³ RPC fork session; ta chá»‰ nháº­n seed text (`context`).
- **Subagent lá»“ng nhau** â€” con cá»§a ta khÃ´ng tá»± spawn con (native má»›i cÃ³).
- **Streaming realtime** â€” khÃ´ng cÃ³; muá»‘n biáº¿t tiáº¿n Ä‘á»™ thÃ¬ Ä‘á»c `history`.
- **Blocking-by-default** â€” `spawn` khÃ´ng chá»; `wait` cÃ³ tráº§n thá»i gian.

## DÃ¹ng tay (CLI)

```powershell
node dsh-agent.mjs new "Doc repo nay, tom tat kien truc trong 10 dong" --cwd <REPO> --label review
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

## Cho ngÆ°á»i review

ÄÃ¢y lÃ  adapter **má»™t chiá»u**: DSH session Ä‘Ã³ng vai subagent cho Codex, khÃ´ng pháº£i báº£n fork cá»§a Codex.
Muá»‘n pháº£n biá»‡n nhanh thÃ¬ Ä‘á»c theo thá»© tá»± nÃ y:

| Muá»‘n kiá»ƒm | Xem |
|---|---|
| Bá»™ tool cÃ³ Ä‘Ãºng vocabulary native khÃ´ng | [dsh-agent-mcp.mjs](dsh-agent-mcp.mjs) â€” Ä‘á»‘i chiáº¿u vá»›i `<multi_agent_role>` in ra bá»Ÿi `codex debug prompt-input` |
| KÃªnh ngÆ°á»£c cÃ³ tháº­t khÃ´ng | [hook-reports.mjs](hook-reports.mjs) + [e2e-real.mjs](e2e-real.mjs) â€” cháº¡y `node e2e-real.mjs` rá»“i tá»± Ä‘Ã¡nh giÃ¡ |
| MCP server cÃ³ há»£p lá»‡ khÃ´ng | [mcp-test.mjs](mcp-test.mjs) (nÃ³i JSON-RPC thuáº§n qua stdio, khÃ´ng SDK) |
| Chá»— dá»… sai nháº¥t | `envelope()` + watermark `reportedSeq` trong [dsh-web.mjs](dsh-web.mjs): bÃ¡o cÃ¡o chá»‰ giao **má»™t láº§n**, ai Ä‘á»c trÆ°á»›c tháº¯ng |
| Chá»— chÆ°a chá»©ng minh | Hook má»›i chá»‰ kiá»ƒm vá»›i **má»™t** event (`UserPromptSubmit`) vÃ  má»™t báº£n Codex (0.155.1); `notifications/progress` khÃ´ng tá»›i model (Ä‘Ã£ Ä‘o); giÃ¡ trá»‹ máº·c Ä‘á»‹nh `tool_timeout_sec` cá»§a Codex chÆ°a xÃ¡c Ä‘á»‹nh |
| Chá»— cá»‘ tÃ¬nh KHÃ”NG lÃ m | KhÃ´ng fork session (`fork_turns`), khÃ´ng subagent lá»“ng nhau, khÃ´ng streaming, khÃ´ng copy mÃ´ hÃ¬nh 4 slot cá»§a Codex â€” xem má»¥c "Há»c tá»« native" á»Ÿ trÃªn |

Nghi ngá» lá»›n nháº¥t mÃ  ngÆ°á»i review nÃªn cháº¥t váº¥n: **adapter dá»±a vÃ o RPC ná»™i bá»™ cá»§a web host DSH**
(`/api/session/*`), khÃ´ng pháº£i surface cÃ³ cam káº¿t nhÆ° `dsh headless`. Náº¿u DSH Ä‘á»•i shape thÃ¬ adapter
há»ng (lá»—i hiá»‡n rÃµ dáº¡ng `gateway/â€¦`), vÃ  Ä‘Æ°á»ng `--headless` lÃ  fallback.

## KhÃ´ng pháº£i báº­t gÃ¬ cáº£

| Náº¥c | Khi nÃ o | LÃ m gÃ¬ |
|---|---|---|
| 1 | BÃ¬nh thÆ°á»ng | DÃ¹ng **cookie Ä‘Ã£ lÆ°u** (`.web-cookie`) nÃ³i chuyá»‡n vá»›i GUI Ä‘ang má»Ÿ; cookie sá»‘ng 30 ngÃ y, qua cáº£ restart GUI |
| 2 | ChÆ°a cÃ³ cookie | Äá»c token `.web-token` (hoáº·c `$DSH_WEB_TOKEN`) â†’ Ä‘á»•i cookie â†’ lÆ°u láº¡i |
| 3 | KhÃ´ng host nÃ o sá»‘ng | **Tá»± dá»±ng host riÃªng** (`dsh web --no-open --port 0`) vÃ  tá»± báº¯t token tá»« stdout â€” nhÆ° báº¡n Ä‘á»c token trÃªn mÃ n hÃ¬nh, chá»‰ khÃ¡c lÃ  mÃ¡y Ä‘á»c há»™ |

Host tá»± dá»±ng dÃ¹ng chung kho session vá»›i GUI; `host stop` chá»‰ táº¯t host **do tool dá»±ng**, khÃ´ng bao giá»
Ä‘á»¥ng GUI báº¡n tá»± má»Ÿ. Hai lá»‡nh cháº¡y song song khÃ´ng dá»±ng 2 host (khoÃ¡ `.web-host.json.lock`).

## File

| File | Vai trÃ² |
|---|---|
| [dsh-agent-mcp.mjs](dsh-agent-mcp.mjs) | MCP server stdio: 7 tool + `instructions` + `notifications/progress` |
| [dsh-agent.mjs](dsh-agent.mjs) | CLI: `new/send/steer/interrupt/stop/wait/reports/history/list/status/host`, runner headless `__run` |
| [dsh-web.mjs](dsh-web.mjs) | Transport web: tÃ¬m/dá»±ng host, tokenâ†’cookie, `session/*`, `envelope()`, `reports()`, `resolve()` |
| [hook-reports.mjs](hook-reports.mjs) | Hook `UserPromptSubmit`: bÆ¡m bÃ¡o cÃ¡o chÆ°a Ä‘á»c vÃ o context cha |
| [hook-install.mjs](hook-install.mjs) | Sinh `hooks.json` Ä‘Ãºng Ä‘Æ°á»ng dáº«n mÃ¡y Ä‘ang cháº¡y (máº·c Ä‘á»‹nh chá»‰ in, `--write` má»›i ghi) |
| [hooks.example.json](hooks.example.json) | Báº£n máº«u shape cá»§a hook (chá»— `command` Ä‘á»ƒ placeholder) |
| [mcp-test.mjs](mcp-test.mjs) | **Live eval** 8 bÆ°á»›c cho táº§ng MCP (spawnâ†’waitâ†’envelopeâ†’hook pathâ†’progressâ†’interrupt) |
| [hook-test.mjs](hook-test.mjs) | **Live eval** kÃªnh ngÆ°á»£c: rá»—ng â†’ envelope â†’ chá»‰ giao má»™t láº§n |
| [e2e-real.mjs](e2e-real.mjs) | **E2E vá»›i Codex THáº¬T**: `CODEX_HOME` táº¡m (khÃ´ng Ä‘á»¥ng config cá»§a báº¡n) â†’ Codex gá»i MCP cá»§a ta â†’ subagent cháº¡y â†’ hook bÆ¡m bÃ¡o cÃ¡o vÃ o turn sau |
| [web-e2e-test.mjs](web-e2e-test.mjs), [web-steer-test.mjs](web-steer-test.mjs), [web-cancel-test.mjs](web-cancel-test.mjs), [web-ops-test.mjs](web-ops-test.mjs) | E2E cÅ©: newâ†’steerâ†’historyâ†’rm, steer giá»¯a turn, cancel, 3 thao tÃ¡c chen ngang |
| `.web-cookie`, `.web-token`, `.web-host.json*` | Tráº¡ng thÃ¡i host/cookie (**Ä‘á»«ng chia sáº», Ä‘Ã£ gitignore**) |
| `%DSH_HOME%\agents\web-index.json` | Nhá»› subagent nÃ o do tool táº¡o + watermark bÃ¡o cÃ¡o |

## Biáº¿n mÃ´i trÆ°á»ng

| Biáº¿n | Máº·c Ä‘á»‹nh | Ã nghÄ©a |
|---|---|---|
| `DSH_WEB_BASE` | `http://127.0.0.1:3080` | Æ¯u tiÃªn host á»Ÿ Ä‘á»‹a chá»‰ nÃ y |
| `DSH_WEB_TOKEN` | â€” | Token, thay cho file `.web-token` |
| `DSH_AGENTS_HOME` | `%DSH_HOME%\agents` | NÆ¡i lÆ°u index + tráº¡ng thÃ¡i headless |
| `DSH_BIN` | tá»± dÃ² báº£n `@deepseek-ai/dsh` má»›i nháº¥t trÃªn Ä‘Ä©a | Ghim `lib/bin.js` |
| `DSH_MCP_PROGRESS_MS` | `10000` | Nhá»‹p progress notification (test háº¡ xuá»‘ng 500) |

## Giá»›i háº¡n Ä‘Ã£ biáº¿t

- **`notifications/progress` khÃ´ng tá»›i model** (Ä‘o Ä‘Æ°á»£c: Codex gá»­i `progressToken`, UI hiá»‡n tiáº¿n Ä‘á»™,
  nhÆ°ng model khÃ´ng tháº¥y gÃ¬). Äá»«ng thiáº¿t káº¿ luá»“ng nghiá»‡p vá»¥ dá»±a vÃ o nÃ³ â€” muá»‘n bÃ¡o tiáº¿n Ä‘á»™ thÃ¬ viáº¿t
  vÃ o cÃ¢u tráº£ lá»i.
- `wait` quÃ¡ ~2 phÃºt chá»‰ nÃªn dÃ¹ng khi Ä‘Ã£ Ä‘áº·t `tool_timeout_sec`; háº¿t háº¡n tool call = lá»—i cá»©ng, máº¥t káº¿t quáº£.
- `session/list` cháº­m dáº§n theo sá»‘ session (158 session â†’ ~2s). `list`/`wait`/`status` Ä‘á»u Ä‘i qua nÃ³;
  Ä‘Æ°á»ng Ä‘á»c bÃ¡o cÃ¡o thÃ¬ khÃ´ng.
- `steer` khÃ´ng cáº¯t bÆ°á»›c Ä‘ang cháº¡y (Ä‘Ãºng thiáº¿t káº¿): tool call Ä‘ang cháº¡y váº«n xong, agent Ä‘á»•i hÆ°á»›ng á»Ÿ
  bÆ°á»›c káº¿ tiáº¿p. Muá»‘n cáº¯t ngay thÃ¬ `interrupt`.
- `rm` = **archive** (má»m). XoÃ¡ cá»©ng thÃ¬ xoÃ¡ `%DSH_HOME%\sessions\<slug>\<id>\` khi host Ä‘Ã£ táº¯t.
- API web lÃ  **RPC ná»™i bá»™ cá»§a host**, khÃ´ng pháº£i surface cÃ³ cam káº¿t nhÆ° `dsh headless`; DSH Ä‘á»•i shape
  thÃ¬ lá»—i hiá»‡n rÃµ (`gateway/â€¦`) vÃ  váº«n cÃ²n Ä‘Æ°á»ng `--headless`.
- Hook `additionalContext` bá»‹ "spill" ra Ä‘Ä©a náº¿u vÆ°á»£t ngÆ°á»¡ng token (`null` = 2500; ta Ä‘áº·t
  `additionalContextLimit: 0` = khÃ´ng spill, vÃ  tá»± cáº¯t má»—i bÃ¡o cÃ¡o á»Ÿ 4000 kÃ½ tá»±).

## Tá»± kiá»ƒm tra

```powershell
node dsh-agent.mjs selftest     # Ä‘Æ¡n vá»‹: so version, cá»­a sá»• limit/offset, render lá»‹ch sá»­, answerFrom
node mcp-test.mjs               # live eval 8 bÆ°á»›c (spawn tháº­t, wait tháº­t, hook path, progress, interrupt)
node hook-test.mjs              # live eval kÃªnh ngÆ°á»£c (payload stdin giáº£ Ä‘Ãºng schema Codex)
node e2e-real.mjs               # E2E vá»›i Codex tháº­t trong CODEX_HOME táº¡m (3 phÃ©p kiá»ƒm, tá»± dá»n)
node web-e2e-test.mjs           # new -> steer giua chung -> history -> rm
```

Káº¿t quáº£ E2E tháº­t (`e2e-real.mjs`, cháº¡y trÃªn mÃ¡y nÃ y):

```
1. Codex goi duoc MCP tool cua ta : PASS
2. Subagent DSH chay that         : PASS
3. Hook bom envelope vao turn 2   : PASS (thay so 6 chu so chi subagent biet)
```

PhÃ©p kiá»ƒm thá»© 3 Ä‘Æ°á»£c lÃ m cháº·t: subagent tá»± sinh má»™t sá»‘ 6 chá»¯ sá»‘ rá»“i tráº£ vá», Codex á»Ÿ turn sau pháº£i in
láº¡i **nguyÃªn vÄƒn envelope kÃ¨m Ä‘Ãºng con sá»‘ Ä‘Ã³** â€” thá»© duy nháº¥t nÃ³ khÃ´ng thá»ƒ biáº¿t náº¿u hook khÃ´ng bÆ¡m.

## Nguá»“n (Ä‘Ã£ Ä‘á»c trá»±c tiáº¿p)

- Subagents: <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
- Hooks: <https://learn.chatgpt.com/docs/hooks.md> Â· schema: `codex-rs/hooks/schema/generated/`
- Prompt tháº­t model tháº¥y: `codex debug prompt-input` (block `<multi_agent_role>`, 2429 kÃ½ tá»±)
- Protocol: `codex app-server generate-json-schema --out <DIR>`
