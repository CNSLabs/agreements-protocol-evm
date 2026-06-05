// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IInputVerifier} from "../../src/interfaces/IInputVerifier.sol";
import {IAgreementEngine} from "../../src/interfaces/IAgreementEngine.sol";

/**
 * @dev A NON-view interface with the SAME `verify(...)` selector the engine uses. The control
 *      path in the verifier-staticcall test calls the mutating verifier through THIS interface,
 *      which the compiler lowers to a plain CALL — so the verifier's direct `sstore` succeeds.
 *      The engine, by contrast, holds the verifier as `IInputVerifier` (whose `verify` is
 *      `view`) and so calls the SAME function via STATICCALL, where the same `sstore` reverts.
 *      Same deployed contract + same selector, two call paths: the only difference is
 *      view→staticcall (engine) vs non-view→call (control). That isolates the staticcall as the
 *      cause of the engine-path revert.
 */
interface IMutatingVerifier {
    function verify(
        address agreement,
        bytes32 inputId,
        bytes calldata payload,
        address sender
    ) external; // NOT view — this call site compiles to a plain CALL.
}

/**
 * @title MockMutatingVerifier
 * @notice Adversarial verifier for the R5 verifier-interaction-safety invariant. The engine
 *         invokes verifiers through `IInputVerifier(verifier).verify(...)`; because
 *         `IInputVerifier.verify` is `view`, the Solidity compiler lowers that call site to a
 *         STATICCALL.
 *
 *         This mock's `verify` is itself a plain NON-view function that performs a DIRECT
 *         `sstore` (SELF_WRITE) or a re-entry into the engine (REENTER_SUBMIT) — with NO inner
 *         view-lying helper interface. The mock therefore does NOT emit a staticcall of its
 *         own; whether its mutation is allowed is decided ENTIRELY by how the CALLER reached
 *         `verify`. The engine reaches it by selector via STATICCALL, so the mutation reverts;
 *         the test's control reaches the SAME function via a plain CALL (IMutatingVerifier), so
 *         the identical mutation lands. A passing engine-path test thus genuinely depends on
 *         the engine using a staticcall — it would FAIL if the engine used a plain CALL.
 *
 * @dev Intentionally does NOT inherit `IInputVerifier`: that interface's `verify` is `view`,
 *      and an overriding implementation must be at least as restrictive, which would forbid the
 *      direct sstore. The engine dispatches verifiers by selector, so no inheritance is needed;
 *      this mock's `verify` keeps the same selector while being (truthfully) non-view.
 */
contract MockMutatingVerifier {
    enum Mode {
        SELF_WRITE, // attempt a direct sstore (counter += 1)
        REENTER_SUBMIT // attempt to re-enter the engine's submitInput
    }

    Mode public mode;
    uint256 public counter; // the slot SELF_WRITE bumps (observable iff CALLed, not STATICCALLed)
    bytes32 public reenterInputId;
    bytes public reenterPayload;

    function setMode(Mode m) external {
        mode = m;
    }

    function setReenter(bytes32 inputId, bytes calldata payload) external {
        reenterInputId = inputId;
        reenterPayload = payload;
    }

    /// @notice Verifier entrypoint — same selector as IInputVerifier.verify, but NON-view.
    /// @dev Performs a real state change (direct sstore, or a mutating re-entry). Under the
    ///      engine's STATICCALL the change reverts; under a plain CALL it lands.
    function verify(
        address agreement,
        bytes32, /* inputId */
        bytes calldata, /* payload */
        address /* sender */
    ) external {
        if (mode == Mode.SELF_WRITE) {
            // DIRECT sstore. Reverts iff this frame is static; succeeds under a plain CALL.
            counter += 1;
        } else {
            // Re-enter the engine's submitInput. Under the engine's staticcall, submitInput's
            // own sstore is a state change from a static frame and reverts — i.e. the STATICCALL
            // CONTEXT blocks the re-entry, NOT the OZ reentrancy guard.
            IAgreementEngine(agreement).submitInput(reenterInputId, reenterPayload);
        }
    }
}

/**
 * @title MockPassThroughVerifier
 * @notice A benign verifier that always passes (does nothing). Used to confirm the verifier
 *         path runs at all on the honest path before the adversarial cases.
 */
contract MockPassThroughVerifier is IInputVerifier {
    function verify(address, bytes32, bytes calldata, address) external view override {}
}

/**
 * @title MockRejectingVerifier
 * @notice A verifier that always rejects (reverts). Used to prove an init-registered verifier
 *         actually runs on the submitInput hot path: a rejecting verifier reverts the submission.
 */
contract MockRejectingVerifier is IInputVerifier {
    error VerifierRejected();

    function verify(address, bytes32, bytes calldata, address) external view override {
        revert VerifierRejected();
    }
}
