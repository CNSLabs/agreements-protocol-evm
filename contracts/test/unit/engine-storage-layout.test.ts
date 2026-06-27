/**
 * R3 — storage-layout stability guardrail (the regression net).
 *
 * AgreementEngine is deployed as EIP-1167 clones (AgreementFactory) that
 * version-lock to one implementation at instantiation and are NOT upgradeable.
 * The implementation therefore owns the clone storage layout, and that layout
 * must evolve APPEND-ONLY across versions — any reorder, type change, or
 * shifting insertion silently corrupts a clone that ever runs newer impl logic.
 *
 * This test extracts the engine's solc `storageLayout` — INCLUDING the full
 * nested type graph (struct members, mapping key/value, array base), normalized
 * to remove solc's build-local type ids — and asserts it against a committed
 * snapshot (engine-storage-layout.snapshot.json). It fails on any non-append-only
 * change (top-level OR inside a struct/mapping/array reachable from a top-level
 * variable) while allowing strictly-appended new top-level state. It is the
 * regression net that protects future spikes (R4 actions, R5, R8 owner-less)
 * from silently shipping a clone-incompatible layout.
 *
 * Regenerate the snapshot deliberately (only for an intended append-only change):
 *   UPDATE_LAYOUT_SNAPSHOT=1 npx hardhat test test/unit/engine-storage-layout.test.ts
 * The update is GATED: it refuses to write a non-append-only mutation, and refuses
 * to run under CI unless ALLOW_LAYOUT_SNAPSHOT_UPDATE_IN_CI=1 is also set.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  extractLayout,
  diffLayout,
  formatDiff,
  maybeUpdateSnapshot,
  type LayoutSnapshot,
  type LayoutEntry,
  type ResolvedType,
} from "../helpers/storage-layout";

const SOURCE = "src/AgreementEngine.sol";
const CONTRACT = "AgreementEngine";
const SNAPSHOT_PATH = path.resolve(__dirname, "engine-storage-layout.snapshot.json");

describe("AgreementEngine — storage-layout stability (R3 guardrail)", () => {
  let current: LayoutSnapshot;

  before(async () => {
    current = await extractLayout(SOURCE, CONTRACT);
    // Deliberate, GATED regeneration for an intended append-only change.
    if (process.env.UPDATE_LAYOUT_SNAPSHOT) {
      maybeUpdateSnapshot(SNAPSHOT_PATH, current);
    }
  });

  it("a committed snapshot exists", () => {
    expect(fs.existsSync(SNAPSHOT_PATH), `missing snapshot ${SNAPSHOT_PATH}`).to.equal(true);
  });

  it("the current layout is append-only relative to the committed snapshot", () => {
    const snapshot: LayoutSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
    const diff = diffLayout(snapshot, current);

    const broken = diff.changed.length > 0 || diff.nonAppended.length > 0;
    expect(
      broken,
      broken
        ? `\nNon-append-only storage-layout change detected — this breaks clones:\n${formatDiff(
            diff
          )}\n\nIf this change is intentional and genuinely append-only, append the new ` +
            `state above the current max slot and regenerate the snapshot with ` +
            `UPDATE_LAYOUT_SNAPSHOT=1.`
        : ""
    ).to.equal(false);
  });

  it("the snapshot matches the current layout exactly (no uncommitted append)", () => {
    // Catches the inverse case: new state was appended but the snapshot was not
    // regenerated. Appends are allowed, but they must be recorded so the snapshot
    // stays the live baseline for the NEXT change.
    const snapshot: LayoutSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
    expect(current).to.deep.equal(snapshot);
  });

  it("the snapshot carries the nested type graph for every top-level entry", () => {
    // A flat snapshot (no resolved `type`) would silently miss intra-struct
    // reorders — pin that the richer format is actually present.
    const snapshot: LayoutSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
    for (const e of snapshot.storage) {
      expect(e.type, `${e.label} missing resolved type`).to.not.be.undefined;
      expect(e.type.encoding, `${e.label} type missing encoding`).to.be.a("string");
    }
    // And specifically: the `vars` mapping value resolves to the StoredVar struct
    // with its (fType, data) members — proof the graph is followed into structs.
    const vars = snapshot.storage.find((e) => e.label === "vars")!;
    expect(vars.type.encoding).to.equal("mapping");
    const stored = vars.type.value!;
    expect(stored.encoding).to.equal("inplace");
    expect(stored.members!.map((m) => m.label)).to.deep.equal(["fType", "data"]);
  });
});

/**
 * Self-test of the detection logic against the committed snapshot. These pin
 * exactly what the guardrail treats as a break vs. an allowed append, using
 * synthetic layouts derived from the real snapshot — so the guardrail's contract
 * is itself regression-tested, not just trusted. Each case demonstrates an
 * evasion the diff must catch.
 */
describe("AgreementEngine — storage-layout guardrail detects the break modes", () => {
  let snapshot: LayoutSnapshot;

  // Deep-clone so per-test mutations don't bleed across cases.
  const clone = (s: LayoutSnapshot): LayoutSnapshot => JSON.parse(JSON.stringify(s));
  const find = (s: LayoutSnapshot, label: string): LayoutEntry =>
    s.storage.find((e) => e.label === label)!;

  before(() => {
    snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
  });

  // ---- top-level evasions ----

  it("flags an in-place reorder/replace (R8 owner -> initialized at slot 7)", () => {
    const replaced = clone(snapshot);
    const owner = find(replaced, "owner");
    owner.label = "initialized";
    owner.type = { encoding: "inplace", label: "bool", numberOfBytes: "1" };
    const diff = diffLayout(snapshot, replaced);
    expect(diff.changed.map((c) => c.label)).to.include("owner");
    expect(diff.nonAppended.map((n) => n.label)).to.include("initialized");
  });

  it("ALLOWS R8 done correctly (owner kept, `initialized` appended above max slot)", () => {
    const appended = clone(snapshot);
    const maxSlot = appended.storage.reduce((m, e) => (BigInt(e.slot) > m ? BigInt(e.slot) : m), 0n);
    appended.storage.push({
      label: "initialized",
      slot: (maxSlot + 1n).toString(),
      offset: 0,
      type: { encoding: "inplace", label: "bool", numberOfBytes: "1" },
    });
    const diff = diffLayout(snapshot, appended);
    expect(diff.changed).to.have.length(0);
    expect(diff.nonAppended).to.have.length(0);
    expect(diff.appended.map((a) => a.label)).to.deep.equal(["initialized"]);
  });

  it("flags an insertion that shifts existing slots", () => {
    const inserted = clone(snapshot);
    inserted.storage = [
      ...inserted.storage.slice(0, 8),
      {
        label: "newThing",
        slot: "8",
        offset: 0,
        type: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      },
      ...inserted.storage.slice(8).map((e) => ({ ...e, slot: (BigInt(e.slot) + 1n).toString() })),
    ];
    const diff = diffLayout(snapshot, inserted);
    expect(diff.changed.length).to.be.greaterThan(0);
    expect(diff.nonAppended.map((n) => n.label)).to.include("newThing");
  });

  it("flags an existing variable's type changing in place", () => {
    const retyped = clone(snapshot);
    find(retyped, "currentState").type = {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    };
    const diff = diffLayout(snapshot, retyped);
    expect(diff.changed.map((c) => c.label)).to.deep.equal(["currentState"]);
  });

  it("flags a pure removal of an existing variable", () => {
    const removed = clone(snapshot);
    removed.storage = removed.storage.filter((e) => e.label !== "docHash");
    const diff = diffLayout(snapshot, removed);
    expect(diff.changed.map((c) => c.label)).to.include("docHash");
    expect(diff.changed.find((c) => c.label === "docHash")!.current).to.equal(null);
  });

  it("treats an identical layout as a clean no-op", () => {
    const diff = diffLayout(snapshot, snapshot);
    expect(diff.changed).to.have.length(0);
    expect(diff.nonAppended).to.have.length(0);
    expect(diff.appended).to.have.length(0);
  });

  // ---- nested (intra-struct / mapping / array) evasions: the BLOCKER class ----
  // These keep the SAME top-level entry, so a flat top-level-only diff passes them.

  it("flags a StoredVar member reorder (vars mapping value struct)", () => {
    const m = clone(snapshot);
    const stored = find(m, "vars").type.value!; // StoredVar struct
    const members = stored.members!;
    // swap (fType, data) -> (data, fType): member slots/offsets move
    const fType = members.find((x) => x.label === "fType")!;
    const data = members.find((x) => x.label === "data")!;
    const tmpSlot = fType.slot,
      tmpOff = fType.offset;
    fType.slot = data.slot;
    fType.offset = data.offset;
    data.slot = tmpSlot;
    data.offset = tmpOff;
    const diff = diffLayout(snapshot, m);
    expect(diff.changed.map((c) => c.label)).to.include("vars");
  });

  it("flags an InputFieldDef packed-offset swap (required/persist within slot)", () => {
    const m = clone(snapshot);
    // inputDefs: mapping(bytes32 => InputDef); InputDef.fields is InputFieldDef[]
    const inputDef = find(m, "inputDefs").type.value!;
    const fieldsArr = inputDef.members!.find((x) => x.label === "fields")!.type;
    const fieldDef = fieldsArr.base!; // InputFieldDef struct
    const required = fieldDef.members!.find((x) => x.label === "required")!;
    const persist = fieldDef.members!.find((x) => x.label === "persist")!;
    const tmp = required.offset;
    required.offset = persist.offset;
    persist.offset = tmp;
    const diff = diffLayout(snapshot, m);
    expect(diff.changed.map((c) => c.label)).to.include("inputDefs");
  });

  it("flags a Condition nested dynamic-array value change (canonicalConditions)", () => {
    const m = clone(snapshot);
    // canonicalConditions: mapping(bytes32 => Condition[]); change the array base
    // struct's numberOfBytes (simulating a member layout change inside Condition).
    const condArray = find(m, "canonicalConditions").type.value!;
    const condStruct = condArray.base!;
    condStruct.numberOfBytes = "999";
    const diff = diffLayout(snapshot, m);
    expect(diff.changed.map((c) => c.label)).to.include("canonicalConditions");
  });

  it("flags a packed same-slot append onto an existing slot (uses a free byte, not a new slot)", () => {
    // Model a new entry that lands on an existing (the current max) slot at a higher
    // offset, simulating a packed same-slot append. The strict-higher-SLOT rule must
    // reject it — appended state must sit at a slot strictly above the snapshot max.
    const m = clone(snapshot);
    const maxSlot = m.storage.reduce((mx, e) => (BigInt(e.slot) > mx ? BigInt(e.slot) : mx), 0n);
    m.storage.push({
      label: "packedExtra",
      slot: maxSlot.toString(), // same slot as the current max — NOT strictly higher
      offset: 1,
      type: { encoding: "inplace", label: "bool", numberOfBytes: "1" },
    });
    const diff = diffLayout(snapshot, m);
    expect(diff.nonAppended.map((n) => n.label)).to.include("packedExtra");
  });

  // ---- bigint-safe slots ----

  it("compares slots as bigints (namespaced/large slots do not overflow)", () => {
    // A namespaced ERC-7201 slot is a full 256-bit value; Number() would lose it.
    const huge = (2n ** 200n).toString();
    const a = clone(snapshot);
    const b = clone(snapshot);
    a.storage.push({
      label: "ns",
      slot: huge,
      offset: 0,
      type: { encoding: "inplace", label: "bytes32", numberOfBytes: "32" },
    });
    b.storage.push({
      label: "ns",
      slot: huge,
      offset: 0,
      type: { encoding: "inplace", label: "bytes32", numberOfBytes: "32" },
    });
    // identical huge slot -> no change, treated as appended (strictly above max).
    const diff = diffLayout(a, b);
    expect(diff.changed).to.have.length(0);
    // and a one-off in the huge slot is detected (not collapsed by float rounding).
    const c = clone(b);
    find(c, "ns").slot = (2n ** 200n + 1n).toString();
    const diff2 = diffLayout(a, c);
    expect(diff2.changed.map((x) => x.label)).to.include("ns");
  });
});

/**
 * Regen-gate self-test: the update path must REFUSE to bless a broken layout.
 * Writes to a temp snapshot file so we never touch the committed baseline.
 */
describe("AgreementEngine — snapshot regeneration is gated", () => {
  let baseline: LayoutSnapshot;
  let tmpPath: string;
  const clone = (s: LayoutSnapshot): LayoutSnapshot => JSON.parse(JSON.stringify(s));

  before(() => {
    baseline = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
    tmpPath = path.resolve(__dirname, ".tmp-layout-regen.snapshot.json");
  });

  afterEach(() => {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("writes when the candidate layout is append-only (clean or appended)", () => {
    fs.writeFileSync(tmpPath, JSON.stringify(baseline, null, 2) + "\n");
    const appended = clone(baseline);
    const maxSlot = appended.storage.reduce((m, e) => (BigInt(e.slot) > m ? BigInt(e.slot) : m), 0n);
    appended.storage.push({
      label: "initialized",
      slot: (maxSlot + 1n).toString(),
      offset: 0,
      type: { encoding: "inplace", label: "bool", numberOfBytes: "1" },
    });
    maybeUpdateSnapshot(tmpPath, appended, { allowInCi: true });
    const written: LayoutSnapshot = JSON.parse(fs.readFileSync(tmpPath, "utf-8"));
    expect(written.storage.map((e) => e.label)).to.include("initialized");
  });

  it("REFUSES to write a non-append-only mutation (the regen-bypass evasion)", () => {
    fs.writeFileSync(tmpPath, JSON.stringify(baseline, null, 2) + "\n");
    const broken = clone(baseline);
    // in-place reorder of the StoredVar members — a non-append-only break
    const stored = broken.storage.find((e) => e.label === "vars")!.type.value!;
    const members = stored.members!;
    const fType = members.find((x) => x.label === "fType")!;
    fType.slot = "5";
    expect(() => maybeUpdateSnapshot(tmpPath, broken, { allowInCi: true })).to.throw(
      /non-append-only/i
    );
    // the on-disk baseline must be UNCHANGED (the broken layout was not blessed)
    const after: LayoutSnapshot = JSON.parse(fs.readFileSync(tmpPath, "utf-8"));
    expect(after).to.deep.equal(baseline);
  });

  it("REFUSES to update under CI without the explicit CI override", () => {
    fs.writeFileSync(tmpPath, JSON.stringify(baseline, null, 2) + "\n");
    const appended = clone(baseline);
    const maxSlot = appended.storage.reduce((m, e) => (BigInt(e.slot) > m ? BigInt(e.slot) : m), 0n);
    appended.storage.push({
      label: "x",
      slot: (maxSlot + 1n).toString(),
      offset: 0,
      type: { encoding: "inplace", label: "bool", numberOfBytes: "1" },
    });
    expect(() => maybeUpdateSnapshot(tmpPath, appended, { ci: true, allowInCi: false })).to.throw(
      /CI/i
    );
  });
});
