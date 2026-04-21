import { describe, it, expect, beforeAll } from "@jest/globals";
import { keccak256, stringToHex, decodeAbiParameters } from "viem";
import * as fs from "fs";
import * as path from "path";
import {
  buildSubmitInputPayload,
  buildInputPayload,
  stringField,
  addressField,
  uint256Field,
  boolField,
  bytes32Field,
} from "../src/payload-builder";
import { AgreementJson, FieldType } from "../src/types";

describe("payload-builder", () => {
  let validationTestJson: AgreementJson;

  beforeAll(() => {
    const agreementPath = path.resolve(
      __dirname,
      "../../agreements/validation-test/unwrapped/validation-test.json"
    );
    validationTestJson = JSON.parse(fs.readFileSync(agreementPath, "utf-8"));
  });

  it("encodes multiple field types into submitInput payload", () => {
    const payload = buildSubmitInputPayload([
      stringField("name", "Alice"),
      addressField("addr", "0x000000000000000000000000000000000000dEaD"),
      uint256Field("amount", 42n),
      boolField("flag", true),
      bytes32Field(
        "hash",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ),
    ]);

    const [fields] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "id", type: "bytes32" },
            { name: "fType", type: "uint8" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      payload
    );

    expect(fields).toHaveLength(5);
    expect(fields[0].id).toBe(keccak256(stringToHex("name")));
    expect(fields[0].fType).toBe(FieldType.STRING);
    expect(fields[1].id).toBe(keccak256(stringToHex("addr")));
    expect(fields[1].fType).toBe(FieldType.ADDRESS);
    expect(fields[2].fType).toBe(FieldType.UINT256);
    expect(fields[3].fType).toBe(FieldType.BOOL);
    expect(fields[4].fType).toBe(FieldType.BYTES32);
  });

  it("builds payloads without omitted optional fields", () => {
    const payload = buildInputPayload(validationTestJson, "submitValidation", {
      uintMin: 10n,
      uintMax: 50n,
      uintMinMax: 50n,
      stringMinLength: "hello",
      stringMaxLength: "short",
      stringMinMaxLength: "test",
    });

    const [fields] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "id", type: "bytes32" },
            { name: "fType", type: "uint8" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      payload
    );

    expect(fields).toHaveLength(6);
    expect(fields.some((field) => field.id === keccak256(stringToHex("optionalComment")))).toBe(false);
    expect(fields.some((field) => field.id === keccak256(stringToHex("optionalScore")))).toBe(false);
  });
});
