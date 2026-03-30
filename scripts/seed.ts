/**
 * seed.ts — Seeds realistic energy attestation data on a testnet.
 *
 * Creates:
 *   - 1 watcher ("Suno Energy")
 *   - Project 1: "Solar Farm Alpha" (solar_pv, energyType=1)
 *   - Project 2: "Wind Farm Beta"   (wind_onshore, energyType=2)
 *   - 10 sequential daily attestations per project (24 hourly readings each)
 *
 * Requirements:
 *   - REGISTRY_ADDRESS in .env
 *   - SCHEMA_UID in .env
 *   - PRIVATE_KEY_DEPLOYER: deployer (authorizes resolver, not used here directly)
 *   - PRIVATE_KEY_WATCHER: watcher owner and attester
 *
 * Usage:
 *   npx hardhat run scripts/seed.ts --network amoy
 */

import hre from "hardhat";
import { AbiCoder, ZeroAddress, ZeroHash } from "ethers";
import { getNetworkAddresses } from "./eas-addresses.js";

// ─── Seed data ────────────────────────────────────────────────────────────────

// Start: 2026-03-16 00:00:00 UTC
const START_TIMESTAMP = 1773619200;
const DAY_SECONDS = 86400;
const READING_INTERVAL_MINUTES = 60; // 1 reading per hour
const READING_COUNT = 24;            // 24 readings per day = 1 full day

/**
 * Solar PV profile — 24 hourly readings in Wh.
 * Night hours produce 0, midday peaks around 700-800 Wh.
 */
const SOLAR_BASE: number[] = [
  0, 0, 0, 0, 0, 0,        // 00:00–05:59  night
  45, 120, 280, 430, 580, 710, // 06:00–11:59  ramp up
  790, 760, 700, 570, 390, 210, // 12:00–17:59  peak + ramp down
  85, 20, 0, 0, 0, 0,       // 18:00–23:59  dusk + night
];

/**
 * Wind onshore profile — 24 hourly readings in Wh.
 * Variable but present at all hours; stronger at night/morning.
 */
const WIND_BASE: number[] = [
  480, 510, 530, 500, 470, 440,
  390, 360, 320, 300, 280, 310,
  340, 370, 410, 450, 490, 520,
  560, 590, 570, 550, 530, 500,
];

// Daily variation factors (10 days) — simulates weather
const SOLAR_FACTORS = [1.00, 0.62, 0.85, 1.08, 1.05, 0.38, 1.00, 0.93, 0.72, 1.10];
const WIND_FACTORS  = [0.95, 1.20, 0.80, 1.05, 1.30, 1.15, 0.70, 0.90, 1.25, 1.00];

function applyFactor(base: number[], factor: number): bigint[] {
  return base.map((v) => BigInt(Math.round(v * factor)));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encodeData(
  projectId: bigint,
  fromTimestamp: number,
  readings: bigint[],
  method: string,
  metadataURI: string = ""
): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
    [projectId, READING_COUNT, READING_INTERVAL_MINUTES, readings, fromTimestamp, method, metadataURI]
  );
}

function totalWh(readings: bigint[]): bigint {
  return readings.reduce((acc, v) => acc + v, 0n);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const connection = await hre.network.connect();
  const { ethers, networkName } = connection;
  const { eas: easAddress } = getNetworkAddresses(networkName);

  const registryAddress = process.env.REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("REGISTRY_ADDRESS not set in .env");
  const schemaUID = process.env.SCHEMA_UID;
  if (!schemaUID) throw new Error("SCHEMA_UID not set in .env");

  const signers = await ethers.getSigners();
  const watcher = signers[1] ?? signers[0];
  console.log(`\nNetwork  : ${networkName}`);
  console.log(`Watcher  : ${watcher.address}\n`);

  const registry = await ethers.getContractAt("EnergyRegistry", registryAddress, watcher);
  const eas = await ethers.getContractAt("EAS", easAddress, watcher);

  // ── 1. Register watcher ───────────────────────────────────────────────────
  console.log("1. Registering watcher...");
  const watcherTx = await registry.registerWatcher("Suno Energy");
  const watcherReceipt = await watcherTx.wait();
  const watcherEvent = watcherReceipt!.logs
    .map((log) => { try { return registry.interface.parseLog(log as any); } catch { return null; } })
    .find((e) => e?.name === "WatcherRegistered");
  const watcherId: bigint = watcherEvent!.args[0];
  console.log(`   ✓ Watcher ID: ${watcherId}`);

  // ── 2. Register projects ──────────────────────────────────────────────────
  console.log("\n2. Registering projects...");

  const proj1Tx = await registry.registerProject(watcherId, "Solar Farm Alpha", 1); // solar_pv
  const proj1Receipt = await proj1Tx.wait();
  const proj1Event = proj1Receipt!.logs
    .map((log) => { try { return registry.interface.parseLog(log as any); } catch { return null; } })
    .find((e) => e?.name === "ProjectRegistered");
  const project1Id: bigint = proj1Event!.args[0];
  await (await registry.addAttester(project1Id, watcher.address)).wait();
  console.log(`   ✓ Project 1 — Solar Farm Alpha (ID: ${project1Id}, solar_pv)`);

  const proj2Tx = await registry.registerProject(watcherId, "Wind Farm Beta", 2); // wind_onshore
  const proj2Receipt = await proj2Tx.wait();
  const proj2Event = proj2Receipt!.logs
    .map((log) => { try { return registry.interface.parseLog(log as any); } catch { return null; } })
    .find((e) => e?.name === "ProjectRegistered");
  const project2Id: bigint = proj2Event!.args[0];
  await (await registry.addAttester(project2Id, watcher.address)).wait();
  console.log(`   ✓ Project 2 — Wind Farm Beta   (ID: ${project2Id}, wind_onshore)`);

  // ── 3. Submit attestations ────────────────────────────────────────────────
  console.log("\n3. Submitting attestations...");

  for (let day = 0; day < 10; day++) {
    const fromTimestamp = START_TIMESTAMP + day * DAY_SECONDS;
    const date = new Date(fromTimestamp * 1000).toISOString().slice(0, 10);

    // Solar Farm
    const solarReadings = applyFactor(SOLAR_BASE, SOLAR_FACTORS[day]);
    const solarData = encodeData(project1Id, fromTimestamp, solarReadings, "iot");
    const solarTx = await eas.attest({
      schema: schemaUID,
      data: { recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: ZeroHash, data: solarData, value: 0n },
    });
    await solarTx.wait();
    console.log(`   ✓ [${date}] Solar Farm — ${totalWh(solarReadings).toLocaleString()} Wh`);

    // Wind Farm
    const windReadings = applyFactor(WIND_BASE, WIND_FACTORS[day]);
    const windData = encodeData(project2Id, fromTimestamp, windReadings, "iot");
    const windTx = await eas.attest({
      schema: schemaUID,
      data: { recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: ZeroHash, data: windData, value: 0n },
    });
    await windTx.wait();
    console.log(`   ✓ [${date}] Wind Farm  — ${totalWh(windReadings).toLocaleString()} Wh`);
  }

  console.log("\n=== Seed complete ===");
  console.log(`Watcher ID  : ${watcherId}`);
  console.log(`Project 1   : Solar Farm Alpha (ID: ${project1Id})`);
  console.log(`Project 2   : Wind Farm Beta   (ID: ${project2Id})`);
  console.log(`Attestations: 10 days × 2 projects = 20 total`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
