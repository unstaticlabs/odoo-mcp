import { describe, expect, test } from "bun:test";
import type { PmWriteInput } from "./safety";
import { classifyPmWrite } from "./safety";

// USL Admin hygiene repro: legitimate PM notes mention banking, B2C exports, deadlines, and
// accounting-adjacent vocabulary — must classify as PM-safe, not bookkeeping mutation.
const USL_ADMIN_NOTE =
  "Valentin: confirm B2C bank export by Friday deadline — reconcile with accounting export.";

const USL_ADMIN_NOTE_SHORT = "Valentin: follow up on task.";

function pmInput(overrides: Partial<PmWriteInput> = {}): PmWriteInput {
  return { ...overrides };
}

describe("classifyPmWrite", () => {
  describe("PM-safe — finance keywords must NOT block", () => {
    test("task description update", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "write",
          values: { description: USL_ADMIN_NOTE }
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });

    test("task chatter (message_post semantics)", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "message_post",
          record_id: 990,
          body: USL_ADMIN_NOTE
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });

    test("mail activity on project.task", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "mail.activity",
          method: "create",
          values: {
            res_model: "project.task",
            res_id: 990,
            summary: USL_ADMIN_NOTE,
            note: USL_ADMIN_NOTE
          }
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });

    test("create_record task with description", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "create",
          values: { name: "USL hygiene", description: USL_ADMIN_NOTE }
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });

    test("shorter control note without finance keywords", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "message_post",
          record_id: 990,
          body: USL_ADMIN_NOTE_SHORT
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });
  });

  describe("accounting — same text must NOT be PM-safe", () => {
    test("vendor bill narration", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "account.move",
          method: "write",
          values: { narration: USL_ADMIN_NOTE }
        })
      );
      expect(result.pm_safe).toBe(false);
      expect(result.lane).not.toBe("pm");
      expect(["bookkeeping", "blocked"]).toContain(result.lane);
    });

    test("external report value create", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "account.report.external.value",
          method: "create",
          values: { name: USL_ADMIN_NOTE, value: 942 }
        })
      );
      expect(result.pm_safe).toBe(false);
      expect(result.lane).not.toBe("pm");
    });

    test("lock exception create", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "account.lock_exception",
          method: "create",
          values: { reason: USL_ADMIN_NOTE }
        })
      );
      expect(result.pm_safe).toBe(false);
      expect(result.lane).not.toBe("pm");
    });
  });

  describe("boundary — PM model, wrong intent", () => {
    test("mail.activity with res_model account.move is not PM-safe", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "mail.activity",
          method: "create",
          values: {
            res_model: "account.move",
            res_id: 42,
            summary: USL_ADMIN_NOTE,
            note: USL_ADMIN_NOTE
          }
        })
      );
      expect(result.pm_safe).toBe(false);
      expect(result.lane).not.toBe("pm");
    });

    test("project.task write on planned_hours only remains PM-safe", () => {
      // PM field heuristics: operational fields must not false-negative when description/body
      // are absent but the model+method are clearly project-management intent.
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "write",
          values: { planned_hours: 4 }
        })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });

    test("project.task write touching accounting-only field is not PM-safe", () => {
      // Hypothetical cross-lane field: account_id on a task write is bookkeeping intent,
      // not chatter/description PM hygiene — classifier must not route via PM lane.
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "write",
          values: { account_id: 7, description: USL_ADMIN_NOTE }
        })
      );
      expect(result.pm_safe).toBe(false);
      expect(result.lane).not.toBe("pm");
    });

    test("project.task description with finance keywords is not false-negative", () => {
      const result = classifyPmWrite(
        pmInput({
          model: "project.task",
          method: "write",
          values: { description: USL_ADMIN_NOTE }
        })
      );
      // Field heuristic: description/body on project.task must stay PM even when text
      // mentions bank/export/reconcile/accounting vocabulary.
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
    });
  });

  describe("bookkeeping independence", () => {
    test("classifier is validate-only intent — no token/HMAC concept", () => {
      const result = classifyPmWrite(
        pmInput({ model: "project.task", body: USL_ADMIN_NOTE })
      );
      expect(result.pm_safe).toBe(true);
      expect(result.lane).toBe("pm");
      // PM lane must not expose bookkeeping planner artifacts (tokens, would_write, status).
      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("would_write");
      expect(result).not.toHaveProperty("token");
    });
  });

  // Future read-side lane: bulk mail.message body fetch discouraged vs per-task expand_record.
  test.todo("read lane: bulk mail.message body fetch discouraged");
});
