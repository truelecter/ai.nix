import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupDoc } from "../shared/settings.ts";
import {
  effectiveAssignments,
  parseLegacyKey,
  planMigration,
  planWrites,
  projectRefKey,
  type DocChange,
  type HostProjects,
} from "./assignments.ts";

function doc(partial: Partial<GroupDoc> = {}): GroupDoc {
  return { projects: {}, remote: {}, legacy: {}, appliedLegacy: [], ...partial };
}

function apply(docs: Record<string, GroupDoc>, changes: Map<string, DocChange>) {
  const next = { ...docs };
  for (const [hostId, change] of changes) next[hostId] = change(next[hostId]);
  return next;
}

describe("parseLegacyKey", () => {
  it("reads Paseo 0.15 placement and equivalence keys", () => {
    assert.deepEqual(parseLegacyKey(JSON.stringify(["srv", "p1"])), {
      kind: "placement",
      hostId: "srv",
      projectId: "p1",
      exact: true,
    });
    assert.deepEqual(parseLegacyKey(JSON.stringify(["placement", "srv", "p1", 0])), {
      kind: "placement",
      hostId: "srv",
      projectId: "p1",
      exact: false,
    });
    assert.deepEqual(parseLegacyKey("github.com/acme/app"), {
      kind: "equivalence",
      projectKey: "github.com/acme/app",
    });
    assert.deepEqual(parseLegacyKey("[not json"), {
      kind: "equivalence",
      projectKey: "[not json",
    });
  });
});

describe("effectiveAssignments", () => {
  it("prefers the owner's entry, then remote, then a 0.15 placement key", () => {
    const docs = [
      { hostId: "a", doc: doc({ projects: { p1: "own" } }) },
      {
        hostId: "b",
        doc: doc({
          remote: { [projectRefKey("a", "p1")]: "shadowed", [projectRefKey("c", "p3")]: "remote" },
          legacy: { [projectRefKey("a", "p2")]: "legacy" },
        }),
      },
    ];
    assert.deepEqual(
      effectiveAssignments(docs, [
        { hostId: "a", projectId: "p1" },
        { hostId: "a", projectId: "p2" },
        { hostId: "c", projectId: "p3" },
        { hostId: "c", projectId: "p4" },
      ]),
      {
        [projectRefKey("a", "p1")]: "own",
        [projectRefKey("a", "p2")]: "legacy",
        [projectRefKey("c", "p3")]: "remote",
      },
    );
  });
});

describe("planWrites", () => {
  it("writes to the owning host and clears copies elsewhere", () => {
    const key = projectRefKey("a", "p1");
    const docs = {
      a: doc({ projects: { p1: "old" } }),
      b: doc({ remote: { [key]: "stale" }, legacy: { [key]: "older" } }),
    };
    const entries = Object.entries(docs).map(([hostId, value]) => ({ hostId, doc: value }));
    const next = apply(docs, planWrites(entries, [{ hostId: "a", projectId: "p1", path: "new" }]));
    assert.deepEqual(next.a.projects, { p1: "new" });
    assert.deepEqual(next.b, doc());
  });

  it("removes an assignment so the name decides again", () => {
    const docs = { a: doc({ projects: { p1: "x", p2: "y" } }) };
    const next = apply(
      docs,
      planWrites([{ hostId: "a", doc: docs.a }], [{ hostId: "a", projectId: "p1", path: undefined }]),
    );
    assert.deepEqual(next.a.projects, { p2: "y" });
  });

  it("keeps projects of hosts without the plugin in the first document's remote map", () => {
    const key = projectRefKey("z", "p9");
    const docs = { a: doc(), b: doc({ remote: { [key]: "stale" } }) };
    const entries = Object.entries(docs).map(([hostId, value]) => ({ hostId, doc: value }));
    const next = apply(docs, planWrites(entries, [{ hostId: "z", projectId: "p9", path: "g" }]));
    assert.deepEqual(next.a.remote, { [key]: "g" });
    assert.deepEqual(next.b.remote, {});
  });

  it("refuses when no host runs the plugin", () => {
    assert.throws(() => planWrites([], [{ hostId: "a", projectId: "p", path: "g" }]), /No connected/);
  });
});

describe("planMigration", () => {
  function hosts(entries: Record<string, [GroupDoc, Record<string, string | null> | null]>) {
    return Object.entries(entries).map(
      ([hostId, [value, projectKeys]]): HostProjects => ({ hostId, doc: value, projectKeys }),
    );
  }

  function migrate(list: HostProjects[]) {
    const plan = planMigration(list);
    assert.ok(plan);
    let docs = Object.fromEntries(list.map((host) => [host.hostId, host.doc]));
    docs = apply(docs, plan.writes);
    return apply(docs, plan.drops);
  }

  it("moves shared project keys and placements to their projects", () => {
    const next = migrate(
      hosts({
        a: [
          doc({
            legacy: {
              "github.com/acme/app": "work/app",
              [JSON.stringify(["a", "p2"])]: "solo",
              [JSON.stringify(["placement", "b", "q1", 0])]: "clash",
            },
          }),
          { p1: "github.com/acme/app", p2: null },
        ],
        b: [doc(), { q1: "github.com/acme/app", q2: "github.com/acme/app" }],
      }),
    );
    assert.deepEqual(
      next.a,
      doc({
        projects: { p1: "work/app", p2: "solo" },
        legacy: { "github.com/acme/app": "work/app" },
        appliedLegacy: ["github.com/acme/app"],
      }),
    );
    // Two projects share the key on b, so 0.15 never matched them; the placement key names one.
    assert.deepEqual(next.b, doc({ projects: { q1: "clash" } }));
  });

  it("applies a shared key to the matching project on every listed host", () => {
    const next = migrate(
      hosts({
        a: [doc({ legacy: { shared: "g" } }), { p1: "shared" }],
        b: [doc(), { q1: "shared" }],
      }),
    );
    assert.deepEqual(
      next.a,
      doc({ projects: { p1: "g" }, legacy: { shared: "g" }, appliedLegacy: ["shared"] }),
    );
    assert.deepEqual(next.b, doc({ projects: { q1: "g" }, appliedLegacy: ["shared"] }));
  });

  it("gives a shared key to a host that was offline, once it is listed", () => {
    const first = migrate(
      hosts({ a: [doc({ legacy: { shared: "g" } }), { p1: "shared" }], b: [doc(), null] }),
    );
    assert.deepEqual(first.b, doc());
    const later = hosts({ a: [first.a, { p1: "shared" }], b: [first.b, { q1: "shared" }] });
    const next = migrate(later);
    assert.deepEqual(next.a, first.a);
    assert.deepEqual(next.b, doc({ projects: { q1: "g" }, appliedLegacy: ["shared"] }));
  });

  it("doesn't undo removing a copied shared key, and stops once applied", () => {
    const applied = doc({ legacy: { shared: "g" }, appliedLegacy: ["shared"] });
    assert.equal(planMigration(hosts({ a: [applied, { p1: "shared" }] })), null);
  });

  it("never replaces an assignment the project already has", () => {
    const next = migrate(
      hosts({ a: [doc({ projects: { p1: "new" }, legacy: { k: "old" } }), { p1: "k" }] }),
    );
    assert.deepEqual(
      next.a,
      doc({ projects: { p1: "new" }, legacy: { k: "old" }, appliedLegacy: ["k"] }),
    );
  });

  it("keeps placements of other hosts by their ref key when that host lacks the plugin", () => {
    const next = migrate(
      hosts({ a: [doc({ legacy: { [JSON.stringify(["placement", "z", "p", 1])]: "g" } }), {}] }),
    );
    assert.deepEqual(next.a, doc({ remote: { [projectRefKey("z", "p")]: "g" } }));
  });

  it("keeps keys it can't resolve yet", () => {
    assert.equal(
      planMigration(
        hosts({
          a: [doc({ legacy: { unknown: "g", [JSON.stringify(["z", "p"])]: "h" } }), { p1: "other" }],
          b: [doc({ legacy: { [JSON.stringify(["b", "gone"])]: "x" } }), null],
        }),
      ),
      null,
    );
  });
});
