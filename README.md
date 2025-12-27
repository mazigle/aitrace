# ailog

CLI tool to collect and export Claude Code and Cursor conversation logs as markdown files.

## Installation

```bash
npm install -g ailog
# or use directly with npx
npx ailog
```

## Quick Start

```bash
# In a project directory with Claude/Cursor history
npx ailog

# List all projects with AI conversation history
npx ailog list

# Dump logs for a specific project
npx ailog dump 1
```

## Commands

### `list` - List Projects

Shows all projects that have Claude Code or Cursor conversation history.

```bash
npx ailog list              # Show top 10 projects
npx ailog list --all        # Show all projects
npx ailog list --count      # Show session counts
npx ailog list -c           # Short form
```

Output example:
```
Projects:

   1. 2025-12-28  ~/repo/myproject  [Claude] (4)
   2. 2025-12-27  ~/repo/myproject  [Cursor] (12)
   3. 2025-12-27  user@server:/home/user/repo/project  [Cursor] (5)

Usage: npx ailog dump <N>
```

### `dump` - Export Logs

Exports conversation logs to markdown files.

```bash
npx ailog dump 1              # Dump project #1 to its directory
npx ailog dump 1 -o ./logs    # Dump to custom output directory
```

### `clean` - Remove Logs

Removes exported log files.

```bash
npx ailog clean         # Remove your logs only
npx ailog clean --all   # Remove all ailog data
```

### Default (no command)

When run in a project directory that has AI history, dumps logs for both Claude and Cursor.

```bash
cd ~/repo/myproject
npx ailog
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --count` | Show session counts in list |
| `-o, --output <path>` | Custom output directory for dump |
| `--all` | Show all projects (list) or clean all data (clean) |
| `-v, --verbose` | Show debug output |
| `-h, --help` | Show help message |

## Remote Projects (Cursor SSH)

When using Cursor's SSH remote development feature, ailog detects remote projects automatically.

### How It Works

1. **Listing**: Remote projects show with `host:path` format
   ```
   3. 2025-12-27  myserver:/home/user/repo/project  [Cursor] (5)
   ```

2. **Dumping**: For remote Cursor projects, ailog:
   - Reads conversation data from your local Cursor database
   - Generates markdown files locally (temp directory)
   - Uploads via `scp` to the remote server
   - Cleans up local temp files

### Requirements for Remote Dump

- SSH key authentication configured (no password prompt)
- `scp` available in PATH
- Write access to the remote project directory

### Example

```bash
# List projects - shows remote projects
npx ailog list
#  1. 2025-12-27  myserver:/home/user/project  [Cursor] (8)

# Dump to remote server via scp
npx ailog dump 1
# Starting ailog...
# Project: /home/user/project
# Tool: Cursor
# Output: myserver:/home/user/project/ailog/username@hostname/ (via scp)
# Processing Cursor logs...
#    Processed 8 sessions
# Uploading to remote server...
# Done! Logs uploaded to myserver:/home/user/project/ailog/username@hostname/
```

### Local Override

To dump remote project logs locally instead:

```bash
npx ailog dump 1 -o ./local-logs
```

## Output Structure

Logs are organized by user identifier (`username@hostname`):

```
project/
└── ailog/
    └── username@hostname/
        ├── claude/
        │   ├── 2025-12-28_abc123_initial-setup.md
        │   └── 2025-12-27_def456_fix-bug.md
        └── cursor/
            ├── 2025-12-28_ghi789_implement-feature.md
            └── 2025-12-27_jkl012_refactor-code.md
```

Each markdown file contains:
- Session metadata (tool, user, timestamps)
- Full conversation history (user messages and AI responses)

## Data Sources

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` (JSONL files) |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS) |
|        | `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux) |
|        | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Windows) |

## License

MIT
