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
- **自動更新清單** — 儲存一份常用工具清單，之後一個指令全部更新，可掛 Task Scheduler 或 cron
- **診斷模式** — `doctor` 一次列出所有工具的安裝狀態與版本

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
```

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

**Shell** — Oh My Posh、zoxide、fzf、ripgrep、fd、bat、eza

**Network** — ngrok、cloudflared、OpenSSH Client、OpenSSL

**Utilities** — jq、yq、delta、wget、curl、zip、unzip

**Frontend** — Tauri CLI

用 `dev-bootstrap list` 看完整清單與 tool id。

## 自動更新

從選單選 **Configure automatic update list**，勾選要保持最新的工具，按 Enter 儲存。之後執行：

```bash
dev-bootstrap update
```

這個指令是非互動的，適合掛在 Windows Task Scheduler 或 cron。

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
