# Keeping a project card

An Odoo card is the operational truth for a piece of work. Agents keep it current with `projects_update_task` and `activities_complete`; this page says what goes where.

| Place | Holds | Never |
| --- | --- | --- |
| Description | The durable brief: goal, current plan, outcome. A living document, replaced in place. HTML only (`description_is_html: true`). | A log, a temporary status, Markdown. |
| Chatter | History: what happened and when. Use `odoo_add_internal_note`. | The current truth. |
| Activities | One action a person owes, with a real deadline or none. Close it with `activities_complete` and a feedback text when done. | A reminder to yourself, a status, a made-up deadline. |
| Stage and state | Where the card is and how it is doing. Written together in one `projects_update_task` call. | A stage change alone: Odoo resets `state` to In progress when only `stage_id` is written. |
| Link | The card's counterpart in another system (`github_url`). Odoo labels it "GitHub URL" until the relabel in unstaticlabs/odoo PR 468 ships, "Link" after. | The deprecated `usl_feedback_pr_url`, which these tools neither read nor write. |
| Sources | The "Sources" task property: references such as `github:org/repo#12`, separated by single spaces. | Edits through `task_properties` directly. |

## Using the tools

- Read the card first with `projects_get_task_context`: it returns stage, state, `link`, `properties` with labels, and the parsed `sources`.
- `projects_update_task` takes `stage_id` or `stage` (a name within the task's project) and requires `state` with it. The read-back confirms both; a mismatch is returned as a warning.
- `sources_add` and `sources_remove` are merged server-side into the task's full property set, because Odoo replaces all properties on write. The existing value is kept exactly as written: `sources_remove` cuts exact whole-token matches, `sources_add` appends missing references after a single space, and an empty value becomes ` a b `. Properties are read then written in two calls, so a concurrent edit to `task_properties` in that window is overwritten. The task's project must define exactly one text property labelled "Sources".
- `link: ""` clears the link.
- The tool writes the card in one Odoo transaction and posts no note. Add history with `odoo_add_internal_note` as a separate action; Odoo already tracks stage changes in Chatter.
- `activities_complete` completes one or more activities in one call. Odoo archives a done activity but it stays readable by id, so an activity that is already done is reported in `already_done` and left untouched (its feedback is not overwritten). Close only what is really done. Feedback is plain text.
