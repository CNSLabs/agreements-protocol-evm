/**
 * Randomized parity cases (the fuzz layer).
 *
 * Same dual-submit equality assertion as the structured grids, but with random
 * typed values per Op. Deterministic seed so failures reproduce. Reuses the
 * single-condition case builder shape from corpus.ts.
 */

import { ethers } from "ethers";
import { FieldType, Op, ParityCase, InputFieldDef, DataField } from "./corpus";

const coder = ethers.AbiCoder.defaultAbiCoder();
const id = (s: string) => ethers.id(s);
const encUint = (v: bigint) => coder.encode(["uint256"], [v]);
const encBytes32 = (v: string) => coder.encode(["bytes32"], [v]);

const STATE_START = id("START");
const STATE_DONE = id("DONE");
const MAX_UINT = (1n << 256n) - 1n;
const FID_AMOUNT = id("amount");
const VID_THRESHOLD = id("threshold");

// Small deterministic PRNG (mulberry32) for reproducible fuzz values.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randUint(rng: () => number): bigint {
  // Mix small/edge-ish and full-width values.
  const pick = rng();
  if (pick < 0.15) return 0n;
  if (pick < 0.3) return MAX_UINT;
  // 256-bit random assembled from 8 x 32-bit words.
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 32n) | BigInt(Math.floor(rng() * 0x100000000));
  }
  return v & MAX_UINT;
}

const CONST_OPS = [
  Op.UINT_EQ_CONST,
  Op.UINT_GT_CONST,
  Op.UINT_GTE_CONST,
  Op.UINT_LT_CONST,
  Op.UINT_LTE_CONST,
];
const VAR_OPS = [Op.UINT_EQ_VAR, Op.UINT_GT_VAR, Op.UINT_GTE_VAR, Op.UINT_LT_VAR, Op.UINT_LTE_VAR];

/** Ground-truth predicate for a uint op (CONST or VAR variant): field <op> compare. */
function uintPasses(op: number, field: bigint, compare: bigint): boolean {
  switch (op) {
    case Op.UINT_EQ_CONST:
    case Op.UINT_EQ_VAR:
      return field === compare;
    case Op.UINT_GT_CONST:
    case Op.UINT_GT_VAR:
      return field > compare;
    case Op.UINT_GTE_CONST:
    case Op.UINT_GTE_VAR:
      return field >= compare;
    case Op.UINT_LT_CONST:
    case Op.UINT_LT_VAR:
      return field < compare;
    case Op.UINT_LTE_CONST:
    case Op.UINT_LTE_VAR:
      return field <= compare;
    default:
      throw new Error(`unexpected uint op ${op}`);
  }
}

const amountField: InputFieldDef = {
  fieldId: FID_AMOUNT,
  fType: FieldType.UINT256,
  required: true,
  persist: false,
};

export function uintFuzzCases(count = 200, seed = 0xc0ffee): ParityCase[] {
  const rng = mulberry32(seed);
  const cases: ParityCase[] = [];
  const inputId = id("INPUT");

  for (let i = 0; i < count; i++) {
    const useVar = rng() < 0.5;
    const opPool = useVar ? VAR_OPS : CONST_OPS;
    const op = opPool[Math.floor(rng() * opPool.length)];
    const fieldValue = randUint(rng);
    const compareValue = randUint(rng);

    const submittedField: DataField = {
      id: FID_AMOUNT,
      fType: FieldType.UINT256,
      data: encUint(fieldValue),
    };

    cases.push({
      name: `fuzz#${i} op=${op} field=${fieldValue} cmp=${compareValue} ${useVar ? "VAR" : "CONST"}`,
      family: "UINT",
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [amountField],
          conditions: [
            {
              op,
              fieldId: FID_AMOUNT,
              bytesArg: useVar ? encBytes32(VID_THRESHOLD) : encUint(compareValue),
            },
          ],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: useVar
        ? [{ id: VID_THRESHOLD, fType: FieldType.UINT256, data: encUint(compareValue) }]
        : [],
      submission: { inputId, fields: [submittedField] },
      expectAccept: uintPasses(op, fieldValue, compareValue),
      expectedToState: STATE_DONE,
      namedException: "none",
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// STRING fuzz
// ---------------------------------------------------------------------------

const FID_NAME = id("name");
const VID_NAME_REF = id("nameRef");
const encString = (s: string) => coder.encode(["string"], [s]);
const stringField: InputFieldDef = {
  fieldId: FID_NAME,
  fType: FieldType.STRING,
  required: true,
  persist: false,
};

const STRING_LEN_OPS = [Op.STRING_MIN_LENGTH, Op.STRING_MAX_LENGTH];
const STRING_EQ_OPS = [Op.STRING_EQ_CONST, Op.STRING_EQ_VAR];
const byteLen = (s: string) => Buffer.from(s, "utf8").length;

// Random string of random byte-ish length, occasionally multibyte.
function randString(rng: () => number): string {
  const n = Math.floor(rng() * 12);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += rng() < 0.2 ? "é" : String.fromCharCode(97 + Math.floor(rng() * 26));
  }
  return s;
}

export function stringFuzzCases(count = 150, seed = 0x5712): ParityCase[] {
  const rng = mulberry32(seed);
  const cases: ParityCase[] = [];
  const inputId = id("INPUT");

  for (let i = 0; i < count; i++) {
    const isLen = rng() < 0.5;
    const fieldVal = randString(rng);

    if (isLen) {
      const op = STRING_LEN_OPS[Math.floor(rng() * STRING_LEN_OPS.length)];
      const limit = BigInt(Math.floor(rng() * 14));
      const len = BigInt(byteLen(fieldVal));
      const accept = op === Op.STRING_MIN_LENGTH ? len >= limit : len <= limit;
      cases.push({
        name: `string-fuzz#${i} len op=${op} len=${byteLen(fieldVal)} limit=${limit}`,
        family: "STRING",
        initialState: STATE_START,
        inputDefs: [
          {
            id: inputId,
            fields: [stringField],
            conditions: [{ op, fieldId: FID_NAME, bytesArg: encUint(limit) }],
            verifierKeys: [],
          },
        ],
        transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
        initVars: [],
        submission: { inputId, fields: [{ id: FID_NAME, fType: FieldType.STRING, data: encString(fieldVal) }] },
        expectAccept: accept,
        expectedToState: STATE_DONE,
        namedException: "none",
      });
    } else {
      const op = STRING_EQ_OPS[Math.floor(rng() * STRING_EQ_OPS.length)];
      const useVar = op === Op.STRING_EQ_VAR;
      // 50% identical, 50% random other
      const cmpVal = rng() < 0.5 ? fieldVal : randString(rng);
      cases.push({
        name: `string-fuzz#${i} eq op=${op} f="${fieldVal}" c="${cmpVal}" ${useVar ? "VAR" : "CONST"}`,
        family: "STRING",
        initialState: STATE_START,
        inputDefs: [
          {
            id: inputId,
            fields: [stringField],
            conditions: [
              { op, fieldId: FID_NAME, bytesArg: useVar ? encBytes32(VID_NAME_REF) : encString(cmpVal) },
            ],
            verifierKeys: [],
          },
        ],
        transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
        initVars: useVar ? [{ id: VID_NAME_REF, fType: FieldType.STRING, data: encString(cmpVal) }] : [],
        submission: { inputId, fields: [{ id: FID_NAME, fType: FieldType.STRING, data: encString(fieldVal) }] },
        expectAccept: fieldVal === cmpVal,
        expectedToState: STATE_DONE,
        namedException: "none",
      });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// ADDRESS fuzz
// ---------------------------------------------------------------------------

const FID_WALLET = id("wallet");
const VID_WALLET_REF = id("walletRef");
const encAddr = (a: string) => coder.encode(["address"], [a]);
const addressField: InputFieldDef = {
  fieldId: FID_WALLET,
  fType: FieldType.ADDRESS,
  required: true,
  persist: false,
};
const ADDR_OPS = [Op.ADDRESS_EQ_CONST, Op.ADDRESS_EQ_VAR];

function randAddr(rng: () => number): string {
  let hex = "0x";
  for (let i = 0; i < 40; i++) hex += Math.floor(rng() * 16).toString(16);
  return ethers.getAddress(hex);
}

export function addressFuzzCases(count = 150, seed = 0xadd4): ParityCase[] {
  const rng = mulberry32(seed);
  const cases: ParityCase[] = [];
  const inputId = id("INPUT");

  for (let i = 0; i < count; i++) {
    const op = ADDR_OPS[Math.floor(rng() * ADDR_OPS.length)];
    const useVar = op === Op.ADDRESS_EQ_VAR;
    const fieldVal = randAddr(rng);
    const cmpVal = rng() < 0.5 ? fieldVal : randAddr(rng);

    cases.push({
      name: `addr-fuzz#${i} op=${op} f=${fieldVal} c=${cmpVal} ${useVar ? "VAR" : "CONST"}`,
      family: "ADDRESS",
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [addressField],
          conditions: [
            { op, fieldId: FID_WALLET, bytesArg: useVar ? encBytes32(VID_WALLET_REF) : encAddr(cmpVal) },
          ],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: useVar ? [{ id: VID_WALLET_REF, fType: FieldType.ADDRESS, data: encAddr(cmpVal) }] : [],
      submission: { inputId, fields: [{ id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(fieldVal) }] },
      expectAccept: fieldVal === cmpVal,
      expectedToState: STATE_DONE,
      namedException: "none",
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// SENDER fuzz (addresses + submitter/relayer roles injected from runtime signers)
// ---------------------------------------------------------------------------

const VID_SENDER = id("expectedSender");
const FID_MARKER = id("marker");
const markerField: InputFieldDef = {
  fieldId: FID_MARKER,
  fType: FieldType.UINT256,
  required: true,
  persist: false,
};

/**
 * SENDER fuzz: random direct/permit, random signer-vs-stored match, random allow-set.
 * `signerAddrs` must be the addresses of signer indices [1..n]; we pick a stored
 * address and a submitter/signer role from those so accept/reject is deterministic.
 */
export function senderFuzzCases(signerAddrs: string[], count = 100, seed = 0x5e4d): ParityCase[] {
  const rng = mulberry32(seed);
  const cases: ParityCase[] = [];
  const inputId = id("INPUT");
  const idxs = signerAddrs.map((_, i) => i + 1); // signer indices 1..n

  for (let i = 0; i < count; i++) {
    const eqVar = rng() < 0.5;
    const mode = rng() < 0.5 ? "permit" : "direct";
    // pick which signer authorizes and which stored address we compare against
    const signerLocal = Math.floor(rng() * idxs.length); // index into signerAddrs
    const storedLocal = Math.floor(rng() * idxs.length);
    const signerIndex = idxs[signerLocal];
    // relayer differs from signer when in permit mode
    const submitterIndex = mode === "permit" ? idxs[(signerLocal + 1) % idxs.length] : signerIndex;
    const storedAddr = signerAddrs[storedLocal];
    // The authorizing identity (AUTH_SIGNER) is always the signer, not the relayer.
    const authAddr = signerAddrs[signerLocal];

    if (eqVar) {
      cases.push({
        name: `sender-fuzz#${i} EQ_VAR mode=${mode} signer=${signerIndex} stored=${idxs[storedLocal]}`,
        family: "SENDER",
        initialState: STATE_START,
        inputDefs: [
          {
            id: inputId,
            fields: [markerField],
            conditions: [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: VID_SENDER, bytesArg: "0x" }],
            verifierKeys: [],
          },
        ],
        transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
        initVars: [{ id: VID_SENDER, fType: FieldType.ADDRESS, data: encAddr(storedAddr) }],
        submission: {
          inputId,
          fields: [{ id: FID_MARKER, fType: FieldType.UINT256, data: encUint(1n) }],
          mode,
          submitterIndex,
          signerIndex,
        },
        expectAccept: authAddr === storedAddr,
        expectedToState: STATE_DONE,
        namedException: "none",
      });
    } else {
      // SENDER_IN_ALLOWED: random allow-set split into VAR entries (backed by set
      // init vars) and CONST literals. All VAR entries are SET (no unset-VAR revert),
      // so membership is the clean union of var-backed and literal addresses.
      const k = 1 + Math.floor(rng() * (idxs.length + 1));
      const varIds: string[] = [];
      const initVars: DataField[] = [];
      const addrs: string[] = [];
      const allowed = new Set<string>();
      for (let j = 0; j < k; j++) {
        const a = signerAddrs[Math.floor(rng() * signerAddrs.length)];
        allowed.add(a);
        if (rng() < 0.5) {
          // VAR entry: unique var id holding this address.
          const vid = id(`inAllowedVar#${i}-${j}`);
          varIds.push(vid);
          initVars.push({ id: vid, fType: FieldType.ADDRESS, data: encAddr(a) });
        } else {
          addrs.push(a); // CONST literal
        }
      }
      const bytesArg = coder.encode(["bytes32[]", "address[]"], [varIds, addrs]);
      cases.push({
        name: `sender-fuzz#${i} IN_ALLOWED mode=${mode} signer=${signerIndex} vars=${varIds.length} consts=${addrs.length}`,
        family: "SENDER",
        initialState: STATE_START,
        inputDefs: [
          {
            id: inputId,
            fields: [markerField],
            conditions: [{ op: Op.SENDER_IN_ALLOWED_ADDRESSES, fieldId: id("ignored"), bytesArg }],
            verifierKeys: [],
          },
        ],
        transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
        initVars,
        submission: {
          inputId,
          fields: [{ id: FID_MARKER, fType: FieldType.UINT256, data: encUint(1n) }],
          mode,
          submitterIndex,
          signerIndex,
        },
        expectAccept: allowed.has(authAddr),
        expectedToState: STATE_DONE,
        namedException: "none",
      });
    }
  }
  return cases;
}
