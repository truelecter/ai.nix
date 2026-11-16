import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentSync, type SettingsRead, type SettingsWrite } from "./sync.ts";

type Doc = Record<string, string>;

function fakeDaemon(initial: Doc) {
  let revision = 1;
  let values: Doc = initial;
  let invalid: string | null = null;
  const writes: string[] = [];
  return {
    writes,
    /** Someone else saves in between. */
    externalWrite(next: Doc) {
      values = next;
      revision += 1;
    },
    corrupt(error: string) {
      invalid = error;
    },
    async read(): Promise<SettingsRead> {
      if (invalid) return { status: "invalid", revision: String(revision), error: invalid };
      return { status: "ready", revision: String(revision), values };
    },
    async write(rev: string, next: Doc): Promise<SettingsWrite> {
      writes.push(rev);
      if (rev !== String(revision)) return { status: "conflict", error: "stale" };
      values = next;
      revision += 1;
      return { status: "saved", revision: String(revision), values: next };
    },
    stored: () => values,
  };
}

function setup(initial: Doc) {
  const daemon = fakeDaemon(initial);
  const seen: Doc[] = [];
  const errors: unknown[] = [];
  const sync = createDocumentSync<Doc>({
    read: daemon.read,
    write: daemon.write,
    parse: (values) => values as Doc,
    empty: {},
    onChange: (doc) => seen.push(doc),
    onError: (error) => errors.push(error),
  });
  return { daemon, sync, seen, errors };
}

describe("createDocumentSync", () => {
  it("loads, shows a change at once, then saves it", async () => {
    const { daemon, sync, seen } = setup({ a: "x" });
    await sync.refresh();
    assert.deepEqual(seen.at(-1), { a: "x" });
    assert.equal(sync.status().status, "ready");

    const saved = sync.update((current) => ({ ...current, b: "y" }));
    assert.deepEqual(seen.at(-1), { a: "x", b: "y" });
    await saved;
    assert.deepEqual(daemon.stored(), { a: "x", b: "y" });
    assert.deepEqual(sync.current(), { a: "x", b: "y" });
  });

  it("re-applies the change on top of a concurrent save", async () => {
    const { daemon, sync, errors } = setup({ a: "x" });
    await sync.refresh();
    daemon.externalWrite({ a: "x", other: "z" });

    await sync.update((current) => ({ ...current, b: "y" }));
    assert.deepEqual(errors, []);
    assert.deepEqual(daemon.stored(), { a: "x", other: "z", b: "y" });
    assert.deepEqual(sync.current(), { a: "x", other: "z", b: "y" });
    assert.deepEqual(daemon.writes, ["1", "2"]);
  });

  it("saves queued changes in order", async () => {
    const { daemon, sync } = setup({});
    await sync.refresh();
    const first = sync.update((current) => ({ ...current, a: "1" }));
    const second = sync.update((current) => ({ ...current, a: "2", b: "2" }));
    await Promise.all([first, second]);
    assert.deepEqual(daemon.stored(), { a: "2", b: "2" });
  });

  it("reverts to the stored values and rejects when saving fails", async () => {
    const errors: unknown[] = [];
    const failing = createDocumentSync<Doc>({
      read: async () => ({ status: "ready", revision: "1", values: { a: "x" } }),
      write: async () => ({ status: "invalid", error: "nope" }),
      parse: (values) => values as Doc,
      empty: {},
      onChange: () => {},
      onError: (error) => errors.push(error),
    });
    await failing.refresh();
    await assert.rejects(failing.update(() => ({ a: "broken" })), /nope/);
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.deepEqual(failing.current(), { a: "x" });
  });

  it("does not let a refresh drop a change that is still saving", async () => {
    const { sync, seen } = setup({});
    await sync.refresh();
    const saving = sync.update(() => ({ a: "1" }));
    await sync.refresh();
    assert.deepEqual(seen.at(-1), { a: "1" });
    await saving;
    assert.deepEqual(sync.current(), { a: "1" });
  });

  it("never overwrites an invalid stored document", async () => {
    const { daemon, sync } = setup({ a: "x" });
    daemon.corrupt("bad schema");
    await sync.refresh();
    assert.deepEqual(sync.status(), { status: "invalid", error: "bad schema" });
    await assert.rejects(sync.update(() => ({ b: "y" })), /bad schema/);
    assert.deepEqual(daemon.writes, []);
    assert.deepEqual(daemon.stored(), { a: "x" });
  });

  it("never lets a read that started before a save replace it", async () => {
    const daemon = fakeDaemon({ a: "x" });
    let releaseRead: () => void = () => {};
    let markParked: () => void = () => {};
    const parked = new Promise<void>((resolve) => (markParked = resolve));
    let deferred = false;
    const sync = createDocumentSync<Doc>({
      read: async () => {
        const snapshot = await daemon.read();
        if (deferred) {
          const release = new Promise<void>((resolve) => (releaseRead = resolve));
          markParked();
          await release;
        }
        return snapshot;
      },
      write: daemon.write,
      parse: (values) => values as Doc,
      empty: {},
      onChange: () => {},
      onError: () => {},
    });
    await sync.refresh();
    deferred = true;
    const reading = sync.refresh();
    const saving = sync.update((current) => ({ ...current, b: "y" }));
    // The read is parked; the save must wait behind it.
    await parked;
    assert.deepEqual(daemon.writes, []);
    deferred = false;
    releaseRead();
    await Promise.all([reading, saving]);
    assert.deepEqual(daemon.writes, ["1"]);
    assert.deepEqual(daemon.stored(), { a: "x", b: "y" });
    assert.deepEqual(sync.current(), { a: "x", b: "y" });
    await sync.refresh();
    assert.deepEqual(sync.current(), { a: "x", b: "y" });
  });
});
