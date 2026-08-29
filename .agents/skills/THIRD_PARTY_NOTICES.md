# Third-party Agent Skills

The skill directories in this folder are vendored from their upstream repositories.
The `.claude/skills/` entries are relative symlinks to these canonical copies so Codex
and Claude Code use the same files.

| Skill | Upstream | License |
| --- | --- | --- |
| `mcp-builder` | `anthropics/skills` | See `mcp-builder/LICENSE.txt` |
| `workers-best-practices` | `cloudflare/skills` | Apache-2.0; see `LICENSES/cloudflare-skills-APACHE-2.0.txt` |
| `agents-sdk` | `cloudflare/skills` | Apache-2.0; see `LICENSES/cloudflare-skills-APACHE-2.0.txt` |
| `differential-review` | `trailofbits/skills` | CC-BY-SA-4.0; see `LICENSES/trailofbits-skills-CC-BY-SA-4.0.txt` |
| `property-based-testing` | `trailofbits/skills` | CC-BY-SA-4.0; see `LICENSES/trailofbits-skills-CC-BY-SA-4.0.txt` |
| `supply-chain-risk-auditor` | `trailofbits/skills` | CC-BY-SA-4.0; see `LICENSES/trailofbits-skills-CC-BY-SA-4.0.txt` |

`differential-review` is adapted for `odoo-mcp`; its `SKILL.md` records the upstream
source and adaptation date.
