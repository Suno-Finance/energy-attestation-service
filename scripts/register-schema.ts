import hre from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getNetworkAddresses } from "./eas-addresses.js";

const SCHEMA =
  "uint64 projectId, uint32 readingCount, uint32 readingIntervalMinutes, uint256[] readings, uint64 fromTimestamp, string method, string metadataURI";

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const { schemaRegistry: registryAddress } = getNetworkAddresses(networkName);

  const resolverAddress = process.env.RESOLVER_ADDRESS;
  if (!resolverAddress) {
    throw new Error("RESOLVER_ADDRESS not set in environment");
  }

  console.log(`Registering schema on ${networkName}...`);
  console.log(`SchemaRegistry: ${registryAddress}`);
  console.log(`Resolver: ${resolverAddress}`);

  const registry = await ethers.getContractAt(
    "SchemaRegistry",
    registryAddress
  );

  const tx = await registry.register(SCHEMA, resolverAddress, true);
  const receipt = await tx.wait();

  // Extract schema UID from the Registered event
  const registeredEvent = receipt!.logs.find((log) => {
    try {
      return registry.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "Registered";
    } catch { return false; }
  });

  if (registeredEvent) {
    const parsed = registry.interface.parseLog({
      topics: registeredEvent.topics as string[],
      data: registeredEvent.data,
    });
    const schemaUID: string = parsed!.args[0];
    console.log(`Schema UID: ${schemaUID}`);

    const addressesPath = resolve(process.cwd(), "deployment-addresses.json");
    const addresses = JSON.parse(readFileSync(addressesPath, "utf8"));
    addresses[networkName] = { ...addresses[networkName], schemaUID };
    writeFileSync(addressesPath, JSON.stringify(addresses, null, 2) + "\n");
    console.log(`deployment-addresses.json updated with schemaUID for "${networkName}"`);
  }

  console.log(`Schema: ${SCHEMA}`);
  console.log("Schema registered successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
