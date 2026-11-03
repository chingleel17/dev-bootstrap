# dev-bootstrap

> Set up your development environment with one command, and keep it up to date.

English | [繁體中文](https://github.com/chingleel17/dev-bootstrap/blob/main/README.zh-TW.md)

<p>
  <a href="https://github.com/chingleel17/dev-bootstrap/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/chingleel17/dev-bootstrap/release.yml?style=for-the-badge&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/dev-bootstrap"><img src="https://img.shields.io/npm/v/dev-bootstrap?style=for-the-badge&color=2563eb&label=version" alt="npm version"></a>
  <a href="https://github.com/chingleel17/dev-bootstrap/releases"><img src="https://img.shields.io/github/v/release/chingleel17/dev-bootstrap?style=for-the-badge&color=7c3aed" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-475569?style=for-the-badge" alt="Platform Windows | macOS | Linux">
  <a href="https://github.com/chingleel17/dev-bootstrap/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/stack-Node.js%20%2B%20Bun%20%2B%20TypeScript-f97316?style=for-the-badge" alt="Stack Node.js + Bun + TypeScript">
</p>

When you get a new computer, reinstall your OS, or set up a machine for a new teammate, you no longer have to hunt down install pages one by one. `dev-bootstrap` ships install definitions for 41 common CLI tools, picks the right package manager for your OS (`winget` on Windows, `brew` on macOS, `apt` on Linux, `npm` / `bun` for cross-platform tools), and skips anything already installed.

## Features

- **Interactive menu** — Pick tools with the arrow keys, with search, category switching, and select all
- **Cross-platform** — Uses the correct install command on Windows, macOS, and Linux
- **No duplicate installs** — Detects versions first and skips installed tools by default
- **Reused scan results** — Scans once per run, so re-entering the menu does not ask again; press `V` to rescan at any time
- **Automatic update list** — Save a list of your usual tools and update them all with one command, from Task Scheduler or cron if you like
- **Diagnostics** — `doctor` lists the install status and version of every tool
- **Custom tools** — Add, adjust, or hide tools with YAML in your user directory; package upgrades will not overwrite it

## Installation

Run without installing:

```bash
npx dev-bootstrap menu
```

Or install globally:

```bash
npm install -g dev-bootstrap
```

With Bun:

```bash
bun add -g dev-bootstrap
```

Requires Node.js 20 or later.

## Quick start

```bash
npx dev-bootstrap menu
```

The menu has 8 options:

| Option | Description |
|---|---|
| Install tools | Select and install tools |
| Configure automatic update list | Choose and save the automatic update list |
| Update saved tools now | Update the saved list immediately |
| Schedule automatic updates | Interactively create, view, or remove the update schedule |
| Doctor | Check the install status and version of every tool |
| List tools | List all available tools |
| List tools with versions | List tools with their installed versions |
| Exit | Quit |

## Let an AI agent install for you

If you use an AI coding tool such as Claude Code, Codex, or Gemini CLI, you can hand this job to it. `install` and `update` are non-interactive commands, so an agent can run them safely.

Give your AI assistant this prompt:

```text
Use npx dev-bootstrap to set up my development environment:
1. Run npx dev-bootstrap doctor to see the current state
2. List the tools that are not installed yet and ask me to confirm
3. After I confirm, install them with npx dev-bootstrap install <tool-id...>
```

Or say exactly what you want:

```text
Use npx dev-bootstrap install to install git gh node bun ripgrep fzf bat eza jq
```

Have the agent run `doctor` first so it knows what is already there. Install commands call `winget` on Windows and `sudo apt-get` on Linux, so you may need to approve them or enter a password.

## Commands

```bash
dev-bootstrap menu                                  # Interactive menu
dev-bootstrap list                                  # List all tools
dev-bootstrap list --versions                       # List tools and check installed versions
dev-bootstrap doctor                                # Diagnose the status of all tools
dev-bootstrap install git gh node                   # Install specific tools
dev-bootstrap install git gh node --force            # Force reinstall, including installed tools
dev-bootstrap update                                # Update the saved list
dev-bootstrap update claude codex opencode          # Update specific tools
dev-bootstrap update --all                          # Update all tools
dev-bootstrap schedule create --daily --time 09:00  # Register scheduled automatic updates
dev-bootstrap schedule status                       # Show the current schedule
dev-bootstrap schedule remove                       # Remove the schedule
dev-bootstrap --version                              # Show the version (or -v)
dev-bootstrap --help                                 # Show usage (or -h)
```

When Bun and tools installed through Bun are selected together, Bun is installed first. If Bun is unavailable, an interactive install asks whether to install Bun first, use npm, or skip; choosing npm or skip can be applied to the remaining Bun packages in that run. After installing Bun, the current process's PATH is refreshed and the install continues once Bun is found; if it still cannot be found, you are asked again. In non-interactive mode, tools that need Bun are skipped when it is missing.

On macOS and Linux, commands installed with `bun add -g` go into Bun's global directory (`~/.bun/bin` by default). Bun's official install script adds this directory to PATH, but the Homebrew build does not. So after Bun or a Bun package installs successfully, dev-bootstrap appends `export PATH="$HOME/.bun/bin:$PATH"` to your shell config (`~/.zshrc` for zsh; `~/.bash_profile` on macOS or `~/.bashrc` on Linux for bash; it is not added twice). For other shells, it prints the line to add manually.

### Command not found after installing

If you see `command not found` (for example `tauri` or `opencode`), or the install ends with `verify did not detect it`:

1. Open a new terminal, or run `source ~/.zshrc` (use the matching config file for bash).
2. If the command is still missing, run `bun pm bin -g` to see the global directory, and make sure that directory is on your PATH:

   ```sh
   echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```

3. If Bun was installed with Homebrew, upgrade it with `brew upgrade bun` (or dev-bootstrap's update feature), not `bun upgrade`.

On macOS and Linux, Rust is always installed with the official rustup script. Homebrew's `rustup` is not used because it is keg-only and has no toolchain, so `rustc` cannot be found after installing. Updates use `rustup update`. If you previously installed rustup with Homebrew, run `brew uninstall rustup` before installing again.

## Menu controls

```text
Arrow keys     Move
PageUp/Down    Page through the list
Home/End       Jump to the first / last item
Space          Select / deselect
A / Ctrl+A     Select / clear all visible tools
C              Select / clear the current category
Tab            Switch category
/              Search
V              Check / refresh installed versions
F              Toggle force install mode
Enter          Install the selected tools
Backspace      Back to the main menu
Q              Quit
```

## Built-in tools

41 tools in 8 categories.

**AI** — Claude Code, OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI, OpenCode CLI, OpenSpec, Herdr

**AI Tools** — agent-browser, Playwright CLI

**Runtime** — Node.js LTS, Bun, pnpm, Yarn, TypeScript, tsx, uv (Python), Rust, Go, Java (Temurin 21)

**Git** — Git, Git LFS, GitHub CLI

**Shell** — Oh My Posh (Windows / Linux) or Oh My Zsh (macOS), zoxide, fzf, ripgrep, fd, bat, eza

**Network** — ngrok, cloudflared, OpenSSH Client, OpenSSL

**Utilities** — jq, yq, delta, wget, curl, zip, unzip

**Frontend** — Tauri CLI

Run `dev-bootstrap list` for the full list and tool ids.

### What AI Tools installs

The `AI` category holds coding agents and workspaces you operate directly. The `AI Tools` category holds tools for agents to use. These usually need setup beyond the CLI itself, so installing them runs one extra step:

| Tool | CLI install | Post-install step | Update |
|---|---|---|---|
| `agent-browser` | `brew` on macOS, `npm` elsewhere | `agent-browser install`: downloads Chrome for Testing | `agent-browser upgrade` |
| `playwright-cli` | `npm` | `playwright-cli install --skills -g`: installs the skill to `~/.claude/skills` | Updates the CLI and reinstalls the skill |

- The `agent-browser` npm package declares Node.js 24 or later, a higher requirement than dev-bootstrap's own. macOS installs through `brew` instead.
- On Linux, if system libraries the browser needs are missing, run `agent-browser install --with-deps` yourself (it uses `sudo`).
- `agent-browser` skills ship with the CLI and can be read with `agent-browser skills get core`, so they are not installed separately. To install them into an agent's skills directory, run `npx skills add vercel-labs/agent-browser`.

## Custom tools

You do not need to clone the project. Create a `tools/` folder in the config directory and add any `.yaml` file:

```
~/.dev-bootstrap/tools/my-tools.yaml
```

Custom definitions are **layered** on top of the built-in ones, so package upgrades will not overwrite your settings, and you still receive updates to the built-in tools.

**Add a tool** — Use an id that is not built in:

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

**Adjust a built-in tool** — Use the same id and write only the fields to change; the rest come from the built-in definition:

```yaml
- id: ripgrep
  description: Our team's search tool
```

**Hide a tool you do not need** — Mark it with `remove`:

```yaml
- id: zip
  remove: true
```

Run `dev-bootstrap doctor` to see which sources were loaded and how many custom entries there are. A file with invalid YAML is skipped and the error location is reported; other tools are not affected.

### Fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier, used in commands |
| `name` | Yes | Display name |
| `category` | Yes | Category; you can define new ones |
| `platforms` | No | Platforms to show and install on: `windows` / `mac` / `linux` |
| `description` | No | Description shown in the menu |
| `homepage` | No | Official website |
| `install` | No | Install methods per platform: `winget` / `brew` / `apt` / `npm` / `bun` / `script` / `powershell` |
| `postInstall` | No | Command to run after the main install succeeds, such as downloading a browser or installing skills; not run on update |
| `update` | No | `command` for a custom update command, `disabled` to turn updates off, `note` for a description |
| `verify` | No | List of verify commands: `command` and optional `regex` (the first capture group is the version); `requireSuccess: true` means the command merely existing does not count as installed |
| `remove` | No | Set to `true` to hide the built-in tool with the same id |

## Automatic updates

From the menu, choose **Configure automatic update list**, check the tools to keep up to date, and press Enter to save. Then run:

```bash
dev-bootstrap update
```

This command is non-interactive, so it suits scheduled runs.

### Scheduled runs

The easiest way is **Schedule automatic updates** in the menu: pick a common time with the arrow keys (daily at 09:00, Mondays at 09:00, Fridays at 18:00, daily at 12:30), or choose **Custom...** to set the frequency, weekday, and time, with no commands to remember.

You can also use commands. `schedule` registers the update command above with the system scheduler, so you do not have to open a scheduler yourself:

```bash
dev-bootstrap schedule create                          # Mondays at 09:00
dev-bootstrap schedule create --daily                  # Daily at 09:00
dev-bootstrap schedule create --daily --time 14:30     # Daily at 14:30
dev-bootstrap schedule create --weekday fri --time 18:00   # Fridays at 18:00
dev-bootstrap schedule status                          # Show the current schedule
dev-bootstrap schedule remove                          # Remove the schedule
```

Mechanism per platform: Task Scheduler (`schtasks`) on Windows, launchd (`~/Library/LaunchAgents`) on macOS, and cron (`crontab`) on Linux.

Before writing to the system scheduler, the full command is printed and you are asked to confirm. In non-interactive environments (scripts, CI), add `--yes`.

You need to set up the automatic update list first; otherwise `schedule create` tells you to do so.

### Update strategy

Checked in this order:

1. If a tool is marked `update.disabled` (for example, Windows' built-in OpenSSH is managed by Windows Update), it is skipped
2. If a tool has its own update command (for example `claude update` or `opencode upgrade`), that command is used
3. Otherwise, by platform: `winget upgrade` on Windows, `brew upgrade` on macOS, or `npm install -g <pkg>@latest` / `bun add -g <pkg>@latest`

Before updating, dev-bootstrap confirms that the tool is actually installed; tools that are not installed are skipped.

On Windows, finding a command **does not mean** its package is managed by `winget`. So `winget list --id ...` is probed first; if the command exists but is not managed by winget, it is marked SKIP instead of being reported as a failed update.

### Config location

Resolution order:

1. The `DEV_BOOTSTRAP_HOME` environment variable, if set
2. `./.dev-bootstrap/` in the current directory, if it exists (can serve as a project-level override)
3. `~/.dev-bootstrap/` (default)

This directory holds:

- `update-profile.json` — The automatic update list
- `tools/*.yaml` — Custom tool definitions (see "Custom tools")

## Development from source

```bash
git clone https://github.com/chingleel17/dev-bootstrap.git
cd dev-bootstrap
bun install
bun run menu
```

Other commands:

```bash
bun run build        # Build to dist/
bun run typecheck    # Type check
```

Tool definitions live in `tools/*.yaml`. Adding a tool only takes one YAML entry, with no code changes. Format:

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

## License

[MIT](https://github.com/chingleel17/dev-bootstrap/blob/main/LICENSE)
