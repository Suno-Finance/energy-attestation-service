// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IEnergyRegistry } from "./IEnergyRegistry.sol";

/// @title EnergyRegistry
/// @notice Permanent state contract for the Energy Attestation Service.
///         Holds all watcher, project, attester, and energy data.
///         EnergyAttestationResolver contracts are authorized to write to it.
///         When a resolver is upgraded, this contract and all its data remain intact —
///         watchers simply update their schema UID to point to the new resolver.
contract EnergyRegistry is IEnergyRegistry, Ownable2Step {
    // ──────────────────────────────────────────────
    //  Types
    // ──────────────────────────────────────────────

    struct Watcher {
        address owner;
        bool registered;
        string name;
    }

    /// @notice Represents an individual energy project (a generation site or consumption point).
    ///         The energyType is set once at registration and cannot be changed.
    ///         energyType = 0 is the reserved consumer sentinel (no generation source).
    ///         energyType = 1–N means the project is a generator of that specific energy type.
    struct Project {
        uint64 watcherId;   // ID of the watcher that owns this project
        bool registered;    // False after deregisterProject(); prevents new attestations
        uint8 energyType;   // 0 = consumer; 1–N = generator (matches energy type registry ID)
        string name;        // Human-readable label (e.g. "Solar Farm Alpha")
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    // Authorized resolvers — multiple can be active simultaneously for migration periods
    mapping(address => bool) private _authorizedResolvers;

    // Watcher registry
    mapping(uint64 => Watcher) private _watchers;
    uint64 private _nextWatcherId;

    // Project registry
    mapping(uint64 => Project) private _projects;
    uint64 private _nextProjectId;

    // On-chain project list per watcher (append-only; callers filter deregistered via isProjectRegistered)
    mapping(uint64 => uint64[]) private _watcherProjects;

    // Per-project attester whitelist
    mapping(uint64 => mapping(address => bool)) private _projectAttesters;

    // Watcher-wide attester whitelist (authorized on all projects under the watcher)
    mapping(uint64 => mapping(address => bool)) private _watcherAttesters;

    // Energy accumulators — split by direction (0=generated, 1=consumed)
    mapping(uint64 => uint256) private _totalGeneratedWh;
    mapping(uint64 => uint256) private _totalConsumedWh;
    mapping(uint64 => uint256) private _totalGeneratedWhByWatcher;
    mapping(uint64 => uint256) private _totalConsumedWhByWatcher;

    // Duplicate period detection: [projectId][fromTimestamp][toTimestamp] => attestation UID
    // bytes32(0) means the period is free; non-zero means it has been attested
    mapping(uint64 => mapping(uint64 => mapping(uint64 => bytes32))) private _attestedPeriods;

    // Strict start-time uniqueness: [projectId][fromTimestamp] => attestation UID
    // This prevents multiple attestations that start at the same timestamp (even if durations differ).
    mapping(uint64 => mapping(uint64 => bytes32)) private _attestedPeriodStarts;

    // Sequential chain tip: toTimestamp of the most recent attestation per project.
    // 0 means no attestations yet (first attestation can start at any timestamp).
    mapping(uint64 => uint64) private _lastToTimestamp;

    // Replacement tracking: maps old (replaced) UIDs to new UIDs for audit trail.
    // bytes32(0) means the attestation has NOT been replaced.
    mapping(bytes32 => bytes32) private _replacedBy;

    // Project metadata URIs — point to JSON following the Energy Attestation Service metadata standard
    mapping(uint64 => string) private _projectMetadataURIs;

    // Energy type registry — dedicated admin registers and removes types; pre-populated in constructor
    mapping(uint8 => string) private _energyTypeNames;
    mapping(uint8 => bool)   private _energyTypeRegistered;

    // Energy type admin — separate from contract owner; can register and remove generation types
    address private _energyTypeAdmin;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    // All events are emitted here so they persist across resolver upgrades and
    // can be indexed from a single contract address regardless of which resolver version was used.

    event ResolverAuthorized(address indexed resolver);
    event ResolverDeauthorized(address indexed resolver);
    event WatcherRegistered(uint64 indexed watcherId, string name, address indexed owner);
    event WatcherOwnershipTransferred(uint64 indexed watcherId, address indexed previousOwner, address indexed newOwner);
    event AttesterAdded(uint64 indexed projectId, address indexed attester);
    event AttesterRemoved(uint64 indexed projectId, address indexed attester);
    event ProjectRegistered(uint64 indexed projectId, uint64 indexed watcherId, string name, uint8 energyType);
    event ProjectDeregistered(uint64 indexed projectId);
    event ProjectTransferred(uint64 indexed projectId, uint64 indexed fromWatcherId, uint64 indexed toWatcherId);
    event EnergyAttested(
        uint64 indexed projectId,
        bytes32 indexed uid,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 energyWh,
        address indexed attester,
        uint8 energyType,
        string metadataURI,
        uint256[] readings
    );
    event EnergyRevoked(
        uint64 indexed projectId,
        uint256 energyWh,
        address indexed attester,
        uint8 energyType
    );
    event EnergyReplaced(
        uint64 indexed projectId,
        bytes32 indexed oldUid,
        bytes32 newUid,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 oldEnergyWh,
        uint256 newEnergyWh,
        address indexed attester,
        string metadataURI
    );
    /// @notice Emitted whenever a project's metadata URI is set or updated.
    ///         Follows the EIP-4906 pattern so indexers can refresh cached metadata.
    event ProjectMetadataURISet(uint64 indexed projectId, string uri);
    /// @notice Emitted when a new energy type is registered by the energy type admin.
    event EnergyTypeRegistered(uint8 indexed id, string name);
    event EnergyTypeAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event EnergyTypeRemoved(uint8 indexed id, string name);
    event WatcherAttesterAdded(uint64 indexed watcherId, address indexed attester);
    event WatcherAttesterRemoved(uint64 indexed watcherId, address indexed attester);

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    error WatcherNotRegistered(uint64 watcherId);
    error UnauthorizedWatcherOwner(address caller, uint64 watcherId);
    error ProjectNotRegistered(uint64 projectId);
    error AttesterAlreadyAuthorized(address attester, uint64 projectId);
    error AttesterNotAuthorized(address attester, uint64 projectId);
    error EmptyAttesterArray();
    error UnauthorizedResolver(address caller);
    error PeriodAlreadyAttested(uint64 projectId, uint64 fromTimestamp, uint64 toTimestamp);
    error PeriodStartAlreadyAttested(uint64 projectId, uint64 fromTimestamp);
    error InvalidEnergyType(uint8 energyType);
    error UnauthorizedEnergyTypeAdmin(address caller);
    error EnergyTypeNotRegistered(uint8 id);
    error NonSequentialAttestation(uint64 projectId, uint64 expectedFrom, uint64 actualFrom);
    error DirectRevocationBlocked(uint64 projectId);
    error ReplacementPeriodMismatch(uint64 projectId, uint64 expectedFrom, uint64 actualFrom, uint64 expectedTo, uint64 actualTo);
    error AttestationNotFound(bytes32 uid);
    error AttestationAlreadyReplaced(bytes32 uid);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    modifier onlyAuthorizedResolver() {
        if (!_authorizedResolvers[msg.sender]) revert UnauthorizedResolver(msg.sender);
        _;
    }

    modifier onlyEnergyTypeAdmin() {
        if (msg.sender != _energyTypeAdmin) revert UnauthorizedEnergyTypeAdmin(msg.sender);
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    constructor() Ownable(msg.sender) {
        _nextWatcherId = 1;
        _nextProjectId = 1;
        _energyTypeAdmin = msg.sender;

        // Pre-register standard energy generation types.
        // The energy type admin can add new types via registerEnergyType() without redeployment.
        _registerEnergyType(1,  "solar_pv");
        _registerEnergyType(2,  "wind_onshore");
        _registerEnergyType(3,  "wind_offshore");
        _registerEnergyType(4,  "hydro");
        _registerEnergyType(5,  "biomass");
        _registerEnergyType(6,  "geothermal");
        _registerEnergyType(7,  "ocean_tidal");
        _registerEnergyType(8,  "nuclear");
        _registerEnergyType(9,  "natural_gas");
        _registerEnergyType(10, "coal");
        _registerEnergyType(11, "oil");
        _registerEnergyType(12, "storage_discharge");
        _registerEnergyType(13, "hydrogen_fuel_cell");
    }

    // ──────────────────────────────────────────────
    //  Internal: Access Control
    // ──────────────────────────────────────────────

    function _registerEnergyType(uint8 id, string memory name) private {
        _energyTypeNames[id] = name;
        _energyTypeRegistered[id] = true;
        emit EnergyTypeRegistered(id, name);
    }

    function _requireWatcherOwner(uint64 watcherId) private view {
        if (!_watchers[watcherId].registered) revert WatcherNotRegistered(watcherId);
        if (_watchers[watcherId].owner != msg.sender) revert UnauthorizedWatcherOwner(msg.sender, watcherId);
    }

    // ──────────────────────────────────────────────
    //  Resolver Authorization (contract owner only)
    // ──────────────────────────────────────────────

    /// @notice Authorize a resolver to write attestation data.
    ///         During a migration, both old and new resolvers can be authorized simultaneously.
    ///         Pause the old resolver via resolver.pause() to end the migration window.
    function authorizeResolver(address resolver) external onlyOwner {
        _authorizedResolvers[resolver] = true;
        emit ResolverAuthorized(resolver);
    }

    /// @notice Remove a resolver's write access. Call after migration is complete and the
    ///         old resolver has been paused and all watchers have migrated.
    function deauthorizeResolver(address resolver) external onlyOwner {
        _authorizedResolvers[resolver] = false;
        emit ResolverDeauthorized(resolver);
    }

    function isAuthorizedResolver(address resolver) external view returns (bool) {
        return _authorizedResolvers[resolver];
    }

    // ──────────────────────────────────────────────
    //  Energy Type Registry (dedicated energy type admin, separate from contract owner)
    // ──────────────────────────────────────────────

    /// @notice Register a new energy type. The id must not be already registered.
    ///         This allows adding novel energy generation methods on-chain
    ///         without redeploying contracts or creating a new schema.
    function registerEnergyType(uint8 id, string calldata name) external onlyEnergyTypeAdmin {
        _registerEnergyType(id, name);
    }

    /// @notice Remove an existing energy type. Only the energy type admin can call this.
    function removeEnergyType(uint8 id) external onlyEnergyTypeAdmin {
        if (!_energyTypeRegistered[id]) revert EnergyTypeNotRegistered(id);
        string memory name = _energyTypeNames[id];
        _energyTypeRegistered[id] = false;
        delete _energyTypeNames[id];
        emit EnergyTypeRemoved(id, name);
    }

    /// @notice Transfer energy type admin role to a new address.
    ///         Only the current energy type admin can call this.
    function transferEnergyTypeAdmin(address newAdmin) external onlyEnergyTypeAdmin {
        address previous = _energyTypeAdmin;
        _energyTypeAdmin = newAdmin;
        emit EnergyTypeAdminTransferred(previous, newAdmin);
    }

    function getEnergyTypeAdmin() external view returns (address) {
        return _energyTypeAdmin;
    }

    function getEnergyTypeName(uint8 id) external view returns (string memory) {
        return _energyTypeNames[id];
    }

    function isEnergyTypeRegistered(uint8 id) external view returns (bool) {
        return _energyTypeRegistered[id];
    }

    // ──────────────────────────────────────────────
    //  Watcher Management (permissionless)
    // ──────────────────────────────────────────────

    function registerWatcher(string calldata name) external returns (uint64 watcherId) {
        watcherId = _nextWatcherId;
        unchecked {
            ++_nextWatcherId;
        }
        _watchers[watcherId] = Watcher({ owner: msg.sender, registered: true, name: name });
        emit WatcherRegistered(watcherId, name, msg.sender);
    }

    function transferWatcherOwnership(uint64 watcherId, address newOwner) external {
        _requireWatcherOwner(watcherId);
        address previousOwner = _watchers[watcherId].owner;
        _watchers[watcherId].owner = newOwner;
        emit WatcherOwnershipTransferred(watcherId, previousOwner, newOwner);
    }

    // ──────────────────────────────────────────────
    //  Project Management (watcher owner only)
    // ──────────────────────────────────────────────

    /// @notice Register a new project under a watcher. Only the watcher owner can call this.
    /// @param watcherId  The watcher that will own this project.
    /// @param name       Human-readable project label.
    /// @param energyType The energy type for this project. Permanent — cannot be changed after registration.
    ///                   Use 0 for a consumer project (grid import, operational load, etc.).
    ///                   Use a registered generation type ID (1–13+ from the energy type registry) for a generator.
    ///                   This determines which accumulator attestations flow into:
    ///                   energyType=0 → consumed accumulator; any other → generated accumulator.
    function registerProject(uint64 watcherId, string calldata name, uint8 energyType) external returns (uint64 projectId) {
        _requireWatcherOwner(watcherId);
        if (energyType != 0 && !_energyTypeRegistered[energyType]) revert InvalidEnergyType(energyType);
        projectId = _nextProjectId;
        unchecked {
            ++_nextProjectId;
        }
        _projects[projectId] = Project({ watcherId: watcherId, registered: true, energyType: energyType, name: name });
        _watcherProjects[watcherId].push(projectId);
        emit ProjectRegistered(projectId, watcherId, name, energyType);
    }

    function deregisterProject(uint64 projectId) external {
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        _projects[projectId].registered = false;
        emit ProjectDeregistered(projectId);
    }

    /// @notice Transfer a project to a different watcher.
    ///         Can only be called by the current watcher owner.
    ///         Migrates accumulated energy totals from old watcher to new watcher.
    ///         Removes the project from the old watcher's project list and adds it to the new watcher's.
    function transferProject(uint64 projectId, uint64 toWatcherId) external {
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        uint64 fromWatcherId = _projects[projectId].watcherId;
        _requireWatcherOwner(fromWatcherId);
        if (!_watchers[toWatcherId].registered) revert WatcherNotRegistered(toWatcherId);

        // Migrate accumulated energy to the new watcher
        uint256 generated = _totalGeneratedWh[projectId];
        uint256 consumed  = _totalConsumedWh[projectId];
        if (generated > 0) {
            _totalGeneratedWhByWatcher[fromWatcherId] -= generated;
            _totalGeneratedWhByWatcher[toWatcherId]   += generated;
        }
        if (consumed > 0) {
            _totalConsumedWhByWatcher[fromWatcherId] -= consumed;
            _totalConsumedWhByWatcher[toWatcherId]   += consumed;
        }

        // Remove from old watcher's project list (swap-and-pop)
        uint64[] storage fromProjects = _watcherProjects[fromWatcherId];
        uint256 len = fromProjects.length;
        for (uint256 i = 0; i < len; ) {
            if (fromProjects[i] == projectId) {
                fromProjects[i] = fromProjects[len - 1];
                fromProjects.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }

        _projects[projectId].watcherId = toWatcherId;
        _watcherProjects[toWatcherId].push(projectId);
        emit ProjectTransferred(projectId, fromWatcherId, toWatcherId);
    }

    /// @notice Set or update the metadata URI for a project.
    ///         The URI must point to a JSON document following the EAS Energy Metadata Standard.
    ///         Can be called at any time by the watcher owner — use this to add certifications,
    ///         update descriptions, or link new documents without changing the contract.
    ///         Emits ProjectMetadataURISet so indexers know to refresh cached metadata.
    function setProjectMetadataURI(uint64 projectId, string calldata uri) external {
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        _projectMetadataURIs[projectId] = uri;
        emit ProjectMetadataURISet(projectId, uri);
    }

    // ──────────────────────────────────────────────
    //  Per-Project Attester Management (watcher owner only)
    // ──────────────────────────────────────────────

    function addAttester(uint64 projectId, address attester) external {
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        if (_projectAttesters[projectId][attester]) revert AttesterAlreadyAuthorized(attester, projectId);
        _projectAttesters[projectId][attester] = true;
        emit AttesterAdded(projectId, attester);
    }

    function removeAttester(uint64 projectId, address attester) external {
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        if (!_projectAttesters[projectId][attester]) revert AttesterNotAuthorized(attester, projectId);
        _projectAttesters[projectId][attester] = false;
        emit AttesterRemoved(projectId, attester);
    }

    function addAttesters(uint64 projectId, address[] calldata attesters) external {
        if (attesters.length == 0) revert EmptyAttesterArray();
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        for (uint256 i = 0; i < attesters.length; ) {
            if (_projectAttesters[projectId][attesters[i]]) revert AttesterAlreadyAuthorized(attesters[i], projectId);
            _projectAttesters[projectId][attesters[i]] = true;
            emit AttesterAdded(projectId, attesters[i]);
            unchecked {
                ++i;
            }
        }
    }

    function removeAttesters(uint64 projectId, address[] calldata attesters) external {
        if (attesters.length == 0) revert EmptyAttesterArray();
        if (!_projects[projectId].registered) revert ProjectNotRegistered(projectId);
        _requireWatcherOwner(_projects[projectId].watcherId);
        for (uint256 i = 0; i < attesters.length; ) {
            if (!_projectAttesters[projectId][attesters[i]]) revert AttesterNotAuthorized(attesters[i], projectId);
            _projectAttesters[projectId][attesters[i]] = false;
            emit AttesterRemoved(projectId, attesters[i]);
            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────────────────────────────
    //  Watcher-Wide Attester Management (watcher owner only)
    //  projectId = 0 used in events as sentinel for watcher-wide scope
    // ──────────────────────────────────────────────

    function addWatcherAttester(uint64 watcherId, address attester) external {
        _requireWatcherOwner(watcherId);
        if (_watcherAttesters[watcherId][attester]) revert AttesterAlreadyAuthorized(attester, 0);
        _watcherAttesters[watcherId][attester] = true;
        emit WatcherAttesterAdded(watcherId, attester);
    }

    function removeWatcherAttester(uint64 watcherId, address attester) external {
        _requireWatcherOwner(watcherId);
        if (!_watcherAttesters[watcherId][attester]) revert AttesterNotAuthorized(attester, 0);
        _watcherAttesters[watcherId][attester] = false;
        emit WatcherAttesterRemoved(watcherId, attester);
    }

    // ──────────────────────────────────────────────
    //  Write Functions (authorized resolver only)
    // ──────────────────────────────────────────────

    /// @notice Record an energy attestation. Called by the authorized resolver after validation.
    ///         Reverts if the period [fromTimestamp, toTimestamp] for this project is already attested.
    ///         Accumulator direction is derived from the project's energyType:
    ///         energyType=0 (consumer) → consumed accumulator; any other → generated accumulator.
    /// @notice Record a validated energy attestation. Enforces linear chain continuity (each attestation
    ///         must start at the previous attestation's toTimestamp), prevents period duplicates, and updates
    ///         accumulators. Accumulator direction (generated vs consumed) is derived from the project's energyType.
    /// @param uid The EAS attestation UID for this attestation (unique on-chain identifier).
    /// @param projectId The project this attestation is for.
    /// @param fromTimestamp Start of the reporting period (Unix seconds).
    /// @param toTimestamp End of the reporting period (Unix seconds). Must equal the previous attestation's
    ///                    toTimestamp if the project already has attestations (linear chain enforcement).
    /// @param energyWh Total energy for this period in watt-hours (uint256 to avoid floats). May be 0
    ///                 for maintenance/offline periods.
    /// @param attester The wallet that submitted this attestation.
    /// @param metadataURI Optional URI to off-chain JSON with proof/audit context; empty string if omitted.
    /// @dev Reverts with NonSequentialAttestation if the chain is broken (gap or overlap).
    ///      Reverts with PeriodAlreadyAttested if this exact period already has an active attestation.
    ///      Reverts with PeriodStartAlreadyAttested if another attestation already starts at fromTimestamp.
    function recordAttestation(
        bytes32 uid,
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 toTimestamp,
        uint256 energyWh,
        address attester,
        string calldata metadataURI,
        uint256[] calldata readings
    ) external onlyAuthorizedResolver {
        if (_attestedPeriods[projectId][fromTimestamp][toTimestamp] != bytes32(0)) {
            revert PeriodAlreadyAttested(projectId, fromTimestamp, toTimestamp);
        }
        if (_attestedPeriodStarts[projectId][fromTimestamp] != bytes32(0)) {
            revert PeriodStartAlreadyAttested(projectId, fromTimestamp);
        }

        // Linearity enforcement: if this project already has attestations,
        // the new one must start exactly where the last one ended.
        uint64 lastTo = _lastToTimestamp[projectId];
        if (lastTo != 0 && fromTimestamp != lastTo) {
            revert NonSequentialAttestation(projectId, lastTo, fromTimestamp);
        }

        _attestedPeriodStarts[projectId][fromTimestamp] = uid;
        _attestedPeriods[projectId][fromTimestamp][toTimestamp] = uid;
        _lastToTimestamp[projectId] = toTimestamp;

        uint64 watcherId = _projects[projectId].watcherId;
        uint8 energyType = _projects[projectId].energyType;

        if (energyType != 0) {
            _totalGeneratedWh[projectId] += energyWh;
            _totalGeneratedWhByWatcher[watcherId] += energyWh;
        } else {
            _totalConsumedWh[projectId] += energyWh;
            _totalConsumedWhByWatcher[watcherId] += energyWh;
        }

        emit EnergyAttested(projectId, uid, fromTimestamp, toTimestamp, energyWh, attester, energyType, metadataURI, readings);
    }

    /// @notice Always reverts. Direct EAS revocations are blocked to preserve the sequential
    ///         attestation chain. Use the replacement mechanism (attest with refUID) instead.
    function recordRevocation(
        bytes32 /*uid*/,
        uint64 projectId,
        uint64 /*fromTimestamp*/,
        uint64 /*toTimestamp*/,
        uint256 /*energyWh*/,
        address /*attester*/
    ) external view onlyAuthorizedResolver {
        revert DirectRevocationBlocked(projectId);
    }

    /// @notice Replace an existing attestation's energy data. The period (fromTimestamp, toTimestamp)
    ///         must be identical to the original — only readings, method, and metadataURI can change.
    ///         Atomically adjusts accumulators (subtract old, add new) and updates period UID mappings.
    ///         The old EAS attestation is not revoked at the EAS level — the registry considers it superseded,
    ///         but both attestations remain visible on EAS for a full audit trail.
    ///         Any currently-authorized attester can perform the replacement (not restricted to the original attester).
    /// @param oldUid The UID of the attestation being replaced (the one being corrected).
    /// @param newUid The UID of the corrected attestation (the new one with updated readings/method).
    /// @param projectId The project this attestation belongs to (must match the old attestation's project).
    /// @param fromTimestamp Start of the reporting period (must match the old attestation's fromTimestamp).
    /// @param toTimestamp End of the reporting period (must match the old attestation's derived toTimestamp).
    /// @param oldEnergyWh Total energy from the original attestation (used to subtract from accumulators).
    /// @param newEnergyWh Total energy from the corrected attestation (used to add to accumulators).
    /// @param attester The wallet submitting the replacement.
    /// @param metadataURI Optional URI to off-chain JSON with proof/audit context; empty string if omitted.
    /// @dev Reverts with AttestationAlreadyReplaced if oldUid was already replaced (cannot replace twice).
    ///      Reverts with AttestationNotFound if oldUid is not at the expected (projectId, fromTimestamp, toTimestamp) location.
    ///      Reverts with ProjectNotRegistered if the project is deregistered.
    ///      Chain tip (_lastToTimestamp) is NOT changed by replacement — it stays at the last attestation's toTimestamp.
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
    ) external onlyAuthorizedResolver {
        // Prevent replacing an already-replaced attestation (check first for clearer error)
        if (_replacedBy[oldUid] != bytes32(0)) {
            revert AttestationAlreadyReplaced(oldUid);
        }
        // Verify the old UID is actually recorded for this period
        if (_attestedPeriods[projectId][fromTimestamp][toTimestamp] != oldUid) {
            revert AttestationNotFound(oldUid);
        }

        // Update period mappings to point to the new UID
        _attestedPeriods[projectId][fromTimestamp][toTimestamp] = newUid;
        _attestedPeriodStarts[projectId][fromTimestamp] = newUid;

        // Track replacement for audit trail
        _replacedBy[oldUid] = newUid;

        // Atomically adjust accumulators
        uint64 watcherId = _projects[projectId].watcherId;
        uint8 energyType = _projects[projectId].energyType;

        if (energyType != 0) {
            _totalGeneratedWh[projectId] = _totalGeneratedWh[projectId] - oldEnergyWh + newEnergyWh;
            _totalGeneratedWhByWatcher[watcherId] = _totalGeneratedWhByWatcher[watcherId] - oldEnergyWh + newEnergyWh;
        } else {
            _totalConsumedWh[projectId] = _totalConsumedWh[projectId] - oldEnergyWh + newEnergyWh;
            _totalConsumedWhByWatcher[watcherId] = _totalConsumedWhByWatcher[watcherId] - oldEnergyWh + newEnergyWh;
        }

        emit EnergyReplaced(projectId, oldUid, newUid, fromTimestamp, toTimestamp, oldEnergyWh, newEnergyWh, attester, metadataURI);
    }

    // ──────────────────────────────────────────────
    //  Ownership
    // ──────────────────────────────────────────────

    function renounceOwnership() public pure override {
        revert("Renounce disabled");
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    function getWatcher(uint64 watcherId) external view returns (Watcher memory) {
        return _watchers[watcherId];
    }

    function isWatcherRegistered(uint64 watcherId) external view returns (bool) {
        return _watchers[watcherId].registered;
    }

    function getNextWatcherId() external view returns (uint64) {
        return _nextWatcherId;
    }

    function getProject(uint64 projectId) external view returns (Project memory) {
        return _projects[projectId];
    }

    function isProjectRegistered(uint64 projectId) external view returns (bool) {
        return _projects[projectId].registered;
    }

    function getProjectWatcherId(uint64 projectId) external view returns (uint64) {
        return _projects[projectId].watcherId;
    }

    /// @notice Returns 0 (generator) or 1 (consumer). Derived from energyType: non-zero = generator (0), zero = consumer (1).
    function getProjectType(uint64 projectId) external view returns (uint8) {
        return _projects[projectId].energyType == 0 ? 1 : 0;
    }

    /// @notice Returns the project's energy type as stored at registration.
    ///         0 = consumer; 1–N = generator with that energy source type ID.
    function getProjectEnergyType(uint64 projectId) external view returns (uint8) {
        return _projects[projectId].energyType;
    }

    function getNextProjectId() external view returns (uint64) {
        return _nextProjectId;
    }

    /// @notice Returns all project IDs registered under a watcher (including deregistered ones).
    ///         Filter results with isProjectRegistered() to get only active projects.
    ///         Works correctly across resolver upgrades since project registration is a direct
    ///         registry call unaffected by which resolver version is active.
    function getWatcherProjects(uint64 watcherId) external view returns (uint64[] memory) {
        return _watcherProjects[watcherId];
    }

    function isProjectAttester(uint64 projectId, address attester) external view returns (bool) {
        return _projectAttesters[projectId][attester];
    }

    function isWatcherAttester(uint64 watcherId, address attester) external view returns (bool) {
        return _watcherAttesters[watcherId][attester];
    }

    /// @notice Total watt-hours generated (projectType=0) for a project.
    function getTotalGeneratedEnergy(uint64 projectId) external view returns (uint256) {
        return _totalGeneratedWh[projectId];
    }

    /// @notice Total watt-hours consumed (projectType=1) for a project.
    function getTotalConsumedEnergy(uint64 projectId) external view returns (uint256) {
        return _totalConsumedWh[projectId];
    }

    /// @notice Total watt-hours generated across all projects under a watcher.
    function getTotalGeneratedEnergyByWatcher(uint64 watcherId) external view returns (uint256) {
        return _totalGeneratedWhByWatcher[watcherId];
    }

    /// @notice Total watt-hours consumed across all projects under a watcher.
    function getTotalConsumedEnergyByWatcher(uint64 watcherId) external view returns (uint256) {
        return _totalConsumedWhByWatcher[watcherId];
    }

    /// @notice Returns the metadata URI for a project, or empty string if none has been set.
    function getProjectMetadataURI(uint64 projectId) external view returns (string memory) {
        return _projectMetadataURIs[projectId];
    }

    /// @notice Returns the attestation UID that occupies a period, or bytes32(0) if free.
    function getAttestedPeriodUID(
        uint64 projectId,
        uint64 fromTimestamp,
        uint64 toTimestamp
    ) external view returns (bytes32) {
        return _attestedPeriods[projectId][fromTimestamp][toTimestamp];
    }

    /// @notice Returns the UID that occupies a period start, or bytes32(0) if the start is free.
    ///         This is useful for debugging why an attestation starting at fromTimestamp failed:
    ///         if this returns non-zero, the start timestamp is already taken for that project.
    function getAttestedPeriodStartUID(
        uint64 projectId,
        uint64 fromTimestamp
    ) external view returns (bytes32) {
        return _attestedPeriodStarts[projectId][fromTimestamp];
    }

    /// @notice Returns the toTimestamp of the most recent attestation for a project, or 0 if none.
    ///         Use this to determine the required fromTimestamp for the next sequential attestation.
    /// @notice Returns the toTimestamp of the most recent attestation for a project, or 0 if no attestations yet.
    ///         This is the "chain tip" — the next attestation must start exactly at this timestamp (linear chain enforcement).
    ///         Use this to determine where to submit the next attestation: the next fromTimestamp must equal this value.
    /// @param projectId The project to query.
    /// @return The toTimestamp of the last attestation in the chain, or 0 if the project has no attestations.
    function getProjectLastTimestamp(uint64 projectId) external view returns (uint64) {
        return _lastToTimestamp[projectId];
    }

    /// @notice Returns the UID that replaced a given attestation, allowing callers to follow the replacement chain.
    ///         This enables auditors to trace corrections: if attestation A was replaced with B, and B was replaced with C,
    ///         then getReplacementUID(A) = B and getReplacementUID(B) = C.
    /// @param uid The attestation UID to check.
    /// @return The UID of the replacement attestation, or bytes32(0) if this attestation has not been replaced
    ///         (i.e., the current attestation for that period).
    function getReplacementUID(bytes32 uid) external view returns (bytes32) {
        return _replacedBy[uid];
    }
}
