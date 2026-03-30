import hre from "hardhat";
import { AbiCoder, ZeroAddress, ZeroHash } from "ethers";
import { getNetworkAddresses } from "./eas-addresses.js";
import * as readline from "readline";
import * as fs from "fs";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptRequired(question: string): Promise<string> {
  while (true) {
    const value = await prompt(question);
    if (value) return value;
    console.log("  This field is required.");
  }
}

type EnergyReportJson = {
  project_id: number;
  reading_count: number;
  reading_interval: number;
  readings: Array<number | string>;
  from_timestamp: number | string;
  method?: string;
  metadata_uri?: string;
  ref_uid?: string;
};

function asPositiveSafeInt(value: unknown, fieldName: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${fieldName} in report JSON`);
  return n;
}

function asNonNegativeSafeInt(value: unknown, fieldName: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${fieldName} in report JSON`);
  return n;
}

function getArgValue(names: string[]): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    if (names.includes(process.argv[i]) && process.argv[i + 1]) return process.argv[i + 1];
  }
  return undefined;
}

function sumReadings(readings: bigint[]): bigint {
  let total = 0n;
  for (const r of readings) total += r;
  return total;
}

function computeToTimestamp(fromTimestamp: number, readingCount: number, readingIntervalMinutes: number): number {
  return fromTimestamp + readingCount * readingIntervalMinutes * 60;
}

// Generation energy types only
const GENERATION_ENERGY_TYPES: Record<number, string> = {
  1:  "solar_pv",
  2:  "wind_onshore",
  3:  "wind_offshore",
  4:  "hydro",
  5:  "biomass",
  6:  "geothermal",
  7:  "ocean_tidal",
  8:  "nuclear",
  9:  "natural_gas",
  10: "coal",
  11: "oil",
  12: "storage_discharge",
  13: "hydrogen_fuel_cell",
};

async function main() {
  const connection = await hre.network.connect();
  const { ethers, networkName } = connection;
  const { eas: easAddress } = getNetworkAddresses(networkName);

  const schemaUID = process.env.SCHEMA_UID;
  if (!schemaUID) throw new Error("SCHEMA_UID not set in environment");

  const registryAddress = process.env.REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("REGISTRY_ADDRESS not set in environment");

  const signers = await ethers.getSigners();
  const signer =
    networkName === "hardhat"
      ? signers[0]
      : signers[1] ??
        (() => {
          throw new Error(
            "Watcher signer not available. Set PRIVATE_KEY_WATCHER in your .env for this network."
          );
        })();
  console.log(`\nNetwork  : ${networkName}`);
  console.log(`Attester : ${signer.address}\n`);

  // Optional: load a full report from JSON (recommended)
  const fileArg = getArgValue(["--file", "-f"]);
  const defaultReportPath = "examples/energy_report.json";
  const promptedPath = await prompt(`Energy report JSON path [default: ${defaultReportPath}]: `);
  const reportPath = fileArg ?? (promptedPath || defaultReportPath);

  let projectId: number;
  let fromTimestamp: number;
  let readingCount: number;
  let readingIntervalMinutes: number;
  let readings: bigint[];
  let method: string;
  let metadataURI: string;

  if (reportPath) {
    const raw = fs.readFileSync(reportPath, "utf8");
    const report = JSON.parse(raw) as EnergyReportJson;

    projectId = asPositiveSafeInt(report.project_id, "project_id");
    fromTimestamp = asNonNegativeSafeInt(report.from_timestamp, "from_timestamp");
    readingCount = asPositiveSafeInt(report.reading_count, "reading_count");
    readingIntervalMinutes = asPositiveSafeInt(report.reading_interval, "reading_interval (minutes)");
    if (!Array.isArray(report.readings)) throw new Error("Invalid readings in report JSON");
    readings = report.readings.map((v) => {
      const b = BigInt(v);
      if (b < 0n) throw new Error("Invalid readings in report JSON (negative value)");
      return b;
    });
    method = report.method ?? "manual";
    metadataURI = report.metadata_uri ?? "";
    if (readings.length !== readingCount) {
      throw new Error(`reading_count (${readingCount}) must equal readings.length (${readings.length})`);
    }
  } else {
    // Fallback: manual entry
    const projectIdRaw = await promptRequired("Project ID: ");
    projectId = parseInt(projectIdRaw, 10);

    const now = Math.floor(Date.now() / 1000);
    const readingCountRaw = await promptRequired("Reading count: ");
    readingCount = parseInt(readingCountRaw, 10);
    const intervalRaw = await promptRequired("Reading interval (minutes): ");
    readingIntervalMinutes = parseInt(intervalRaw, 10);

    console.log("\nReporting period");
    const defaultFrom = now - readingCount * readingIntervalMinutes * 60;
    const fromInput = await prompt(`  From timestamp [default: ${defaultFrom}]: `);
    fromTimestamp = fromInput ? parseInt(fromInput, 10) : defaultFrom;

    const readingsRaw = await promptRequired(`Readings (comma-separated, ${readingCount} values): `);
    const parts = readingsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length !== readingCount) {
      throw new Error(`Expected ${readingCount} readings, got ${parts.length}`);
    }
    readings = parts.map((p) => BigInt(p));

    const methodInput = await prompt("\nCollection method (manual / iot / estimated) [default: manual]: ");
    method = methodInput || "manual";

    metadataURI = await prompt("\nMetadata URI — IPFS or HTTPS link to supporting evidence (leave blank to skip): ");
  }

  // Look up project info from the registry
  const registry = await ethers.getContractAt("EnergyRegistry", registryAddress);

  // Replacement mode: --replace <uid> CLI arg
  const replaceArg = getArgValue(["--replace", "-r"]);
  const refUID = replaceArg ?? ZeroHash;

  const projectEnergyType: number = Number(await registry.getProjectEnergyType(projectId));
  const isConsumer = projectEnergyType === 0;
  const projectTypeLabel = isConsumer ? "consumer" : `generator (${GENERATION_ENERGY_TYPES[projectEnergyType] ?? `type ${projectEnergyType}`})`;
  console.log(`  → Project: ${projectTypeLabel}`);

  const lastTimestamp: bigint = await registry.getProjectLastTimestamp(projectId);
  if (lastTimestamp > 0n) {
    console.log(`  → Last timestamp: ${lastTimestamp} (next attestation must start here)`);
  } else {
    console.log("  → No prior attestations — first attestation can start at any timestamp");
  }

  const isReplacement = refUID !== ZeroHash;
  if (isReplacement) {
    console.log(`  → Mode: REPLACE (ref: ${refUID})`);
  }

  const toTimestamp = computeToTimestamp(fromTimestamp, readingCount, readingIntervalMinutes);
  const energyWh = sumReadings(readings);

  // Summary before submitting
  console.log("\n─────────────────────────────────────────────");
  console.log(`  ${isReplacement ? "Replacement" : "Attestation"} summary`);
  console.log(`  Project ID  : ${projectId}`);
  console.log(`  Type        : ${projectTypeLabel}`);
  console.log(`  Mode        : ${isReplacement ? `REPLACE (ref: ${refUID})` : "NEW"}`);
  console.log(`  Period      : ${fromTimestamp} → ${toTimestamp} (derived)`);
  console.log(`  Readings    : ${readingCount} × ${readingIntervalMinutes} min`);
  console.log(`  Energy      : ${energyWh.toLocaleString()} Wh`);
  console.log(`  Method      : ${method}`);
  if (metadataURI) console.log(`  Metadata    : ${metadataURI}`);
  console.log("─────────────────────────────────────────────");

  const confirm = await prompt("\nSubmit? (y/N): ");
  if (confirm.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  const eas = await ethers.getContractAt("EAS", easAddress, signer);

  const data = AbiCoder.defaultAbiCoder().encode(
    ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
    [projectId, readingCount, readingIntervalMinutes, readings, fromTimestamp, method, metadataURI]
  );

  try {
    const tx = await eas.attest({
      schema: schemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: refUID,
        data,
        value: 0n,
      },
    });

    console.log("\nSubmitting...");
    const receipt = await tx.wait();
    console.log(`\n✓ ${isReplacement ? "Replacement" : "Attestation"} submitted!`);
    console.log(`  Tx hash: ${receipt!.hash}`);
  } catch (err: unknown) {
    const error = err as { data?: string; errorName?: string; errorArgs?: unknown[] };
    if (error.data) {
      try {
        const decoded = registry.interface.parseError(error.data);
        console.error("\n✗ Attestation reverted in resolver:");
        console.error(`  Error : ${decoded.name}`);
        console.error(`  Args  : ${JSON.stringify(decoded.args)}`);
      } catch {
        try {
          const decoded = eas.interface.parseError(error.data);
          console.error("\n✗ Attestation reverted in EAS:");
          console.error(`  Error : ${decoded.name}`);
          console.error(`  Args  : ${JSON.stringify(decoded.args)}`);
        } catch {
          console.error("\n✗ Attestation reverted with unknown error data:");
          console.error(`  data: ${error.data}`);
        }
      }
    } else {
      console.error("\n✗ Attestation reverted without error data.");
    }
    throw err;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
