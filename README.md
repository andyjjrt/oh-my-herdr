# oh-my-herdr

在 [herdr](https://herdr.dev) 上做 [OmO（oh-my-openagent）](https://omo.dev) 風格的多 agent、多模型分工的 Claude Code mod。

Claude Code 當主控（lead）：規劃、分派、驗收。worker 是 herdr pane 裡的其他 agent（Claude Code，或跑 OpenCode Go 模型的 [senpi](https://github.com/code-yeongyu/senpi)），依每個 task 的意圖與類別挑選，派出前先查各訂閱的剩餘額度。

```
┌─ herdr ─────────────────────────────────────────────────────────┐
│ [主控 pane] Claude Code          │ [omh-workers 分頁]            │
│  /ulw <目標>                     │  w1-t1  senpi · DeepSeek      │
│   ├ plan.json（waves + gates）   │  w1-t2  senpi · DeepSeek      │
│   ├ omh_dispatch ───────────────►│  w2-r1  Claude · Opus（審查） │
│   ├ 結束這一輪，等 mod 叫醒      │                               │
│   └ omh_collect → 驗收 ◄─────────│  result.md                    │
│ omh W1 ▓▓▓▓▓▓▓▓░░░░ 2/3 ⚠1       │                               │
└─────────────────────────────────────────────────────────────────┘
```

## 和直接用 herdr 有什麼不同

- **輸入框上方一列 wave 進度條。** 目前這一波做完幾個、有幾個需要處理；`/omh board` 開完整看板（所有 wave、task、worker、額度）。
- **worker 停下來時，主控知道為什麼。** mod 透過 herdr 的事件串流盯每個 worker；herdr 判斷不出來（卡住、沒開始、閒置卻沒交結果、pane 不見了）時，mod 讀畫面、結果檔和額度，判定是 `quota-exhausted`、`permission-prompt`、`config-error`、`crashed`、`interrupted` 還是 `unknown`，連同建議一起叫醒主控。
- **派出前先做意圖分析。** 每次派工都要寫明 intent（explore / research / implement / fix / review / plan / write）、category 和理由，路由依 category 的 profile 順序挑出有額度的那個；審查自動避開實作者的模型家族。
- **主控不用等。** 派完就結束這一輪；一波結束或有 worker 需要處理時，mod 會送訊息叫醒主控。mod 重新載入時，還沒送出的訊息也不會遺失。
- **每個 task 留一句品質紀錄。** 驗收時主控寫一行品質評語，和 intent、profile、耗時一起記到 `~/.local/state/oh-my-herdr/history.jsonl`，之後用來評估哪個 profile 適合哪類工作。

## 狀態列

裝了這個 mod，輸入框下方那一列會換成精簡的狀態列。**每個 session 都有效**，不需要在 herdr 裡：

```
⏵⏵ auto mode on · Opus 5.5 (high) · ~/codes/github/oh-my-herdr  main · ███░░░░░░░ 31% · 68%/9%
```

依序是：
- 模型與 effort（橘色，effort 灰色）
- 資料夾（藍色）與 git branch（紫色）
- context 用量條
- Claude 訂閱的 5 小時／每週用量

用量條和用量的顏色：綠色，70% 起轉黃，90% 起轉紅。

- **字型：** branch icon 是 Nerd Font 的字元，沒有 Nerd Font 會顯示成方框。
- **前面的 mode 標示：** 「⏵⏵ auto mode on」是 Claude Code 自己畫的，mod 無法改掉。
- **更新時機：** session 開始時、每次回覆後、`/effort`、`/model`、compact 之後。
- **關掉：** 在 `/plugin` 的 `statusbar` 選項。

## 安裝

需要 herdr、python3，以及登入過的 Claude Code。在 Claude Code 裡輸入：

```
/plugin install oh-my-herdr --marketplace andyjjrt/oh-my-herdr
```

問到 `Add marketplace?` 時按 `y`，再選安裝範圍。

想用 OpenCode Go 的模型當 worker，再裝 senpi 並登入：

```sh
bun add -g @code-yeongyu/senpi   # 或 npm install -g --ignore-scripts @code-yeongyu/senpi
senpi                            # 在 senpi 裡 /login → OpenCode Go
```

詳細設定（herdr 整合、senpi 權限、設定檔格式、額度）見 [skills/oh-my-herdr/references/setup.md](skills/oh-my-herdr/references/setup.md)。

## 使用

在 herdr 的 pane 裡、專案目錄下開 Claude Code（mod 只在 `HERDR_ENV=1` 的主控 pane 裡啟動，worker pane 裡不會），然後：

```
/ulw 把 orders API 改成分頁，補上測試
```

| 指令 | 作用 |
| --- | --- |
| `/ulw <目標>` | 開始一次 ultrawork：探索 → 規劃 waves → 派工 → 驗收 → gate |
| `/omh board` | 開關完整看板 pane |
| `/omh status` | 目前 run 的狀態 |
| `/omh quota` | 各訂閱目前用量 |
| `/omh check` | 檢查設定、需要的 agent、額度對應 |
| `/omh teardown` | 關掉所有 worker |

主控使用的工具：`omh_dispatch`、`omh_status`（plan / show / verified / abandon / gate）、`omh_collect`、`omh_spawn`、`omh_teardown`。流程寫在 [skills/oh-my-herdr/SKILL.md](skills/oh-my-herdr/SKILL.md)。

run 的檔案放在專案的 `.omh/`，記得加進 `.gitignore`。

## 設定

設定檔依序找：`$OMH_CONFIG` → `<專案>/.omh/config.json` → `~/.config/oh-my-herdr/config.json` → 內建的 `skills/oh-my-herdr/assets/config.default.json`。

```jsonc
{
  "profiles": {
    "claude-opus": { "agent": "claude", "family": "claude", "args": ["--model", "opus"] },
    "go-deepseek": { "agent": "senpi", "family": "deepseek",
                     "args": ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "max"] }
  },
  "categories": {
    "deep":     ["go-deepseek", "claude-opus"],
    "reviewer": ["claude-opus"]
  }
}
```

mod 本身的選項（`/plugin` 裡設定）：

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `band` | 開 | 輸入框上方的 wave 進度條 |
| `statusbar` | 開 | 輸入框下方的精簡狀態列（每個 session 都有效） |
| `wakeOnSettle` | 開 | 一波結束或 worker 出狀況時叫醒主控 |
| `notifyHuman` | 開 | 同時發 herdr 通知給你 |
| `autoContinue` | 關 | run 還沒結束、也沒有 worker 在跑時，自動叫主控繼續 |
| `autoContinueMax` | 3 | 自動繼續的上限（你自己輸入訊息就重新計算） |

## 開發

```sh
claude --plugin-dir ~/codes/github/oh-my-herdr   # 或把路徑放進 CLAUDE_CODE_PLUGIN_DIRS
claude plugin validate .
claude plugin test .
```

設計與進度見 [plan.md](plan.md)。
