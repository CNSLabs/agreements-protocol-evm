// SPDX-License-Identifier: Apache-2.0
//
// Differential test: random agreements and random submissions run through a
// reference build of the engine and through this build, side by side. Every
// creation and every submission must have the same outcome: the same revert
// data when refused, the same events and the same public state when accepted.
//
// DIFF_REFERENCE is a directory with the reference build's AgreementEngine.json
// and AgreementFactory.json artifacts. Without it the test is skipped.
// DIFF_SEEDS (default 150) agreements are generated, DIFF_STEPS (default 30)
// submissions each, starting at seed DIFF_FIRST_SEED (default 1).

import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { ethers } from "hardhat";

const REFERENCE = process.env.DIFF_REFERENCE;
const SEEDS = Number(process.env.DIFF_SEEDS || 150);
const STEPS = Number(process.env.DIFF_STEPS || 30);
const FIRST_SEED = Number(process.env.DIFF_FIRST_SEED || 1);

const coder = ethers.AbiCoder.defaultAbiCoder();
const id = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));
const BLOCK_TIME_FIELD = id("block.timestamp");
const DATA_FIELDS = "tuple(bytes32 id, uint8 fType, bytes data)[]";

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)];
  const chance = (p: number) => next() < p;
  const hex = (bytes: number) => "0x" + Array.from({ length: bytes }, () => int(256).toString(16).padStart(2, "0")).join("");
  return { next, int, pick, chance, hex };
}
type Rng = ReturnType<typeof rng>;

(REFERENCE ? describe : describe.skip)("differential: reference engine against this build", function () {
  this.timeout(0);

  it(`random agreements and submissions behave the same (${SEEDS} agreements, ${STEPS} submissions each)`, async () => {
    const signers = await ethers.getSigners();
    const [deployer, alice, bob, carol] = signers;
    const people = [alice, bob, carol];

    const load = (name: string) => JSON.parse(fs.readFileSync(path.join(REFERENCE!, `${name}.json`), "utf8"));
    const refEngineArtifact = load("AgreementEngine");
    const refFactoryArtifact = load("AgreementFactory");
    const refImpl = await new ethers.ContractFactory(refEngineArtifact.abi, refEngineArtifact.bytecode, deployer).deploy();
    const refFactory: any = await new ethers.ContractFactory(refFactoryArtifact.abi, refFactoryArtifact.bytecode, deployer).deploy(await refImpl.getAddress());
    const newImpl = await (await ethers.getContractFactory("AgreementEngine")).deploy();
    const newFactory: any = await (await ethers.getContractFactory("AgreementFactory")).deploy(await newImpl.getAddress());
    const engineAbi = (await ethers.getContractFactory("AgreementEngine")).interface;

    const token = await (await ethers.getContractFactory("TestERC20")).deploy("T", "T");
    const verifier = await (await ethers.getContractFactory("ExpectedSenderInputVerifier")).deploy(alice.address);
    const tokenAddress = await token.getAddress();
    const verifierAddress = await verifier.getAddress();

    const FIELD_IDS = ["f0", "f1", "f2", "f3", "f4", "f5"].map(id);
    // Enough further ids for an input with more than 31 fields, where the byte kept
    // for each field no longer fits in one slot.
    const MORE_FIELD_IDS = Array.from({ length: 40 }, (_, n) => id(`g${n}`));
    const STATES = ["S0", "S1", "S2", "S3"].map(id);
    const INPUT_IDS = ["i0", "i1", "i2", "i3"].map(id);
    const VERIFIER_KEYS = ["k0", "k1"].map(id);

    // Action targets that call back into the agreement while its transition is running:
    // another input, directly; the same, with the failure ignored; and a permit cancellation.
    const Reentrant = await ethers.getContractFactory("ReentrantActionTarget");
    const reenterInput = engineAbi.encodeFunctionData("submitInput", [INPUT_IDS[0], coder.encode([DATA_FIELDS], [[]])]);
    const reentrantTargets = await Promise.all([
      Reentrant.deploy(reenterInput, false),
      Reentrant.deploy(reenterInput, true),
      Reentrant.deploy(engineAbi.encodeFunctionData("cancelPermits"), false),
    ].map(async (deployment) => (await deployment).getAddress()));

    // ---- values -----------------------------------------------------------
    const validValue = (r: Rng, fType: number): string => {
      switch (fType) {
        case 0: return coder.encode(["uint256"], [r.chance(0.8) ? r.int(6) : r.chance(0.5) ? ethers.MaxUint256 : BigInt(r.hex(16))]);
        case 1: return coder.encode(["string"], [r.chance(0.2) ? "" : "x".repeat(r.int(40)) + r.int(3)]);
        case 2: return coder.encode(["address"], [r.chance(0.85) ? r.pick(people).address : ethers.getAddress(r.hex(20))]);
        case 3: return coder.encode(["bool"], [r.chance(0.5)]);
        default: return r.chance(0.3) ? ethers.ZeroHash : r.hex(32);
      }
    };
    const anyValue = (r: Rng, fType: number): string => {
      if (r.chance(0.9)) return validValue(r, fType);
      // Malformed: empty, a wrong length, a bool that is not 0 or 1, an address with high bits set.
      return r.pick(["0x", r.hex(31), r.hex(33), coder.encode(["uint256"], [2]), "0x" + "ff".repeat(32), r.hex(64), r.hex(96)]);
    };

    const conditionArg = (r: Rng, op: number): string => {
      if (r.chance(0.12)) return r.pick(["0x", r.hex(1), r.hex(31), r.hex(32), r.hex(33), r.hex(63), r.hex(64), r.hex(65), r.hex(96)]);
      const target = r.pick(FIELD_IDS);
      if (op <= 1) return coder.encode(["uint256"], [r.int(30)]);                       // string length
      if (op === 2) return coder.encode(["string"], ["x".repeat(r.int(40)) + r.int(3)]);  // string equals constant
      if (op === 3 || (op >= 9 && op <= 13) || op === 15) return coder.encode(["bytes32"], [target]);
      if (op >= 4 && op <= 8) return coder.encode(["uint256"], [r.chance(0.8) ? r.int(6) : r.chance(0.5) ? ethers.MaxUint256 : 0]);
      if (op === 14) return coder.encode(["address"], [r.pick(people).address]);
      if (op === 16) return r.chance(0.7) ? "0x" : coder.encode(["bytes32"], [target]);
      if (op === 17) {
        const long = r.chance(0.1);
        return coder.encode(["bytes32[]", "address[]"], [
          Array.from({ length: long ? 20 : r.int(3) }, () => r.pick(FIELD_IDS)),
          Array.from({ length: long ? 20 : r.int(3) }, () => r.pick(people).address),
        ]);
      }
      const offset = r.chance(0.8) ? BigInt(r.int(5) - 2) : r.pick([ethers.MaxInt256, ethers.MinInt256, -1n, 1n]);
      return coder.encode(["bytes32", "int256"], [target, offset]);
    };

    // ---- a random agreement -------------------------------------------------
    // A coherent agreement: conditions that fit their fields and can hold, states that
    // connect, values that decode. Most submissions against it have a chance to be accepted,
    // which is what exercises persisted values, counters, actions and verifiers.
    const U = FIELD_IDS[4], A = FIELD_IDS[5], S = FIELD_IDS[3];
    const typeOfId = (r: Rng, fieldId: string) => (fieldId === U ? 0 : fieldId === A ? 2 : fieldId === S ? 1 : r.int(5));
    const generateCoherent = (r: Rng) => {
      const authority = r.pick(people);
      const initVars = [
        { id: U, fType: 0, data: coder.encode(["uint256"], [r.int(4)]) },
        { id: A, fType: 2, data: coder.encode(["address"], [authority.address]) },
        ...(r.chance(0.6) ? [{ id: S, fType: 1, data: coder.encode(["string"], [r.pick(["", "alpha", "x".repeat(33)])]) }] : []),
      ];
      const useVerifier = r.chance(0.15);
      const verifiers = useVerifier ? [{ key: VERIFIER_KEYS[0], verifier: verifierAddress }] : [];
      const inputDefs = Array.from({ length: 1 + r.int(4) }, (_, n) => {
        // The first input is sometimes open to anyone with no fields, which is what a call back
        // from an action target would need in order to be accepted.
        const open = n === 0 && r.chance(0.3);
        const many = !open && r.chance(0.06);
        const ids = open ? [] : many
          ? [...FIELD_IDS, ...MORE_FIELD_IDS].sort(() => r.next() - 0.5).slice(0, 30 + r.int(11))
          : [...FIELD_IDS].sort(() => r.next() - 0.5).slice(0, 1 + r.int(4));
        const fields = ids.map((fieldId) => ({ fieldId, fType: typeOfId(r, fieldId), required: r.chance(many ? 0.5 : 0.8), persist: r.chance(0.5) }));
        const conditions: { op: number; fieldId: string; bytesArg: string }[] = [];
        if (open) return { id: INPUT_IDS[n], fields, conditions, verifierKeys: [] };
        if (r.chance(0.45)) conditions.push({ op: 16, fieldId: A, bytesArg: "0x" });
        else if (r.chance(0.3)) conditions.push({ op: 17, fieldId: ethers.ZeroHash, bytesArg: coder.encode(["bytes32[]", "address[]"], [[A], [r.pick(people).address]]) });
        for (const field of fields) {
          // Few conditions on an input with very many fields, or none of its submissions would pass them all.
          if (!r.chance(many ? 0.03 : 0.5)) continue;
          if (field.fType === 0) {
            const flavour = r.int(3);
            if (flavour === 0) conditions.push({ op: 4 + r.int(5), fieldId: field.fieldId, bytesArg: coder.encode(["uint256"], [r.int(5)]) });
            else if (flavour === 1) conditions.push({ op: 9 + r.int(5), fieldId: field.fieldId, bytesArg: coder.encode(["bytes32"], [U]) });
            else conditions.push({ op: 18 + r.int(5), fieldId: field.fieldId, bytesArg: coder.encode(["bytes32", "int256"], [U, r.int(5) - 2]) });
          } else if (field.fType === 1) {
            const flavour = r.int(4);
            if (flavour === 0) conditions.push({ op: 0, fieldId: field.fieldId, bytesArg: coder.encode(["uint256"], [r.int(4)]) });
            else if (flavour === 1) conditions.push({ op: 1, fieldId: field.fieldId, bytesArg: coder.encode(["uint256"], [20 + r.int(40)]) });
            else if (flavour === 2) conditions.push({ op: 2, fieldId: field.fieldId, bytesArg: coder.encode(["string"], ["alpha"]) });
            else conditions.push({ op: 3, fieldId: field.fieldId, bytesArg: coder.encode(["bytes32"], [S]) });
          } else if (field.fType === 2) {
            conditions.push(r.chance(0.5)
              ? { op: 14, fieldId: field.fieldId, bytesArg: coder.encode(["address"], [r.pick(people).address]) }
              : { op: 15, fieldId: field.fieldId, bytesArg: coder.encode(["bytes32"], [A]) });
          }
        }
        if (r.chance(0.05)) {
          // More than 31 conditions, all of which hold, ahead of the ones that may not: the
          // byte kept per condition leaves its one slot, and the later indexes still decide.
          for (let k = 0; k < 32 + r.int(8); k++) conditions.unshift({ op: 5, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["uint256"], [1000 + k]) });
        }
        if (r.chance(0.3)) {
          // The block time against a moment long past, far ahead, or the stored number.
          conditions.push(r.pick([
            { op: 5, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["uint256"], [1000]) },
            { op: 7, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["uint256"], [ethers.MaxUint256]) },
            { op: 10, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["bytes32"], [U]) },
            { op: 19, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["bytes32", "int256"], [U, 5]) },
            { op: 7, fieldId: BLOCK_TIME_FIELD, bytesArg: coder.encode(["uint256"], [1000]) },
          ]));
        }
        // Now and then an argument of an unexpected shape, on a condition that is otherwise reachable.
        for (const condition of conditions) {
          if (r.chance(0.07)) condition.bytesArg = r.pick(["0x", "0x", r.hex(31), r.hex(32), r.hex(33), r.hex(64), coder.encode(["uint256"], [0])]);
        }
        return { id: INPUT_IDS[n], fields, conditions, verifierKeys: useVerifier && r.chance(0.5) ? [VERIFIER_KEYS[0]] : [] };
      });
      const transitions: { fromState: string; toState: string; inputId: string }[] = [];
      for (const fromState of STATES) {
        for (const def of inputDefs) {
          if (r.chance(0.6)) transitions.push({ fromState, toState: r.pick(STATES), inputId: def.id });
          if (r.chance(0.08)) transitions.push({ fromState, toState: r.pick(STATES), inputId: def.id }); // a duplicate pair
        }
      }
      if (transitions.length === 0) transitions.push({ fromState: STATES[0], toState: STATES[1], inputId: inputDefs[0].id });
      const actions = r.chance(0.3)
        ? Array.from({ length: 1 + r.int(2) }, () => {
            const t = r.pick(transitions);
            return {
              fromState: t.fromState, inputId: t.inputId, target: r.chance(0.4) ? r.pick(reentrantTargets) : r.chance(0.9) ? tokenAddress : bob.address, value: 0,
              data: r.pick([
                token.interface.encodeFunctionData("approve", [alice.address, 1]),
                token.interface.encodeFunctionData("transfer", [alice.address, 0]),
                token.interface.encodeFunctionData("transfer", [alice.address, 5]),
              ]),
            };
          })
        : [];
      return { docUri: "ipfs://doc", docHash: r.hex(32), initialState: STATES[0], inputDefs, transitions, initVars, verifiers, actions, coherent: true, authority };
    };

    const generate = (r: Rng): any => {
      if (r.chance(0.7)) return generateCoherent(r);
      const useVerifier = r.chance(0.2);
      const verifiers = useVerifier
        ? [{ key: VERIFIER_KEYS[0], verifier: r.chance(0.95) ? verifierAddress : ethers.ZeroAddress }]
            .concat(r.chance(0.1) ? [{ key: VERIFIER_KEYS[0], verifier: verifierAddress }] : [])
        : [];
      const inputCount = 1 + r.int(4);
      const inputDefs = Array.from({ length: inputCount }, (_, n) => {
        const manyFields = r.chance(0.05);
        const fields = Array.from({ length: manyFields ? 30 + r.int(11) : r.int(5) }, () => ({
          fieldId: r.chance(0.03) ? BLOCK_TIME_FIELD : r.pick(manyFields ? MORE_FIELD_IDS : FIELD_IDS),
          fType: r.int(5),
          required: r.chance(0.7),
          persist: r.chance(0.5),
        }));
        // Sometimes a long list, so the one-byte-per-condition record outgrows a slot.
        const conditionCount = r.chance(0.04) ? 33 + r.int(6) : r.int(6);
        const conditions = Array.from({ length: conditionCount }, () => {
          const op = r.int(23);
          return {
            op,
            fieldId: r.chance(0.15) ? BLOCK_TIME_FIELD : r.chance(0.6) && fields.length ? r.pick(fields).fieldId : r.pick(FIELD_IDS),
            bytesArg: conditionArg(r, op),
          };
        });
        return {
          id: r.chance(0.03) ? ethers.ZeroHash : r.chance(0.06) ? INPUT_IDS[0] : INPUT_IDS[n],
          fields,
          conditions,
          verifierKeys: useVerifier && r.chance(0.5) ? [r.chance(0.95) ? VERIFIER_KEYS[0] : VERIFIER_KEYS[1]] : r.chance(0.02) ? [VERIFIER_KEYS[1]] : [],
        };
      });
      const transitions = Array.from({ length: 1 + r.int(8) }, () => ({
        fromState: r.pick(STATES),
        toState: r.chance(0.07) ? ethers.ZeroHash : r.pick(STATES),
        inputId: r.chance(0.9) ? r.pick(inputDefs).id : r.pick(INPUT_IDS),
      }));
      const initVars = Array.from({ length: r.int(6) }, () => {
        const fType = r.int(5);
        return {
          id: r.chance(0.02) ? ethers.ZeroHash : r.chance(0.02) ? BLOCK_TIME_FIELD : r.pick(FIELD_IDS),
          fType,
          data: r.chance(0.95) ? validValue(r, fType) : anyValue(r, fType),
        };
      });
      const actions = r.chance(0.3)
        ? Array.from({ length: 1 + r.int(2) }, () => {
            const t = r.pick(transitions);
            return {
              fromState: t.fromState,
              inputId: t.inputId,
              target: r.chance(0.3) ? r.pick(reentrantTargets) : r.chance(0.8) ? tokenAddress : r.chance(0.5) ? bob.address : ethers.ZeroAddress,
              value: r.chance(0.95) ? 0 : 1,
              // approve works without a balance; transfer of a positive amount fails; a short call has no selector.
              data: r.pick([
                token.interface.encodeFunctionData("approve", [alice.address, 1]),
                token.interface.encodeFunctionData("transfer", [alice.address, 0]),
                token.interface.encodeFunctionData("transfer", [alice.address, 5]),
                "0x1234",
              ]),
            };
          })
        : [];
      return {
        docUri: r.chance(0.5) ? "ipfs://doc" : "u".repeat(r.int(70)),
        docHash: r.hex(32),
        initialState: r.chance(0.05) ? ethers.ZeroHash : STATES[0],
        inputDefs, transitions, initVars, verifiers, actions,
      };
    };

    const payloadFor = (r: Rng, def: { fields: { fieldId: string; fType: number }[] } | undefined, coherent: boolean) => {
      const fields: { id: string; fType: number; data: string }[] = [];
      for (const field of def?.fields ?? []) {
        if (r.chance(coherent ? 0.05 : 0.12)) continue; // left out
        const fType = r.chance(coherent ? 0.97 : 0.93) ? field.fType : r.int(5);
        // In a coherent agreement numbers stay small and strings short, so comparisons can hold.
        const data = coherent && r.chance(0.95)
          ? fType === 0 ? coder.encode(["uint256"], [r.int(6)])
            : fType === 1 ? coder.encode(["string"], [r.pick(["", "alpha", "beta", "x".repeat(33)])])
            : validValue(r, fType)
          : anyValue(r, fType);
        fields.push({ id: field.fieldId, fType, data });
      }
      if (r.chance(coherent ? 0.05 : 0.15)) {
        const fType = r.int(5);
        fields.push({ id: r.pick(FIELD_IDS), fType, data: anyValue(r, fType) });
      }
      if (r.chance(0.03)) return r.hex(40); // not a field list at all
      return coder.encode([DATA_FIELDS], [fields]);
    };

    // ---- comparing ---------------------------------------------------------
    // The revert data of a refused call, as hex. A refusal that carries none in a recognisable
    // place is reported by its message and counted, so that two such refusals are never taken
    // to be equal without anyone seeing that it happened.
    let refusalsWithoutData = 0;
    const revertDataOf = (error: any): string => {
      for (const candidate of [error?.data, error?.info?.error?.data, error?.info?.error?.data?.data, error?.error?.data]) {
        if (typeof candidate === "string" && /^0x[0-9a-fA-F]*$/.test(candidate)) return candidate;
      }
      refusalsWithoutData++;
      return `no revert data: ${String(error?.shortMessage ?? error?.message).slice(0, 160)}`;
    };
    const outcome = async (from: any, to: string, data: string) => {
      try {
        await ethers.provider.call({ from: from.address, to, data });
        return { ok: true as const };
      } catch (error: any) {
        return { ok: false as const, revert: revertDataOf(error) };
      }
    };
    const normalizeLogs = (receipt: any, self: string, other: string) =>
      receipt.logs.map((log: any) => ({
        own: log.address.toLowerCase() === self.toLowerCase(),
        topics: log.topics.map((t: string) => t.toLowerCase().replaceAll(self.slice(2).toLowerCase(), "<agreement>").replaceAll(other.slice(2).toLowerCase(), "<agreement>")),
        data: log.data.toLowerCase().replaceAll(self.slice(2).toLowerCase(), "<agreement>").replaceAll(other.slice(2).toLowerCase(), "<agreement>"),
      }));

    const domain = (verifyingContract: string, chainId: bigint) => ({ name: "AgreementEngine", version: "1", chainId, verifyingContract });
    const PERMIT_TYPES = {
      PermitInput: [
        { name: "signer", type: "address" }, { name: "inputId", type: "bytes32" }, { name: "payload", type: "bytes" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    };
    const { chainId } = await ethers.provider.getNetwork();

    let acceptedWithManyConditions = 0;
    let created = 0, refusedAtCreation = 0, accepted = 0, refused = 0, actionsRun = 0, viaPermit = 0, manyFieldInputs = 0, reentrantActionsRun = 0;
    const actionTopic = engineAbi.getEvent("ActionExecuted")!.topicHash;
    const acceptedTopic = engineAbi.getEvent("InputAccepted")!.topicHash;
    const permitTopic = engineAbi.getEvent("InputSubmittedWithPermit")!.topicHash;
    const refusalKinds = new Map<string, number>();

    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      const r = rng(seed);
      const g = generate(r);
      const args = [g.docUri, g.docHash, g.initialState, g.inputDefs, g.transitions, g.initVars, g.verifiers, g.actions];
      const where = `seed ${seed}`;

      const creationData = refFactory.interface.encodeFunctionData("createAgreement", args);
      const [refCreation, newCreation] = await Promise.all([
        outcome(deployer, await refFactory.getAddress(), creationData),
        outcome(deployer, await newFactory.getAddress(), creationData),
      ]);
      expect(newCreation, `${where}: creation`).to.deep.equal(refCreation);
      if (!refCreation.ok) { refusedAtCreation++; continue; }
      created++;

      const deployedAt = async (factory: any) => {
        const receipt = await (await factory.connect(deployer).createAgreement(...args)).wait();
        const event = receipt.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "AgreementDeployed");
        return { address: event.args[0] as string, receipt };
      };
      const ref = await deployedAt(refFactory);
      const cur = await deployedAt(newFactory);
      expect(normalizeLogs(cur.receipt, cur.address, ref.address), `${where}: creation events`).to.deep.equal(normalizeLogs(ref.receipt, ref.address, cur.address));
      const refEngine: any = new ethers.Contract(ref.address, engineAbi, deployer);
      const curEngine: any = new ethers.Contract(cur.address, engineAbi, deployer);

      const sameState = async (when: string) => {
        for (const getter of ["currentState", "initialState", "docHash", "docUri", "owner"]) {
          expect(await curEngine[getter](), `${where} ${when}: ${getter}`).to.equal(await refEngine[getter]());
        }
        for (const person of [...people, deployer]) {
          expect(await curEngine.nonces(person.address), `${where} ${when}: nonce of ${person.address}`).to.equal(await refEngine.nonces(person.address));
        }
        for (const key of VERIFIER_KEYS) {
          expect(await curEngine.verifierRegistry(key), `${where} ${when}: verifier`).to.equal(await refEngine.verifierRegistry(key));
        }
      };
      await sameState("after creation");

      for (let step = 0; step < STEPS; step++) {
        const at = `${where} step ${step}`;
        const actor = g.coherent && r.chance(0.6) ? g.authority : r.pick(people);
        const kind = r.next();

        let build: (engineAddress: string, engine: any) => Promise<{ from: any; data: string }>;
        let submittedTo: { conditions: unknown[] } | undefined;
        if (kind < 0.04) {
          build = async () => ({ from: actor, data: engineAbi.encodeFunctionData("cancelPermits") });
        } else {
          const def: { id: string; fields: { fieldId: string; fType: number }[]; conditions: unknown[] } | undefined = r.chance(0.92) ? r.pick(g.inputDefs) : undefined;
          submittedTo = def;
          const inputId = def ? def.id : r.pick(INPUT_IDS);
          const payload = payloadFor(r, def, Boolean(g.coherent));
          if (kind < 0.5) {
            build = async () => ({ from: actor, data: engineAbi.encodeFunctionData("submitInput", [inputId, payload]) });
          } else {
            const relayer = r.pick([...people, deployer]);
            const signedBy = r.chance(0.93) ? actor : r.pick(people);
            const nonceShift = r.chance(0.95) ? 0n : 1n;
            const latest = (await ethers.provider.getBlock("latest"))!.timestamp;
            const deadline = r.chance(0.95) ? latest + 1_000_000 : latest - 1_000;
            const tamper = r.chance(0.03);
            build = async (engineAddress, engine) => {
              const nonce = (await engine.nonces(actor.address)) + nonceShift;
              const signature = await signedBy.signTypedData(domain(engineAddress, chainId), PERMIT_TYPES, { signer: actor.address, inputId, payload, nonce, deadline });
              return {
                from: relayer,
                data: engineAbi.encodeFunctionData("submitInputWithPermit", [actor.address, inputId, payload, deadline, tamper ? signature.slice(0, -2) + "00" : signature]),
              };
            };
          }
        }

        const refCall = await build(ref.address, refEngine);
        const curCall = await build(cur.address, curEngine);
        // Both are judged against the same pending block, so a time condition cannot split them.
        const [refOutcome, curOutcome] = await Promise.all([
          outcome(refCall.from, ref.address, refCall.data),
          outcome(curCall.from, cur.address, curCall.data),
        ]);
        const comparable = (o: typeof refOutcome, self: string) => (o.ok ? o : { ok: false, revert: o.revert.toLowerCase().replaceAll(self.slice(2).toLowerCase(), "<agreement>") });
        expect(comparable(curOutcome, cur.address), `${at}: outcome`).to.deep.equal(comparable(refOutcome, ref.address));

        if (!refOutcome.ok) {
          refused++;
          const kindOfRefusal = refOutcome.revert.slice(0, 10);
          refusalKinds.set(kindOfRefusal, (refusalKinds.get(kindOfRefusal) ?? 0) + 1);
          continue;
        }
        accepted++;
        const refReceipt = await (await refCall.from.sendTransaction({ to: ref.address, data: refCall.data })).wait();
        const curReceipt = await (await curCall.from.sendTransaction({ to: cur.address, data: curCall.data })).wait();
        expect(normalizeLogs(curReceipt, cur.address, ref.address), `${at}: events`).to.deep.equal(normalizeLogs(refReceipt, ref.address, cur.address));
        if ((submittedTo?.conditions.length ?? 0) > 31) acceptedWithManyConditions++;
        const ranAction = refReceipt.logs.find((l: any) => l.topics[0] === actionTopic);
        if (ranAction) actionsRun++;
        if (ranAction && reentrantTargets.some((target) => ranAction.data.toLowerCase().includes(target.slice(2).toLowerCase()))) reentrantActionsRun++;
        if ((refReceipt.logs.find((l: any) => l.topics[0] === acceptedTopic)?.data.length ?? 0) > 2 + 64 * 40) manyFieldInputs++;
        if (refReceipt.logs.some((l: any) => l.topics[0] === permitTopic)) viaPermit++;
        await sameState(`after step ${step}`);
      }
    }

    console.log(`      agreements created: ${created}, refused at creation: ${refusedAtCreation}; submissions accepted: ${accepted} (${viaPermit} by permit, ${actionsRun} ran an action, ${reentrantActionsRun} of those a target that calls back, ${manyFieldInputs} with a very long payload, ${acceptedWithManyConditions} on an input with more than 31 conditions), refused: ${refused} (${refusalsWithoutData} without revert data in a recognised place)`);
    console.log(`      distinct refusal selectors seen: ${refusalKinds.size} (${[...refusalKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(", ")})`);
    expect(created, "some agreements must be created for the comparison to mean anything").to.be.greaterThan(SEEDS / 10);
    expect(accepted, "some submissions must be accepted for the comparison to mean anything").to.be.greaterThan(0);
  });
});
