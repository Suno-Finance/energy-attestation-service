# Energy Attestation Service

## Project Overview

An on-chain public good that allows any energy-related project to attest energy data publicly using the Ethereum Attestation Service (EAS). Built as part of Ethereum For The World's Solution Development Grants for Suno. The goal is to become an on-chain energy reporting standard.

**Repo scope**: Solidity contracts + deployment/interaction scripts. Off-chain signer module and SDK live in separate repos.

## Tech Stack

- **Framework**: Hardhat
- **Solidity**: 0.8.28
- **EAS Contracts**: `@ethereum-attestation-service/eas-contracts`
- **Target Network**: Celo (mainnet)
- **Attestation Mode**: On-chain only

## EAS Contract Addresses

### Celo Mainnet
- **EAS**: `0x72E1d8ccf5299fb36fEfD8CC4394B8ef7e98Af92`
- **SchemaRegistry**: `0x5ece93bE4BDCF293Ed61FA78698B594F2135AF34`


### Other Networks (future)
- **Polygon EAS**: `0x5E634ef5355f45A855d02D66eCD687b1502AF790`
- **Polygon SchemaRegistry**: `0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7`
- **Sepolia EAS**: `0xC2679fBD37d54388Ce493F1DB75320D236e1815e`
- **Sepolia SchemaRegistry**: `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`

## Architecture

### Core Components

1. **EAS Schema** -- Registered on EAS SchemaRegistry, defines the energy attestation data structure
2. **EnergyAttestationResolver** -- Custom resolver contract attached to the schema that enforces:
   - Attester whitelisting (only authorized addresses can submit attestations)
   - Data validation (energy values, timestamp ranges, etc.)
   - State tracking (project registry, aggregated energy totals)
3. **Deployment & interaction scripts** -- Hardhat scripts for deploying, registering schemas, and submitting attestations

### Schema Design

```
uint64 projectId, uint64 fromTimestamp, uint64 toTimestamp, uint256 energyWh, string method
```

- `projectId`: Identifier for the energy project
- `fromTimestamp` / `toTimestamp`: Reporting period (flexible: hourly, daily, monthly, custom)
- `energyWh`: Energy generated in watt-hours (uint256 for precision, use Wh not kWh to avoid floats)
- `method`: Data collection method (`"manual"`, `"iot"`, `"estimated"`, etc.)

Batch reporting is supported via EAS's `multiAttest()` for submitting multiple periods at once.

### Resolver Contract Responsibilities

- **Access control**: Maintain a whitelist of authorized attesters (IoT devices, auditors, project operators)
- **Project registry**: Track registered projects with metadata
- **Data validation**: Reject invalid attestations (zero energy, `toTimestamp <= fromTimestamp`, unregistered projects)
- **State aggregation**: Track total attested energy per project
- **Revocation support**: Enable corrections/invalidations via EAS's built-in revocation

### Key EAS Patterns to Follow

- Import from `@ethereum-attestation-service/eas-contracts` -- do NOT reimplement EAS functionality
- Resolver extends `SchemaResolver` base contract from EAS
- Use `IEAS`, `AttestationRequest`, `AttestationRequestData` for creating attestations
- Use `NO_EXPIRATION_TIME` and `EMPTY_UID` constants from `Common.sol`
- Use `refUID` for linked attestations (e.g., corrections referencing original)
- Attestation data is ABI-encoded: `abi.encode(projectId, fromTimestamp, toTimestamp, energyWh, method)`

### Resolver Base Contract Pattern

```solidity
import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

contract EnergyAttestationResolver is SchemaResolver {
    constructor(IEAS eas) SchemaResolver(eas) {}

    function onAttest(Attestation calldata attestation, uint256 value) internal override returns (bool) {
        // Validate attester, decode & validate data, update state
    }

    function onRevoke(Attestation calldata attestation, uint256 value) internal override returns (bool) {
        // Handle revocation logic
    }
}
```

## Project Structure

```
contracts/
  EnergyAttestationResolver.sol   # Custom resolver with whitelist + validation + state
scripts/
  deploy.ts                       # Deploy resolver contract
  register-schema.ts              # Register schema on EAS SchemaRegistry
  attest.ts                       # Submit energy attestations
test/
  EnergyAttestationResolver.test.ts
hardhat.config.ts
```

## Commands

- `npx hardhat compile` -- Compile contracts
- `npx hardhat test` -- Run tests
- `npx hardhat test --grep "pattern"` -- Run specific tests
- `npx hardhat run scripts/deploy.ts --network <network>` -- Deploy

## Development Guidelines

- Inherit and reuse EAS functionality -- don't reinvent what EAS provides
- Use Wh (watt-hours) as uint256 instead of kWh floats for on-chain precision
- Attestations are immutable -- corrections are done by revoking and re-attesting
- Keep the resolver focused: access control, validation, state. Everything else stays in EAS
- Schema is registered once per network; the schema UID is deterministic
- Use `multiAttest()` for batch submissions (e.g., hourly readings for a full day)
