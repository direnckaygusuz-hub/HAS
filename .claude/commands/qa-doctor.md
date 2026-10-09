---
disable-model-invocation: true
description: Check that the tools and connectors qa-toolkit's skills expect are installed, and how to fix what's missing
---

Check this machine's QA setup. Read-only: install and change nothing.

1. Run the check script and show its table as it prints:

   ```bash
   bash "${CLAUDE_PROJECT_DIR}/.claude/qa-toolkit/tools/doctor.sh"
   ```

2. Add what the script can't see — whether these are available in this session, from
   your own tool list:
   - a **Jira** connector (Atlassian) — needed to read tickets and file bugs;
   - the **Maestro** MCP — needed for Android/iOS flows;
   - a **browser** (the app's browser pane or Claude in Chrome) — for quick web looks.

3. Settings: the client projects folder is `${user_config.clients_dir}`; Jira project
   keys: `${user_config.jira_projects}`. A value that still reads as an unfilled
   `user_config` placeholder means the setting was never set (installing from the shell
   doesn't ask): report it as *not set*, with the default (`~/Documents/Claude`; Jira:
   asked each time). Say whether the folder exists. To set them:
   `/plugin configure qa-toolkit@framna-qa` in Claude Code.

4. Close with a short list: what's missing, which skills it blocks, and the fix command
   for each — commands in their own `bash` blocks. If everything is there, say so in one
   line.
