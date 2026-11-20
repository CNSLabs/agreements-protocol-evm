// SPDX-License-Identifier: Apache-2.0
//
// How the three permit paths check a signature: an input permit on an
// agreement, a creation permit and a deterministic creation permit on the
// factory. Every test runs against each path. A permit is accepted only when
// it is unexpired, unused, signed for this contract on this chain, well formed,
// and approved by the account it names.

import { expect } from "chai";
import { ethers } from "hardhat";
import { setCode, takeSnapshot, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const coder = ethers.AbiCoder.defaultAbiCoder();
const hash = (type: string, value: unknown) => ethers.keccak256(coder.encode([type], [value]));
const emptyPayload = coder.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);

const CREATION_FIELDS = [
  { name: "signer", type: "address" },
  { name: "docUri", type: "string" },
  { name: "docHash", type: "bytes32" },
  { name: "initialState", type: "bytes32" },
  { name: "inputDefsHash", type: "bytes32" },
  { name: "transitionsHash", type: "bytes32" },
  { name: "initVarsHash", type: "bytes32" },
  { name: "verifiersHash", type: "bytes32" },
  { name: "actionsHash", type: "bytes32" },
];
const TAIL = [
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];

type Deployment = {
  docUri: string;
  docHash: string;
  initialState: string;
  inputDefs: any[];
  transitions: any[];
  initVars: any[];
  verifiers: any[];
  actions: any[];
};
const createArgs = (d: Deployment) =>
  [d.docUri, d.docHash, d.initialState, d.inputDefs, d.transitions, d.initVars, d.verifiers, d.actions] as const;

const SIGN = id("sign");
const [S0, S1] = [id("S0"), id("S1")];
// One input, open to anyone, that moves the agreement from S0 to S1.
const oneInput = (name: string): Deployment => ({
  docUri: `ipfs://${name}`,
  docHash: id(name),
  initialState: S0,
  inputDefs: [{ id: SIGN, fields: [], conditions: [], verifierKeys: [] }],
  transitions: [{ fromState: S0, toState: S1, inputId: SIGN }],
  initVars: [],
  verifiers: [],
  actions: [],
});
const contentHashes = (d: Deployment) => ({
  docUri: d.docUri,
  docHash: d.docHash,
  initialState: d.initialState,
  inputDefsHash: hash(
    "tuple(bytes32 id,tuple(bytes32 fieldId,uint8 fType,bool required,bool persist)[] fields,tuple(uint8 op,bytes32 fieldId,bytes bytesArg)[] conditions,bytes32[] verifierKeys)[]",
    d.inputDefs
  ),
  transitionsHash: hash("tuple(bytes32 fromState,bytes32 toState,bytes32 inputId)[]", d.transitions),
  initVarsHash: hash("tuple(bytes32 id,uint8 fType,bytes data)[]", d.initVars),
  verifiersHash: hash("tuple(bytes32 key,address verifier)[]", d.verifiers),
  actionsHash: hash("tuple(bytes32 fromState,bytes32 inputId,address target,uint256 value,bytes data)[]", d.actions),
});

const KINDS = ["input permit", "creation permit", "deterministic creation permit"] as const;
type Kind = (typeof KINDS)[number];

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

type TypedDataTypes = Record<string, { name: string; type: string }[]>;

describe("AgreementsProtocol (permit signatures)", function () {
  // Some tests move the chain's clock or put code at an account. Each one is
  // undone, so nothing here reaches the other test files.
  let snapshot: Awaited<ReturnType<typeof takeSnapshot>>;
  beforeEach(async function () {
    snapshot = await takeSnapshot();
  });
  afterEach(async function () {
    await snapshot.restore();
  });

  /**
   * A fresh factory and, for `kind`, one permit that names `signerAddress`:
   * the typed data to sign and the call a relayer makes with the signature.
   */
  async function permitFor(kind: Kind, signerAddress: string, deadlineIn?: number) {
    const implementation = await ethers.deployContract("AgreementEngine");
    const factory: any = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
    const [, relayer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + (deadlineIn ?? 3600);
    const common = { implementationAddress: await implementation.getAddress(), factory, relayer, deadline };

    if (kind === "input permit") {
      const deployment = oneInput("signed-on");
      const deploy = async () => {
        const address = await factory.createAgreement.staticCall(...createArgs(deployment));
        await factory.createAgreement(...createArgs(deployment));
        return (await ethers.getContractAt("AgreementEngine", address)) as any;
      };
      const agreement = await deploy();
      return {
        ...common,
        contract: agreement,
        deploySameAgreementAgain: deploy,
        domain: { name: "AgreementEngine", version: "1", chainId, verifyingContract: await agreement.getAddress() },
        otherDomainName: "AgreementFactory",
        types: {
          PermitInput: [CREATION_FIELDS[0], { name: "inputId", type: "bytes32" }, { name: "payload", type: "bytes" }, ...TAIL],
        } as TypedDataTypes,
        message: { signer: signerAddress, inputId: SIGN, payload: emptyPayload, nonce: 0n, deadline },
        submit: (signature: string) =>
          agreement.connect(relayer).submitInputWithPermit(signerAddress, SIGN, emptyPayload, deadline, signature),
        nonce: (): Promise<bigint> => agreement.nonces(signerAddress),
        accepted: async () => (await agreement.currentState()) === S1,
      };
    }

    const deployment = oneInput("created");
    const domain = { name: "AgreementFactory", version: "1", chainId, verifyingContract: await factory.getAddress() };
    const nonce = (): Promise<bigint> => factory.nonces(signerAddress);

    if (kind === "creation permit") {
      return {
        ...common,
        contract: factory,
        deploySameAgreementAgain: undefined,
        domain,
        otherDomainName: "AgreementEngine",
        types: { PermitAgreementWithActions: [...CREATION_FIELDS, ...TAIL] } as TypedDataTypes,
        message: { signer: signerAddress, ...contentHashes(deployment), nonce: 0n, deadline },
        submit: (signature: string) =>
          factory.connect(relayer).createAgreementWithPermit(signerAddress, ...createArgs(deployment), deadline, signature),
        nonce,
        accepted: async () => (await nonce()) === 1n,
      };
    }

    const salt = id("salt");
    const predictedAgreement: string = await factory.predictAddress(signerAddress, salt);
    return {
      ...common,
      contract: factory,
      deploySameAgreementAgain: undefined,
      domain,
      otherDomainName: "AgreementEngine",
      types: {
        PermitDeterministicAgreementWithActions: [
          ...CREATION_FIELDS,
          { name: "salt", type: "bytes32" },
          { name: "predictedAgreement", type: "address" },
          ...TAIL,
        ],
      } as TypedDataTypes,
      message: { signer: signerAddress, ...contentHashes(deployment), salt, predictedAgreement, nonce: 0n, deadline },
      submit: (signature: string) =>
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(signerAddress, salt, ...createArgs(deployment), deadline, signature),
      nonce,
      accepted: async () => (await ethers.provider.getCode(predictedAgreement)) !== "0x",
    };
  }

  type Permit = Awaited<ReturnType<typeof permitFor>>;

  async function expectRefused(permit: Permit, signature: string) {
    await expect(permit.submit(signature)).to.be.revertedWithCustomError(permit.contract, "InvalidSignature");
    expect(await permit.nonce()).to.equal(0n);
    expect(await permit.accepted()).to.equal(false);
  }

  async function expectAccepted(permit: Permit, signature: string) {
    await permit.submit(signature);
    expect(await permit.nonce()).to.equal(1n);
    expect(await permit.accepted()).to.equal(true);
  }

  for (const kind of KINDS) {
    describe(kind, function () {
      it("is accepted in the block whose time equals its deadline", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, key.address, 600);
        const signature = await key.signTypedData(permit.domain, permit.types, permit.message);

        await time.setNextBlockTimestamp(permit.deadline);
        await expectAccepted(permit, signature);
        expect((await ethers.provider.getBlock("latest"))!.timestamp).to.equal(permit.deadline);
      });

      it("is refused one second after its deadline", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, key.address, 600);
        const signature = await key.signTypedData(permit.domain, permit.types, permit.message);

        await time.setNextBlockTimestamp(permit.deadline + 1);
        await expect(permit.submit(signature))
          .to.be.revertedWithCustomError(permit.contract, "PermitExpired")
          .withArgs(permit.deadline);
        expect(await permit.nonce()).to.equal(0n);
      });

      it("cannot be used a second time", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, key.address);
        const signature = await key.signTypedData(permit.domain, permit.types, permit.message);

        await expectAccepted(permit, signature);
        await expect(permit.submit(signature)).to.be.revertedWithCustomError(permit.contract, "InvalidSignature");
        expect(await permit.nonce()).to.equal(1n);
      });

      it("is refused when signed for another chain, another contract or another contract name", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, key.address);
        const otherDomains = [
          { ...permit.domain, chainId: permit.domain.chainId + 1n },
          // For an agreement this is the implementation its clone runs on.
          { ...permit.domain, verifyingContract: permit.implementationAddress },
          { ...permit.domain, name: permit.otherDomainName },
          { ...permit.domain, version: "2" },
        ];
        for (const domain of otherDomains) {
          await expectRefused(permit, await key.signTypedData(domain, permit.types, permit.message));
        }

        await expectAccepted(permit, await key.signTypedData(permit.domain, permit.types, permit.message));
      });

      it("is refused with a malformed signature", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, key.address);
        const signature = await key.signTypedData(permit.domain, permit.types, permit.message);
        const { r, s, v, compactSerialized } = ethers.Signature.from(signature);
        const vByte = (value: number) => ethers.toBeHex(value, 1);
        // The second signature every ECDSA signature has: (r, n - s) with the other recovery byte.
        const twinS = ethers.toBeHex(SECP256K1_N - BigInt(s), 32);
        const twinV = v === 27 ? 28 : 27;

        const malformed: Record<string, string> = {
          empty: "0x",
          "64-byte compact form": compactSerialized,
          "one byte too long": ethers.concat([signature, "0x00"]),
          "recovery byte 0 or 1": ethers.concat([r, s, vByte(v - 27)]),
          "high-s twin": ethers.concat([r, twinS, vByte(twinV)]),
        };
        // The twin is a genuine signature by the same key: the bare ecrecover
        // precompile accepts it. The contracts refuse it all the same, so a
        // third party cannot turn a signature it has seen into a different one.
        const digest = ethers.TypedDataEncoder.hash(permit.domain, permit.types, permit.message);
        const recovered = await ethers.provider.call({
          to: "0x0000000000000000000000000000000000000001",
          data: ethers.concat([digest, ethers.toBeHex(twinV, 32), r, twinS]),
        });
        expect(ethers.getAddress(ethers.dataSlice(recovered, 12))).to.equal(key.address);

        for (const [what, bytes] of Object.entries(malformed)) {
          await expect(permit.submit(bytes), what).to.be.revertedWithCustomError(permit.contract, "InvalidSignature");
        }
        expect(await permit.nonce()).to.equal(0n);

        await expectAccepted(permit, signature);
      });

      it("cannot name the zero address as its signer", async function () {
        const [key] = await ethers.getSigners();
        const permit = await permitFor(kind, ethers.ZeroAddress);

        await expectRefused(permit, await key.signTypedData(permit.domain, permit.types, permit.message));
        await expectRefused(permit, "0x");
        await expectRefused(permit, ethers.concat([ethers.ZeroHash, ethers.ZeroHash, "0x1b"]));
      });

      it("is refused when the smart account it names does not approve it properly", async function () {
        const [key] = await ethers.getSigners();
        // Revert, EmptyReturn, ShortMagic, BooleanTrue
        for (const mode of [0, 1, 2, 3]) {
          const account = await ethers.deployContract("MisbehavingERC1271Signer", [mode]);
          const permit = await permitFor(kind, await account.getAddress());
          const signature = await key.signTypedData(permit.domain, permit.types, permit.message);

          await expect(permit.submit(signature), `mode ${mode}`).to.be.revertedWithCustomError(
            permit.contract,
            "InvalidSignature"
          );
          expect(await permit.nonce()).to.equal(0n);
        }
      });

      // The case of a wallet that has delegated its account to a contract
      // (EIP-7702): once the account has code, its own key no longer speaks for
      // it directly, and the code must answer ERC-1271.
      it("an account with code is asked through ERC-1271, and its bare key signature is not enough", async function () {
        const wallet = ethers.Wallet.createRandom();
        const permit = await permitFor(kind, wallet.address);
        const signature = await wallet.signTypedData(permit.domain, permit.types, permit.message);

        // Code that does not implement the ERC-1271 check.
        await setCode(wallet.address, await ethers.provider.getCode(permit.implementationAddress));
        await expectRefused(permit, signature);

        // Code that approves what the wallet's key signed.
        const validator = await ethers.deployContract("TestERC1271Signer", [wallet.address]);
        await setCode(wallet.address, await ethers.provider.getCode(await validator.getAddress()));
        await expectAccepted(permit, signature);
      });
    });
  }

  it("an input permit signed for one agreement is refused on another with identical terms", async function () {
    const [key] = await ethers.getSigners();
    const permit = await permitFor("input permit", key.address);
    const twin = await permit.deploySameAgreementAgain!();
    const signature = await key.signTypedData(permit.domain, permit.types, permit.message);

    await expect(
      twin.connect(permit.relayer).submitInputWithPermit(key.address, SIGN, emptyPayload, permit.deadline, signature)
    ).to.be.revertedWithCustomError(twin, "InvalidSignature");
    expect(await twin.currentState()).to.equal(S0);

    await expectAccepted(permit, signature);
  });
});
