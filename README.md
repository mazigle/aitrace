# ailog

CLI tool to collect Claude Code and Cursor logs for debugging and analysis.

## Usage

```bash
npx ailog
```

## Options

- `--claude` - Copy only Claude Code logs
- `--cursor` - Copy only Cursor logs
- `-h, --help` - Show help message

## Output

Creates an `ailog/` directory in the current working directory containing:
- `ailog/claude/` - Claude Code logs
- `ailog/cursor/` - Cursor logs

