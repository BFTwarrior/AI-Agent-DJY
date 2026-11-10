---
description: Break a goal into tasks and run it with an AI agent team (captain + two teams)
argument-hint: <goal>
---

# /agent-teams

Use the `ai-agent-teams` plugin.

The user's goal is: $ARGUMENTS

Start with `mcp__agent-teams__agent_teams_status`. If a team exists, continue it; otherwise create a staged team with a captain, one or two teams, and a task DAG. Call `agent_teams_route` first when the request's size is unclear. For a qualifying task (2+ independent subtasks, 2+ review perspectives, or >10 minutes single-threaded), approve and start without asking the user; only pause for ambiguous scope or a permission problem. In v0.6 start with zero workers and use role-based tasks; legacy configs keep 1 captain / 2 teams / 16 default / 32 max / 6 active.
