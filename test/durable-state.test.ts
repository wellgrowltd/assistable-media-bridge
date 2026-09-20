import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createCursorStore } from "../src/store/cursors";
import { createOutboxStore } from "../src/store/outbox";

describe("durable processing state", () => {
  it("persists cursors and increments generations", () => {
    const db = openDb(":memory:");
    const cursors = createCursorStore(db);
    cursors.set("t1", "2026-09-20T00:00:00Z");
    cursors.set("t1", "2026-09-20T00:01:00Z");
    expect(cursors.get("t1")?.cursor).toContain("00:01");
    expect(cursors.get("t1")?.generation).toBe(1);
  });
  it("deduplicates outbox operations and exposes unknown outcomes", () => {
    const db = openDb(":memory:");
    const outbox = createOutboxStore(db);
    const one = outbox.enqueue({ tenantId: "t1", conversationId: "c1", contactId: "p1", operationId: "wake:m1", kind: "wake", payload: { x: 1 } });
    const two = outbox.enqueue({ tenantId: "t1", conversationId: "c1", contactId: "p1", operationId: "wake:m1", kind: "wake", payload: { x: 2 } });
    expect(two.id).toBe(one.id);
    const claimed = outbox.claim(1, 10_000);
    expect(claimed).toHaveLength(1);
    outbox.finish(one.id, "unknown", "upstream timeout");
    expect(outbox.listUnknown("t1")).toHaveLength(1);
  });
});
