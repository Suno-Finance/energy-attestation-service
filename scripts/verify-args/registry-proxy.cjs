// Constructor args for the ERC1967Proxy that wraps EnergyRegistry.
// Usage: npx hardhat verify --network amoy --constructor-args scripts/verify-args/registry-proxy.cjs <proxy-address>
module.exports = [
  // implementation
  "0x1e951f46F74cce1fA0b14ca0FbDB039d944469fB",
  // initData = EnergyRegistry.initialize(deployer)
  "0x8129fc1c0000000000000000000000008713fda9330b0326ee209e680bd1fef8da8519f9",
];
