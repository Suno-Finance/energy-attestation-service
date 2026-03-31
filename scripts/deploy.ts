import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { getNetworkAddresses } from "./eas-addresses.js";

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const { eas: easAddress } = getNetworkAddresses(networkName);

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying on ${networkName}...`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`EAS:      ${easAddress}`);

  // Step 1: Deploy EnergyRegistry implementation + ERC1967 proxy
  console.log("\n1. Deploying EnergyRegistry (UUPS proxy)...");
  const RegistryImpl = await ethers.getContractFactory("EnergyRegistry");
  const registryImpl = await RegistryImpl.deploy();
  await registryImpl.waitForDeployment();
  const registryImplAddress = await registryImpl.getAddress();
  console.log(`   EnergyRegistry implementation: ${registryImplAddress}`);

  const initData = RegistryImpl.interface.encodeFunctionData("initialize", [deployer.address]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(registryImplAddress, initData);
  await proxy.waitForDeployment();
  const registryAddress = await proxy.getAddress();
  console.log(`   EnergyRegistry proxy (use this address): ${registryAddress}`);

  const registry = RegistryImpl.attach(registryAddress);

  // Step 2: Deploy the resolver, pointing it at EAS and the registry
  console.log("\n2. Deploying EnergyAttestationResolver...");
  const Resolver = await ethers.getContractFactory("EnergyAttestationResolver");
  const resolver = await Resolver.deploy(easAddress, registryAddress);
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  console.log(`   EnergyAttestationResolver deployed to: ${resolverAddress}`);

  // Step 3: Authorize the resolver to write to the registry
  console.log("\n3. Authorizing resolver on registry...");
  const authTx = await registry.authorizeResolver(resolverAddress);
  await authTx.wait();
  console.log(`   Resolver authorized.`);

  // Persist deployment info to disk
  const deployedAt = new Date().toISOString();
  const deployment = {
    registry: registryAddress,
    registryImpl: registryImplAddress,
    resolver: resolverAddress,
    deployer: deployer.address,
    eas: easAddress,
    deployedAt,
  };

  // Write to deployments/{network}.json (per-network file)
  const deploymentsDir = path.resolve("deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const perNetworkPath = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(perNetworkPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nDeployment saved to ${perNetworkPath}`);

  // Update deployment-addresses.json (all networks, organized by network key)
  const addressesPath = path.resolve("deployment-addresses.json");
  const allAddresses = fs.existsSync(addressesPath)
    ? JSON.parse(fs.readFileSync(addressesPath, "utf-8"))
    : {};
  allAddresses[networkName] = deployment;
  fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2) + "\n");
  console.log(`deployment-addresses.json updated for network: ${networkName}`);

  console.log("\n=== Next steps ===");
  console.log(`1. Set in your .env:`);
  console.log(`     REGISTRY_ADDRESS=${registryAddress}   # proxy — use this everywhere`);
  console.log(`     RESOLVER_ADDRESS=${resolverAddress}`);
  console.log(`2. Verify contracts:`);
  console.log(`     npm run verify:${networkName} -- ${registryImplAddress}   # implementation`);
  console.log(`     npm run verify:${networkName} -- ${resolverAddress} ${easAddress} ${registryAddress}`);
  console.log(`3. Register schema:`);
  console.log(`     npx hardhat run scripts/register-schema.ts --network ${networkName}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
