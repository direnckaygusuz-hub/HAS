# qa-toolkit (vendored)

Copy of Floris Andréa's QA-Toolkit plugin (v0.11.0, `framna-qa` marketplace), installed as
project-level files so it also loads in Claude Code on the web, where locally installed
plugins aren't available.

- Skills: `.claude/skills/` (unchanged)
- Commands: `.claude/commands/` (`qa-doctor.md` points at `$CLAUDE_PROJECT_DIR/.claude/qa-toolkit/tools/doctor.sh`
  instead of `${CLAUDE_PLUGIN_ROOT}`)
- Hooks: `.claude/qa-toolkit/hooks/`, registered in `.claude/settings.json`
- Plugin settings (`user_config.*`) aren't available outside the plugin; the commands
  treat them as "not set" and ask instead.

To update: unpack a newer QA-Toolkit and copy the same folders again.
