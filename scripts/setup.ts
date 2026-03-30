import hre from "hardhat";
import * as readline from "readline";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function registerWatcher(registry: any) {
  const name = await promptRequired("Watcher name: ");

  console.log(`\nRegistering watcher "${name}"...`);
  const tx = await registry.registerWatcher(name);
  const receipt = await tx.wait();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const event = receipt!.logs.find((log: any) => {
    try {
      return registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "WatcherRegistered";
    } catch { return false; }
  });

  let watcherId = 1n;
  if (event) {
    const parsed = registry.interface.parseLog({ topics: event.topics as string[], data: event.data });
    watcherId = parsed!.args[0];
  }

  console.log("\n✓ Watcher registered!");
  console.log(`  Watcher ID : ${watcherId}`);
  console.log(`  Name       : ${name}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function registerProject(registry: any, signerAddress: string) {
  const watcherIdRaw = await promptRequired("Watcher ID: ");
  const watcherId = BigInt(watcherIdRaw);

  const watcher = await registry.getWatcher(watcherId);
  if (!watcher.registered) {
    console.error(`Watcher ${watcherId} is not registered.`);
    process.exitCode = 1;
    return;
  }

  const name = await promptRequired("Project name: ");

  const ENERGY_TYPES: Record<number, string> = {
    0:  "consumer  (grid import, operational load, etc.)",
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

  console.log("\nProject energy type:");
  for (const [id, label] of Object.entries(ENERGY_TYPES)) {
    console.log(`  ${String(id).padStart(2)}  ${label}`);
  }
  const energyTypeRaw = await promptRequired("Enter type ID: ");
  const energyType = parseInt(energyTypeRaw, 10);
  if (!Object.keys(ENERGY_TYPES).map(Number).includes(energyType)) {
    console.error(`Invalid energy type ID: ${energyType}. Choose a value from the list above.`);
    process.exitCode = 1;
    return;
  }
  const isConsumer = energyType === 0;
  const energyTypeLabel = isConsumer ? "consumer" : ENERGY_TYPES[energyType];

  const attesterInput = await prompt(`Attester wallet address (leave blank to use your wallet ${signerAddress}): `);
  const attesterAddress = attesterInput || signerAddress;

  console.log(`\nRegistering project "${name}" (${energyTypeLabel}) under watcher ${watcherId}...`);
  const tx1 = await registry.registerProject(watcherId, name, energyType);
  const receipt1 = await tx1.wait();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectEvent = receipt1!.logs.find((log: any) => {
    try {
      return registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ProjectRegistered";
    } catch { return false; }
  });

  let projectId = 1n;
  if (projectEvent) {
    const parsed = registry.interface.parseLog({ topics: projectEvent.topics as string[], data: projectEvent.data });
    projectId = parsed!.args[0];
  }

  console.log(`Adding attester ${attesterAddress}...`);
  const tx2 = await registry.addAttester(projectId, attesterAddress);
  await tx2.wait();

  console.log("\n✓ Project registered!");
  console.log(`  Project ID   : ${projectId}`);
  console.log(`  Name         : ${name}`);
  console.log(`  Energy type  : ${isConsumer ? "consumer (0)" : `${energyTypeLabel} (${energyType})`}`);
  console.log(`  Watcher ID   : ${watcherId}`);
  console.log(`  Attester     : ${attesterAddress}`);
}

async function main() {
  const registryAddress = process.env.REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("REGISTRY_ADDRESS not set in environment");

  const connection = await hre.network.connect();
  const { ethers, networkName } = connection;
  const registry = await ethers.getContractAt("EnergyRegistry", registryAddress);
  const signers = await ethers.getSigners();
  const watcherSigner =
    networkName === "hardhat"
      ? signers[0]
      : signers[1] ??
        (() => {
          throw new Error(
            "Watcher signer not available. Set PRIVATE_KEY_WATCHER in your .env for this network."
          );
        })();

  console.log("\nWhat would you like to do?");
  console.log("  1) Register a new watcher");
  console.log("  2) Register a new project");

  const choice = await promptRequired("\nEnter 1 or 2: ");

  console.log();

  if (choice === "1") {
    await registry.connect(watcherSigner);
    await registerWatcher(registry.connect(watcherSigner));
  } else if (choice === "2") {
    await registerProject(registry.connect(watcherSigner), watcherSigner.address);
  } else {
    console.error('Invalid choice. Enter "1" or "2".');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
