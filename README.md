# dev-bootstrap

> 一個指令把開發環境裝起來，並持續保持最新。

<p>
  <a href="https://github.com/chingleel17/dev-bootstrap/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/chingleel17/dev-bootstrap/release.yml?style=for-the-badge&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/dev-bootstrap"><img src="https://img.shields.io/npm/v/dev-bootstrap?style=for-the-badge&color=2563eb&label=version" alt="npm version"></a>
  <a href="https://github.com/chingleel17/dev-bootstrap/releases"><img src="https://img.shields.io/github/v/release/chingleel17/dev-bootstrap?style=for-the-badge&color=7c3aed" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-475569?style=for-the-badge" alt="Platform Windows | macOS | Linux">
  <a href="https://github.com/chingleel17/dev-bootstrap/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/stack-Node.js%20%2B%20Bun%20%2B%20TypeScript-f97316?style=for-the-badge" alt="Stack Node.js + Bun + TypeScript">
</p>

換新電腦、重裝系統、或幫團隊新成員設定機器時，不用再一個一個找安裝頁面。`dev-bootstrap` 內建 39 個常用 CLI 工具的安裝定義，會依照你的作業系統自動選用正確的套件管理器（Windows 用 `winget`、macOS 用 `brew`、Linux 用 `apt`，跨平台工具用 `npm` / `bun`），並跳過已安裝的項目。

## 特色

- **互動式選單** — 方向鍵勾選要裝的工具，支援搜尋、分類切換、全選
- **跨平台** — Windows / macOS / Linux 各自對應正確的安裝指令
- **不重複安裝** — 先偵測版本，已安裝的預設跳過
- **掃描結果沿用** — 同一次執行期間只掃描一次，進出選單不會重複詢問；按 `V` 可隨時重新掃描
- **自動更新清單** — 儲存一份常用工具清單，之後一個指令全部更新，可掛 Task Scheduler 或 cron
- **診斷模式** — `doctor` 一次列出所有工具的安裝狀態與版本
- **可自訂工具** — 在使用者目錄放 YAML 即可新增、調整或隱藏工具，升級套件不會被覆蓋

## 安裝

不安裝直接執行：

```bash
npx dev-bootstrap menu
```

或全域安裝：

```bash
npm install -g dev-bootstrap
```

使用 Bun：

```bash
bun add -g dev-bootstrap
```

需要 Node.js 20 以上。

## 快速開始

```bash
npx dev-bootstrap menu
```

進入選單後有 7 個選項：

| 選項 | 說明 |
|---|---|
| Install tools | 勾選並安裝工具 |
| Configure automatic update list | 設定自動更新清單並儲存 |
| Update saved tools now | 立即更新已儲存的清單 |
| Schedule automatic updates | 互動式建立、查看或移除定時更新排程 |
| Doctor | 檢查所有工具的安裝狀態與版本 |
| List tools | 列出所有可用工具 |
| List tools with versions | 列出工具並顯示已安裝版本 |
| Exit | 離開 |

## 讓 AI 幫你安裝

如果你用 Claude Code、Codex、Gemini CLI 之類的 AI 編碼工具，可以直接請它代勞。因為 `install` 和 `update` 都是非互動指令，AI 可以安全地執行。

把這段話丟給你的 AI 助理：

```text
請用 npx dev-bootstrap 幫我設定開發環境：
1. 先跑 npx dev-bootstrap doctor 看目前狀態
2. 列出還沒安裝的工具給我確認
3. 我確認後用 npx dev-bootstrap install <tool-id...> 安裝
```

或直接指定要什麼：

```text
用 npx dev-bootstrap install 幫我裝 git gh node bun ripgrep fzf bat eza jq
```

建議讓 AI 先跑 `doctor` 再安裝，這樣它能知道哪些已經有了。注意安裝指令在 Windows 會呼叫 `winget`、在 Linux 會用 `sudo apt-get`，可能需要你手動授權或輸入密碼。

## 指令

```bash
dev-bootstrap menu                                  # 互動式選單
dev-bootstrap list                                  # 列出所有工具
dev-bootstrap list --versions                       # 列出並檢查已安裝版本
dev-bootstrap doctor                                # 診斷所有工具狀態
dev-bootstrap install git gh node                   # 安裝指定工具
dev-bootstrap install git gh node --force            # 強制重裝（含已安裝的）
dev-bootstrap update                                # 更新已儲存的清單
dev-bootstrap update claude codex opencode          # 更新指定工具
dev-bootstrap update --all                          # 更新全部工具
dev-bootstrap schedule create --daily --time 09:00  # 註冊定時自動更新
dev-bootstrap schedule status                       # 查詢目前排程
dev-bootstrap schedule remove                       # 移除排程
dev-bootstrap --version                              # 顯示版本（也可用 -v）
dev-bootstrap --help                                 # 顯示用法（也可用 -h）
```

同時選取 Bun 與使用 Bun 安裝的工具時，會先安裝 Bun。若 Bun 不可用，互動式安裝會詢問是否先安裝 Bun、改用 npm，或略過；選擇 npm／略過時可套用至本次剩餘的 Bun 套件。安裝 Bun 後會更新目前程序的 PATH，找到 Bun 後接續安裝；若仍找不到則再次詢問。非互動模式缺少 Bun 時會略過相關工具。

## 選單操作

```text
方向鍵         移動
PageUp/Down    翻頁
Home/End       跳到第一個 / 最後一個
Space          選取 / 取消選取
A / Ctrl+A     全選 / 清除目前可見工具
C              全選 / 清除目前分類
Tab            切換分類
/              搜尋
V              檢查 / 重新整理已安裝版本
F              切換強制安裝模式
Enter          安裝已選取的工具
Backspace      回到主選單
Q              離開
```

## 內建工具

共 39 個，分為 7 類。

**AI** — Claude Code、OpenAI Codex CLI、Gemini CLI、GitHub Copilot CLI、OpenCode CLI、OpenSpec、Herdr

**Runtime** — Node.js LTS、Bun、pnpm、Yarn、TypeScript、tsx、uv (Python)、Rust、Go、Java (Temurin 21)

**Git** — Git、Git LFS、GitHub CLI

**Shell** — Oh My Posh（Windows／Linux）或 Oh My Zsh（macOS）、zoxide、fzf、ripgrep、fd、bat、eza

**Network** — ngrok、cloudflared、OpenSSH Client、OpenSSL

**Utilities** — jq、yq、delta、wget、curl、zip、unzip

**Frontend** — Tauri CLI

用 `dev-bootstrap list` 看完整清單與 tool id。

## 自訂工具

不需要 clone 專案。在設定目錄下建立 `tools/` 資料夾，放入任意 `.yaml` 檔即可：

```
~/.dev-bootstrap/tools/my-tools.yaml
```

自訂定義會**疊加**在內建定義之上，所以升級套件時你的設定不會被覆蓋，也不會錯過內建工具的更新。

**新增工具** — 用內建沒有的 id：

```yaml
- id: httpie
  name: HTTPie
  category: Utilities
  description: Human-friendly HTTP client
  install:
    winget: "HTTPie.HTTPie"
    brew: "httpie"
    apt: "httpie"
  verify:
    - command: "http --version"
      regex: "([0-9]+(?:\\.[0-9]+)+)"
```

**調整內建工具** — 用相同的 id，只寫要改的欄位，其餘沿用內建：

```yaml
- id: ripgrep
  description: 我們團隊的搜尋工具
```

**隱藏不需要的工具** — 標記 `remove`：

```yaml
- id: zip
  remove: true
```

執行 `dev-bootstrap doctor` 可以看到目前讀取了哪些來源與自訂筆數。YAML 格式有誤時會跳過該檔並指出錯誤位置，不影響其他工具。

### 欄位說明

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | 是 | 唯一識別，指令中使用 |
| `name` | 是 | 顯示名稱 |
| `category` | 是 | 分類，可自訂新分類 |
| `platforms` | 否 | 顯示及安裝的平台清單：`windows`／`mac`／`linux` |
| `description` | 否 | 選單中的說明 |
| `homepage` | 否 | 官方網站 |
| `install` | 否 | 各平台安裝方式：`winget`／`brew`／`apt`／`npm`／`bun`／`script`／`powershell` |
| `update` | 否 | `command` 自訂更新指令、`disabled` 停用更新、`note` 說明 |
| `verify` | 否 | 驗證指令清單：`command`、選用的 `regex`（第一個擷取群組為版本號）；`requireSuccess: true` 表示不可只以指令存在判定已安裝 |
| `remove` | 否 | 標記 `true` 可隱藏同 id 的內建工具 |

## 自動更新

從選單選 **Configure automatic update list**，勾選要保持最新的工具，按 Enter 儲存。之後執行：

```bash
dev-bootstrap update
```

這個指令是非互動的，適合交給系統排程定時執行。

### 定時執行

最簡單的方式是從選單選 **Schedule automatic updates**：用方向鍵挑常用時段（每天 09:00、每週一 09:00、每週五 18:00、每天 12:30），或選 **Custom...** 自訂頻率、星期與時間，不用記指令。

也可以用指令，`schedule` 會把上面的更新指令註冊到系統排程，不需要手動開排程管理器：

```bash
dev-bootstrap schedule create                          # 每週一 09:00
dev-bootstrap schedule create --daily                  # 每天 09:00
dev-bootstrap schedule create --daily --time 14:30     # 每天 14:30
dev-bootstrap schedule create --weekday fri --time 18:00   # 每週五 18:00
dev-bootstrap schedule status                          # 查詢目前排程
dev-bootstrap schedule remove                          # 移除排程
```

各平台使用的機制：Windows 為工作排程器（`schtasks`）、macOS 為 launchd（`~/Library/LaunchAgents`）、Linux 為 cron（`crontab`）。

寫入系統排程前會先印出完整指令並要求確認，確認後才執行。非互動環境（腳本、CI）請加 `--yes`。

需要先設定好自動更新清單，否則 `schedule create` 會提示你先去設定。

### 更新策略

依序判斷：

1. 工具若標記 `update.disabled`（例如 Windows 內建的 OpenSSH 由 Windows Update 管理），直接跳過
2. 工具若有自己的更新指令（例如 `claude update`、`opencode upgrade`），優先使用
3. 否則依平台：Windows `winget upgrade`、macOS `brew upgrade`、或 `npm install -g <pkg>@latest` / `bun add -g <pkg>@latest`

更新前會先確認工具是否真的已安裝，未安裝的會跳過。

在 Windows 上，偵測到指令存在**不代表**該套件由 `winget` 管理。所以會先用 `winget list --id ...` 探測，若指令存在但實際不是 winget 管理的，會標記為 SKIP 而不是回報更新失敗。

### 設定檔位置

解析順序：

1. `DEV_BOOTSTRAP_HOME` 環境變數（若已設定）
2. 當前目錄的 `./.dev-bootstrap/`（若已存在，可作為專案層級覆寫）
3. `~/.dev-bootstrap/`（預設）

此目錄存放：

- `update-profile.json` — 自動更新清單
- `tools/*.yaml` — 自訂工具定義（見「自訂工具」）

## 從原始碼開發

```bash
git clone https://github.com/chingleel17/dev-bootstrap.git
cd dev-bootstrap
bun install
bun run menu
```

其他指令：

```bash
bun run build        # 建置到 dist/
bun run typecheck    # 型別檢查
```

工具定義在 `tools/*.yaml`，新增工具只要加一筆 YAML，不用改程式。格式：

```yaml
- id: ripgrep
  name: ripgrep
  category: Shell
  description: Fast text search
  install:
    winget: "BurntSushi.ripgrep.MSVC"
    brew: "ripgrep"
    apt: "ripgrep"
  verify:
    - command: "rg --version"
      regex: "ripgrep ([0-9]+(?:\\.[0-9]+)+)"
```

## 授權

[MIT](https://github.com/chingleel17/dev-bootstrap/blob/main/LICENSE)
