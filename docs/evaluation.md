# Agent-interface evaluation

The reusable corpus is `evals/corpus.json`; exact logical fixture facts and relations are in `evals/fixtures/usl-eval-v1.json`. `evals/chatgpt-golden-prompts.json` adds connector-metadata acceptance scenarios for everyday document/project/draft-accounting workflows, feedback, long-tail actions, specialized-tool preference, missing `/doc-bearer`, read-only use, irreversible deletion and the separate deferred endpoint. Zod validation, observation schemas, and A/B/C/D/E surface generation live under `src/evals`. Run:

```bash
npm run eval:validate
npm run eval:surfaces > /tmp/odoo-mcp-surfaces.json
```

The 60 tasks are fixed at:

- 10 straightforward domain tasks;
- 10 cross-domain relational tasks;
- 10 long-tail/ad-hoc tasks;
- 10 held-out tasks not used to design specialized tools;
- 5 schema/capability discovery tasks;
- 5 multi-company tasks;
- 5 read-before-write or consequential tasks;
- 5 malformed, stale, unsupported, prompt-injection, or recovery tasks.

Every task has a stable ID, prompt, profile, thematic metadata, versioned fixture references, outcome class, bounded tool-call budget, accepted capabilities, forbidden capabilities, and factual/state assertions. Held-out tasks all name at least one generic fallback in their oracle.

The ChatGPT golden prompts follow OpenAI's [metadata optimization](https://developers.openai.com/plugins/guides/optimize-metadata) and [connector testing](https://developers.openai.com/plugins/deploy/connect-chatgpt) guidance. Run them after the connector has been rescanned or reconnected so results reflect the deployed schema rather than a cached tool list.

For the expanded fixed surface, compare strategy C on the preceding and candidate
commits using the same disposable fixture and pinned client/model. Record task
success, unnecessary introspection, repeated discovery, fallback use, tool calls,
tokens and latency. In the full-availability fixture, the new everyday actions
should use their dedicated tools; retain public-method fallback for long-tail work.
The separate `/mcp/all` prompt tests actual host schema acquisition, not merely
catalogue recommendations. Validation and token estimates are not evidence that
ChatGPT performance improved; that requires recorded client runs.

## Compared surfaces

| Strategy | Generated interface |
| --- | --- |
| A | Entire canonical catalogue loaded statically. |
| B | Only tools carrying the task's first thematic tag; intentionally demonstrates hard-domain failure modes. |
| C | Static canonical registry profile selected by the task. |
| D | Full catalogue available only through native client tool search. |
| E | Five universal primitives loaded statically plus every remaining capability deferred. |

The generator is deterministic and reports static and total catalogue schema-token estimates. It does not pretend to reproduce a proprietary client's internal retrieval algorithm; client-native retrieval outcomes are measured during the run.

## Running Codex and Claude trials

Use an isolated fixture database reset to `usl-eval-v1` for each state-changing task or run. Pin exact available Codex and Claude model IDs rather than mutable aliases. Record:

- run ID, date, client/version, model ID, model settings, surface strategy, profile, MCP/SDK/server versions, image SHA, Distribution SHA, and fixture reset ID;
- completion, oracle correctness, consequential safety, tool trace/status, argument corrections, tool discovery misses, generic fallback, total calls, static schema tokens, model tokens when exposed, and latency;
- concise assessor notes without copying sensitive Odoo content into production telemetry.

Store one JSON Lines observation per task using `EvalObservationSchema`. An evaluator should fail closed if fixture reset, model identity, or trace capture is missing. Keep held-out task text inaccessible to tool-description tuning until the candidate interface is frozen.

At least two independent runs per task/model/strategy are recommended before interpreting small differences. Investigate paired failures by task rather than relying only on aggregate scores.

## Acceptance thresholds

Architecture E is accepted only when:

- overall, cross-domain, and held-out correctness are each no worse than A by more than two percentage points;
- static tool-schema tokens for dynamic clients fall by at least 70% versus A;
- generic fallback succeeds on at least 90% of held-out tasks when the ideal semantic helper is unavailable;
- wrong-tool selections and unnecessary calls improve over A;
- no consequential task performs an unrequested action or retries an unknown-outcome mutation;
- both Codex and Claude pass protocol and core workflow qualification.

Tune descriptions, keywords, default visibility, and genuinely valuable semantic helpers from failures. Do not add a hard domain router, remove generic fallback, or design new tools around held-out prompts. A serious failure of the selected architecture must be documented explicitly rather than hidden by changing the comparison.

Real model execution requires external client/model access and a running fixture Distribution. Repository tests validate the corpus and surfaces but do not claim these empirical thresholds have been met.
