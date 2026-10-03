#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsDir = join(rootDir, "tools");

/** 從 package.json 取得版本，避免在畫面上寫死版本號。 */
function readPackageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

const APP_VERSION = readPackageVersion();

const SCHEDULE_TASK_NAME = "dev-bootstrap-update";
const DEFAULT_SCHEDULE_TIME = "09:00";
type ScheduleFrequency = "daily" | "weekly";
type ScheduleOptions = { frequency: ScheduleFrequency; time: string; weekday: string };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * 解析排程要執行的指令。
 *
 * 排程執行時的 PATH 與互動 shell 不同，因此一律使用絕對路徑，
 * 不能依賴 dev-bootstrap 這個指令名稱能被解析到。
 */
function scheduleCommandParts(): { exec: string; args: string[] } {
  const entry = join(rootDir, "dist", "index.js");
  return { exec: process.execPath, args: [entry, "update"] };
}

function parseScheduleTime(value: string): string {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time "${value}". Use HH:MM in 24-hour format, e.g. 09:00.`);
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function parseWeekday(value: string): string {
  const normalized = value.trim().toLowerCase().slice(0, 3);
  if (!WEEKDAYS.includes(normalized as (typeof WEEKDAYS)[number])) {
    throw new Error(`Invalid weekday "${value}". Use one of: ${WEEKDAYS.join(", ")}.`);
  }
  return normalized;
}

/**
 * 設定目錄解析順序：
 * 1. DEV_BOOTSTRAP_HOME 環境變數（供 CI 或自訂路徑使用）
 * 2. 當前目錄已存在的 .dev-bootstrap（相容舊版專案內設定）
 * 3. 使用者家目錄 ~/.dev-bootstrap（全域安裝後的預設位置）
 *
 * 不可使用套件所在目錄，否則全域安裝後設定會落在 node_modules 內，
 * 每次升級都會被清除。
 */
function resolveConfigDir(): string {
  const fromEnv = process.env.DEV_BOOTSTRAP_HOME;
  if (fromEnv) return fromEnv;

  const localDir = join(process.cwd(), ".dev-bootstrap");
  if (existsSync(localDir)) return localDir;

  return join(homedir(), ".dev-bootstrap");
}

const configDir = resolveConfigDir();
const updateProfilePath = join(configDir, "update-profile.json");
/** 使用者自訂工具定義；疊加在套件內建的 tools/ 之上。 */
const userToolsDir = join(configDir, "tools");
const VERIFY_TIMEOUT_MS = 10000;
const WINGET_NO_UPGRADE_EXIT_CODE = 43;

type Platform = "windows" | "mac" | "linux";
type InstallSpec = {
  npm?: string;
  bun?: string;
  winget?: string;
  brew?: string;
  apt?: string;
  script?: string;
  powershell?: string;
};
type UpdateSpec = {
  disabled?: boolean;
  note?: string;
  command?: string;
};
type VerifySpec = { command: string; regex?: string };
type Tool = {
  id: string;
  name: string;
  category: string;
  description?: string;
  homepage?: string;
  install?: InstallSpec;
  update?: UpdateSpec;
  verify?: VerifySpec[];
  /** 僅用於使用者自訂設定：標記 true 可隱藏同 id 的內建工具。 */
  remove?: boolean;
};
type ToolStatusKind = "unchecked" | "installed" | "missing" | "timeout";
type ToolStatus = {
  kind: ToolStatusKind;
  installed: boolean;
  version: string;
  raw?: string;
};

type MenuState = {
  cursor: number;
  scrollOffset: number;
  selected: Set<string>;
  filter: string;
  category: string;
  force: boolean;
};

type UpdateProfile = {
  version: 1;
  toolIds: string[];
  updatedAt: string;
};

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  clear: "\x1b[2J\x1b[H",
  home: "\x1b[H",
  clearBelow: "\x1b[J",
  clearLineEnd: "\x1b[K",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  // 替代畫面緩衝區：全螢幕介面在獨立畫面繪製，離開後還原原本的終端內容，
  // 避免每次重繪把畫面推進捲動緩衝區而殘留大量歷史。
  enterAltScreen: "\x1b[?1049h",
  exitAltScreen: "\x1b[?1049l",
};

let altScreenActive = false;

function enterAltScreen() {
  if (altScreenActive || !process.stdout.isTTY) return;
  process.stdout.write(ansi.enterAltScreen);
  altScreenActive = true;
}

function exitAltScreen() {
  if (!altScreenActive) return;
  process.stdout.write(`${ansi.showCursor}${ansi.exitAltScreen}`);
  altScreenActive = false;
}

function enableRawInput() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
}

function disableRawInput() {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

function restoreTerminal(newline = false) {
  disableRawInput();
  exitAltScreen();
  process.stdout.write(`${ansi.showCursor}${newline ? "\n" : ""}`);
}

function platform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

const COMMAND_ENV = "DEV_BOOTSTRAP_COMMAND";

function shellCommand(command: string) {
  // Windows 上不能直接把命令放進 args：Node 會把命令內的雙引號改寫成 \"，
  // 導致 `powershell -Command "..."` 的內容被當成字串輸出而非執行。
  // 改以環境變數傳遞，由 cmd.exe 自行展開，引號便能原封不動保留。
  // cmd 是在展開前才判斷是否剝除外層引號，所以變數值不能再額外包引號。
  if (isWindows()) {
    return {
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", `%${COMMAND_ENV}%`],
      env: { ...process.env, [COMMAND_ENV]: command },
    };
  }
  return { cmd: "bash", args: ["-lc", command], env: process.env };
}

function runCapture(
  command: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): { ok: boolean; stdout: string; stderr: string; code: number | null; timedOut: boolean } {
  try {
    const sh = shellCommand(command);
    const proc = spawnSync(sh.cmd, sh.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: sh.env,
    });
    return {
      ok: proc.status === 0,
      stdout: (proc.stdout ?? "").trim(),
      stderr: (proc.stderr ?? "").trim(),
      code: proc.status,
      timedOut: (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: String(err?.message ?? err), code: null, timedOut: false };
  }
}

function runInteractive(command: string): number | null {
  const sh = shellCommand(command);
  const proc = spawnSync(sh.cmd, sh.args, {
    stdio: "inherit",
    windowsHide: false,
    env: sh.env,
  });
  if (proc.error || proc.status == null) {
    console.log(`Process did not exit normally: signal=${proc.signal ?? "none"} error=${proc.error?.message ?? "none"}`);
  }
  return proc.status;
}

function isWingetUpToDateResult(command: string, code: number | null): boolean {
  if (!command.trim().startsWith("winget upgrade")) return false;
  return code === WINGET_NO_UPGRADE_EXIT_CODE;
}

function readToolsFromDir(dir: string): Tool[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const tools: Tool[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = YAML.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`Skipping ${path}: ${(err as Error).message}`);
      continue;
    }
    if (Array.isArray(parsed)) tools.push(...(parsed as Tool[]));
    else if (parsed) tools.push(parsed as Tool);
  }
  return tools;
}

/**
 * 載入工具定義，使用者自訂的設定疊加在內建定義之上。
 *
 * - 內建：套件內的 tools/，隨版本更新，不應手動修改
 * - 自訂：<設定目錄>/tools/*.yaml，同 id 覆寫、新 id 新增
 * - 以 remove: true 標記可隱藏不需要的內建工具
 *
 * 採疊加而非複製，使用者既能自訂，又不會失去內建定義的後續更新。
 */
function loadTools(): Tool[] {
  if (!existsSync(toolsDir)) throw new Error(`Missing tools directory: ${toolsDir}`);

  const merged = new Map<string, Tool>();
  for (const tool of readToolsFromDir(toolsDir)) merged.set(tool.id, tool);

  for (const tool of readToolsFromDir(userToolsDir)) {
    if (!tool?.id) {
      console.error(`Skipping a user-defined tool without an id in ${userToolsDir}`);
      continue;
    }
    if (tool.remove) {
      merged.delete(tool.id);
      continue;
    }
    const base = merged.get(tool.id);
    // 淺層合併：未指定的欄位沿用內建定義，install/update/verify 整組覆寫。
    merged.set(tool.id, base ? { ...base, ...tool } : tool);
  }

  const tools = [...merged.values()].filter((tool) => tool.id && tool.name && tool.category);
  return tools.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function chooseInstallCommand(tool: Tool): string | null {
  const p = platform();
  const install = tool.install ?? {};

  if (p === "windows") {
    if (install.winget) return `winget install --id ${install.winget} -e --accept-package-agreements --accept-source-agreements`;
    if (install.powershell) return install.powershell;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "mac") {
    if (install.brew) return `brew install ${install.brew}`;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "linux") {
    if (install.apt) return `sudo apt-get update && sudo apt-get install -y ${install.apt}`;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (install.npm) return `npm install -g ${install.npm}`;
  if (install.bun) return `bun add -g ${install.bun}`;
  return null;
}

function versionFromOutput(output: string, regex?: string): string {
  const text = output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? output.trim();
  if (!text) return "installed";
  if (regex) {
    try {
      const m = text.match(new RegExp(regex));
      if (m?.[1]) return m[1];
    } catch { }
  }
  const m = text.match(/v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/);
  return m?.[0] ?? text.slice(0, 80);
}

function hasVersionInOutput(output: string, regex?: string): boolean {
  const text = output.trim();
  if (!text) return false;
  if (regex) {
    try {
      if (new RegExp(regex).test(text)) return true;
    } catch { }
  }
  return /v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/.test(text);
}

function commandNameFromVerify(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const quoted = trimmed.match(/^"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return trimmed.split(/\s+/)[0] ?? null;
}

function commandExists(command: string): boolean {
  const name = commandNameFromVerify(command);
  if (!name) return false;
  const probe = isWindows() ? `where.exe ${name}` : `command -v ${name}`;
  const result = runCapture(probe, 3000);
  return result.ok && !!result.stdout.trim();
}

function detectStatus(tool: Tool): ToolStatus {
  if (!tool.verify || tool.verify.length === 0) {
    return { kind: "missing", installed: false, version: "no verify" };
  }

  for (const v of tool.verify) {
    const result = runCapture(v.command);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.ok && output.trim()) {
      return {
        kind: "installed",
        installed: true,
        version: versionFromOutput(output, v.regex),
        raw: output,
      };
    }
    if (result.timedOut && output.trim()) {
      return {
        kind: "installed",
        installed: true,
        version: versionFromOutput(output, v.regex),
        raw: output,
      };
    }
    if (result.ok) {
      return { kind: "installed", installed: true, version: "installed" };
    }
    if (commandExists(v.command)) {
      return {
        kind: "installed",
        installed: true,
        version: hasVersionInOutput(output, v.regex) ? versionFromOutput(output, v.regex) : "installed",
        raw: output || undefined,
      };
    }
    if (result.timedOut) {
      return { kind: "timeout", installed: false, version: "timeout" };
    }
  }

  return { kind: "missing", installed: false, version: "not installed" };
}

function uncheckedStatus(): ToolStatus {
  return { kind: "unchecked", installed: false, version: "unchecked" };
}

function detectAllWithProgress(tools: Tool[], label = "Checking installed versions"): Map<string, ToolStatus> {
  const status = new Map<string, ToolStatus>();
  const frames = ["-", "\\", "|", "/"];
  const interactive = !!process.stdout.isTTY;
  if (interactive) process.stdout.write(ansi.hideCursor);
  try {
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      if (interactive) {
        const pct = Math.round(((i + 1) / tools.length) * 24);
        const lines = [
          `${ansi.bold}dev-bootstrap${ansi.reset}`,
          `${ansi.cyan}${frames[i % frames.length]}${ansi.reset} ${label}`,
          `${ansi.dim}${i + 1}/${tools.length}${ansi.reset} ${tool.name}`,
          tool.verify?.[0]?.command ? `${ansi.dim}${tool.verify[0].command}${ansi.reset}` : "",
          "",
          `[${"#".repeat(pct)}${"-".repeat(24 - pct)}] ${i + 1}/${tools.length}`,
        ];
        const painted = lines.map((line) => `${line}${ansi.clearLineEnd}`).join("\n");
        process.stdout.write(`${i === 0 ? ansi.clear : ansi.home}${painted}${ansi.clearBelow}`);
      }
      status.set(tool.id, detectStatus(tool));
    }
  } finally {
    if (interactive) process.stdout.write(ansi.showCursor);
  }
  return status;
}

function loadUpdateProfile(): UpdateProfile {
  try {
    const parsed = JSON.parse(readFileSync(updateProfilePath, "utf8")) as Partial<UpdateProfile>;
    const toolIds = Array.isArray(parsed.toolIds) ? parsed.toolIds.filter((id): id is string => typeof id === "string") : [];
    return { version: 1, toolIds, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
  } catch {
    return { version: 1, toolIds: [], updatedAt: "" };
  }
}

function saveUpdateProfile(toolIds: string[]) {
  mkdirSync(configDir, { recursive: true });
  const profile: UpdateProfile = { version: 1, toolIds: [...new Set(toolIds)].sort(), updatedAt: new Date().toISOString() };
  writeFileSync(updateProfilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function updateCommand(tool: Tool): string | null {
  if (tool.update?.disabled) return null;
  if (tool.update?.command) return tool.update.command;

  const p = platform();
  const install = tool.install ?? {};

  if (p === "windows" && install.winget) {
    return `winget upgrade --id ${install.winget} -e --accept-package-agreements --accept-source-agreements`;
  }
  if (p === "mac" && install.brew) return `brew upgrade ${install.brew}`;
  // npm 與 bun 各自只更新自己安裝的那份；yaml 應標註官方推薦的那個管理器。
  if (install.npm) return `npm install -g ${install.npm}@latest`;
  if (install.bun) return `bun add -g ${install.bun}@latest`;
  // Script-based installers do not expose a portable update command. Re-run only when explicitly selected.
  return install.script ?? chooseInstallCommand(tool);
}

function canUseWingetForUpdate(packageId: string): boolean {
  const result = runCapture(
    `winget list --id ${packageId} -e --accept-source-agreements --disable-interactivity`,
    5000,
  );
  return result.ok;
}

function statusText(status?: ToolStatus): string {
  if (!status) return "unchecked";
  if (status.kind === "unchecked") return "unchecked";
  if (status.kind === "timeout") return "timeout";
  return status.installed ? status.version : "not installed";
}

function colorStatus(status?: ToolStatus): string {
  if (!status || status.kind === "unchecked") return `${ansi.dim}unchecked${ansi.reset}`;
  if (status.kind === "timeout") return `${ansi.yellow}timeout${ansi.reset}`;
  if (status.installed) return `${ansi.green}${status.version}${ansi.reset}`;
  return `${ansi.dim}not installed${ansi.reset}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function pad(value: string, width: number): string {
  const length = stripAnsi(value).length;
  return value + " ".repeat(Math.max(1, width - length));
}

function groupedCategories(tools: Tool[]): string[] {
  return ["All", ...Array.from(new Set(tools.map((t) => t.category))).sort()];
}

function filteredTools(tools: Tool[], state: MenuState): Tool[] {
  const q = state.filter.trim().toLowerCase();
  return tools.filter((tool) => {
    const categoryOk = state.category === "All" || tool.category === state.category;
    const querySource = [tool.id, tool.name, tool.category, tool.description ?? ""].join(" ").toLowerCase();
    const queryOk = !q || querySource.includes(q);
    return categoryOk && queryOk;
  });
}

function currentTool(visible: Tool[], state: MenuState): Tool | undefined {
  if (visible.length === 0) return undefined;
  if (state.cursor >= visible.length) state.cursor = visible.length - 1;
  if (state.cursor < 0) state.cursor = 0;
  return visible[state.cursor];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// 選單固定佔用的行數：
// header 6（標題、說明、空行、分類、狀態列、分隔線）
// footer 8（空行、分隔線、名稱、描述、狀態、homepage、install）
// 滾動提示 2（上方/下方各一行）
const MENU_CHROME_ROWS = 16;

/**
 * 可顯示的工具列數。
 *
 * 每組分類標題會額外佔用 2 行（空行 + 分類名稱），而組數取決於捲動位置，
 * 因此以實際會進入視窗的工具反推，逐步收斂到不超出終端高度的最大值。
 */
function pageSize(visible?: Tool[], scrollOffset = 0): number {
  const rows = process.stdout.rows ?? 30;
  const budget = rows - MENU_CHROME_ROWS;
  if (!visible || visible.length === 0) return Math.max(3, Math.min(budget, 60));

  let size = Math.max(3, Math.min(budget, 60));
  while (size > 3) {
    const windowed = visible.slice(scrollOffset, scrollOffset + size);
    const categories = new Set(windowed.map((tool) => tool.category)).size;
    if (size + categories * 2 <= budget) break;
    size--;
  }
  return size;
}

function screenWidth(): number {
  const columns = process.stdout.columns ?? 100;
  return clamp(columns - 1, 72, 120);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function ensureCursorVisible(visible: Tool[], state: MenuState) {
  const visibleCount = visible.length;
  const size = pageSize(visible, state.scrollOffset);
  state.cursor = clamp(state.cursor, 0, Math.max(0, visibleCount - 1));
  state.scrollOffset = clamp(state.scrollOffset, 0, Math.max(0, visibleCount - size));

  if (state.cursor < state.scrollOffset) {
    state.scrollOffset = state.cursor;
  }
  if (state.cursor >= state.scrollOffset + size) {
    state.scrollOffset = state.cursor - size + 1;
  }
}

function renderInstallMenu(tools: Tool[], status: Map<string, ToolStatus>, state: MenuState) {
  const visible = filteredTools(tools, state);
  ensureCursorVisible(visible, state);
  const selectedTool = currentTool(visible, state);
  const size = pageSize(visible, state.scrollOffset);
  const windowed = visible.slice(state.scrollOffset, state.scrollOffset + size);
  const width = screenWidth();
  const lines: string[] = [];

  const categoryActionLabel =
    state.category === "All" ? "all category items" : `${state.category} category`;

  const categories = groupedCategories(tools)
    .map((category) => (category === state.category ? `[${category}]` : category))
    .join(" | ");

  lines.push(`${ansi.bold}dev-bootstrap${ansi.reset}${APP_VERSION ? ` ${ansi.dim}v${APP_VERSION}${ansi.reset}` : ""}`);
  lines.push(
    `${ansi.dim}${truncate(
      `Space toggle | A/Ctrl+A visible items | C ${categoryActionLabel} | Tab category | / search | V refresh versions | F force ${state.force ? "on" : "off"} | Enter install | Backspace back | Q quit`,
      width,
    )}${ansi.reset}`,
  );
  lines.push("");
  lines.push(`Categories: ${truncate(categories, width - 12)}`);
  lines.push(
    truncate(
      `Filter: ${state.filter ? state.filter : "none"}  ` +
      `Selected: ${state.selected.size}  ` +
      `Visible: ${visible.length}/${tools.length}  ` +
      `Showing: ${visible.length === 0 ? 0 : state.scrollOffset + 1}-${Math.min(visible.length, state.scrollOffset + size)}`,
      width,
    ),
  );
  lines.push("=".repeat(width));

  if (visible.length === 0) {
    lines.push(`${ansi.yellow}No tools matched the current filter.${ansi.reset}`);
  } else {
    if (state.scrollOffset > 0) {
      lines.push(`${ansi.dim}... ${state.scrollOffset} tools above${ansi.reset}`);
    }

    let lastCategory = "";
    for (let i = 0; i < windowed.length; i++) {
      const absoluteIndex = state.scrollOffset + i;
      const tool = windowed[i];
      if (tool.category !== lastCategory) {
        lastCategory = tool.category;
        lines.push("");
        lines.push(`${ansi.bold}${tool.category}${ansi.reset}`);
      }

      const pointer = absoluteIndex === state.cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      const checked = state.selected.has(tool.id) ? `${ansi.green}[x]${ansi.reset}` : "[ ]";
      const labelWidth = Math.min(32, Math.max(22, Math.floor(width * 0.34)));
      const descWidth = Math.min(36, Math.max(18, width - labelWidth - 24));
      const label = pad(`${checked} ${truncate(tool.name, labelWidth - 5)}`, labelWidth);
      const desc = pad(truncate(tool.description ?? "", descWidth), descWidth);
      lines.push(`${pointer} ${label} ${desc} ${colorStatus(status.get(tool.id))}`);
    }

    const hiddenBelow = visible.length - state.scrollOffset - windowed.length;
    if (hiddenBelow > 0) {
      lines.push(`${ansi.dim}... ${hiddenBelow} tools below${ansi.reset}`);
    }
  }

  lines.push("");
  lines.push("-".repeat(width));
  if (selectedTool) {
    const st = status.get(selectedTool.id) ?? uncheckedStatus();
    lines.push(`${ansi.bold}${truncate(selectedTool.name, Math.max(20, width - selectedTool.id.length - 4))}${ansi.reset} ${ansi.dim}(${selectedTool.id})${ansi.reset}`);
    lines.push(truncate(selectedTool.description ?? "No description", width));
    lines.push(`Status: ${colorStatus(st)}  Category: ${selectedTool.category}`);
    if (selectedTool.homepage) lines.push(truncate(`Homepage: ${selectedTool.homepage}`, width));
    const installCommand = chooseInstallCommand(selectedTool);
    if (installCommand) lines.push(`${ansi.dim}${truncate(`Install: ${installCommand}`, width)}${ansi.reset}`);
  } else {
    lines.push(`${ansi.dim}No tool selected.${ansi.reset}`);
  }

  // 每行結尾清到行尾，避免新行比舊行短時殘留前一次的字元。
  const painted = lines.map((line) => `${line}${ansi.clearLineEnd}`).join("\n");
  process.stdout.write(`${ansi.home}${painted}${ansi.clearBelow}`);
}

async function readKey(): Promise<string> {
  return await new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.off("data", onData);
      resolve(data.toString("utf8"));
    };
    process.stdin.on("data", onData);
  });
}

async function promptLine(label: string): Promise<string> {
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write(label ? `\n${label}: ` : "\n");
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      if (text.includes("\n") || text.includes("\r")) {
        process.stdin.off("data", onData);
        buf += text.replace(/[\r\n]+/g, "");
        resolve(buf.trim());
      } else {
        buf += text;
      }
    };
    process.stdin.on("data", onData);
  });
  enableRawInput();
  return line;
}

async function confirmLine(label: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await promptLine(`${label} (${suffix})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function withUncheckedStatus(tools: Tool[]): Map<string, ToolStatus> {
  return new Map(tools.map((tool) => [tool.id, uncheckedStatus()]));
}

async function installMenu(
  tools: Tool[],
  mode: "install" | "update-profile" = "install",
  sharedStatus?: Map<string, ToolStatus>,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("Interactive menu requires a TTY. Try: bun run menu");
    process.exit(1);
  }

  process.stdout.write(ansi.clear);
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const isUpdateProfile = mode === "update-profile";
  console.log(`${ansi.bold}${isUpdateProfile ? "Configure automatic updates" : "Install tools"}${ansi.reset}\n`);
  console.log(isUpdateProfile ? "Choose the tools that should be updated by the saved update command." : "You can skip version detection for a faster menu load.");

  // 沿用本次執行期間已掃描過的結果，避免重複進出選單時反覆詢問與掃描。
  // 以 V 鍵可隨時重新掃描。
  let status = sharedStatus ?? withUncheckedStatus(tools);
  const alreadyScanned = [...status.values()].some((s) => s.kind !== "unchecked");
  if (alreadyScanned) {
    const scanned = [...status.values()].filter((s) => s.kind !== "unchecked").length;
    console.log(`${ansi.dim}Using cached versions for ${scanned} tools. Press V in the menu to rescan.${ansi.reset}`);
  } else {
    // Ask before raw mode. Git Bash can lose the first keypress when switching modes.
    const shouldScan = await confirmLine("Check installed versions now", false);
    if (shouldScan) {
      const detected = detectAllWithProgress(tools);
      for (const [toolId, toolStatus] of detected) status.set(toolId, toolStatus);
    }
  }
  const saved = isUpdateProfile ? loadUpdateProfile() : null;
  const state: MenuState = {
    cursor: 0,
    scrollOffset: 0,
    selected: new Set(saved?.toolIds ?? []),
    filter: "",
    category: "All",
    force: isUpdateProfile,
  };
  const categories = groupedCategories(tools);
  enableRawInput();
  enterAltScreen();
  process.stdout.write(ansi.clear + ansi.hideCursor);

  try {
    while (true) {
      renderInstallMenu(tools, status, state);
      const visible = filteredTools(tools, state);
      const key = await readKey();

      if (key === "\u0003" || key.toLowerCase() === "q") {
        restoreTerminal(true);
        process.exit(0);
      }

      if (key === "\u001b[A") {
        state.cursor = Math.max(0, state.cursor - 1);
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\u001b[B") {
        state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + 1);
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\u001b[5~") {
        state.cursor = Math.max(0, state.cursor - pageSize(visible, state.scrollOffset));
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\u001b[6~") {
        state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + pageSize(visible, state.scrollOffset));
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\u001b[H" || key === "\u001b[1~") {
        state.cursor = 0;
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\u001b[F" || key === "\u001b[4~") {
        state.cursor = Math.max(0, visible.length - 1);
        ensureCursorVisible(visible, state);
        continue;
      }
      if (key === "\t") {
        const idx = categories.indexOf(state.category);
        state.category = categories[(idx + 1) % categories.length];
        state.cursor = 0;
        state.scrollOffset = 0;
        continue;
      }
      if (key === " ") {
        const tool = visible[state.cursor];
        if (tool) {
          if (state.selected.has(tool.id)) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "a" || key === "\u0001") {
        const allSelected = visible.length > 0 && visible.every((tool) => state.selected.has(tool.id));
        for (const tool of visible) {
          if (allSelected) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "c") {
        const categoryTools = tools.filter((tool) => state.category === "All" || tool.category === state.category);
        const allSelected = categoryTools.length > 0 && categoryTools.every((tool) => state.selected.has(tool.id));
        for (const tool of categoryTools) {
          if (allSelected) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "f") {
        state.force = !state.force;
        continue;
      }
      if (key.toLowerCase() === "v") {
        // 原地更新，讓主選單傳入的共用快取也一併刷新。
        const refreshed = detectAllWithProgress(tools, "Refreshing installed versions");
        for (const [toolId, toolStatus] of refreshed) status.set(toolId, toolStatus);
        process.stdout.write(ansi.clear + ansi.hideCursor);
        continue;
      }
      if (key === "/") {
        state.filter = await promptLine("Search");
        state.cursor = 0;
        state.scrollOffset = 0;
        process.stdout.write(ansi.clear + ansi.hideCursor);
        continue;
      }
      if (key === "\b" || key === "\x7f" || key === "\u001b") {
        restoreTerminal(false);
        return false;
      }
      if (key === "\r" || key === "\n") {
        restoreTerminal(true);
        const selected = tools.filter((tool) => state.selected.has(tool.id));
        if (isUpdateProfile) {
          const save = await confirmLine(`Save ${selected.length} selected tools as the automatic update profile`, true);
          if (save) {
            saveUpdateProfile(selected.map((tool) => tool.id));
            console.log(`Saved update profile: ${updateProfilePath}`);
          } else {
            console.log("Update profile was not changed.");
          }
        } else {
          await installTools(selected, status, state.force);
        }
        return true;
      }
    }
  } finally {
    exitAltScreen();
    process.stdout.write(ansi.showCursor);
  }
}

async function installTools(tools: Tool[], status = withUncheckedStatus(tools), force = false) {
  if (tools.length === 0) {
    console.log("No tools selected.");
    return;
  }

  const unchecked = tools.filter((tool) => (status.get(tool.id) ?? uncheckedStatus()).kind === "unchecked");
  if (unchecked.length > 0) {
    const refreshed = detectAllWithProgress(unchecked, "Checking selected tools before install");
    for (const [toolId, toolStatus] of refreshed) status.set(toolId, toolStatus);
  }

  const installed = tools.filter((tool) => status.get(tool.id)?.installed);
  if (installed.length > 0 && !force) {
    console.log("Already installed tools will be skipped:");
    for (const tool of installed) {
      console.log(`- ${tool.name} ${status.get(tool.id)?.version ?? ""}`);
    }
    const reinstall = await confirmLine("Install/update already installed tools too", false);
    if (reinstall) force = true;
  }

  for (const tool of tools) {
    const currentStatus = status.get(tool.id);
    if (currentStatus?.installed && !force) {
      console.log(`\nSKIP ${tool.name} (${currentStatus.version})`);
      continue;
    }

    const command = chooseInstallCommand(tool);
    if (!command) {
      console.log(`\nNO INSTALLER ${tool.name} on ${platform()}`);
      if (tool.homepage) console.log(`Homepage: ${tool.homepage}`);
      continue;
    }

    console.log(`\n==> Installing ${tool.name}`);
    console.log(`$ ${command}`);
    const code = runInteractive(command);
    const after = detectStatus(tool);
    status.set(tool.id, after);

    if (code === 0 && after.installed) {
      console.log(`OK ${tool.name}: ${after.version}`);
    } else if (code === 0) {
      console.log(`DONE ${tool.name}, but verify did not detect it. Restart terminal or check PATH.`);
    } else {
      console.log(`FAILED ${tool.name} exit=${code}`);
    }
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const launchAgentPath = () =>
  join(homedir(), "Library", "LaunchAgents", `com.dev-bootstrap.update.plist`);

/** 產生註冊排程所需的指令；不執行，供顯示與確認後再執行。 */
function buildScheduleCreateCommand(options: ScheduleOptions): string {
  const { exec, args } = scheduleCommandParts();
  const p = platform();

  if (p === "windows") {
    // schtasks /tr 的值以一對外層引號包住，內部引號需以 \" 逸出。
    const task = [exec, ...args].map((a) => `\\"${a}\\"`).join(" ");
    const base = `schtasks /create /tn "${SCHEDULE_TASK_NAME}" /tr "${task}" /st ${options.time} /f`;
    return options.frequency === "daily"
      ? `${base} /sc daily`
      : `${base} /sc weekly /d ${options.weekday.toUpperCase()}`;
  }

  if (p === "mac") {
    const [hour, minute] = options.time.split(":").map(Number);
    const calendar =
      options.frequency === "daily"
        ? `    <key>Hour</key><integer>${hour}</integer>\n    <key>Minute</key><integer>${minute}</integer>`
        : `    <key>Weekday</key><integer>${WEEKDAYS.indexOf(options.weekday as (typeof WEEKDAYS)[number])}</integer>\n    <key>Hour</key><integer>${hour}</integer>\n    <key>Minute</key><integer>${minute}</integer>`;
    const programArgs = [exec, ...args]
      .map((a) => `    <string>${a}</string>`)
      .join("\n");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dev-bootstrap.update</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${calendar}
  </dict>
</dict>
</plist>`;
    const path = launchAgentPath();
    return [
      `mkdir -p ${quoteForShell(dirname(path))}`,
      `cat > ${quoteForShell(path)} <<'PLIST'\n${plist}\nPLIST`,
      `launchctl unload ${quoteForShell(path)} 2>/dev/null; launchctl load ${quoteForShell(path)}`,
    ].join("\n");
  }

  // Linux：以 crontab 註冊，保留既有項目並移除舊的 dev-bootstrap 設定。
  const [hour, minute] = options.time.split(":").map(Number);
  const dayField = options.frequency === "daily" ? "*" : String(WEEKDAYS.indexOf(options.weekday as (typeof WEEKDAYS)[number]));
  const line = `${minute} ${hour} * * ${dayField} ${quoteForShell(exec)} ${args.map(quoteForShell).join(" ")} # ${SCHEDULE_TASK_NAME}`;
  return `(crontab -l 2>/dev/null | grep -v '# ${SCHEDULE_TASK_NAME}$'; echo ${quoteForShell(line)}) | crontab -`;
}

function buildScheduleRemoveCommand(): string {
  const p = platform();
  if (p === "windows") return `schtasks /delete /tn "${SCHEDULE_TASK_NAME}" /f`;
  if (p === "mac") {
    const path = launchAgentPath();
    return `launchctl unload ${quoteForShell(path)} 2>/dev/null; rm -f ${quoteForShell(path)}`;
  }
  return `crontab -l 2>/dev/null | grep -v '# ${SCHEDULE_TASK_NAME}$' | crontab -`;
}

function buildScheduleStatusCommand(): string {
  const p = platform();
  if (p === "windows") return `schtasks /query /tn "${SCHEDULE_TASK_NAME}" /fo list /v`;
  if (p === "mac") return `launchctl list | grep com.dev-bootstrap.update || echo "Not scheduled."`;
  return `crontab -l 2>/dev/null | grep '# ${SCHEDULE_TASK_NAME}$' || echo "Not scheduled."`;
}

type Confirm = (label: string) => Promise<boolean>;
type CreateScheduleResult = "scheduled" | "failed" | "cancelled" | "no-profile";

const WEEKDAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

function describeSchedule(options: ScheduleOptions): string {
  return options.frequency === "daily"
    ? `every day at ${options.time}`
    : `every ${WEEKDAY_NAMES[options.weekday as (typeof WEEKDAYS)[number]]} at ${options.time}`;
}

function showScheduleStatus() {
  const command = buildScheduleStatusCommand();
  console.log(`${ansi.dim}${command}${ansi.reset}\n`);
  const code = runInteractive(command);
  if (code !== 0) console.log("\nNo automatic update schedule seems to be registered yet.");
}

async function removeSchedule(confirm: Confirm) {
  const command = buildScheduleRemoveCommand();
  console.log("This will remove the scheduled automatic update:\n");
  console.log(`${ansi.dim}${command}${ansi.reset}\n`);
  if (!(await confirm("Proceed"))) {
    if (process.exitCode !== 1) console.log("Cancelled.");
    return;
  }
  const code = runInteractive(command);
  console.log(code === 0 ? "\nSchedule removed." : `\nFailed with exit code ${code}.`);
}

async function createSchedule(options: ScheduleOptions, confirm: Confirm): Promise<CreateScheduleResult> {
  const profile = loadUpdateProfile();
  if (profile.toolIds.length === 0) {
    console.log("No saved update profile. Run: dev-bootstrap menu, then choose 'Configure automatic update list'.");
    return "no-profile";
  }

  const command = buildScheduleCreateCommand(options);
  console.log(`Scheduling automatic update ${describeSchedule(options)} for ${profile.toolIds.length} tools.\n`);
  console.log("The following will be executed:\n");
  console.log(`${ansi.dim}${command}${ansi.reset}\n`);

  if (!(await confirm("Proceed"))) {
    if (process.exitCode !== 1) console.log("Cancelled.");
    return "cancelled";
  }

  const code = runInteractive(command);
  if (code === 0) {
    console.log(`\nScheduled ${describeSchedule(options)}. Check it with: dev-bootstrap schedule status`);
    return "scheduled";
  }
  console.log(`\nFailed with exit code ${code}.`);
  return "failed";
}

/** 以方向鍵從清單挑一項；Esc／Backspace／Ctrl+C 取消並回傳 null。 */
async function chooseOne(title: string, items: string[], subtitle?: string): Promise<number | null> {
  let cursor = 0;
  enableRawInput();
  while (true) {
    process.stdout.write(ansi.clear);
    console.log(`${ansi.bold}${title}${ansi.reset}`);
    console.log(`${ansi.dim}Arrow keys move | Enter select | Esc back${ansi.reset}`);
    if (subtitle) console.log(`${ansi.dim}${subtitle}${ansi.reset}`);
    console.log("");
    for (let i = 0; i < items.length; i++) {
      const pointer = i === cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      console.log(`${pointer} ${items[i]}`);
    }

    const key = await readKey();
    if (key === "\u0003" || key === "\u001b" || key === "\b" || key === "\x7f") return null;
    if (key === "\u001b[A") cursor = Math.max(0, cursor - 1);
    else if (key === "\u001b[B") cursor = Math.min(items.length - 1, cursor + 1);
    else if (key === "\r" || key === "\n") return cursor;
  }
}

const SCHEDULE_PRESETS: ScheduleOptions[] = [
  { frequency: "daily", time: "09:00", weekday: "mon" },
  { frequency: "weekly", time: "09:00", weekday: "mon" },
  { frequency: "weekly", time: "18:00", weekday: "fri" },
  { frequency: "daily", time: "12:30", weekday: "mon" },
];

/** 讓使用者自訂頻率、星期與時間；中途取消回傳 null。 */
async function promptCustomSchedule(): Promise<ScheduleOptions | null> {
  const frequencyIndex = await chooseOne("Custom schedule: how often?", ["Every day", "Every week"]);
  if (frequencyIndex === null) return null;
  const frequency: ScheduleFrequency = frequencyIndex === 0 ? "daily" : "weekly";

  let weekday = "mon";
  if (frequency === "weekly") {
    // 週一排最前面，符合多數人的習慣。
    const order = [...WEEKDAYS.slice(1), WEEKDAYS[0]];
    const dayIndex = await chooseOne(
      "Custom schedule: which day?",
      order.map((d) => WEEKDAY_NAMES[d]),
    );
    if (dayIndex === null) return null;
    weekday = order[dayIndex];
  }

  process.stdout.write(ansi.clear);
  while (true) {
    const answer = await promptLine(`Time in 24-hour HH:MM [${DEFAULT_SCHEDULE_TIME}], type q to cancel`);
    if (answer.toLowerCase() === "q") return null;
    try {
      return { frequency, weekday, time: parseScheduleTime(answer || DEFAULT_SCHEDULE_TIME) };
    } catch (err) {
      console.log(`${ansi.yellow}${(err as Error).message}${ansi.reset}`);
    }
  }
}

/** 互動式排程選單。回傳是否有輸出需要讓使用者看過再回主選單。 */
async function scheduleMenu(): Promise<boolean> {
  const action = await chooseOne("Automatic update schedule", [
    "Create or change schedule",
    "Show current schedule",
    "Remove schedule",
    "Back",
  ]);
  if (action === null || action === 3) return false;

  // 子選單結束時 stdin 仍為 raw 模式，需先還原才能讓子程序與輸入提示正常運作。
  const confirm: Confirm = async (label) => {
    const ok = await confirmLine(label, true);
    disableRawInput();
    return ok;
  };

  if (action === 1) {
    disableRawInput();
    process.stdout.write(ansi.clear);
    showScheduleStatus();
    return true;
  }

  if (action === 2) {
    disableRawInput();
    process.stdout.write(ansi.clear);
    await removeSchedule(confirm);
    return true;
  }

  const profile = loadUpdateProfile();
  if (profile.toolIds.length === 0) {
    disableRawInput();
    process.stdout.write(ansi.clear);
    console.log("No saved update profile. Choose 'Configure automatic update list' first.");
    return true;
  }

  const presetLabels = SCHEDULE_PRESETS.map((p) => describeSchedule(p).replace(/^every/, "Every"));
  const picked = await chooseOne(
    "When should the automatic update run?",
    [...presetLabels, "Custom..."],
    `${profile.toolIds.length} tools in the saved update list`,
  );
  if (picked === null) return false;

  const options = picked < SCHEDULE_PRESETS.length ? SCHEDULE_PRESETS[picked] : await promptCustomSchedule();
  disableRawInput();
  process.stdout.write(ansi.clear);
  if (!options) {
    console.log("Cancelled.");
    return true;
  }
  await createSchedule(options, confirm);
  return true;
}

async function scheduleCommand(args: string[]) {
  const sub = args[0] ?? "create";
  const rest = args.slice(1);

  /**
   * 取得確認。非互動環境（管線、排程、CI）沒有 TTY 可讀，
   * 直接等待輸入會永遠掛住，因此要求明確帶 --yes。
   */
  const confirm = async (label: string): Promise<boolean> => {
    if (rest.includes("--yes")) return true;
    if (!process.stdin.isTTY) {
      console.log("Not an interactive terminal. Re-run with --yes to proceed.");
      process.exitCode = 1;
      return false;
    }
    const ok = await confirmLine(label, false);
    disableRawInput();
    return ok;
  };

  if (sub === "status") {
    showScheduleStatus();
    return;
  }

  if (sub === "remove") {
    await removeSchedule(confirm);
    return;
  }

  if (sub !== "create") {
    console.log(`Unknown schedule subcommand "${sub}". Use: create, status, remove.`);
    process.exitCode = 1;
    return;
  }

  const readOption = (name: string, fallback: string) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
  };

  let options: ScheduleOptions;
  try {
    const frequency = rest.includes("--daily") ? "daily" : "weekly";
    options = {
      frequency,
      time: parseScheduleTime(readOption("time", DEFAULT_SCHEDULE_TIME)),
      weekday: parseWeekday(readOption("weekday", "mon")),
    };
  } catch (err) {
    console.log(String((err as Error).message));
    process.exitCode = 1;
    return;
  }

  const result = await createSchedule(options, confirm);
  if (result === "failed" || result === "no-profile") process.exitCode = 1;
}

function resolveToolsByIds(tools: Tool[], ids: string[]): Tool[] {
  return tools.filter((tool) => ids.includes(tool.id));
}

async function updateTools(tools: Tool[], status = withUncheckedStatus(tools)) {
  if (tools.length === 0) {
    console.log("No tools selected for update.");
    return;
  }

  const unchecked = tools.filter((tool) => (status.get(tool.id) ?? uncheckedStatus()).kind === "unchecked");
  if (unchecked.length > 0) {
    const refreshed = detectAllWithProgress(unchecked, "Checking saved tools before update");
    for (const [toolId, toolStatus] of refreshed) status.set(toolId, toolStatus);
  }

  const missing = tools.filter((tool) => !status.get(tool.id)?.installed);
  if (missing.length > 0) {
    console.log("Skipping tools that are not installed:");
    for (const tool of missing) console.log(`- ${tool.name}`);
  }

  for (const tool of tools) {
    const before = status.get(tool.id) ?? uncheckedStatus();
    if (!before.installed) continue;

    if (platform() === "windows" && tool.install?.winget && !tool.update?.command) {
      const managedByWinget = canUseWingetForUpdate(tool.install.winget);
      if (!managedByWinget) {
        console.log(`\nSKIP ${tool.name}: installed, but not managed by winget on this machine.`);
        if (tool.update?.note) console.log(tool.update.note);
        else if (tool.homepage) console.log(`Homepage: ${tool.homepage}`);
        continue;
      }
    }

    const command = updateCommand(tool);
    if (!command) {
      console.log(`\nSKIP ${tool.name}: no updater configured on ${platform()}.`);
      if (tool.update?.note) console.log(tool.update.note);
      continue;
    }

    console.log(`\n==> Updating ${tool.name} (current: ${before.version})`);
    console.log(`$ ${command}`);
    const code = runInteractive(command);
    const after = detectStatus(tool);
    status.set(tool.id, after);

    if (code === 0 && after.installed) console.log(`OK ${tool.name}: ${before.version} -> ${after.version}`);
    else if (isWingetUpToDateResult(command, code) && after.installed) console.log(`UP-TO-DATE ${tool.name}: ${after.version}`);
    else if (code === 0) console.log(`DONE ${tool.name}, but verify did not detect it. Restart terminal or check PATH.`);
    else console.log(`FAILED ${tool.name} exit=${code}`);
  }
}

function listTools(tools: Tool[], withStatus = false, sharedStatus?: Map<string, ToolStatus>) {
  let status: Map<string, ToolStatus>;
  if (!withStatus) {
    status = withUncheckedStatus(tools);
  } else {
    // 已有本次執行期間掃描過的結果就沿用，避免重複掃描。
    const cachedCount = sharedStatus
      ? tools.filter((tool) => (sharedStatus.get(tool.id)?.kind ?? "unchecked") !== "unchecked").length
      : 0;
    if (sharedStatus && cachedCount === tools.length) {
      status = sharedStatus;
    } else {
      status = detectAllWithProgress(tools, "Checking installed versions");
      if (sharedStatus) for (const [toolId, toolStatus] of status) sharedStatus.set(toolId, toolStatus);
    }
  }
  let lastCategory = "";

  for (const tool of tools) {
    if (tool.category !== lastCategory) {
      lastCategory = tool.category;
      console.log(`\n${tool.category}`);
    }
    const suffix = withStatus ? ` - ${statusText(status.get(tool.id))}` : "";
    console.log(`  ${tool.id.padEnd(18)} ${tool.name}${suffix}`);
  }
}

function doctor(tools: Tool[], sharedStatus?: Map<string, ToolStatus>) {
  // Doctor 一律重新掃描：診斷的目的就是反映當下實際狀態。
  // 掃描結果寫回共用快取，讓後續選單可以直接沿用。
  const status = detectAllWithProgress(tools, "Doctor: checking installed tools");
  if (sharedStatus) for (const [toolId, toolStatus] of status) sharedStatus.set(toolId, toolStatus);
  let installed = 0;

  for (const tool of tools) {
    const st = status.get(tool.id) ?? uncheckedStatus();
    if (st.installed) installed++;
    const mark = st.installed ? `${ansi.green}OK${ansi.reset}` : st.kind === "timeout" ? `${ansi.yellow}??${ansi.reset}` : "--";
    console.log(`${mark} ${pad(tool.name, 24)} ${statusText(st)}`);
  }

  console.log(`\n${installed}/${tools.length} tools detected.`);

  const userTools = readToolsFromDir(userToolsDir);
  console.log(`\n${ansi.dim}Built-in definitions: ${toolsDir}${ansi.reset}`);
  console.log(
    userTools.length > 0
      ? `${ansi.dim}Custom definitions:   ${userToolsDir} (${userTools.length} entries)${ansi.reset}`
      : `${ansi.dim}Custom definitions:   ${userToolsDir} (none yet)${ansi.reset}`,
  );
}

async function mainMenu(tools: Tool[]) {
  const options = [
    "Install tools",
    "Configure automatic update list",
    "Update saved tools now",
    "Schedule automatic updates",
    "Doctor",
    "List tools",
    "List tools with versions",
    "Exit",
  ];
  let cursor = 0;
  // 本次執行期間共用的版本掃描快取，避免每次進出選單都重新詢問與掃描。
  const sessionStatus = withUncheckedStatus(tools);

  enableRawInput();

  while (true) {
    const scanned = [...sessionStatus.values()].filter((s) => s.kind !== "unchecked").length;
    process.stdout.write(ansi.clear);
    console.log(`${ansi.bold}dev-bootstrap${ansi.reset}`);
    console.log(`${ansi.dim}Arrow keys move | Enter select | Q quit${ansi.reset}\n`);
    console.log(`${ansi.magenta}Platform:${ansi.reset} ${platform()}`);
    console.log(
      scanned > 0
        ? `${ansi.magenta}Versions:${ansi.reset} ${scanned}/${tools.length} scanned this session\n`
        : `${ansi.magenta}Versions:${ansi.reset} ${ansi.dim}not scanned yet${ansi.reset}\n`,
    );
    for (let i = 0; i < options.length; i++) {
      const pointer = i === cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      console.log(`${pointer} ${options[i]}`);
    }

    const key = await readKey();
    if (key === "\u0003" || key.toLowerCase() === "q") {
      restoreTerminal(true);
      return;
    }
    if (key === "\u001b[A") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (key === "\u001b[B") {
      cursor = Math.min(options.length - 1, cursor + 1);
      continue;
    }
    if (key === "\r" || key === "\n") {
      disableRawInput();
      process.stdout.write("\n");
      // 安裝有實際執行時才需要暫停，否則主選單的清畫面會蓋掉安裝結果。
      let needsPause = true;
      if (cursor === 0) needsPause = await installMenu(tools, "install", sessionStatus);
      else if (cursor === 1) await installMenu(tools, "update-profile", sessionStatus);
      else if (cursor === 2) {
        const profile = loadUpdateProfile();
        const selected = resolveToolsByIds(tools, profile.toolIds);
        if (profile.toolIds.length === 0) {
          console.log("No saved update profile. Choose 'Configure automatic update list' first.");
        } else {
          const unknown = profile.toolIds.filter((id) => !selected.some((tool) => tool.id === id));
          if (unknown.length > 0) console.log(`Ignoring removed/unknown tool ids: ${unknown.join(", ")}`);
          await updateTools(selected, sessionStatus);
        }
      }
      else if (cursor === 3) needsPause = await scheduleMenu();
      else if (cursor === 4) doctor(tools, sessionStatus);
      else if (cursor === 5) listTools(tools, false);
      else if (cursor === 6) listTools(tools, true, sessionStatus);
      else break;

      if (needsPause) {
        console.log("\nPress Enter to return.");
        await promptLine("");
      }
      enableRawInput();
    }
  }

  restoreTerminal(false);
}

async function main() {
  const tools = loadTools();
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "menu") {
    return await mainMenu(tools);
  }
  if (cmd === "list") {
    return listTools(tools, args.includes("--versions"));
  }
  if (cmd === "doctor") {
    return doctor(tools);
  }
  if (cmd === "install") {
    const force = args.includes("--force");
    const ids = args.filter((arg) => arg !== "--force");
    const selected = tools.filter((tool) => ids.includes(tool.id));
    const missing = ids.filter((id) => !selected.some((tool) => tool.id === id));
    if (missing.length > 0) console.log(`Unknown tool ids: ${missing.join(", ")}`);
    return await installTools(selected, detectAllWithProgress(selected, "Checking installed versions"), force);
  }
  if (cmd === "update") {
    const useAll = args.includes("--all");
    const ids = args.filter((arg) => arg !== "--all");
    const profile = loadUpdateProfile();
    const requestedIds = useAll ? tools.map((tool) => tool.id) : ids.length > 0 ? ids : profile.toolIds;
    const selected = resolveToolsByIds(tools, requestedIds);
    const missing = requestedIds.filter((id) => !selected.some((tool) => tool.id === id));
    if (missing.length > 0) console.log(`Unknown tool ids: ${missing.join(", ")}`);
    if (requestedIds.length === 0) {
      console.log("No saved update profile. Run: dev-bootstrap menu, then choose 'Configure automatic update list'.");
      process.exitCode = 1;
      return;
    }
    return await updateTools(selected);
  }
  if (cmd === "schedule") {
    return await scheduleCommand(args);
  }

  console.log(`Usage:
  dev-bootstrap menu
  dev-bootstrap list [--versions]
  dev-bootstrap doctor
  dev-bootstrap install <tool-id...> [--force]
  dev-bootstrap update [<tool-id...> | --all]
  dev-bootstrap schedule create [--daily] [--time HH:MM] [--weekday mon] [--yes]
  dev-bootstrap schedule status
  dev-bootstrap schedule remove [--yes]
`);
}

// 保險機制：任何離開路徑都必須還原終端，否則使用者的終端會卡在
// 替代畫面或隱藏游標的狀態。
process.on("exit", () => {
  exitAltScreen();
  // 僅在互動終端還原游標，避免污染管線或重導向的輸出。
  if (process.stdout.isTTY) process.stdout.write(ansi.showCursor);
});

main().catch((err) => {
  restoreTerminal(false);
  console.error(err);
  process.exit(1);
});
