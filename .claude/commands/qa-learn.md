---
disable-model-invocation: true
description: Add a lesson from this session to the right qa-toolkit skill, bump the version and reinstall
argument-hint: "[the lesson, or empty to take it from this session]"
---

Add what was learned in this session to the qa-toolkit plugin. Lesson: **$ARGUMENTS**
(if empty: identify the lessons from this session yourself, list them in one short line
each, and **carry on with all of them** — don't stop to ask which ones. The user strikes
any they don't want at the diff review in step 6. A run that stopped at "which ones?"
once lost ten lessons when the session ended there.)

0. **Find the source clone.** If the plugin setting `toolkit_clone` is set
   (`${user_config.toolkit_clone}` — ignore it if empty or still an unfilled
   `user_config` placeholder), use that folder. Otherwise run
   `claude plugin marketplace list` and look at `framna-qa`:
   - `Source: Directory (<path>)` → that path is the clone. Check that
     `<path>/.claude-plugin/plugin.json` has `"name": "qa-toolkit"` and that it is a git
     repo.
   - `Source: GitHub (…)` → this user has no editable clone registered. Ask where their
     clone is, or offer to clone `git@github.com:floris-andrea/QA-Toolkit.git` to a
     folder they choose. Never edit `~/.claude/plugins/marketplaces/` or
     `~/.claude/plugins/cache/` — both are overwritten on the next update.

   Call the result `<repo>` below. Run `git -C <repo> status` first: if there are
   uncommitted changes you didn't make, stop and ask. Make sure
   `git -C <repo> config core.hooksPath` is `.githooks`; set it if it is empty.

1. **Pick the skill.** Read the `description` of every `skills/*/SKILL.md` and put the
   lesson in the one whose work it belongs to. Only create a new skill if the lesson is
   about a kind of work no skill covers — and then say so and ask first.
2. **Keep it general.** Project-specific facts (hostnames, flag names, container IDs,
   account details) do not belong in a skill; they go in that project's own `CLAUDE.md`.
   Write the rule so it helps on the next project, and use the specific case only as the
   example.
3. **Write it as a trap:** what went wrong, how it looked, and what to do instead. One
   short paragraph or a bullet. Put it next to the related rule, not at the end of the
   file. Don't duplicate a rule that is already there — sharpen it. **Grep the other
   skills and commands for the same rule** (`grep -rn "<key phrase>" <repo>/skills
   <repo>/commands`); if it appears elsewhere, update every copy so they don't disagree.
4. **English**, matching the tone of the file.
5. **Bump the version** in `.claude-plugin/plugin.json` (patch for a lesson, minor for a
   new skill) — without a version bump the installed copy does not update. The
   pre-commit hook refuses the commit if you forget.
6. **Validate and commit on a branch:**

   ```bash
   claude plugin validate <repo> --strict
   ```

   ```bash
   <repo>/ci/check.sh origin/main
   ```

   Both must pass — CI runs the same checks on the pull request.

   ```bash
   git -C <repo> switch -c lesson/<short-slug>
   ```

   Commit with the lesson as the message. Show the user the diff, then **ask before
   pushing** — everyone who updates gets this lesson, so it gets a second look first.
   With a yes: push the branch and open a pull request against `main`
   (`gh pr create`). If `gh` isn't available, give the user the compare URL instead.
   Don't push to `main` directly unless the user explicitly asks for that.
7. **Update the installed copy**, only if the marketplace source is the directory from
   step 0 (with a GitHub source, the lesson arrives after the PR is merged):

   ```bash
   claude plugin marketplace update framna-qa && claude plugin update qa-toolkit@framna-qa
   ```

   Tell the user this installs the branch as it is now, before review. Then tell them
   to type `/reload-plugins` in the Claude input box (it is not a shell command), or
   start a new session.

Show the user the diff of the skill change in the reply.
