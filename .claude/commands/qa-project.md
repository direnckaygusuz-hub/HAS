---
disable-model-invocation: true
description: Load (or create) the context file for a client project — environments, builds, flags, Jira, accounts — and move into its folder
argument-hint: "[client or project name]"
---

Set up this session for client QA work: **$ARGUMENTS**

The client projects live in `${user_config.clients_dir}` — if that still reads as an
unfilled `user_config` placeholder or is empty, the setting isn't set: use
`~/Documents/Claude`. One folder per project, each
with its own `CLAUDE.md`, and one shared `<client>-context.md` per client next to them,
imported from each project's `CLAUDE.md` with `@../<client>-context.md`.

1. **Find it.** List the project folders there that have a `CLAUDE.md`, and the
   `*-context.md` files. Match the argument to a client or project; if it's empty or
   ambiguous, show the list and ask. If you can't list the folder (no access, it doesn't
   exist), say so and ask for the path — never guess a project folder's name.
2. **Move into it.** If this session isn't already in that project folder and you have
   a tool to change the session's working directory, offer to switch to it. Otherwise tell
   the user to start the session in that folder next time, and read its `CLAUDE.md` and
   the context file now so this session has them.
3. **No context file yet?** Offer to create `<clients_dir>/<client>-context.md` with the
   sections below, fill in what the project's files and the user tell you, and leave
   unknowns as a one-line open question. Then offer to add `@../<client>-context.md` to
   each of that client's `CLAUDE.md` files. Ask before writing either.
4. **Summarise** in a few lines what the context says — environments, current builds,
   Jira project — so the user can correct it before testing starts.

Never put a password, token, card number or private person's contact details in a context
file. Test accounts are listed by name and role only; the sign-in happens by hand
(`authenticated-testing`).

Sections of a context file:

```markdown
# <Client> — QA context

## Environments
| Name | URL / build | Notes (flags, data, who deploys) |

## Apps and builds
App IDs per variant, where builds come from (TestFlight, CI artifact), how to tell which is installed.

## Flags and config
Feature flags or remote config that differ per environment, and how to read them.

## Analytics
Tag-manager container per environment, tracking plan link, consent manager.

## Jira
Project key(s), board, how tickets are written up (link to an example note).

## Test accounts
Name and role only — never passwords. Which environments each exists on.

## Devices
Physical devices available for this client, OS versions.

## Known issues
Things broken everywhere, including production — not regressions.

## Where the tooling lives
Regression suite, crawl baselines, scripts, saved sessions (paths in the project folders).
```
