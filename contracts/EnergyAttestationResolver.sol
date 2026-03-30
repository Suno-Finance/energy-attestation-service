// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IEnergyRegistry } from "./IEnergyRegistry.sol";

/// @title EnergyAttestationResolver
/// @notice EAS resolver that validates energy attestations and delegates all state reads/writes
///         to EnergyRegistry. Stateless beyond the registry address — can be replaced without
///         migrating any company or project data. Multiple resolver versions can run concurrently
///         during a migration window; pause this contract to end the old version.
contract EnergyAttestationResolver is SchemaResolver, Ownable2Step, Pausable {
    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    IEnergyRegistry private immutable _REGISTRY;

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    error UnauthorizedAttester(address attester);
    error ProjectNotRegistered(uint64 projectId);
    error InvalidTimestamps();
    error InvalidReadingCount();
    error InvalidReadingInterval();
    error InvalidReadingsLength(uint32 readingCount, uint256 readingsLength);
    error TimestampOverflow();
    error InvalidMethod();
    error ReplacementPeriodMismatch();
    error ReplacementProjectMismatch();
    error DirectRevocationBlocked();

    // ──────────────────────────────────────────────
    //  Internal helpers
    // ──────────────────────────────────────────────

    function _computeEnergyWh(uint256[] memory readings) private pure returns (uint256 energyWh) {
        for (uint256 i = 0; i < readings.length; ) {
            energyWh += readings[i];
            unchecked {
                ++i;
            }
        }
    }

    function _computeToTimestamp(
        uint64 fromTimestamp,
        uint32 readingCount,
        uint32 readingIntervalMinutes
    ) private pure returns (uint64 toTimestamp) {
        // readingCount and readingIntervalMinutes are uint32, so the product fits comfortably in uint256.
        uint256 durationSeconds;
        unchecked {
            durationSeconds = uint256(readingCount) * uint256(readingIntervalMinutes) * 60;
        }
        uint256 toTimestamp256 = uint256(fromTimestamp) + durationSeconds;
        if (toTimestamp256 > type(uint64).max) revert TimestampOverflow();
        toTimestamp = uint64(toTimestamp256);
    }

    function _validateReport(
        uint32 readingCount,
        uint32 readingIntervalMinutes,
        uint256[] memory readings,
        string memory method
    ) private pure {
        if (readingCount == 0) revert InvalidReadingCount();
        if (readingIntervalMinutes == 0) revert InvalidReadingInterval();
        if (readings.length != uint256(readingCount)) {
            revert InvalidReadingsLength(readingCount, readings.length);
        }
        if (bytes(method).length == 0) revert InvalidMethod();
    }

    function _requireAuthorizedAttester(uint64 projectId, uint64 watcherId, address attester) private view {
        if (!_REGISTRY.isProjectAttester(projectId, attester) && !_REGISTRY.isWatcherAttester(watcherId, attester)) {
            revert UnauthorizedAttester(attester);
        }
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    constructor(IEAS eas, IEnergyRegistry registry_) SchemaResolver(eas) Ownable(msg.sender) {
        _REGISTRY = registry_;
    }

    // ──────────────────────────────────────────────
    //  Admin: Pause (contract owner only)
    //  Use pause() to end a migration window — companies must then use the new schema UID.
    // ──────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  Registry accessor
    // ──────────────────────────────────────────────

    function getRegistry() external view returns (address) {
        return address(_REGISTRY);
    }

    // ──────────────────────────────────────────────
    //  Admin: Ownership
    // ──────────────────────────────────────────────

    function renounceOwnership() public pure override {
        revert("Renounce disabled");
    }

    function isPayable() public pure override returns (bool) {
        return false;
    }

    // ──────────────────────────────────────────────
    //  Internal: Replacement validation
    // ──────────────────────────────────────────────

    /// @dev Internal helper to validate a replacement attestation (refUID flow).
    ///      Fetches the old attestation from EAS, decodes it, validates that the project and period match,
    ///      then delegates to registry.recordReplacement. Ensures the replacement is for the same period
    ///      (same fromTimestamp and derived toTimestamp) but with corrected energy readings.
    /// @param attestation The new attestation being submitted (contains refUID pointing to the old one).
    /// @param projectId The project ID from the new attestation data.
    /// @param fromTimestamp The fromTimestamp from the new attestation data.
    /// @param newToTimestamp The derived toTimestamp of the new attestation.
    /// @param newEnergyWh The computed total energy from the new attestation's readings.
    /// @param metadataURI Optional URI with proof/audit context for the new attestation.
    /// @dev Reverts with ReplacementProjectMismatch if the old attestation is for a different project.
    ///      Reverts with ReplacementPeriodMismatch if the period (from/to timestamps) differs.
    function _handleReplacement(
        Attestation calldata attestation,
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 newToTimestamp,
        uint256 newEnergyWh,
        string memory metadataURI,
        uint256[] memory newReadings
    ) private {
        Attestation memory oldAttestation = _eas.getAttestation(attestation.refUID);

        (uint64 oldProjectId, uint32 oldReadingCount, uint32 oldReadingIntervalMinutes, uint256[] memory oldReadings, uint64 oldFromTimestamp, , ) =
            abi.decode(oldAttestation.data, (uint64, uint32, uint32, uint256[], uint64, string, string));

        if (oldProjectId != projectId) revert ReplacementProjectMismatch();

        uint64 oldToTimestamp = _computeToTimestamp(oldFromTimestamp, oldReadingCount, oldReadingIntervalMinutes);
        if (oldFromTimestamp != fromTimestamp || oldToTimestamp != newToTimestamp) {
            revert ReplacementPeriodMismatch();
        }

        _REGISTRY.recordReplacement(
            attestation.refUID, attestation.uid, projectId, fromTimestamp, newToTimestamp,
            _computeEnergyWh(oldReadings), newEnergyWh, attestation.attester, metadataURI, newReadings
        );
    }

    // ──────────────────────────────────────────────
    //  Resolver Hooks (internal overrides)
    // ──────────────────────────────────────────────

    /// @notice EAS hook called on every new attestation. Validates the submission and writes to the registry.
    ///         If attestation.refUID is set, this is a replacement — the resolver fetches the old attestation
    ///         from EAS, validates the period is identical, and calls recordReplacement.
    ///         If refUID is zero, this is a normal sequential attestation — calls recordAttestation.
    ///         Returns true on success; reverts with a typed error on any validation failure.
    function onAttest(
        Attestation calldata attestation,
        uint256 /*value*/
    ) internal override returns (bool) {
        _requireNotPaused();

        (uint64 projectId, uint32 readingCount, uint32 readingIntervalMinutes, uint256[] memory readings, uint64 fromTimestamp, string memory method, string memory metadataURI) =
            abi.decode(attestation.data, (uint64, uint32, uint32, uint256[], uint64, string, string));
        if (!_REGISTRY.isProjectRegistered(projectId)) revert ProjectNotRegistered(projectId);
        uint64 watcherId = _REGISTRY.getProjectWatcherId(projectId);
        _requireAuthorizedAttester(projectId, watcherId, attestation.attester);
        _validateReport(readingCount, readingIntervalMinutes, readings, method);

        uint256 newEnergyWh = _computeEnergyWh(readings);
        uint64 newToTimestamp = _computeToTimestamp(fromTimestamp, readingCount, readingIntervalMinutes);
        if (newToTimestamp <= fromTimestamp) revert InvalidTimestamps();

        if (attestation.refUID != bytes32(0)) {
            _handleReplacement(attestation, projectId, fromTimestamp, newToTimestamp, newEnergyWh, metadataURI, readings);
        } else {
            _REGISTRY.recordAttestation(
                attestation.uid, projectId, fromTimestamp, newToTimestamp,
                newEnergyWh, attestation.attester, metadataURI, readings
            );
        }

        return true;
    }

    /// @notice EAS hook called on revocation attempts. Always reverts — direct revocations are
    ///         blocked to preserve the sequential attestation chain. Use the replacement mechanism
    ///         (submit a new attestation with refUID pointing to the old one) instead.
    function onRevoke(
        Attestation calldata attestation,
        uint256 /*value*/
    ) internal view override returns (bool) {
        if (_REGISTRY.getReplacementUID(attestation.uid) == bytes32(0)) {
            revert DirectRevocationBlocked();
        }
        return true;
    }

}
