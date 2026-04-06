// v0.0.5
import { BigInt } from "@graphprotocol/graph-ts";
import {
  ResolverAuthorized,
  ResolverDeauthorized,
  EnergyTypeRegistered,
  EnergyTypeRemoved,
  EnergyTypeAdminTransferred,
  WatcherRegistered,
  WatcherOwnershipTransferred,
  ProjectRegistered,
  ProjectDeregistered,
  ProjectTransferred,
  ProjectMetadataURISet,
  AttesterAdded,
  AttesterRemoved,
  WatcherAttesterAdded,
  WatcherAttesterRemoved,
  EnergyAttested,
  EnergyReplaced,
} from "../generated/EnergyRegistry/EnergyRegistry";
import {
  Resolver,
  EnergyType,
  Watcher,
  WatcherOwnershipTransfer,
  Project,
  EnergyAttestation,
  ProjectAttester,
  WatcherAttester,
  DailyEnergySnapshot,
} from "../generated/schema";
import { loadOrCreateProtocol, timestampToDateString, dayStartTimestamp } from "./helpers";

// ─── Resolvers ────────────────────────────────────────

export function handleResolverAuthorized(event: ResolverAuthorized): void {
  let id = event.params.resolver.toHex();
  let resolver = Resolver.load(id);
  if (resolver == null) {
    resolver = new Resolver(id);
    resolver.authorizedAt = event.block.timestamp;
    resolver.authorizedAtBlock = event.block.number;
    resolver.deauthorizedAt = null;
    resolver.deauthorizedAtBlock = null;
  }
  resolver.authorized = true;
  resolver.save();
}

export function handleResolverDeauthorized(event: ResolverDeauthorized): void {
  let id = event.params.resolver.toHex();
  let resolver = Resolver.load(id);
  if (resolver == null) return;
  resolver.authorized = false;
  resolver.deauthorizedAt = event.block.timestamp;
  resolver.deauthorizedAtBlock = event.block.number;
  resolver.save();
}

// ─── Energy Types ─────────────────────────────────────

export function handleEnergyTypeRegistered(event: EnergyTypeRegistered): void {
  let id = event.params.id.toString();
  let energyType = EnergyType.load(id);
  if (energyType == null) {
    energyType = new EnergyType(id);
    energyType.totalGeneratedWh = BigInt.fromI32(0);
  }
  energyType.name = event.params.name;
  energyType.registered = true;
  energyType.save();
}

export function handleEnergyTypeRemoved(event: EnergyTypeRemoved): void {
  let energyType = EnergyType.load(event.params.id.toString());
  if (energyType == null) return;
  energyType.registered = false;
  energyType.save();
}

export function handleEnergyTypeAdminTransferred(event: EnergyTypeAdminTransferred): void {
  let protocol = loadOrCreateProtocol();
  protocol.energyTypeAdmin = event.params.newAdmin;
  protocol.save();
}

// ─── Watchers ─────────────────────────────────────────

export function handleWatcherRegistered(event: WatcherRegistered): void {
  let id = event.params.watcherId.toString();
  let watcher = new Watcher(id);
  watcher.name = event.params.name;
  watcher.owner = event.params.owner;
  watcher.registered = true;
  watcher.totalGeneratedWh = BigInt.fromI32(0);
  watcher.totalConsumedWh = BigInt.fromI32(0);
  watcher.projectCount = 0;
  watcher.createdAt = event.block.timestamp;
  watcher.createdAtBlock = event.block.number;
  watcher.save();

  let protocol = loadOrCreateProtocol();
  protocol.totalWatchers = protocol.totalWatchers + 1;
  protocol.save();
}

export function handleWatcherOwnershipTransferred(event: WatcherOwnershipTransferred): void {
  let watcherId = event.params.watcherId.toString();
  let watcher = Watcher.load(watcherId);
  if (watcher == null) return;
  watcher.owner = event.params.newOwner;
  watcher.save();

  let transferId = event.transaction.hash.toHex() + "-" + event.logIndex.toString();
  let transfer = new WatcherOwnershipTransfer(transferId);
  transfer.watcher = watcherId;
  transfer.previousOwner = event.params.previousOwner;
  transfer.newOwner = event.params.newOwner;
  transfer.timestamp = event.block.timestamp;
  transfer.blockNumber = event.block.number;
  transfer.txHash = event.transaction.hash;
  transfer.save();
}

// ─── Projects ─────────────────────────────────────────

export function handleProjectRegistered(event: ProjectRegistered): void {
  let projectId = event.params.projectId.toString();
  let watcherId = event.params.watcherId.toString();

  let project = new Project(projectId);
  project.watcher = watcherId;
  project.name = event.params.name;
  project.registered = true;
  project.totalGeneratedWh = BigInt.fromI32(0);
  project.totalConsumedWh = BigInt.fromI32(0);
  project.lastToTimestamp = BigInt.fromI32(0);
  project.metadataURI = null;
  project.attestationCount = 0;
  project.createdAt = event.block.timestamp;
  project.createdAtBlock = event.block.number;
  // energyType=0 means consumer (no generation source) — leave null
  project.energyType = event.params.energyType != 0
    ? event.params.energyType.toString()
    : null;
  project.save();

  let watcher = Watcher.load(watcherId);
  if (watcher != null) {
    watcher.projectCount = watcher.projectCount + 1;
    watcher.save();
  }

  let protocol = loadOrCreateProtocol();
  protocol.totalProjects = protocol.totalProjects + 1;
  protocol.save();
}

export function handleProjectDeregistered(event: ProjectDeregistered): void {
  let project = Project.load(event.params.projectId.toString());
  if (project == null) return;
  project.registered = false;
  project.save();
}

export function handleProjectTransferred(event: ProjectTransferred): void {
  let project = Project.load(event.params.projectId.toString());
  if (project == null) return;

  let fromWatcherId = event.params.fromWatcherId.toString();
  let toWatcherId = event.params.toWatcherId.toString();
  let fromWatcher = Watcher.load(fromWatcherId);
  let toWatcher = Watcher.load(toWatcherId);

  if (fromWatcher != null && toWatcher != null) {
    if (project.energyType != null) {
      fromWatcher.totalGeneratedWh = fromWatcher.totalGeneratedWh.minus(project.totalGeneratedWh);
      toWatcher.totalGeneratedWh = toWatcher.totalGeneratedWh.plus(project.totalGeneratedWh);
    } else {
      fromWatcher.totalConsumedWh = fromWatcher.totalConsumedWh.minus(project.totalConsumedWh);
      toWatcher.totalConsumedWh = toWatcher.totalConsumedWh.plus(project.totalConsumedWh);
    }
    fromWatcher.projectCount = fromWatcher.projectCount - 1;
    toWatcher.projectCount = toWatcher.projectCount + 1;
    fromWatcher.save();
    toWatcher.save();
  }

  project.watcher = toWatcherId;
  project.save();
}

export function handleProjectMetadataURISet(event: ProjectMetadataURISet): void {
  let project = Project.load(event.params.projectId.toString());
  if (project == null) return;
  project.metadataURI = event.params.uri;
  project.save();
}

// ─── Attesters ────────────────────────────────────────

export function handleAttesterAdded(event: AttesterAdded): void {
  // projectId=0 was the old sentinel for watcher-wide scope — now handled by WatcherAttesterAdded
  if (event.params.projectId.equals(BigInt.fromI32(0))) return;

  let id = event.params.projectId.toString() + "-" + event.params.attester.toHex();
  let attester = ProjectAttester.load(id);
  if (attester == null) {
    attester = new ProjectAttester(id);
    attester.project = event.params.projectId.toString();
    attester.attester = event.params.attester;
    attester.addedAt = event.block.timestamp;
    attester.addedAtBlock = event.block.number;
  }
  attester.active = true;
  attester.save();
}

export function handleAttesterRemoved(event: AttesterRemoved): void {
  if (event.params.projectId.equals(BigInt.fromI32(0))) return;

  let id = event.params.projectId.toString() + "-" + event.params.attester.toHex();
  let attester = ProjectAttester.load(id);
  if (attester == null) return;
  attester.active = false;
  attester.save();
}

export function handleWatcherAttesterAdded(event: WatcherAttesterAdded): void {
  let id = event.params.watcherId.toString() + "-" + event.params.attester.toHex();
  let attester = WatcherAttester.load(id);
  if (attester == null) {
    attester = new WatcherAttester(id);
    attester.watcher = event.params.watcherId.toString();
    attester.attester = event.params.attester;
    attester.addedAt = event.block.timestamp;
    attester.addedAtBlock = event.block.number;
  }
  attester.active = true;
  attester.save();
}

export function handleWatcherAttesterRemoved(event: WatcherAttesterRemoved): void {
  let id = event.params.watcherId.toString() + "-" + event.params.attester.toHex();
  let attester = WatcherAttester.load(id);
  if (attester == null) return;
  attester.active = false;
  attester.save();
}

// ─── Attestations ─────────────────────────────────────

export function handleEnergyAttested(event: EnergyAttested): void {
  let uid = event.params.uid.toHex();
  let projectId = event.params.projectId.toString();
  let isGenerator = event.params.energyType != 0;

  // Create attestation entity
  let attestation = new EnergyAttestation(uid);
  attestation.project = projectId;
  attestation.fromTimestamp = event.params.fromTimestamp;
  attestation.toTimestamp = event.params.toTimestamp;
  attestation.energyWh = event.params.energyWh;
  attestation.attester = event.params.attester;
  attestation.metadataURI = event.params.metadataURI.length > 0 ? event.params.metadataURI : null;
  attestation.readings = event.params.readings;
  attestation.replaced = false;
  attestation.replacedBy = null;
  attestation.replaces = null;
  attestation.energyType = isGenerator ? event.params.energyType.toString() : null;
  attestation.blockTimestamp = event.block.timestamp;
  attestation.blockNumber = event.block.number;
  attestation.txHash = event.transaction.hash;
  attestation.save();

  // Update project
  let project = Project.load(projectId);
  if (project == null) return;
  project.attestationCount = project.attestationCount + 1;
  project.lastToTimestamp = event.params.toTimestamp;
  if (isGenerator) {
    project.totalGeneratedWh = project.totalGeneratedWh.plus(event.params.energyWh);
  } else {
    project.totalConsumedWh = project.totalConsumedWh.plus(event.params.energyWh);
  }
  project.save();

  // Update watcher
  let watcher = Watcher.load(project.watcher);
  if (watcher != null) {
    if (isGenerator) {
      watcher.totalGeneratedWh = watcher.totalGeneratedWh.plus(event.params.energyWh);
    } else {
      watcher.totalConsumedWh = watcher.totalConsumedWh.plus(event.params.energyWh);
    }
    watcher.save();
  }

  // Update energy type accumulator
  if (isGenerator) {
    let energyType = EnergyType.load(event.params.energyType.toString());
    if (energyType != null) {
      energyType.totalGeneratedWh = energyType.totalGeneratedWh.plus(event.params.energyWh);
      energyType.save();
    }
  }

  // Update protocol
  let protocol = loadOrCreateProtocol();
  protocol.totalAttestations = protocol.totalAttestations + 1;
  if (isGenerator) {
    protocol.totalGeneratedWh = protocol.totalGeneratedWh.plus(event.params.energyWh);
  } else {
    protocol.totalConsumedWh = protocol.totalConsumedWh.plus(event.params.energyWh);
  }
  protocol.save();

  // Distribute energy across daily snapshots using actual readings when available
  distributeDailyEnergy(projectId, event.params.fromTimestamp, event.params.toTimestamp, event.params.energyWh, event.params.readings, isGenerator, true, true);
}

export function handleEnergyReplaced(event: EnergyReplaced): void {
  let oldUid = event.params.oldUid.toHex();
  let newUid = event.params.newUid.toHex();
  let projectId = event.params.projectId.toString();

  // Mark old attestation as replaced and link to new one
  let oldAttestation = EnergyAttestation.load(oldUid);
  if (oldAttestation != null) {
    oldAttestation.replaced = true;
    oldAttestation.replacedBy = newUid;
    oldAttestation.save();
  }

  // Create new attestation entity for the replacement
  let newAttestation = new EnergyAttestation(newUid);
  newAttestation.project = projectId;
  newAttestation.fromTimestamp = event.params.fromTimestamp;
  newAttestation.toTimestamp = event.params.toTimestamp;
  newAttestation.energyWh = event.params.newEnergyWh;
  newAttestation.attester = event.params.attester;
  newAttestation.metadataURI = event.params.metadataURI.length > 0 ? event.params.metadataURI : null;
  newAttestation.replaced = false;
  newAttestation.replacedBy = null;
  newAttestation.replaces = oldUid;
  newAttestation.readings = [];
  newAttestation.energyType = oldAttestation != null ? oldAttestation.energyType : null;
  newAttestation.blockTimestamp = event.block.timestamp;
  newAttestation.blockNumber = event.block.number;
  newAttestation.txHash = event.transaction.hash;
  newAttestation.save();

  // Adjust accumulators using the delta between old and new energy
  let delta = event.params.newEnergyWh.minus(event.params.oldEnergyWh);
  let isGenerator = newAttestation.energyType != null;

  let project = Project.load(projectId);
  if (project == null) return;
  if (isGenerator) {
    project.totalGeneratedWh = project.totalGeneratedWh.plus(delta);
  } else {
    project.totalConsumedWh = project.totalConsumedWh.plus(delta);
  }
  project.save();

  let watcher = Watcher.load(project.watcher);
  if (watcher != null) {
    if (isGenerator) {
      watcher.totalGeneratedWh = watcher.totalGeneratedWh.plus(delta);
    } else {
      watcher.totalConsumedWh = watcher.totalConsumedWh.plus(delta);
    }
    watcher.save();
  }

  if (isGenerator && newAttestation.energyType != null) {
    let energyType = EnergyType.load(newAttestation.energyType!);
    if (energyType != null) {
      energyType.totalGeneratedWh = energyType.totalGeneratedWh.plus(delta);
      energyType.save();
    }
  }

  let protocol = loadOrCreateProtocol();
  if (isGenerator) {
    protocol.totalGeneratedWh = protocol.totalGeneratedWh.plus(delta);
  } else {
    protocol.totalConsumedWh = protocol.totalConsumedWh.plus(delta);
  }
  protocol.save();

  // Undo old energy distribution using stored readings, then apply new one uniformly
  // (new readings are not emitted in EnergyReplaced — fall back to uniform distribution)
  if (oldAttestation != null) {
    distributeDailyEnergy(projectId, oldAttestation.fromTimestamp, oldAttestation.toTimestamp, event.params.oldEnergyWh, oldAttestation.readings, isGenerator, false, false);
  }
  distributeDailyEnergy(projectId, event.params.fromTimestamp, event.params.toTimestamp, event.params.newEnergyWh, [], isGenerator, true, false);
}

// ─── Daily snapshot helper ────────────────────────────

// Distributes energy across daily snapshots.
// If readings[] is non-empty, uses actual per-interval readings (accurate daily values).
// If readings[] is empty, falls back to uniform distribution across days.
// add=true accumulates, add=false subtracts (used when undoing a replaced attestation).
// incrementCount=true bumps attestationCount once per day (only for new attestations).
function distributeDailyEnergy(
  projectId: string,
  fromTimestamp: BigInt,
  toTimestamp: BigInt,
  energyWh: BigInt,
  readings: Array<BigInt>,
  isGenerator: boolean,
  add: boolean,
  incrementCount: boolean
): void {
  if (readings.length > 0) {
    // Use actual readings: derive each reading's timestamp and accumulate into its day
    let numReadings = BigInt.fromI32(readings.length);
    let interval    = toTimestamp.minus(fromTimestamp).div(numReadings);
    let countedDays: Array<string> = [];

    for (let i = 0; i < readings.length; i++) {
      let readingTimestamp = fromTimestamp.plus(BigInt.fromI32(i).times(interval));
      let date             = timestampToDateString(readingTimestamp);
      let snapshotId       = projectId + "-" + date;
      let snapshot         = DailyEnergySnapshot.load(snapshotId);

      if (snapshot == null) {
        snapshot = new DailyEnergySnapshot(snapshotId);
        snapshot.project          = projectId;
        snapshot.date             = date;
        snapshot.timestamp        = dayStartTimestamp(readingTimestamp);
        snapshot.generatedWh      = BigInt.fromI32(0);
        snapshot.consumedWh       = BigInt.fromI32(0);
        snapshot.attestationCount = 0;
      }

      let readingValue = readings[i];

      if (add) {
        if (isGenerator) {
          snapshot.generatedWh = snapshot.generatedWh.plus(readingValue);
        } else {
          snapshot.consumedWh = snapshot.consumedWh.plus(readingValue);
        }
        // Increment attestationCount only once per day per attestation
        if (incrementCount && !countedDays.includes(date)) {
          snapshot.attestationCount = snapshot.attestationCount + 1;
          countedDays.push(date);
        }
      } else {
        if (isGenerator) {
          snapshot.generatedWh = snapshot.generatedWh.minus(readingValue);
        } else {
          snapshot.consumedWh = snapshot.consumedWh.minus(readingValue);
        }
      }

      snapshot.save();
    }
  } else {
    // Fallback: distribute energyWh uniformly across each day in [fromTimestamp, toTimestamp]
    let DAY_SECONDS  = BigInt.fromI32(86400);
    let fromDay      = dayStartTimestamp(fromTimestamp);
    let toDay        = dayStartTimestamp(toTimestamp);
    let numDays      = toDay.minus(fromDay).div(DAY_SECONDS).plus(BigInt.fromI32(1));
    let energyPerDay = energyWh.div(numDays);
    let remainder    = energyWh.mod(numDays);

    let currentDay = fromDay;
    let dayIndex   = BigInt.fromI32(0);

    while (!currentDay.gt(toDay)) {
      let date       = timestampToDateString(currentDay);
      let snapshotId = projectId + "-" + date;
      let snapshot   = DailyEnergySnapshot.load(snapshotId);

      if (snapshot == null) {
        snapshot = new DailyEnergySnapshot(snapshotId);
        snapshot.project          = projectId;
        snapshot.date             = date;
        snapshot.timestamp        = currentDay;
        snapshot.generatedWh      = BigInt.fromI32(0);
        snapshot.consumedWh       = BigInt.fromI32(0);
        snapshot.attestationCount = 0;
      }

      // Remainder goes to the last day to preserve total energy exactly
      let isLastDay    = dayIndex.equals(numDays.minus(BigInt.fromI32(1)));
      let energyForDay = isLastDay ? energyPerDay.plus(remainder) : energyPerDay;

      if (add) {
        if (isGenerator) {
          snapshot.generatedWh = snapshot.generatedWh.plus(energyForDay);
        } else {
          snapshot.consumedWh = snapshot.consumedWh.plus(energyForDay);
        }
        if (incrementCount) {
          snapshot.attestationCount = snapshot.attestationCount + 1;
        }
      } else {
        if (isGenerator) {
          snapshot.generatedWh = snapshot.generatedWh.minus(energyForDay);
        } else {
          snapshot.consumedWh = snapshot.consumedWh.minus(energyForDay);
        }
      }

      snapshot.save();

      currentDay = currentDay.plus(DAY_SECONDS);
      dayIndex   = dayIndex.plus(BigInt.fromI32(1));
    }
  }
}
