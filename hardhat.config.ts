import "dotenv/config";
import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import "@nomicfoundation/hardhat-verify";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  test: {
    mocha: {
      reporter: process.env.CI ? "mocha-junit-reporter" : "spec",
      reporterOptions: {
        mochaFile: "junit.xml",
      },
    },
  },
  solidity: {
    profiles: {
      default: {
        compilers: [
          {
            version: "0.8.28",
            settings: {
              optimizer: { enabled: true, runs: 200 },
              evmVersion: "cancun",
              viaIR: true,
            },
          },
          {
            version: "0.8.27",
            settings: {
              optimizer: { enabled: true, runs: 200 },
              evmVersion: "cancun",
              viaIR: true,
            },
          },
        ],
      },
    },
    // Build EAS core contracts so they are available as factories in tests
    npmFilesToBuild: [
      "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol",
      "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    ],
  },
  networks: {
    celo: {
      type: "http",
      url: "https://forno.celo.org",
      chainId: 42220,
      accounts: [configVariable("PRIVATE_KEY_DEPLOYER"), configVariable("PRIVATE_KEY_WATCHER")],
    },
    amoy: {
      type: "http",
      url: "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: [configVariable("PRIVATE_KEY_DEPLOYER"), configVariable("PRIVATE_KEY_WATCHER")],
      gasPrice: 30_000_000_000, // 30 gwei — Amoy minimum tip is 25 gwei; bypasses bad EIP-1559 estimation from public RPC
    },
    polygon: {
      type: "http",
      url: "https://polygon-rpc.com",
      chainId: 137,
      accounts: [configVariable("PRIVATE_KEY_DEPLOYER"), configVariable("PRIVATE_KEY_WATCHER")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
