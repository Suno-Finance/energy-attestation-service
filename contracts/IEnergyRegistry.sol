// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IEnergyRegistry
/// @notice Interface used by EnergyAttestationResolver to read state from and write to EnergyRegistry.
interface IEnergyRegistry {
    // ──────────────────────────────────────────────
    //  Write functions (called by authorized resolver only)
    // ──────────────────────────────────────────────

    /// @notice Record a validated energy attestation. Updates period locks and energy accumulators.
    ///         Accumulator direction is derived from the project's energyType:
    ///         energyType=0 (consumer) → consumed accumulator; any other → generated accumulator.
    ///         Reverts if the period is already attested or the start timestamp is already taken.
    function recordAttestation(
        bytes32 uid,
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 energyWh,
        address attester,
        string calldata metadataURI,
        uint256[] calldata readings
    ) external;

    /// @notice Always reverts with DirectRevocationBlocked. Direct EAS revocations are blocked
    ///         to preserve the sequential attestation chain. Use recordReplacement instead.
    function recordRevocation(
        bytes32 uid,
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 energyWh,
        address attester
    ) external;

    /// @notice Replace an existing attestation's energy data. The period (fromTimestamp, toTimestamp)
    ///         must be identical to the original. Atomically adjusts accumulators (subtract old, add new)
    ///         and updates period UID mappings. The old EAS attestation is not revoked — the registry
    ///         considers it superseded. Any currently-authorized attester can perform the replacement.
    function recordReplacement(
        bytes32 oldUid,
        bytes32 newUid,
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 oldEnergyWh,
        uint256 newEnergyWh,
        address attester,
        string calldata metadataURI
    ) external;

    // ──────────────────────────────────────────────
    //  Read functions (called during onAttest/onRevoke validation)
    // ──────────────────────────────────────────────

    function isProjectRegistered(uint64 projectId) external view returns (bool);
    function getProjectWatcherId(uint64 projectId) external view returns (uint64);

    /// @notice Returns 0 (generator) or 1 (consumer). Derived from energyType: non-zero = 0 (generator), zero = 1 (consumer).
    function getProjectType(uint64 projectId) external view returns (uint8);

    /// @notice Returns the project's stored energyType: 0 = consumer, 1–N = generator energy source.
    function getProjectEnergyType(uint64 projectId) external view returns (uint8);

    /// @notice Returns true if the wallet is on the per-project attester whitelist.
    function isProjectAttester(uint64 projectId, address attester) external view returns (bool);
    function isWatcherAttester(uint64 watcherId, address attester) external view returns (bool);

    /// @notice Returns the toTimestamp of the most recent attestation for a project, or 0 if none.
    function getProjectLastTimestamp(uint64 projectId) external view returns (uint64);

    /// @notice Returns the UID that occupies a period start, or bytes32(0) if free.
    function getAttestedPeriodStartUID(uint64 projectId, uint64 fromTimestamp) external view returns (bytes32);
}
