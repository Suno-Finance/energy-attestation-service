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

function formatWh(wh: bigint): string {
  if (wh === 0n) return "0 Wh";
  if (wh >= 1_000_000_000n) return `${(Number(wh) / 1e9).toFixed(3)} GWh  (${wh.toLocaleString()} Wh)`;
  if (wh >= 1_000_000n)     return `${(Number(wh) / 1e6).toFixed(3)} MWh  (${wh.toLocaleString()} Wh)`;
  if (wh >= 1_000n)         return `${(Number(wh) / 1e3).toFixed(3)} kWh  (${wh.toLocaleString()} Wh)`;
  return `${wh.toLocaleString()} Wh`;
}

async function main() {
  const registryAddress = process.env.REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("REGISTRY_ADDRESS not set in environment");

  const connection = await hre.network.connect();
  const { ethers, networkName } = connection;
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
  const registry = await ethers.getContractAt("EnergyRegistry", registryAddress, watcherSigner);

  // Accept watcher ID from env var or prompt interactively
  const watcherIdInput = process.env.WATCHER_ID ?? await prompt("Enter watcher ID: ");

  const watcherId = BigInt(watcherIdInput);

  const watcher = await registry.getWatcher(watcherId);
  if (!watcher.registered) {
    console.error(`Watcher ${watcherId} is not registered.`);
    process.exitCode = 1;
    return;
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Watcher #${watcherId}: ${watcher.name}`);
  console.log(`  Owner: ${watcher.owner}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Watcher-level totals
  const watcherGenerated = await registry.getTotalGeneratedEnergyByWatcher(watcherId);
  const watcherConsumed  = await registry.getTotalConsumedEnergyByWatcher(watcherId);

  console.log("  Watcher totals");
  console.log(`    Generated : ${formatWh(watcherGenerated)}`);
  console.log(`    Consumed  : ${formatWh(watcherConsumed)}`);
  console.log();

  // Per-project breakdown
  const projectIds = await registry.getWatcherProjects(watcherId);

  if (projectIds.length === 0) {
    console.log("  No projects registered yet.");
  } else {
    console.log(`  Projects (${projectIds.length})`);
    console.log("  " + "─".repeat(48));

    for (const projectId of projectIds) {
      const project     = await registry.getProject(projectId);
      const projectType = await registry.getProjectType(projectId);
      const typeLabel   = Number(projectType) === 0 ? "generator" : "consumer";
      const generated   = await registry.getTotalGeneratedEnergy(projectId);
      const consumed    = await registry.getTotalConsumedEnergy(projectId);
      const metaURI     = await registry.getProjectMetadataURI(projectId);
      const status      = project.registered ? "active" : "deregistered";

      console.log(`\n  Project #${projectId}: ${project.name}  [${status}]  [${typeLabel}]`);
      if (Number(projectType) === 0) {
        console.log(`    Generated : ${formatWh(generated)}`);
      } else {
        console.log(`    Consumed  : ${formatWh(consumed)}`);
      }
      if (metaURI) console.log(`    Metadata  : ${metaURI}`);
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
