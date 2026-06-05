/**
 * Storage-layout extraction + append-only diff for the R3 guardrail.
 *
 * Agreements are EIP-1167 clones (AgreementFactory) version-locked to one
 * implementation at instantiation, so an implementation's storage layout must
 * evolve APPEND-ONLY across versions or a clone that ever runs newer impl logic
 * reads garbage. This helper pulls the solc `storageLayout` for a contract out of
 * Hardhat's build-info and diffs it against a committed snapshot.
 *
 * Crucially, it captures the FULL nested type graph reachable from each top-level
 * variable — struct `members`, mapping `key`/`value`, array `base` — normalized to
 * remove solc's build-local type ids (the `t_...` keys that churn per compile). So
 * a reorder or type/offset change INSIDE a struct (e.g. ValueLib.StoredVar,
 * AgreementTypes.Condition / AgreementEngine.InputFieldDef) is caught, even though
 * the top-level entry is unchanged. That intra-struct class is exactly what R4 touches.
 *
 * Append-only rule (conservative): every snapshot top-level entry must keep the
 * SAME slot/offset/resolved-type; any new top-level entry must sit at a slot
 * STRICTLY HIGHER than the snapshot's max slot. Consuming a reserved `__gap` (an
 * append into an existing slot range) is intentionally NOT recognized as
 * append-only by this rule — adding gaps would require extending the guardrail.
 *
 * Slots are kept as decimal STRINGS and compared with BigInt, so namespaced
 * ERC-7201 slots (full 256-bit values) never lose precision through Number().
 */

import { artifacts } from "hardhat";

/**
 * A type resolved into a build-id-free structural shape. `label` is solc's
 * human-readable type label (kept for diagnostics and identity); `encoding`,
 * `numberOfBytes`, and the recursive members/key/value/base define the layout.
 */
export interface ResolvedType {
  encoding: string; // "inplace" | "mapping" | "dynamic_array" | "bytes" ...
  label: string; // e.g. "mapping(bytes32 => struct ValueLib.StoredVar)"
  numberOfBytes: string; // string to stay bigint-safe
  members?: ResolvedMember[]; // struct members (in declaration order)
  key?: ResolvedType; // mapping key type
  value?: ResolvedType; // mapping value type
  base?: ResolvedType; // array element type
}

export interface ResolvedMember {
  label: string; // member name
  slot: string; // slot WITHIN the struct (string, bigint-safe)
  offset: number; // byte offset within the slot
  type: ResolvedType; // recursively resolved member type
}

/** One top-level storage variable with its fully-resolved type graph. */
export interface LayoutEntry {
  label: string; // variable name (e.g. "docUri")
  slot: string; // storage slot (decimal string, bigint-safe)
  offset: number; // byte offset within the slot
  type: ResolvedType; // resolved type (no build-local ids)
}

/** A committed snapshot: the contract's append-only layout baseline. */
export interface LayoutSnapshot {
  contract: string;
  storage: LayoutEntry[];
}

/**
 * Resolve a solc type id into a build-id-free ResolvedType, recursing through
 * struct members, mapping key/value, and array base. `seen` guards recursive
 * types (a struct that transitively references itself) from infinite recursion.
 */
function resolveType(
  typeId: string,
  types: Record<string, any>,
  seen: Set<string> = new Set()
): ResolvedType {
  const t = types[typeId];
  if (!t) {
    // Unknown id — keep the id as label so a diff still flags a change.
    return { encoding: "unknown", label: typeId, numberOfBytes: "0" };
  }

  const resolved: ResolvedType = {
    encoding: t.encoding,
    label: t.label,
    numberOfBytes: String(t.numberOfBytes),
  };

  // Recursion guard: if we re-enter the same type id, stop at the label (the
  // shape below is identical to the already-resolved instance up the stack).
  if (seen.has(typeId)) {
    return resolved;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(typeId);

  if (t.members) {
    resolved.members = t.members.map((m: any) => ({
      label: m.label,
      slot: String(m.slot),
      offset: Number(m.offset),
      type: resolveType(m.type, types, nextSeen),
    }));
  }
  if (t.key) resolved.key = resolveType(t.key, types, nextSeen);
  if (t.value) resolved.value = resolveType(t.value, types, nextSeen);
  if (t.base) resolved.base = resolveType(t.base, types, nextSeen);

  return resolved;
}

/**
 * Extract the normalized storage layout of a contract from its build-info,
 * including the full nested type graph for every top-level variable.
 * Requires `storageLayout` in the compiler's outputSelection (see hardhat.config.ts).
 */
export async function extractLayout(
  sourceName: string,
  contractName: string
): Promise<LayoutSnapshot> {
  const fqn = `${sourceName}:${contractName}`;
  const buildInfo = await artifacts.getBuildInfo(fqn);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqn} (run \`hardhat compile\`)`);
  }
  const out: any = (buildInfo as any).output?.contracts?.[sourceName]?.[contractName];
  const layout = out?.storageLayout;
  if (!layout) {
    throw new Error(
      `No storageLayout for ${fqn}. Enable it in hardhat.config.ts settings.outputSelection.`
    );
  }

  const storage: LayoutEntry[] = layout.storage.map((s: any) => ({
    label: s.label,
    slot: String(s.slot),
    offset: Number(s.offset),
    type: resolveType(s.type, layout.types),
  }));

  return { contract: fqn, storage };
}

/**
 * Structural equality of two resolved types — ignores nothing layout-relevant:
 * encoding, numberOfBytes, label, and recursively members (label/slot/offset/type),
 * mapping key/value, and array base. A change to any of these is a break.
 */
function typesEqual(a: ResolvedType | undefined, b: ResolvedType | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.encoding !== b.encoding) return false;
  if (a.label !== b.label) return false;
  if (a.numberOfBytes !== b.numberOfBytes) return false;

  if (!membersEqual(a.members, b.members)) return false;
  if (!typesEqual(a.key, b.key)) return false;
  if (!typesEqual(a.value, b.value)) return false;
  if (!typesEqual(a.base, b.base)) return false;

  return true;
}

function membersEqual(a?: ResolvedMember[], b?: ResolvedMember[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].label !== b[i].label) return false;
    if (a[i].slot !== b[i].slot) return false;
    if (a[i].offset !== b[i].offset) return false;
    if (!typesEqual(a[i].type, b[i].type)) return false;
  }
  return true;
}

/** True when a snapshot entry and current entry have the same on-chain layout. */
function entriesEqual(a: LayoutEntry, b: LayoutEntry): boolean {
  return a.slot === b.slot && a.offset === b.offset && typesEqual(a.type, b.type);
}

export interface LayoutDiff {
  /** Existing snapshot entries whose slot/offset/(nested) type changed — breaks. */
  changed: Array<{ label: string; snapshot: LayoutEntry; current: LayoutEntry | null }>;
  /** Current entries not in the snapshot that are NOT strictly appended — breaks. */
  nonAppended: LayoutEntry[];
  /** Current entries strictly appended above the snapshot's max slot — allowed. */
  appended: LayoutEntry[];
}

/** Max top-level slot in a snapshot, as a BigInt (-1 for an empty layout). */
function maxSlot(snapshot: LayoutSnapshot): bigint {
  return snapshot.storage.reduce((m, e) => {
    const s = BigInt(e.slot);
    return s > m ? s : m;
  }, -1n);
}

/**
 * Diff a current layout against a committed snapshot under the append-only rule.
 * Walks the full nested type graph; an empty `changed` + empty `nonAppended`
 * means the change is append-only (or a no-op).
 */
export function diffLayout(snapshot: LayoutSnapshot, current: LayoutSnapshot): LayoutDiff {
  const byLabel = new Map(current.storage.map((e) => [e.label, e]));
  const snapshotLabels = new Set(snapshot.storage.map((e) => e.label));
  const ceiling = maxSlot(snapshot);

  const changed: LayoutDiff["changed"] = [];
  for (const prev of snapshot.storage) {
    const cur = byLabel.get(prev.label) ?? null;
    if (!cur || !entriesEqual(prev, cur)) {
      changed.push({ label: prev.label, snapshot: prev, current: cur });
    }
  }

  const nonAppended: LayoutEntry[] = [];
  const appended: LayoutEntry[] = [];
  for (const cur of current.storage) {
    if (snapshotLabels.has(cur.label)) continue;
    // A new variable is only acceptable if it sits STRICTLY above the prior max
    // slot (bigint comparison — namespaced/large slots don't overflow).
    if (BigInt(cur.slot) > ceiling) {
      appended.push(cur);
    } else {
      nonAppended.push(cur);
    }
  }

  return { changed, nonAppended, appended };
}

/** Human-readable rendering of a diff for assertion failure messages. */
export function formatDiff(diff: LayoutDiff): string {
  const lines: string[] = [];
  for (const c of diff.changed) {
    const cur = c.current
      ? `slot ${c.current.slot} off ${c.current.offset} ${c.current.type.label}`
      : "(removed)";
    lines.push(
      `  CHANGED  ${c.label}: snapshot[slot ${c.snapshot.slot} off ${c.snapshot.offset} ${c.snapshot.type.label}] -> current[${cur}]`
    );
  }
  for (const n of diff.nonAppended) {
    lines.push(
      `  INSERTED ${n.label}: slot ${n.slot} off ${n.offset} ${n.type.label} (does not sit strictly above the max snapshot slot — not append-only)`
    );
  }
  return lines.join("\n");
}

export interface UpdateOptions {
  /** Whether the run is in CI (defaults to process.env.CI === "true"). */
  ci?: boolean;
  /** Explicit CI override (defaults to ALLOW_LAYOUT_SNAPSHOT_UPDATE_IN_CI === "1"). */
  allowInCi?: boolean;
}

/**
 * Gated snapshot regeneration. Refuses to bless a broken layout:
 *   1. In CI, refuses unless an explicit CI override is set (a snapshot must not
 *      be silently regenerated by an automated run).
 *   2. Diffs the CANDIDATE against the EXISTING committed snapshot and refuses to
 *      write if the candidate is non-append-only (`changed` or `nonAppended`
 *      non-empty) — a non-append-only mutation can never become the new baseline.
 * Only an append-only candidate (clean or strictly-appended) is written.
 */
export function maybeUpdateSnapshot(
  snapshotPath: string,
  candidate: LayoutSnapshot,
  opts: UpdateOptions = {}
): void {
  // Lazy require so the helper stays usable in non-Node contexts if ever imported.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");

  const ci = opts.ci ?? process.env.CI === "true";
  const allowInCi =
    opts.allowInCi ?? process.env.ALLOW_LAYOUT_SNAPSHOT_UPDATE_IN_CI === "1";
  if (ci && !allowInCi) {
    throw new Error(
      "Refusing to regenerate the storage-layout snapshot under CI. " +
        "Set ALLOW_LAYOUT_SNAPSHOT_UPDATE_IN_CI=1 to override deliberately."
    );
  }

  if (fs.existsSync(snapshotPath)) {
    const existing: LayoutSnapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const diff = diffLayout(existing, candidate);
    if (diff.changed.length > 0 || diff.nonAppended.length > 0) {
      throw new Error(
        "Refusing to write a non-append-only storage-layout snapshot " +
          "(a non-append-only mutation can never become the baseline):\n" +
          formatDiff(diff)
      );
    }
  }

  fs.writeFileSync(snapshotPath, JSON.stringify(candidate, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`[layout] snapshot regenerated at ${snapshotPath}`);
}
