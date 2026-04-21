import { expect } from "chai";
import { ethers } from "hardhat";
import { Address } from "viem";
import {
  loadAgreement,
  deployProtocol,
  loadSDKModule,
  createViemClientsForSigner,
} from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

let validationTest: AgreementJson;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

function buildMultiIssuerAgreement(literalApprover: Address): AgreementJson {
  return {
    metadata: {
      id: "did:example:multi-issuer-approval",
      templateId: "did:template:multi-issuer-approval",
      version: "1.0.0",
      name: "Multi Issuer Approval",
    },
    variables: {
      primaryApprover: {
        type: "address",
        name: "Primary Approver",
        validation: {
          required: true,
        },
      },
      backupApprover: {
        type: "address",
        name: "Backup Approver",
        validation: {
          required: true,
        },
      },
      approvalNote: {
        type: "string",
        name: "Approval Note",
        validation: {
          required: true,
          minLength: 3,
        },
      },
    },
    content: {
      type: "md",
      data: "Approve the request.",
    },
    execution: {
      states: {
        PENDING: {
          name: "Pending",
        },
        APPROVED: {
          name: "Approved",
        },
      },
      initialize: {
        initialState: "PENDING",
        data: {
          primaryApprover: "${variables.primaryApprover}",
          backupApprover: "${variables.backupApprover}",
        },
      },
      inputs: {
        approve: {
          type: "signedFields",
          data: {
            approvalNote: "${variables.approvalNote}",
          },
          issuer: [
            "${variables.primaryApprover.value}",
            "${variables.backupApprover.value}",
            literalApprover,
          ],
        },
      },
      transitions: [
        {
          from: "PENDING",
          to: "APPROVED",
          conditions: [
            {
              type: "isValid",
              input: "approve",
            },
          ],
        },
      ],
    },
  };
}

describe("AgreementEngine (integration) - Validation Conditions", () => {
  before(async () => {
    validationTest = loadAgreement("validation-test");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Uint256 Validation - Min", () => {
    it("accepts value >= min", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: value = 10 (exactly min)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: value = 15 (above min)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;
    });

    it("rejects value < min", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: value = 9 (below min of 10)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 9n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("Uint256 Validation - Max", () => {
    it("accepts value <= max", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: value = 100 (exactly max)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 100n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: value = 50 (below max)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;
    });

    it("rejects value > max", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: value = 101 (above max of 100)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 101n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("Uint256 Validation - Min and Max", () => {
    it("accepts value within range", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: value = 20 (exactly min)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 20n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: value = 50 (middle of range)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: value = 80 (exactly max)
      const { address: agreementAddress3 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement3 = new AgreementEngineClass(agreementAddress3, publicClient, walletClient);
      await expect(
        agreement3.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 80n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;
    });

    it("rejects value < min", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: value = 19 (below min of 20)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 19n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });

    it("rejects value > max", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: value = 81 (above max of 80)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 81n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("String Validation - MinLength", () => {
    it("accepts string with length >= minLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: length = 5 (exactly minLength)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: length = 10 (above minLength)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "helloworld",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;
    });

    it("rejects string with length < minLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: length = 4 (below minLength of 5)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hell",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("String Validation - MaxLength", () => {
    it("accepts string with length <= maxLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: length = 20 (exactly maxLength)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "12345678901234567890",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;

      // Valid: length = 5 (below maxLength)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "test",
        })
      ).to.not.be.reverted;
    });

    it("rejects string with length > maxLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: length = 21 (above maxLength of 20)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "123456789012345678901",
          stringMinMaxLength: "test",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("String Validation - MinLength and MaxLength", () => {
    it("accepts string within length range", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Valid: length = 3 (exactly minLength)
      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "abc",
        })
      ).to.not.be.reverted;

      // Valid: length = 5 (middle of range)
      const { address: agreementAddress2 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement2 = new AgreementEngineClass(agreementAddress2, publicClient, walletClient);
      await expect(
        agreement2.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "hello",
        })
      ).to.not.be.reverted;

      // Valid: length = 10 (exactly maxLength)
      const { address: agreementAddress3 } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });
      const agreement3 = new AgreementEngineClass(agreementAddress3, publicClient, walletClient);
      await expect(
        agreement3.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "1234567890",
        })
      ).to.not.be.reverted;
    });

    it("rejects string with length < minLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: length = 2 (below minLength of 3)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "ab",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });

    it("rejects string with length > maxLength", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      // Invalid: length = 11 (above maxLength of 10)
      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 10n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello",
          stringMaxLength: "short",
          stringMinMaxLength: "12345678901",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("All Validations Together", () => {
    it("accepts all valid values together", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,        // >= 10 ✓
          uintMax: 50n,        // <= 100 ✓
          uintMinMax: 50n,     // >= 20 && <= 80 ✓
          stringMinLength: "hello world",  // length >= 5 ✓
          stringMaxLength: "short",        // length <= 20 ✓
          stringMinMaxLength: "test123",    // length >= 3 && <= 10 ✓
        })
      ).to.not.be.reverted;

      expect(await agreement.getCurrentState(validationTest)).to.equal("VALIDATED");
    });
  });

  describe("Optional Fields", () => {
    it("accepts omitted optional fields", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello world",
          stringMaxLength: "short",
          stringMinMaxLength: "test123",
        })
      ).to.not.be.reverted;

      expect(await agreement.getCurrentState(validationTest)).to.equal("VALIDATED");
    });

    it("accepts optional fields when provided with valid values", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      await expect(
        agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello world",
          stringMaxLength: "short",
          stringMinMaxLength: "test123",
          optionalComment: "looks good",
          optionalScore: 15n,
        })
      ).to.not.be.reverted;

      expect(await agreement.getCurrentState(validationTest)).to.equal("VALIDATED");
    });

    it("rejects invalid optional string values when provided", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello world",
          stringMaxLength: "short",
          stringMinMaxLength: "test123",
          optionalComment: "bad",
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });

    it("rejects invalid optional uint values when provided", async () => {
      const [signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient, publicClient }
      );

      const { address: agreementAddress } = await factory.createAgreement(validationTest, {
        initValues: {
          testAddress: signer.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(agreementAddress, publicClient, walletClient);

      try {
        await agreement.submitInput(validationTest, "submitValidation", {
          uintMin: 15n,
          uintMax: 50n,
          uintMinMax: 50n,
          stringMinLength: "hello world",
          stringMaxLength: "short",
          stringMinMaxLength: "test123",
          optionalScore: 9n,
        });
        expect.fail("Expected transaction to revert with ComparisonFailed");
      } catch (error: any) {
        expect(error.message).to.include("ComparisonFailed");
      }
    });
  });

  describe("Multi-Issuer Input Authorization", () => {
    it("allows any configured signer to trigger the same transition", async () => {
      const [owner, primaryApprover, backupApprover, literalApprover] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();

      const { publicClient: ownerPublic, walletClient: ownerWallet } =
        await createViemClientsForSigner(owner);
      const { publicClient: primaryPublic, walletClient: primaryWallet } =
        await createViemClientsForSigner(primaryApprover);
      const { publicClient: backupPublic, walletClient: backupWallet } =
        await createViemClientsForSigner(backupApprover);
      const { publicClient: literalPublic, walletClient: literalWallet } =
        await createViemClientsForSigner(literalApprover);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: ownerWallet, publicClient: ownerPublic }
      );

      const multiIssuerAgreement = buildMultiIssuerAgreement(
        literalApprover.address as Address
      );
      const initValues = {
        primaryApprover: primaryApprover.address as Address,
        backupApprover: backupApprover.address as Address,
      };

      const allowedSigners = [
        { publicClient: primaryPublic, walletClient: primaryWallet },
        { publicClient: backupPublic, walletClient: backupWallet },
        { publicClient: literalPublic, walletClient: literalWallet },
      ];

      for (const signerClients of allowedSigners) {
        const { address: agreementAddress } = await factory.createAgreement(
          multiIssuerAgreement,
          { initValues }
        );

        const agreement = new AgreementEngineClass(
          agreementAddress,
          signerClients.publicClient,
          signerClients.walletClient
        );

        await expect(
          agreement.submitInput(multiIssuerAgreement, "approve", {
            approvalNote: "approved",
          })
        ).to.not.be.reverted;

        expect(await agreement.getCurrentState(multiIssuerAgreement)).to.equal("APPROVED");
      }
    });

    it("rejects senders outside the configured issuer list", async () => {
      const [owner, primaryApprover, backupApprover, literalApprover, outsider] =
        await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();

      const { publicClient: ownerPublic, walletClient: ownerWallet } =
        await createViemClientsForSigner(owner);
      const { publicClient: outsiderPublic, walletClient: outsiderWallet } =
        await createViemClientsForSigner(outsider);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: ownerWallet, publicClient: ownerPublic }
      );

      const multiIssuerAgreement = buildMultiIssuerAgreement(
        literalApprover.address as Address
      );

      const { address: agreementAddress } = await factory.createAgreement(
        multiIssuerAgreement,
        {
          initValues: {
            primaryApprover: primaryApprover.address as Address,
            backupApprover: backupApprover.address as Address,
          },
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        outsiderPublic,
        outsiderWallet
      );

      try {
        await agreement.submitInput(multiIssuerAgreement, "approve", {
          approvalNote: "approved",
        });
        expect.fail("Expected transaction to revert with SenderAddressNotAllowed");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressNotAllowed");
      }
    });
  });
});

