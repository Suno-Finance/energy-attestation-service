import { describe, it } from "mocha";
import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import { ZeroAddress, ZeroHash, AbiCoder } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network.js";
import type { EnergyAttestationResolver, EnergyRegistry, EAS, SchemaRegistry } from "../typechain-types/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types.js";

const SCHEMA =
  "uint64 projectId, uint32 readingCount, uint32 readingIntervalMinutes, uint256[] readings, uint64 fromTimestamp, string method, string metadataURI";
const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

function computeToTimestamp(fromTimestamp: number, readingCount: number, readingIntervalMinutes: number): number {
  return fromTimestamp + readingCount * readingIntervalMinutes * 60;
}

function encodeAttestationData(
  projectId: number,
  fromTimestamp: number,
  readings: bigint[],
  readingIntervalMinutes: number = 1,
  method: string,
  metadataURI: string = ""
): string {
  const readingCount = readings.length;
  return AbiCoder.defaultAbiCoder().encode(
    ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
    [projectId, readingCount, readingIntervalMinutes, readings, fromTimestamp, method, metadataURI]
  );
}

async function deployFixture(connection: NetworkConnection) {
  const { ethers } = connection;
  const [owner, attester, other, watcherOwner] = await ethers.getSigners();

  // Deploy EAS infrastructure
  const SchemaRegistryFactory = await ethers.getContractFactory("SchemaRegistry");
  const schemaRegistry = (await SchemaRegistryFactory.deploy()) as unknown as SchemaRegistry;
  await schemaRegistry.waitForDeployment();

  const EASFactory = await ethers.getContractFactory("EAS");
  const eas = (await EASFactory.deploy(await schemaRegistry.getAddress())) as unknown as EAS;
  await eas.waitForDeployment();

  // Deploy Registry (permanent state contract)
  const RegistryFactory = await ethers.getContractFactory("EnergyRegistry");
  const registry = (await RegistryFactory.deploy()) as unknown as EnergyRegistry;
  await registry.waitForDeployment();

  // Deploy Resolver (logic contract — points to registry)
  const ResolverFactory = await ethers.getContractFactory("EnergyAttestationResolver");
  const resolver = (await ResolverFactory.deploy(
    await eas.getAddress(),
    await registry.getAddress()
  )) as unknown as EnergyAttestationResolver;
  await resolver.waitForDeployment();

  // Authorize resolver in registry
  await registry.authorizeResolver(await resolver.getAddress());

  // Register schema with resolver
  const schemaUID = await schemaRegistry.register.staticCall(
    SCHEMA,
    await resolver.getAddress(),
    true // revocable
  );
  await schemaRegistry.register(SCHEMA, await resolver.getAddress(), true);

  // Watcher owner self-registers, creates a project, whitelists the attester
  // Note: all management calls go directly to registry, not through resolver
  await registry.connect(watcherOwner).registerWatcher("Green Energy Co");
  const watcherId = 1n;
  await registry.connect(watcherOwner).registerProject(watcherId, "Solar Farm Alpha", 1);
  const projectId = 1;
  await registry.connect(watcherOwner).addAttester(projectId, attester.address);

  return { owner, attester, other, watcherOwner, schemaRegistry, eas, resolver, registry, schemaUID, projectId, watcherId };
}

async function attestEnergy(
  eas: EAS,
  schemaUID: string,
  attester: HardhatEthersSigner,
  projectId: number,
  fromTimestamp: number,
  // Back-compat with old tests:
  // - Old: (from, to, energyWh, method?, _ignored_energyType?, metadataURI?)
  // - New: (from, readings[], method?, metadataURI?, readingIntervalMinutes?)
  toTimestampOrReadings: number | bigint[],
  energyWhOrMethod?: bigint | string,
  methodOrIgnored: string | number = "manual",
  ignoredOrMetadataURI: number | string = "",
  metadataURIOrInterval: string | number = "",
  maybeIntervalMinutes: number = 1
): Promise<string> {
  let readings: bigint[];
  let readingIntervalMinutes: number;
  let method: string;
  let metadataURI: string;

  if (Array.isArray(toTimestampOrReadings)) {
    readings = toTimestampOrReadings;
    method = (typeof energyWhOrMethod === "string" ? energyWhOrMethod : "manual") as string;
    // skip ignored energyType arg (methodOrIgnored)
    metadataURI = typeof ignoredOrMetadataURI === "string" ? ignoredOrMetadataURI : "";
    readingIntervalMinutes = typeof metadataURIOrInterval === "number" ? metadataURIOrInterval : maybeIntervalMinutes;
  } else {
    const energyWh = energyWhOrMethod as bigint;
    readings = [energyWh];
    method = methodOrIgnored as string;
    // ignoredOrMetadataURI is the old energyType — skip it
    metadataURI = typeof metadataURIOrInterval === "string" ? metadataURIOrInterval : "";
    readingIntervalMinutes = 1;
  }

  const data = encodeAttestationData(projectId, fromTimestamp, readings, readingIntervalMinutes, method, metadataURI);
  const tx = await eas.connect(attester).attest({
    schema: schemaUID,
    data: {
      recipient: ZeroAddress,
      expirationTime: NO_EXPIRATION,
      revocable: true,
      refUID: ZERO_BYTES32,
      data,
      value: 0n,
    },
  });
  const receipt = await tx.wait();
  const attestedEvent = receipt!.logs.find(
    (log) => {
      try {
        return eas.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "Attested";
      } catch { return false; }
    }
  );
  const parsed = eas.interface.parseLog({
    topics: attestedEvent!.topics as string[],
    data: attestedEvent!.data,
  });
  return parsed!.args[2]; // uid
}

async function replaceAttestation(
  eas: EAS,
  schemaUID: string,
  attester: HardhatEthersSigner,
  oldUid: string,
  projectId: number,
  fromTimestamp: number,
  readings: bigint[],
  readingIntervalMinutes: number = 1,
  method: string = "manual",
  metadataURI: string = ""
): Promise<string> {
  const data = encodeAttestationData(projectId, fromTimestamp, readings, readingIntervalMinutes, method, metadataURI);
  const tx = await eas.connect(attester).attest({
    schema: schemaUID,
    data: {
      recipient: ZeroAddress,
      expirationTime: NO_EXPIRATION,
      revocable: true,
      refUID: oldUid,
      data,
      value: 0n,
    },
  });
  const receipt = await tx.wait();
  const attestedEvent = receipt!.logs.find(
    (log) => {
      try {
        return eas.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "Attested";
      } catch { return false; }
    }
  );
  const parsed = eas.interface.parseLog({
    topics: attestedEvent!.topics as string[],
    data: attestedEvent!.data,
  });
  return parsed!.args[2]; // uid
}

describe("EnergyAttestationResolver", function () {
  // ─── Deployment ───────────────────────────────────────

  describe("Deployment", function () {
    it("Should set the correct EAS address", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, eas } = await networkHelpers.loadFixture(deployFixture);
      expect(await resolver.getAddress()).to.be.a("string");
      expect(await eas.getAddress()).to.be.a("string");
    });

    it("Should set the deployer as owner of both contracts", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, registry, owner } = await networkHelpers.loadFixture(deployFixture);
      expect(await resolver.owner()).to.equal(owner.address);
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("Should return false for isPayable", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      expect(await resolver.isPayable()).to.equal(false);
    });

    it("Should start with nextProjectId = 1 and nextWatcherId = 1", async function () {
      const { ethers } = await hre.network.connect();
      const RegistryFactory = await ethers.getContractFactory("EnergyRegistry");
      const registry = await RegistryFactory.deploy();
      expect(await registry.getNextProjectId()).to.equal(1);
      expect(await registry.getNextWatcherId()).to.equal(1);
    });

    it("Should expose registry address on resolver", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, registry } = await networkHelpers.loadFixture(deployFixture);
      expect(await resolver.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  // ─── Resolver Authorization ──────────────────────────

  describe("Resolver Authorization", function () {
    it("Should authorize a resolver", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, resolver } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isAuthorizedResolver(await resolver.getAddress())).to.equal(true);
    });

    it("Should emit ResolverAuthorized event", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await expect(registry.authorizeResolver(signers[5].address))
        .to.emit(registry, "ResolverAuthorized")
        .withArgs(signers[5].address);
    });

    it("Should deauthorize a resolver", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, resolver } = await networkHelpers.loadFixture(deployFixture);
      await registry.deauthorizeResolver(await resolver.getAddress());
      expect(await registry.isAuthorizedResolver(await resolver.getAddress())).to.equal(false);
    });

    it("Should revert recordAttestation from unauthorized caller", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        registry.connect(other).recordAttestation(ZeroHash, 1n, 1000n, 2000n, 500n, other.address, "", [])
      ).to.be.revertedWithCustomError(registry, "UnauthorizedResolver");
    });

    it("Should revert recordRevocation from unauthorized caller", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        registry.connect(other).recordRevocation(ZeroHash, 1n, 1000n, 2000n, 500n, other.address)
      ).to.be.revertedWithCustomError(registry, "UnauthorizedResolver");
    });

    it("Should allow two resolvers to be authorized simultaneously", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, eas } = await networkHelpers.loadFixture(deployFixture);
      // Deploy a second resolver pointing to the same registry
      const ResolverFactory = await ethers.getContractFactory("EnergyAttestationResolver");
      const resolver2 = await ResolverFactory.deploy(await eas.getAddress(), await registry.getAddress());
      await registry.authorizeResolver(await resolver2.getAddress());
      expect(await registry.isAuthorizedResolver(await resolver2.getAddress())).to.equal(true);
    });
  });

  // ─── Watcher Registration ──────────────────────────────

  describe("Watcher Registration", function () {
    it("Should allow anyone to register a watcher (permissionless)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(other).registerWatcher("Other Co");
    });

    it("Should emit WatcherRegistered event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      // watcherId=1 used in fixture; next is 2
      await expect(registry.connect(other).registerWatcher("Other Co"))
        .to.emit(registry, "WatcherRegistered")
        .withArgs(2, "Other Co", other.address);
    });

    it("Should increment getNextWatcherId", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getNextWatcherId()).to.equal(2); // 1 used in fixture
      await registry.registerWatcher("Second Co");
      expect(await registry.getNextWatcherId()).to.equal(3);
    });

    it("Should return correct watcher data via getWatcher", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const watcher = await registry.getWatcher(watcherId);
      expect(watcher.registered).to.equal(true);
      expect(watcher.name).to.equal("Green Energy Co");
      expect(watcher.owner).to.equal(watcherOwner.address);
    });
  });

  // ─── Watcher Ownership Transfer ──────────────────────

  describe("Watcher Ownership Transfer", function () {
    it("Should allow watcher owner to transfer ownership", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).transferWatcherOwnership(watcherId, other.address);
      const watcher = await registry.getWatcher(watcherId);
      expect(watcher.owner).to.equal(other.address);
    });

    it("Should emit WatcherOwnershipTransferred event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).transferWatcherOwnership(watcherId, other.address))
        .to.emit(registry, "WatcherOwnershipTransferred")
        .withArgs(watcherId, watcherOwner.address, other.address);
    });

    it("Should allow new owner to manage the watcher after transfer", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).transferWatcherOwnership(watcherId, other.address);
      await registry.connect(other).registerProject(watcherId, "New Project", 1);
    });

    it("Should revert if non-watcher-owner tries to transfer", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).transferWatcherOwnership(watcherId, other.address))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner")
        .withArgs(other.address, watcherId);
    });
  });

  // ─── Attester Management ──────────────────────────────

  describe("Attester Management", function () {
    it("Should add an attester to a project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).addAttester(projectId, other.address);
      expect(await registry.isProjectAttester(projectId, other.address)).to.equal(true);
    });

    it("Should emit AttesterAdded event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).addAttester(projectId, other.address))
        .to.emit(registry, "AttesterAdded")
        .withArgs(projectId, other.address);
    });

    it("Should remove an attester from a project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).removeAttester(projectId, attester.address);
      expect(await registry.isProjectAttester(projectId, attester.address)).to.equal(false);
    });

    it("Should emit AttesterRemoved event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).removeAttester(projectId, attester.address))
        .to.emit(registry, "AttesterRemoved")
        .withArgs(projectId, attester.address);
    });

    it("Should revert when adding an already authorized attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).addAttester(projectId, attester.address))
        .to.be.revertedWithCustomError(registry, "AttesterAlreadyAuthorized")
        .withArgs(attester.address, projectId);
    });

    it("Should revert when removing a non-authorized attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).removeAttester(projectId, other.address))
        .to.be.revertedWithCustomError(registry, "AttesterNotAuthorized")
        .withArgs(other.address, projectId);
    });

    it("Should revert when non-watcher-owner adds attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).addAttester(projectId, other.address))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });

    it("Should revert when non-watcher-owner removes attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, attester, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).removeAttester(projectId, attester.address))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });
  });

  // ─── Project Management ───────────────────────────────

  describe("Project Management", function () {
    it("Should register a project with sequential IDs", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Wind Turbine Beta", 1);
      expect(await registry.getNextProjectId()).to.equal(3);
      const project = await registry.getProject(2);
      expect(project.registered).to.equal(true);
      expect(project.name).to.equal("Wind Turbine Beta");
    });

    it("Should emit ProjectRegistered event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Wind Turbine Beta", 1))
        .to.emit(registry, "ProjectRegistered")
        .withArgs(2, watcherId, "Wind Turbine Beta", 1);
    });

    it("Should deregister a project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).deregisterProject(projectId);
      expect(await registry.isProjectRegistered(projectId)).to.equal(false);
    });

    it("Should emit ProjectDeregistered event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).deregisterProject(projectId))
        .to.emit(registry, "ProjectDeregistered")
        .withArgs(projectId);
    });

    it("Should revert deregistering a non-registered project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.deregisterProject(99))
        .to.be.revertedWithCustomError(registry, "ProjectNotRegistered")
        .withArgs(99);
    });

    it("Should revert when non-watcher-owner registers project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).registerProject(watcherId, "Unauthorized", 1))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });

    it("Should revert when non-watcher-owner deregisters project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).deregisterProject(projectId))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });

    it("Should revert when registering project for unregistered watcher", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(99n, "Ghost Project", 1))
        .to.be.revertedWithCustomError(registry, "WatcherNotRegistered")
        .withArgs(99);
    });
  });

  // ─── Project Transfer ─────────────────────────────────

  describe("Project Transfer", function () {
    it("Should transfer a project to another watcher", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];
      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      const toWatcherId = 2n;

      await registry.connect(watcherOwner).transferProject(projectId, toWatcherId);

      expect(await registry.getProjectWatcherId(projectId)).to.equal(toWatcherId);
    });

    it("Should emit ProjectTransferred event", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");
      const toWatcherId = 2n;

      await expect(registry.connect(watcherOwner).transferProject(projectId, toWatcherId))
        .to.emit(registry, "ProjectTransferred")
        .withArgs(projectId, watcherId, toWatcherId);
    });

    it("Should migrate accumulated energy to the new watcher", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, projectId, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");
      const toWatcherId = 2n;

      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(5000n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(toWatcherId)).to.equal(0n);

      await registry.connect(watcherOwner).transferProject(projectId, toWatcherId);

      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(0n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(toWatcherId)).to.equal(5000n);
      // Project-level total unchanged
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(5000n);
    });

    it("Should migrate consumed energy to the new watcher for consumer project", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");
      const toWatcherId = 2n;

      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 3000n, "manual", 0);

      await registry.connect(watcherOwner).transferProject(2, toWatcherId);

      expect(await registry.getTotalConsumedEnergyByWatcher(watcherId)).to.equal(0n);
      expect(await registry.getTotalConsumedEnergyByWatcher(toWatcherId)).to.equal(3000n);
    });

    it("Should allow new watcher owner to manage the project after transfer", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];
      await registry.connect(watcherBOwner).registerWatcher("Watcher B");

      await registry.connect(watcherOwner).transferProject(projectId, 2n);

      // New owner can add an attester
      await registry.connect(watcherBOwner).addAttester(projectId, signers[5].address);
      expect(await registry.isProjectAttester(projectId, signers[5].address)).to.equal(true);
    });

    it("Should appear in getWatcherProjects for the new watcher and not the old", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");

      await registry.connect(watcherOwner).transferProject(projectId, 2n);

      const newProjects = await registry.getWatcherProjects(2n);
      expect(newProjects).to.include(BigInt(projectId));

      const oldProjects = await registry.getWatcherProjects(1n);
      expect(oldProjects).to.not.include(BigInt(projectId));
    });

    it("Should revert when non-watcher-owner calls transferProject", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");

      await expect(registry.connect(other).transferProject(projectId, 2n))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });

    it("Should revert when transferring to an unregistered watcher", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);

      await expect(registry.connect(watcherOwner).transferProject(projectId, 99n))
        .to.be.revertedWithCustomError(registry, "WatcherNotRegistered")
        .withArgs(99);
    });

    it("Should revert when transferring a deregistered project", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");
      await registry.connect(watcherOwner).deregisterProject(projectId);

      await expect(registry.connect(watcherOwner).transferProject(projectId, 2n))
        .to.be.revertedWithCustomError(registry, "ProjectNotRegistered");
    });

    it("Should transfer project with zero accumulated energy (no accumulator underflow)", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      await registry.connect(signers[4]).registerWatcher("Watcher B");

      // Should not revert even with zero energy
      await registry.connect(watcherOwner).transferProject(projectId, 2n);
      expect(await registry.getProjectWatcherId(projectId)).to.equal(2n);
    });
  });

  // ─── onAttest (happy path) ────────────────────────────

  describe("onAttest — Happy Path", function () {
    it("Should accept a valid attestation and update energy total", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const energyWh = 5000n;
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, energyWh);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(energyWh);
    });

    it("Should emit EnergyAttested event (from registry)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const fromTimestamp = 1000;
      const readings = [5000n];
      const toTimestamp = computeToTimestamp(fromTimestamp, readings.length, 1);
      const data = encodeAttestationData(projectId, fromTimestamp, readings, 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      )
        .to.emit(registry, "EnergyAttested")
        .withArgs(projectId, anyValue, fromTimestamp, toTimestamp, 5000n, attester.address, 1, "", anyValue);
    });

    it("Should derive toTimestamp correctly for multi-reading attestations", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);

      const fromTimestamp = 1000;
      const readings = [1n, 2n, 3n]; // readingCount=3
      const readingIntervalMinutes = 10; // 600 seconds each
      const expectedToTimestamp = fromTimestamp + readings.length * readingIntervalMinutes * 60;
      const expectedEnergyWh = 6n;

      const data = encodeAttestationData(projectId, fromTimestamp, readings, readingIntervalMinutes, "iot");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      )
        .to.emit(registry, "EnergyAttested")
        .withArgs(projectId, anyValue, fromTimestamp, expectedToTimestamp, expectedEnergyWh, attester.address, 1, "", anyValue);
    });

    it("Should accumulate energy across multiple attestations", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 3000n);
      await attestEnergy(eas, schemaUID, attester, projectId, 1060, 3000, 7000n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(10000n);
    });

    it("Should accept attestation with different methods", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 1000n, "iot");
      await attestEnergy(eas, schemaUID, attester, projectId, 1060, 3000, 2000n, "estimated");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(3000n);
    });
  });

  // ─── onAttest (rejections) ────────────────────────────

  describe("onAttest — Rejections", function () {
    it("Should revert for unauthorized attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 1000, [5000n], 1, "manual");
      await expect(
        eas.connect(other).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
    });

    it("Should allow zero-total energy (all readings are 0)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 1000, [0n], 1, "manual");
      await eas.connect(attester).attest({
        schema: schemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data,
          value: 0n,
        },
      });
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(0n);
    });

    it("Should revert for readingCount = 0", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 1000, [], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "InvalidReadingCount");
    });

    it("Should revert for readingIntervalMinutes = 0", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 1000, [5000n], 0, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "InvalidReadingInterval");
    });

    it("Should revert if readingCount does not match readings.length", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const malformed = AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
        [projectId, 2, 1, [5000n], 1000, "manual", ""]
      );
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: malformed,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "InvalidReadingsLength");
    });

    it("Should revert for unregistered project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(99, 1000, [5000n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "ProjectNotRegistered");
    });

    it("Should revert for deregistered project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, attester, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).deregisterProject(projectId);
      const data = encodeAttestationData(projectId, 1000, [5000n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "ProjectNotRegistered");
    });
  });

  // ─── onRevoke ─────────────────────────────────────────

  describe("onRevoke", function () {
    it("Should revert on direct revocation", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });

    it("Should revert revocation with DirectRevocationBlocked", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });

    it("Should revert revocation even on deregistered projects", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, attester, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      await registry.connect(watcherOwner).deregisterProject(projectId);
      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });
  });

  // ─── Ownership (Ownable2Step) ─────────────────────────

  describe("Ownership", function () {
    it("Should support two-step ownership transfer on resolver", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, owner, other } = await networkHelpers.loadFixture(deployFixture);
      await resolver.transferOwnership(other.address);
      expect(await resolver.owner()).to.equal(owner.address);
      await resolver.connect(other).acceptOwnership();
      expect(await resolver.owner()).to.equal(other.address);
    });

    it("Should revert if non-pending owner tries to accept", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(resolver.connect(other).acceptOwnership())
        .to.be.revertedWithCustomError(resolver, "OwnableUnauthorizedAccount");
    });
  });

  // ─── Batch Attestation ────────────────────────────────

  describe("Batch Attestation", function () {
    it("Should process multiple attestations via multiAttest", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data1 = encodeAttestationData(projectId, 1000, [1000n], 1, "iot");
      const data2 = encodeAttestationData(projectId, 1060, [2000n], 1, "iot");
      const data3 = encodeAttestationData(projectId, 1120, [3000n], 1, "iot");

      await eas.connect(attester).multiAttest([
        {
          schema: schemaUID,
          data: [
            { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data1, value: 0n },
            { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data2, value: 0n },
            { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data3, value: 0n },
          ],
        },
      ]);

      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(6000n);
    });
  });

  // ─── View Functions ───────────────────────────────────

  describe("View Functions", function () {
    it("Should return correct project data", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, projectId, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const project = await registry.getProject(projectId);
      expect(project.registered).to.equal(true);
      expect(project.name).to.equal("Solar Farm Alpha");
      expect(project.watcherId).to.equal(watcherId);
    });

    it("Should return false for non-existent project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isProjectRegistered(99)).to.equal(false);
    });

    it("Should return zero energy for project with no attestations", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, projectId } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(0n);
    });
  });

  // ─── Multi-Project Isolation ──────────────────────────

  describe("Multi-Project Isolation", function () {
    it("Should track energy separately per project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Wind Farm Beta", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 4000n);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 9000n);

      expect(await registry.getTotalGeneratedEnergy(1)).to.equal(4000n);
      expect(await registry.getTotalGeneratedEnergy(2)).to.equal(9000n);
    });

    it("Should not affect project 1 energy when replacing attestation from project 2", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Wind Farm Beta", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 4000n);
      const uid = await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 9000n);

      // Replace project 2's attestation with different energy
      await replaceAttestation(eas, schemaUID, attester, uid, 2, 1000, [5000n], 1, "manual");

      expect(await registry.getTotalGeneratedEnergy(1)).to.equal(4000n); // unchanged
      expect(await registry.getTotalGeneratedEnergy(2)).to.equal(5000n); // updated
    });
  });

  // ─── Attester Revocation Mid-Session ──────────────────

  describe("Attester Revocation Mid-Session", function () {
    it("Should block attestation after attester is removed", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, attester, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      await registry.connect(watcherOwner).removeAttester(projectId, attester.address);
      const data = encodeAttestationData(projectId, 1060, [5000n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(5000n);
    });
  });

  // ─── Energy Underflow Protection ─────────────────────

  describe("Energy Underflow Protection", function () {
    it("Should revert on direct revocation (underflow scenario no longer possible)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });
  });

  // ─── Correction Flow (refUID) ─────────────────────────

  describe("Correction Flow (refUID)", function () {
    it("Should accept a corrective attestation via replacement (refUID)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const originalUid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);

      // Replace with corrected value
      const newUid = await replaceAttestation(eas, schemaUID, attester, originalUid, projectId, 1000, [750n], 1, "manual");

      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(750n);
      expect(await registry.getReplacementUID(originalUid)).to.equal(newUid);
    });
  });

  // ─── Batch Edge Cases ─────────────────────────────────

  describe("Batch Edge Cases", function () {
    it("Should revert the entire batch if one item has an invalid attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      const validData = encodeAttestationData(projectId, 1000, [1000n], 1, "iot");
      const invalidData = encodeAttestationData(projectId, 2000, [2000n], 1, "iot");

      await expect(
        eas.connect(other).multiAttest([
          {
            schema: schemaUID,
            data: [
              { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: validData, value: 0n },
              { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: invalidData, value: 0n },
            ],
          },
        ])
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");

      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(0n);
    });

    it("Should accept batch where one item has zero total energy", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data1 = encodeAttestationData(projectId, 1000, [1000n], 1, "iot");
      const data2 = encodeAttestationData(projectId, 1060, [0n], 1, "iot");

      await eas.connect(attester).multiAttest([
        {
          schema: schemaUID,
          data: [
            { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data1, value: 0n },
            { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data2, value: 0n },
          ],
        },
      ]);

      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(1000n);
    });
  });

  // ─── Pausable ───────────────────────────────────────────

  describe("Pausable", function () {
    it("Should start unpaused", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      expect(await resolver.paused()).to.equal(false);
    });

    it("Should allow owner to pause", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      await resolver.pause();
      expect(await resolver.paused()).to.equal(true);
    });

    it("Should allow owner to unpause", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      await resolver.pause();
      await resolver.unpause();
      expect(await resolver.paused()).to.equal(false);
    });

    it("Should revert attestation when paused", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await resolver.pause();
      const data = encodeAttestationData(projectId, 1000, [5000n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "EnforcedPause");
    });

    it("Should revert revocation even when paused", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);
      await resolver.pause();
      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });

    it("Should revert when non-owner pauses", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(resolver.connect(other).pause())
        .to.be.revertedWithCustomError(resolver, "OwnableUnauthorizedAccount");
    });
  });

  // ─── Batch Attester Management ──────────────────────────

  describe("Batch Attester Management", function () {
    it("Should add multiple attesters in one call", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const addr1 = signers[4].address;
      const addr2 = signers[5].address;
      await registry.connect(watcherOwner).addAttesters(projectId, [addr1, addr2]);
      expect(await registry.isProjectAttester(projectId, addr1)).to.equal(true);
      expect(await registry.isProjectAttester(projectId, addr2)).to.equal(true);
    });

    it("Should remove multiple attesters in one call", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const addr1 = signers[4].address;
      const addr2 = signers[5].address;
      await registry.connect(watcherOwner).addAttesters(projectId, [addr1, addr2]);
      await registry.connect(watcherOwner).removeAttesters(projectId, [addr1, addr2]);
      expect(await registry.isProjectAttester(projectId, addr1)).to.equal(false);
      expect(await registry.isProjectAttester(projectId, addr2)).to.equal(false);
    });

    it("Should revert batch add if any already authorized", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).addAttesters(projectId, [other.address, attester.address]))
        .to.be.revertedWithCustomError(registry, "AttesterAlreadyAuthorized")
        .withArgs(attester.address, projectId);
    });

    it("Should revert batch remove if any not authorized", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).removeAttesters(projectId, [attester.address, other.address]))
        .to.be.revertedWithCustomError(registry, "AttesterNotAuthorized")
        .withArgs(other.address, projectId);
    });

    it("Should revert batch add with empty array", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).addAttesters(projectId, []))
        .to.be.revertedWithCustomError(registry, "EmptyAttesterArray");
    });

    it("Should revert batch remove with empty array", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).removeAttesters(projectId, []))
        .to.be.revertedWithCustomError(registry, "EmptyAttesterArray");
    });
  });

  // ─── Method Validation ──────────────────────────────────

  describe("Method Validation", function () {
    it("Should revert attestation with empty method string", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 1000, [5000n], 1, "");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "InvalidMethod");
    });

    it("Should accept attestation with short valid method", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 1000n, "m");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(1000n);
    });
  });

  // ─── Boundary Values ───────────────────────────────────

  describe("Boundary Values", function () {
    it("Should accept minimum valid attestation (1 Wh, 1-minute interval)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 0, 1, 1n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(1n);
    });

    it("Should accept large energy value (2^128 Wh)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const largeEnergy = 2n ** 128n;
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, largeEnergy);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(largeEnergy);
    });

    it("Should accept max uint64 fromTimestamp if derived toTimestamp stays in-range", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const maxUint64 = 2n ** 64n - 1n;
      const fromTimestamp = maxUint64 - 60n; // +60 seconds (1 minute) stays <= max
      const data = AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
        [projectId, 1, 1, [500n], fromTimestamp, "manual", ""]
      );
      const tx = await eas.connect(attester).attest({
        schema: schemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data,
          value: 0n,
        },
      });
      await tx.wait();
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);
    });

    it("Should revert with TimestampOverflow if derived toTimestamp exceeds uint64.max", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);

      const maxUint64 = 2n ** 64n - 1n;
      const fromTimestamp = maxUint64 - 30n; // adding >= 60 seconds will overflow
      const data = AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
        [projectId, 1, 1, [1n], fromTimestamp, "manual", ""]
      );

      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data,
            value: 0n,
          },
        })
      ).to.be.revertedWithCustomError(resolver, "TimestampOverflow");
    });

    it("Should allow re-adding a removed attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).removeAttester(projectId, attester.address);
      expect(await registry.isProjectAttester(projectId, attester.address)).to.equal(false);
      await registry.connect(watcherOwner).addAttester(projectId, attester.address);
      expect(await registry.isProjectAttester(projectId, attester.address)).to.equal(true);
    });
  });

  // ─── Lifecycle & Access Control ─────────────────────────

  describe("Lifecycle & Access Control", function () {
    it("Should issue new projectId, not re-register deregistered one", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).deregisterProject(projectId);
      await registry.connect(watcherOwner).registerProject(watcherId, "New Project", 1);
      expect(await registry.isProjectRegistered(projectId)).to.equal(false);
      expect(await registry.isProjectRegistered(2)).to.equal(true);
      expect(await registry.getNextProjectId()).to.equal(3);
    });

    it("Should revert batch multiRevoke (revocation blocked)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid1 = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 1000n);

      await expect(
        eas.connect(attester).multiRevoke([
          { schema: schemaUID, data: [{ uid: uid1, value: 0n }] },
        ])
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });

    it("Should revert on renounceOwnership (resolver)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { resolver } = await networkHelpers.loadFixture(deployFixture);
      await expect(resolver.renounceOwnership()).to.be.revertedWith("Renounce disabled");
    });

    it("Should revert on renounceOwnership (registry)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.renounceOwnership()).to.be.revertedWith("Renounce disabled");
    });
  });

  // ─── Tenant Isolation ──────────────────────────────────

  describe("Tenant Isolation", function () {
    it("Should prevent Watcher A attester from attesting to Watcher B project", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];

      const registry2 = (await networkHelpers.loadFixture(deployFixture)).registry;
      await registry2.connect(watcherBOwner).registerWatcher("Watcher B");
      await registry2.connect(watcherBOwner).registerProject(2n, "Project B", 1);

      const data = encodeAttestationData(2, 1000, [5000n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
    });

    it("Should prevent Watcher A owner from registering project under Watcher B", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];

      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      await expect(registry.connect(watcherOwner).registerProject(2n, "Stolen Project", 1))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner")
        .withArgs(watcherOwner.address, 2n);
    });

    it("Should prevent Watcher A owner from adding attester to Watcher B project", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, other } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];

      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      await registry.connect(watcherBOwner).registerProject(2n, "Project B", 1);
      await expect(registry.connect(watcherOwner).addAttester(2n, other.address))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner");
    });
  });

  // ─── Watcher-Wide Attesters ────────────────────────────

  describe("Watcher-Wide Attesters", function () {
    it("Should allow watcher-wide attester to attest to any project under the watcher", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);

      await attestEnergy(eas, schemaUID, other, 1, 1000, 2000, 100n);
      await attestEnergy(eas, schemaUID, other, 2, 1000, 2000, 200n);

      expect(await registry.getTotalGeneratedEnergy(1)).to.equal(100n);
      expect(await registry.getTotalGeneratedEnergy(2)).to.equal(200n);
    });

    it("Should remove watcher-wide attester access", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);
      await registry.connect(watcherOwner).removeWatcherAttester(watcherId, other.address);

      const data = encodeAttestationData(1, 1000, [100n], 1, "manual");
      await expect(
        eas.connect(other).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
    });

    it("Should prevent watcher-wide attester from attesting to a different watcher project", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];

      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      await registry.connect(watcherBOwner).registerProject(2n, "Project B", 1);
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);

      const data = encodeAttestationData(2, 1000, [100n], 1, "manual");
      await expect(
        eas.connect(other).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
    });

    it("Should return correct isWatcherAttester result", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isWatcherAttester(watcherId, other.address)).to.equal(false);
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);
      expect(await registry.isWatcherAttester(watcherId, other.address)).to.equal(true);
    });

    it("Should emit WatcherAttesterAdded event with correct watcherId and attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address))
        .to.emit(registry, "WatcherAttesterAdded")
        .withArgs(watcherId, other.address);
    });

    it("Should emit WatcherAttesterRemoved event with correct watcherId and attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, other } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);
      await expect(registry.connect(watcherOwner).removeWatcherAttester(watcherId, other.address))
        .to.emit(registry, "WatcherAttesterRemoved")
        .withArgs(watcherId, other.address);
    });
  });

  // ─── Watcher Energy Accumulator ──────────────────────

  describe("Watcher Energy Accumulator", function () {
    it("Should start at zero", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherId } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(0n);
    });

    it("Should accumulate energy across multiple projects", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 3000n);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 7000n);

      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(10000n);
    });

    it("Should adjust watcher accumulator on replacement", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 5000n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(5000n);

      await replaceAttestation(eas, schemaUID, attester, uid, 1, 1000, [2000n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(2000n);
    });

    it("Should isolate totals between companies", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];
      const watcherBAttester = signers[5];

      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      await registry.connect(watcherBOwner).registerProject(2n, "Project B", 1);
      await registry.connect(watcherBOwner).addAttester(2, watcherBAttester.address);

      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 4000n);
      await attestEnergy(eas, schemaUID, watcherBAttester, 2, 1000, 2000, 9000n);

      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(4000n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(2n)).to.equal(9000n);
    });
  });

  // ─── getWatcherProjects ────────────────────────────────

  describe("getWatcherProjects", function () {
    it("Should return empty array for watcher with no projects", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(other).registerWatcher("Empty Co");
      const projects = await registry.getWatcherProjects(2n);
      expect(projects.length).to.equal(0);
    });

    it("Should return all project IDs for a watcher", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 3", 1);

      const projects = await registry.getWatcherProjects(watcherId);
      expect(projects.length).to.equal(3); // project 1 from fixture + 2 new
      expect(projects[0]).to.equal(1n);
      expect(projects[1]).to.equal(2n);
      expect(projects[2]).to.equal(3n);
    });

    it("Should include deregistered projects in the list", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).deregisterProject(projectId);

      const projects = await registry.getWatcherProjects(watcherId);
      expect(projects.length).to.equal(1);
      expect(projects[0]).to.equal(BigInt(projectId));
      // Caller must filter using isProjectRegistered
      expect(await registry.isProjectRegistered(projectId)).to.equal(false);
    });

    it("Should not mix projects between companies", async function () {
      const { ethers, networkHelpers } = await hre.network.connect();
      const { registry, watcherId } = await networkHelpers.loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const watcherBOwner = signers[4];

      await registry.connect(watcherBOwner).registerWatcher("Watcher B");
      await registry.connect(watcherBOwner).registerProject(2n, "B Project", 1);

      const projectsA = await registry.getWatcherProjects(watcherId);
      const projectsB = await registry.getWatcherProjects(2n);

      expect(projectsA.length).to.equal(1);
      expect(projectsA[0]).to.equal(1n);
      expect(projectsB.length).to.equal(1);
      expect(projectsB[0]).to.equal(2n);
    });
  });

  // ─── Duplicate Period Detection ────────────────────────

  describe("Duplicate Period Detection", function () {
    it("Should revert PeriodAlreadyAttested for same project/from/to", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      const fromTimestamp = 1000;
      const readings = [300n];
      const toTimestamp = computeToTimestamp(fromTimestamp, readings.length, 1);
      const data = encodeAttestationData(projectId, fromTimestamp, readings, 1, "iot");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      )
        .to.be.revertedWithCustomError(registry, "PeriodAlreadyAttested")
        .withArgs(projectId, fromTimestamp, toTimestamp);
    });

    it("Should revert PeriodAlreadyAttested if same fromTimestamp but different interval produces same derived toTimestamp", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);

      // First: 1 reading × 120 minutes => +7200 seconds
      const data1 = encodeAttestationData(projectId, 1000, [10n], 120, "manual");
      await eas.connect(attester).attest({
        schema: schemaUID,
        data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data1, value: 0n },
      });

      // Second: 2 readings × 60 minutes => also +7200 seconds (same derived toTimestamp)
      const data2 = encodeAttestationData(projectId, 1000, [1n, 2n], 60, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data2, value: 0n },
        })
      )
        .to.be.revertedWithCustomError(registry, "PeriodAlreadyAttested")
        .withArgs(projectId, 1000, 8200);
    });

    it("Should allow same period for different projects (cross-project isolation)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      // Same period [1000, 2000] for both projects — must succeed
      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 500n);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 700n);

      expect(await registry.getTotalGeneratedEnergy(1)).to.equal(500n);
      expect(await registry.getTotalGeneratedEnergy(2)).to.equal(700n);
    });

    it("Should allow different periods for the same project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      await attestEnergy(eas, schemaUID, attester, projectId, 1060, 3000, 600n);

      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(1100n);
    });

    it("Should revert if another attestation uses the same fromTimestamp (even with different duration)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);

      // First: 1 reading, 1440 min => one-day report starting at 1000
      const dayData = encodeAttestationData(projectId, 1000, [100n], 1440, "manual");
      await eas.connect(attester).attest({
        schema: schemaUID,
        data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: dayData, value: 0n },
      });

      // Second: 23 readings, 60 min => different duration but same start
      const hourlyReadings = Array.from({ length: 23 }, () => 1n);
      const hourData = encodeAttestationData(projectId, 1000, hourlyReadings, 60, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: hourData, value: 0n },
        })
      )
        .to.be.revertedWithCustomError(registry, "PeriodStartAlreadyAttested")
        .withArgs(projectId, 1000);
    });

    it("Should allow replacement of a period via refUID", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      const toTimestamp = computeToTimestamp(1000, 1, 1);

      // Replace — period UID updated
      const newUid = await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [750n], 1, "manual");
      expect(await registry.getAttestedPeriodUID(projectId, 1000, toTimestamp)).to.equal(newUid);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(750n);
    });

    it("Should record attestation UID in getAttestedPeriodUID", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      const toTimestamp = computeToTimestamp(1000, 1, 1);

      expect(await registry.getAttestedPeriodUID(projectId, 1000, toTimestamp)).to.equal(uid);
    });
  });

  // ─── Energy Type Registry ──────────────────────────────

  describe("Energy Type Registry", function () {
    it("Should have pre-registered generation types at deployment (e.g. solar_pv=1, hydrogen_fuel_cell=13)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isEnergyTypeRegistered(1)).to.equal(true);
      expect(await registry.getEnergyTypeName(1)).to.equal("solar_pv");
      expect(await registry.isEnergyTypeRegistered(13)).to.equal(true);
      expect(await registry.getEnergyTypeName(13)).to.equal("hydrogen_fuel_cell");
      expect(await registry.isEnergyTypeRegistered(14)).to.equal(false);
    });

    it("Should return false for unregistered type id", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.isEnergyTypeRegistered(99)).to.equal(false);
      expect(await registry.getEnergyTypeName(99)).to.equal("");
    });

    it("Should allow owner to register a new type and emit EnergyTypeRegistered", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.registerEnergyType(50, "fusion"))
        .to.emit(registry, "EnergyTypeRegistered")
        .withArgs(50, "fusion");
      expect(await registry.isEnergyTypeRegistered(50)).to.equal(true);
      expect(await registry.getEnergyTypeName(50)).to.equal("fusion");
    });

    it("Should revert when non-owner registers a type", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).registerEnergyType(50, "fusion"))
        .to.be.revertedWithCustomError(registry, "UnauthorizedEnergyTypeAdmin");
    });

    it("Should allow energy type admin to remove a type and emit EnergyTypeRemoved", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.removeEnergyType(1))
        .to.emit(registry, "EnergyTypeRemoved")
        .withArgs(1, "solar_pv");
      expect(await registry.isEnergyTypeRegistered(1)).to.equal(false);
    });

    it("Should revert removeEnergyType for non-admin caller", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).removeEnergyType(1))
        .to.be.revertedWithCustomError(registry, "UnauthorizedEnergyTypeAdmin");
    });

    it("Should revert removeEnergyType for unregistered type", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.removeEnergyType(99))
        .to.be.revertedWithCustomError(registry, "EnergyTypeNotRegistered")
        .withArgs(99);
    });

    it("Should allow energy type admin to transfer the admin role", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, owner, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.transferEnergyTypeAdmin(other.address))
        .to.emit(registry, "EnergyTypeAdminTransferred")
        .withArgs(owner.address, other.address);
      expect(await registry.getEnergyTypeAdmin()).to.equal(other.address);
    });

    it("Should revert transferEnergyTypeAdmin from non-admin", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).transferEnergyTypeAdmin(other.address))
        .to.be.revertedWithCustomError(registry, "UnauthorizedEnergyTypeAdmin");
    });

    it("Should set deployer as energyTypeAdmin at deployment", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, owner } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getEnergyTypeAdmin()).to.equal(owner.address);
    });

    it("Removed type rejects registerProject", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      // Remove type 1 (solar_pv)
      await registry.removeEnergyType(1);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Solar Gen", 1))
        .to.be.revertedWithCustomError(registry, "InvalidEnergyType")
        .withArgs(1);
    });

    it("Should revert registerProject with unregistered energyType", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Unknown Gen", 99))
        .to.be.revertedWithCustomError(registry, "InvalidEnergyType")
        .withArgs(99);
    });
  });

  // ─── Project Type ──────────────────────────────────────

  describe("Project Type", function () {
    it("Generator project increments getTotalGeneratedEnergy only", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // Fixture project is type 0 (generator)
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);
      expect(await registry.getTotalConsumedEnergy(projectId)).to.equal(0n);
    });

    it("Consumer project increments getTotalConsumedEnergy only", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre Alpha", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 300n, "manual", 0);
      expect(await registry.getTotalConsumedEnergy(2)).to.equal(300n);
      expect(await registry.getTotalGeneratedEnergy(2)).to.equal(0n);
    });

    it("Replacement of generator project adjusts generated accumulator; consumer project unchanged", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre Beta", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      const genUid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      await attestEnergy(eas, schemaUID, attester, 2, 2000, 3000, 300n, "manual", 0);
      await replaceAttestation(eas, schemaUID, attester, genUid, projectId, 1000, [200n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(200n);
      expect(await registry.getTotalConsumedEnergy(2)).to.equal(300n); // unchanged
    });

    it("Replacement of consumer project adjusts consumed accumulator; generator project unchanged", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre Gamma", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      const conUid = await attestEnergy(eas, schemaUID, attester, 2, 2000, 3000, 300n, "manual", 0);
      await replaceAttestation(eas, schemaUID, attester, conUid, 2, 2000, [100n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n); // unchanged
      expect(await registry.getTotalConsumedEnergy(2)).to.equal(100n);
    });

    it("registerProject with unregistered energyType reverts InvalidEnergyType", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Bad Project", 99))
        .to.be.revertedWithCustomError(registry, "InvalidEnergyType")
        .withArgs(99);
    });

    it("registerProject with energyType=0 succeeds (consumer sentinel)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Consumer Co", 0);
      expect(await registry.isProjectRegistered(2)).to.equal(true);
    });

    it("registerProject with energyType=1 succeeds (solar_pv generator)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Solar Gen", 1);
      expect(await registry.isProjectRegistered(2)).to.equal(true);
    });

    it("registerProject with energyType=1 after removeEnergyType(1) reverts InvalidEnergyType", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.removeEnergyType(1);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Solar Gen", 1))
        .to.be.revertedWithCustomError(registry, "InvalidEnergyType")
        .withArgs(1);
    });

    it("getProjectType returns 0 for generator project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, projectId } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getProjectType(projectId)).to.equal(0);
    });

    it("getProjectType returns 1 for consumer project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Consumer Project", 0);
      expect(await registry.getProjectType(2)).to.equal(1);
    });

    it("getProjectEnergyType returns stored energyType for generator project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, projectId } = await networkHelpers.loadFixture(deployFixture);
      // Fixture project registered with energyType=1 (solar_pv)
      expect(await registry.getProjectEnergyType(projectId)).to.equal(1);
    });

    it("getProjectEnergyType returns 0 for consumer project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Consumer Project", 0);
      expect(await registry.getProjectEnergyType(2)).to.equal(0);
    });

    it("ProjectRegistered event includes energyType", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Solar Farm", 1))
        .to.emit(registry, "ProjectRegistered")
        .withArgs(2, watcherId, "Solar Farm", 1);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Grid Draw", 0))
        .to.emit(registry, "ProjectRegistered")
        .withArgs(3, watcherId, "Grid Draw", 0);
    });

    it("registerProject rejects unregistered energyType with InvalidEnergyType", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).registerProject(watcherId, "Unknown Gen", 99))
        .to.be.revertedWithCustomError(registry, "InvalidEnergyType")
        .withArgs(99);
    });

    it("Consumer project (energyType=0) accepts attestations normally", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 500n, "manual", 0);
      expect(await registry.getTotalConsumedEnergy(2)).to.equal(500n);
    });
  });

  // ─── Generated/Consumed Accumulator Isolation ─────────

  describe("Generated/Consumed Accumulator Isolation", function () {
    it("Generator and consumer project totals are independent", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 400n); // generator
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 200n, "manual", 0); // consumer
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(400n);
      expect(await registry.getTotalConsumedEnergy(2)).to.equal(200n);
    });

    it("Watcher-level generated vs consumed totals are independent", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Data Centre", 0);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 600n); // generator
      await attestEnergy(eas, schemaUID, attester, 2, 2000, 3000, 100n, "manual", 0); // consumer
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(600n);
      expect(await registry.getTotalConsumedEnergyByWatcher(watcherId)).to.equal(100n);
    });

    it("Generation totals from two generator projects sum in watcher accumulator", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);
      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 300n);
      await attestEnergy(eas, schemaUID, attester, 2, 1000, 2000, 700n);
      expect(await registry.getTotalGeneratedEnergyByWatcher(watcherId)).to.equal(1000n);
    });
  });

  describe("Project Metadata URI", function () {
    it("Should return empty string when no URI has been set", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, projectId } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getProjectMetadataURI(projectId)).to.equal("");
    });

    it("Should allow watcher owner to set a metadata URI", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri = "ipfs://QmSolarFarmAlphaMetadata";
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, uri);
      expect(await registry.getProjectMetadataURI(projectId)).to.equal(uri);
    });

    it("Should emit ProjectMetadataURISet event", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri = "ipfs://QmSolarFarmAlphaMetadata";
      await expect(registry.connect(watcherOwner).setProjectMetadataURI(projectId, uri))
        .to.emit(registry, "ProjectMetadataURISet")
        .withArgs(projectId, uri);
    });

    it("Should allow updating the URI after it has been set", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, "ipfs://QmOld");
      const newUri = "ipfs://QmNewWithCertification";
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, newUri);
      expect(await registry.getProjectMetadataURI(projectId)).to.equal(newUri);
    });

    it("Should emit ProjectMetadataURISet on every update", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, "ipfs://QmOld");
      await expect(registry.connect(watcherOwner).setProjectMetadataURI(projectId, "ipfs://QmNew"))
        .to.emit(registry, "ProjectMetadataURISet")
        .withArgs(projectId, "ipfs://QmNew");
    });

    it("Should revert when non-watcher-owner sets URI", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, other, projectId, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(other).setProjectMetadataURI(projectId, "ipfs://Qm"))
        .to.be.revertedWithCustomError(registry, "UnauthorizedWatcherOwner")
        .withArgs(other.address, watcherId);
    });

    it("Should revert when setting URI on an unregistered project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner } = await networkHelpers.loadFixture(deployFixture);
      await expect(registry.connect(watcherOwner).setProjectMetadataURI(999n, "ipfs://Qm"))
        .to.be.revertedWithCustomError(registry, "ProjectNotRegistered");
    });

    it("Should accept HTTPS URIs in addition to IPFS", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri = "https://api.myenergy.com/projects/1/metadata.json";
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, uri);
      expect(await registry.getProjectMetadataURI(projectId)).to.equal(uri);
    });

    it("Should keep URIs isolated between projects", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { registry, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      // Register a second project
      const tx = await registry.connect(watcherOwner).registerProject(watcherId, "Project Two", 1);
      const receipt = await tx.wait();
      const event = receipt!.logs.find((log) => {
        try { return registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ProjectRegistered"; }
        catch { return false; }
      });
      const projectId2 = registry.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await registry.connect(watcherOwner).setProjectMetadataURI(projectId, "ipfs://QmProject1");
      await registry.connect(watcherOwner).setProjectMetadataURI(projectId2, "ipfs://QmProject2");

      expect(await registry.getProjectMetadataURI(projectId)).to.equal("ipfs://QmProject1");
      expect(await registry.getProjectMetadataURI(projectId2)).to.equal("ipfs://QmProject2");
    });
  });

  // ─── Attestation Metadata URI ──────────────────────────

  describe("Attestation Metadata URI", function () {
    it("Should attest with empty metadataURI (default)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);
    });

    it("Should attest with an IPFS metadataURI and emit it in EnergyAttested", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri = "ipfs://QmAuditReportHash";
      const fromTimestamp = 1000;
      const readings = [500n];
      const toTimestamp = computeToTimestamp(fromTimestamp, readings.length, 1);
      const data = encodeAttestationData(projectId, fromTimestamp, readings, 1, "manual", uri);
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      )
        .to.emit(registry, "EnergyAttested")
        .withArgs(projectId, anyValue, fromTimestamp, toTimestamp, 500n, attester.address, 1, uri, anyValue);
    });

    it("Should attest with an HTTPS metadataURI", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri = "https://api.auditor.com/reports/42.json";
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n, "manual", 1, uri);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);
    });

    it("Should allow different attestations to carry different metadataURIs", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uri1 = "ipfs://QmReport1";
      const uri2 = "ipfs://QmReport2";

      const from1 = 1000;
      const readings1 = [100n];
      const to1 = computeToTimestamp(from1, readings1.length, 1);
      const data1 = encodeAttestationData(projectId, from1, readings1, 1, "iot", uri1);

      const from2 = 1060;
      const readings2 = [200n];
      const to2 = computeToTimestamp(from2, readings2.length, 1);
      const data2 = encodeAttestationData(projectId, from2, readings2, 1, "iot", uri2);

      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data1, value: 0n },
        })
      ).to.emit(registry, "EnergyAttested").withArgs(projectId, anyValue, from1, to1, 100n, attester.address, 1, uri1, anyValue);

      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data: data2, value: 0n },
        })
      ).to.emit(registry, "EnergyAttested").withArgs(projectId, anyValue, from2, to2, 200n, attester.address, 1, uri2, anyValue);
    });

    it("Should still validate all fields when metadataURI is non-empty", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const data = encodeAttestationData(projectId, 2000, [500n], 0, "iot", "ipfs://QmSomething");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "InvalidReadingInterval");
    });
  });

  // ─── Linearity Enforcement ──────────────────────────

  describe("Linearity Enforcement", function () {
    it("Should accept first attestation at any timestamp", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 50000, 51000, 100n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(100n);
    });

    it("Should accept second attestation starting at first's toTimestamp", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // First: from=1000, to=1060 (1 reading, 1 min interval)
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      // Second: from=1060, to=1120
      await attestEnergy(eas, schemaUID, attester, projectId, 1060, 2000, 200n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(300n);
    });

    it("Should revert if second attestation has a gap (from > lastTo)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      // from=5000 but expected from=1060
      const data = encodeAttestationData(projectId, 5000, [200n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(registry, "NonSequentialAttestation")
        .withArgs(projectId, 1060, 5000);
    });

    it("Should revert if second attestation overlaps (from < lastTo)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      // from=500 but expected from=1060
      const data = encodeAttestationData(projectId, 500, [200n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(registry, "NonSequentialAttestation")
        .withArgs(projectId, 1060, 500);
    });

    it("Should return correct getProjectLastTimestamp after attestation", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(0);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(1060);
    });

    it("Should maintain independent chains per project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, watcherOwner, watcherId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      // Project 1 starts at 1000
      await attestEnergy(eas, schemaUID, attester, 1, 1000, 2000, 100n);
      // Project 2 starts at 5000 (independent)
      await attestEnergy(eas, schemaUID, attester, 2, 5000, 6000, 200n);
      // Project 1 continues at 1060
      await attestEnergy(eas, schemaUID, attester, 1, 1060, 2000, 300n);

      expect(await registry.getProjectLastTimestamp(1)).to.equal(1120);
      expect(await registry.getProjectLastTimestamp(2)).to.equal(5060);
    });

    it("Should accept chain of 3+ attestations with varying intervals", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // 1: from=0, 2 readings at 60min => to = 0 + 2*60*60 = 7200
      await attestEnergy(eas, schemaUID, attester, projectId, 0, [100n, 200n], "iot", "", "", 60);
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(7200);
      // 2: from=7200, 1 reading at 30min => to = 7200 + 1*30*60 = 9000
      await attestEnergy(eas, schemaUID, attester, projectId, 7200, [50n], "iot", "", "", 30);
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(9000);
      // 3: from=9000, 3 readings at 15min => to = 9000 + 3*15*60 = 11700
      await attestEnergy(eas, schemaUID, attester, projectId, 9000, [10n, 20n, 30n], "iot", "", "", 15);
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(11700);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(410n);
    });
  });

  // ─── Replacement Mechanism ────────────────────────────

  describe("Replacement Mechanism", function () {
    it("Should replace attestation and update accumulators atomically", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(500n);

      await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [750n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(750n);
    });

    it("Should replace with different readings but same period", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // 2 readings at 30 min => to = 1000 + 2*30*60 = 4600
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, [100n, 200n], "iot", "", "", 30);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(300n);

      // Replace with same period (2 readings at 30 min)
      await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [400n, 500n], 30, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(900n);
    });

    it("Should revert if replacement has different fromTimestamp", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      const data = encodeAttestationData(projectId, 2000, [500n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "ReplacementPeriodMismatch");
    });

    it("Should revert if replacement has different toTimestamp (different interval)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // Original: 1 reading at 1 min => to=1060
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Replacement: 1 reading at 2 min => to=1120 (different!)
      const data = encodeAttestationData(projectId, 1000, [500n], 2, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "ReplacementPeriodMismatch");
    });

    it("Should revert if replacement targets different project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, attester, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).registerProject(watcherId, "Project 2", 1);
      await registry.connect(watcherOwner).addAttester(2, attester.address);

      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Try to replace with data targeting project 2
      const data = encodeAttestationData(2, 1000, [500n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "ReplacementProjectMismatch");
    });

    it("Should revert if replacing an already-replaced attestation", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [750n], 1, "manual");

      // Try to replace the already-replaced UID again
      const data = encodeAttestationData(projectId, 1000, [800n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(registry, "AttestationAlreadyReplaced");
    });

    it("Should return new UID via getReplacementUID after replacement", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);
      expect(await registry.getReplacementUID(uid)).to.equal(ZeroHash);

      const newUid = await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [750n], 1, "manual");
      expect(await registry.getReplacementUID(uid)).to.equal(newUid);
    });

    it("Should emit EnergyReplaced event with correct args", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      const replacementData = encodeAttestationData(projectId, 1000, [750n], 1, "manual", "ipfs://QmCorrected");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data: replacementData, value: 0n },
        })
      ).to.emit(registry, "EnergyReplaced");
    });

    it("Should replace middle-of-chain attestation without affecting chain tip", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      // Chain: from=1000->to=1060, from=1060->to=1120, from=1120->to=1180
      const uid1 = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      await attestEnergy(eas, schemaUID, attester, projectId, 1060, 2000, 200n);
      await attestEnergy(eas, schemaUID, attester, projectId, 1120, 2000, 300n);

      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(1180);
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(600n);

      // Replace first attestation (uid1)
      await replaceAttestation(eas, schemaUID, attester, uid1, projectId, 1000, [50n], 1, "manual");

      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(1180); // unchanged
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(550n); // 100->50
    });

    it("Should allow replacement by different authorized attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, other, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      await registry.connect(watcherOwner).addAttester(projectId, other.address);

      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Different attester replaces
      await replaceAttestation(eas, schemaUID, other, uid, projectId, 1000, [750n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(750n);
    });

    it("Should allow replacement with zero-energy readings (maintenance period)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      await replaceAttestation(eas, schemaUID, attester, uid, projectId, 1000, [0n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(0n);
    });

    it("Should revert replacement when resolver is paused", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      await resolver.pause();

      const data = encodeAttestationData(projectId, 1000, [750n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "EnforcedPause");
    });
  });

  // ─── Replacement Edge Cases ──────────────────────────

  describe("Replacement Edge Cases", function () {
    it("Should support chained replacements (A→B, then B→C)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uidA = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Replace A with B
      const uidB = await replaceAttestation(eas, schemaUID, attester, uidA, projectId, 1000, [600n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(600n);
      expect(await registry.getReplacementUID(uidA)).to.equal(uidB);

      // Replace B with C
      const uidC = await replaceAttestation(eas, schemaUID, attester, uidB, projectId, 1000, [700n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(700n);
      expect(await registry.getReplacementUID(uidB)).to.equal(uidC);
    });

    it("Should replace the tip (last) attestation without changing lastToTimestamp", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 100n);
      const tipUid = await attestEnergy(eas, schemaUID, attester, projectId, 1060, 2000, 200n);

      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(1120);

      await replaceAttestation(eas, schemaUID, attester, tipUid, projectId, 1060, [300n], 1, "manual");
      expect(await registry.getProjectLastTimestamp(projectId)).to.equal(1120); // unchanged
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(400n); // 100 + 300
    });

    it("Should revert replacement on deregistered project", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, registry, schemaUID, attester, watcherOwner, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      await registry.connect(watcherOwner).deregisterProject(projectId);

      const data = encodeAttestationData(projectId, 1000, [750n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "ProjectNotRegistered");
    });

    it("Should revert replacement by unauthorized attester", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, other, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      const data = encodeAttestationData(projectId, 1000, [750n], 1, "manual");
      await expect(
        eas.connect(other).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "UnauthorizedAttester");
    });

    it("Should revert replacement with mismatched period (refUID points to different time range)", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Try to "replace" but with a different fromTimestamp → ReplacementPeriodMismatch (resolver)
      const data = encodeAttestationData(projectId, 5000, [750n], 1, "manual");
      await expect(
        eas.connect(attester).attest({
          schema: schemaUID,
          data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: uid, data, value: 0n },
        })
      ).to.be.revertedWithCustomError(resolver, "ReplacementPeriodMismatch");
    });

    it("Should allow watcher-wide attester to perform replacement", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, registry, schemaUID, attester, other, watcherOwner, watcherId, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 500n);

      // Add other as watcher-wide attester (not per-project)
      await registry.connect(watcherOwner).addWatcherAttester(watcherId, other.address);

      await replaceAttestation(eas, schemaUID, other, uid, projectId, 1000, [800n], 1, "manual");
      expect(await registry.getTotalGeneratedEnergy(projectId)).to.equal(800n);
    });
  });

  // ─── Direct Revocation Blocked ────────────────────────

  describe("Direct Revocation Blocked", function () {
    it("Should revert single revoke via EAS", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);

      await expect(
        eas.connect(attester).revoke({ schema: schemaUID, data: { uid, value: 0n } })
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });

    it("Should revert multiRevoke via EAS", async function () {
      const { networkHelpers } = await hre.network.connect();
      const { eas, resolver, schemaUID, attester, projectId } = await networkHelpers.loadFixture(deployFixture);
      const uid = await attestEnergy(eas, schemaUID, attester, projectId, 1000, 2000, 5000n);

      await expect(
        eas.connect(attester).multiRevoke([
          { schema: schemaUID, data: [{ uid, value: 0n }] },
        ])
      ).to.be.revertedWithCustomError(resolver, "DirectRevocationBlocked");
    });
  });
});
