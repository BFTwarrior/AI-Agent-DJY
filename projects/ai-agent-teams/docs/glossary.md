# Glossary

| Term | Meaning |
| --- | --- |
| Captain | The one control session that commands both teams. |
| Team | One of the two groups, with one lead and a member roster. |
| Lead | A team's control session; manages tasks/members, reports to the captain. |
| Member | A worker row; becomes a ZCode session/container only when active. |
| Active worker | A member currently consuming one of the six global worker slots. |
| Attempt | One execution generation of a task; identified by `attempt_id`. |
| Handoff | A revocation/serialization record between two owners of a task. |
| Parked | A member ended a turn while still owning an open attempt; only explicit reassignment rotates it. |
| Lease | A time bound on an open attempt; expiry makes it stalled. |
| Stalled | An attempt whose lease expired or whose member is lost. |
| DAG | The task dependency graph; only completed dependencies unlock. |
| Causal edge | `findingSourceTaskIds`: a repair points at the failed gate without making it a dependency. |
| Verdict | `pass`, `needs_revision`, or `reject` from a review/requirements task. |
| Artifact digest | Path/present/sha256/size/mtime/unreadable snapshot used to bind a verdict to bytes. |
| Drift | A reviewed artifact changed between review start/close or after the verdict. |
| Scope gap | A declared scope that could not be fully enumerated; blocks clean delivery. |
| Delivery audit | The independent check that all tasks/reviews/evidence/scope are valid. |
| Repair round | A generated task that fixes findings; followed by a review/verification round. |
| Escalated | Automatic review/repair loop hit its ceiling; not the same as halted. |
| Halted | A human stopped the team; resume requires a reason. |
| Worktree | A per-task working folder/branch created from the git repo. Plain language: each task gets its own copy of the project so members do not overwrite each other. File separation only, not a security boundary. 中文：每个任务一个独立工作目录，像复制一份项目，队员各改各的。 |
| Container | The isolation boundary for one active member; only its worktree and home volume are mounted. |
| MicroVM | A stronger isolation tier (Kata/gVisor/Firecracker) for malicious-code boundaries. |
| Guide | A delivery mode that injects a message at the next model step of a running turn. |
| Queue | A delivery mode that waits for the current turn to end. |
| Stop | Cancel the current turn; context and files remain, in-flight tool progress may be lost. |
| Profile | A named team template (roster, tasks, routing, review policy). |
| Tool policy | An owner-declared allow/deny policy selected by id; not an OS sandbox. |
| License (牌照) | v0.6: hidden `licenseId` plus the visible name and its role/scope/tool authority. Cost-budget fields were removed by ADR-0027. A member may hold one active license. |
| Settled | v0.6: every task/attempt/review/merge is closed, worktree is clean or archived, and no actionable message/finding remains. Only settled members may be re-licensed. |
| Contractor | v0.6: a one-shot non-member session used for outsourced work such as post-merge review; no mailbox, roster seat, or task claim. |
| Captain patrol (队长自醒巡检) | v0.6: the daemon schedules a read-only progress report to the captain for active work. A live captain session may be woken/created when enabled; no persistent rover is kept. |
| Contractor slot | v0.6: reserved capacity for one-shot contractors. `merge` holds one merge-review/verification contractor; `patrol` holds one general-purpose contractor (legacy `main` is its alias). Slots never borrow from each other. |
| Patrol contractor (临时巡检工) | v0.6: an optional one-shot contractor created when configured and selected for patrol work; it scans once, reports, and is stopped. It uses the `patrol` slot (legacy `main` alias). The current default busy-captain behavior queues the report instead. |
| Residency | v0.6: hot (running), warm (idle compacted), cold (closed with summary), archived. Separate from work state. |
| Cold transition | v0.6: checkpoint, close the session, persist a summary and attempt token, and release memory. License/task ownership unchanged. |
| Post-merge review | v0.6: lightweight review of the merged result on an integration branch, performed by a contractor or optional independent reviewer. |

v0.6 terms originated in [design-v0.6-roster-and-licenses.md](design-v0.6-roster-and-licenses.md); current supported behavior is summarized in `config/README.md` and checked against `config/example.v06.json`. Historical descriptions above are not a separate acceptance record.
