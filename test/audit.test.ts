import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createAuditStore } from "../src/store/audit";

describe("audit store", () => {
  it("records tenant-scoped actions and prunes old metadata", () => {
    const db = openDb(":memory:");
    const audit = createAuditStore(db);
    audit.record({ tenantId: "t1", actor: "portal", action: "kill_switch", detail: "audio" });
    audit.record({ tenantId: "t2", actor: "portal", action: "provision" });
    expect(audit.latest("t1")).toHaveLength(1);
    expect(audit.latest("t1")[0]).toMatchObject({ actor: "portal", action: "kill_switch", detail: "audio" });
    audit.prune(Date.now() + 1);
    expect(audit.latest("t1")).toHaveLength(0);
  });
});
