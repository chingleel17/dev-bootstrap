# dev-bootstrap v0.2

Bun + TypeScript development environment bootstrapper.

## Requirements

Install Bun first.

Windows:

```powershell
winget install --id Oven-sh.Bun -e
```

macOS:

```bash
brew install oven-sh/bun/bun
```

Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Setup

```bash
bun install
bun run menu
```

Important: `bun install` only installs this project's dependencies. It no longer runs the tool installer.

## Commands

```bash
bun run menu
bun run list
bun run list -- --versions
bun run doctor
bun run src/index.ts install bun opencode claude
bun run src/index.ts install bun opencode claude --force
```

## Menu controls

```text
Arrow keys    Move
Space         Select / unselect
A / Ctrl+A    Select all visible tools / clear all visible tools
C             Select all tools in current category / clear category
Tab           Switch category
/             Search
V             Check / refresh installed versions
F             Toggle force install/update
Enter         Install selected tools
Backspace     Return to main menu
Q             Quit
```

## Notes

- Menu entry now asks whether to scan installed versions first.
- Installed version is detected through each tool's `verify.command`.
- If you skip the initial scan, selected tools are still checked before install.
- Already installed tools are skipped by default.
- Press `F` or use `--force` to reinstall/update selected installed tools.
- Tools are defined in `tools/*.yaml`.

## PostgreSQL Client / MySQL Client

Those are not database servers. They are command-line clients such as `psql`, `pg_dump`, `mysql`, and `mysqldump`.

This version does not include them by default because you are mainly using Docker + DBeaver. Add them later if you need direct CLI backup/restore commands on the host.

## Desktop apps intentionally not included

These can be installed by CLI on some platforms, but they usually still need GUI login, WSL/driver setup, profile sync, or first-run configuration. Recommended manual installs:

- VS Code: https://code.visualstudio.com/
- Docker Desktop: https://www.docker.com/products/docker-desktop/
- DBeaver: https://dbeaver.io/download/
- Obsidian: https://obsidian.md/download
- Postman: https://www.postman.com/downloads/
- Chrome: https://www.google.com/chrome/
