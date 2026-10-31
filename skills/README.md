# Skills

| Skill | Purpose | Source | License |
|---|---|---|---|
| [code-review-and-quality](code-review-and-quality/) | Multi-axis code review: correctness, readability, architecture, security, performance | addyosmani/agent-skills | MIT |
| [code-simplification](code-simplification/) | Reduce complexity without changing behavior | addyosmani/agent-skills | MIT |
| [constraint-driven-development](constraint-driven-development/) | Turn the quality bar into `CONSTRAINTS.md` and prevent it from being lowered | addyosmani/agent-skills | MIT |

## Adding a skill

1. Create `skills/<name>/`; the directory name must match `name` in `SKILL.md`.
2. For third-party content, add `LICENSE` and `UPSTREAM.md` (template in
   [02-Inclusion Rules](../docs/02-inclusion-rules.md)).
3. Update this table and the index in the root `README.md`.
4. Install to the AI directory and sync to the runtime, following
   [03-Deployment and Sync](../docs/03-deployment-and-sync.md).