# Energy Attestation Service

An on-chain public good for transparent energy reporting, built on the [Ethereum Attestation Service (EAS)](https://attest.org). Any energy project can attest production or consumption data publicly and permanently on-chain, creating a verifiable record that anyone can audit.

Project site: [attest.energy](https://attest.energy/)

With the goal of becoming an open standard for on-chain energy reporting.

---

## Table of Contents

- **Core concepts**
  - [What is EAS?](#what-is-eas)
  - [Terminology Legend](#terminology-legend)
  - [Schema](#schema)
    - [Energy Type Registry](#energy-type-registry)
    - [Project Types](#project-types)
    - [Attestation Metadata URI](#attestation-metadata-uri)
  - [Sequential Attestation Model](#sequential-attestation-model)
  - [Corrections via Replacement](#corrections-via-replacement)
  - [No Direct Revocation](#no-direct-revocation)
- **Protocol architecture**
  - [Multi-Tenant Architecture](#multi-tenant-architecture)
  - [Project Metadata Standard](#project-metadata-standard)
  - [Contract Architecture](#contract-architecture)
  - [On-Chain Query Reference](#on-chain-query-reference)
  - [Events Reference](#events-reference)
  - [Custom Errors Reference](#custom-errors-reference)
  - [Common Error Scenarios](#common-error-scenarios)
  - [Upgrade & Migration Guide](#upgrade--migration-guide)
  - [Supported Networks](#supported-networks)
- **Subgraph**
  - [Subgraph](#subgraph)
- **Operations**
  - [Scripts Reference](#scripts-reference)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
  - [Deployment Guide (operators)](#deployment-guide-operators)
  - [Using an existing deployment (watchers & testers)](#using-an-existing-deployment-watchers--testers)
  - [Linting](#linting)
  - [Running Tests](#running-tests)
- **Security**
  - [Security: Watcher Ownership](#security-watcher-ownership)
  - [Security Notes](#security-notes)

---

## Terminology Legend

**Critical terms used consistently throughout this document:**


| Term                  | Definition                                                                         | Code Format                        | JSON Format                      |
| --------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------- |
| **Period**            | A time range for an attestation, bounded by `fromTimestamp` and `toTimestamp`      | `(fromTimestamp, toTimestamp)`     | `from_timestamp`, `to_timestamp` |
| **Attestation**       | A signed energy report stored on-chain via EAS, containing readings for a period   | Noun (singular/plural)             | Entity in JSON reports           |
| **Reporting period**  | The time range covered by readings (equivalent to "period")                        | Used interchangeably with "period" | —                                |
| **Energy**            | Watt-hours (Wh) accumulated over a period                                          | `uint256 energyWh`                 | `readings[]` (array)             |
| **Power**             | Instantaneous rate (W, kW, kWp) — different from energy                            | Not on-chain                       | In project metadata only         |
| **Readings**          | Array of per-interval energy values in Wh                                          | `uint256[] readings`               | `readings` array in JSON         |
| **Reading interval**  | Time between consecutive readings (in minutes)                                     | `readingIntervalMinutes`           | `reading_interval`               |
| **Collection method** | How data was gathered: `"manual"`, `"iot"`, `"estimated"`                          | `method` field                     | `method` field                   |
| **Metadata URI**      | Off-chain JSON document with proof/audit context                                   | `metadataURI` (camelCase)          | `metadata_uri` (snake_case)      |
| **Replacement**       | Correcting an attestation by submitting new data with `refUID` pointing to old UID | Via `refUID`                       | `ref_uid` in JSON                |
| **Chain/Chain tip**   | Sequence of gapless attestations; chain tip = `toTimestamp` of the last one        | `getProjectLastTimestamp()`        | —                                |


> **Code vs JSON convention**: Solidity and TypeScript use camelCase (`fromTimestamp`, `metadataURI`). JSON reports from off-chain systems use snake_case (`from_timestamp`, `metadata_uri`). Scripts automatically convert between them.

---

## What is EAS?

[Ethereum Attestation Service (EAS)](https://attest.org/)

The Ethereum Attestation Service is a permissionless protocol for making and verifying on-chain statements ("attestations") about anything. An attestation is a signed, structured piece of data stored on-chain, linked to a **schema** that defines its fields.

Key components used in this project:

- **SchemaRegistry** — registers the data structure that all energy attestations follow
- **EAS** — accepts attestation submissions and routes them through a **resolver** contract for validation
- **SchemaResolver** — a custom contract (this repo) that EAS calls on every attest/revoke, where business logic lives

This means EAS handles storage, indexing, and revocation — and this contract handles *who* can attest and *what data* is valid.

---

## Schema

```
uint64 projectId, uint32 readingCount, uint32 readingIntervalMinutes, uint256[] readings, uint64 fromTimestamp, string method, string metadataURI
```


| Field                    | Type        | Description                                                               |
| ------------------------ | ----------- | ------------------------------------------------------------------------- |
| `projectId`              | `uint64`    | ID of the registered energy project                                       |
| `readingCount`           | `uint32`    | Number of interval readings in this report (must equal `readings.length`) |
| `readingIntervalMinutes` | `uint32`    | Interval length in **minutes** between readings                           |
| `readings`               | `uint256[]` | Per-interval energy in **Wh** (array length must equal `readingCount`)    |
| `fromTimestamp`          | `uint64`    | Start of the reporting period (Unix seconds)                              |
| `method`                 | `string`    | Collection method: `"manual"`, `"iot"`, `"estimated"`, etc.               |
| `metadataURI`            | `string`    | Optional URI pointing to supporting evidence (pass `""` for none)         |


> **Note**: `energyType` is no longer a per-attestation field. It is set **once at project registration** and stored on the project. The resolver reads it from the registry on every attestation — attesters never need to re-declare it.

The resolver derives:

- `toTimestamp = fromTimestamp + readingCount * readingIntervalMinutes * 60`
- `energyWh = sum(readings)` (may be `0` for maintenance/offline periods)

Each reading is stored as **watt-hours (Wh)** as a `uint256` integer to avoid floating-point precision issues on-chain.


| Conversion               | Example      |
| ------------------------ | ------------ |
| 1 kWh = 1,000 Wh         | `1000`       |
| 1 MWh = 1,000,000 Wh     | `1000000`    |
| 1 GWh = 1,000,000,000 Wh | `1000000000` |


> **Wh vs W vs kW**: The schema reports **energy** (Wh — watt-hours, accumulated over a period). Do not confuse this with **power** (W or kW — the instantaneous rate of generation). A 100 kW solar installation running for one hour produces 100,000 Wh (100 kWh). Project metadata can separately describe installed power capacity (kW), but all on-chain attestation data is always in Wh.

### Energy Type Registry

The `energyType` is stored on the **project** (set once at registration, never changes). It serves a dual purpose: it identifies the generation source and determines whether the project is a generator or consumer.

**Reserved value: `0` = consumer.** Any project registered with `energyType = 0` is treated as a consumer — its attestations flow into the consumed accumulator. All other IDs must be registered in the on-chain energy type registry and indicate a generator project.


| ID  | Name                 | Notes                                                 |
| --- | -------------------- | ----------------------------------------------------- |
| 0   | `consumer`           | Reserved — consumption project (no generation source) |
| 1   | `solar_pv`           | Photovoltaic solar                                    |
| 2   | `wind_onshore`       | Land-based wind turbines                              |
| 3   | `wind_offshore`      | Offshore wind turbines                                |
| 4   | `hydro`              | Hydroelectric (run-of-river or reservoir)             |
| 5   | `biomass`            | Biomass combustion or biogas                          |
| 6   | `geothermal`         | Geothermal heat or steam                              |
| 7   | `ocean_tidal`        | Tidal or wave energy                                  |
| 8   | `nuclear`            | Nuclear fission                                       |
| 9   | `natural_gas`        | Natural gas combustion                                |
| 10  | `coal`               | Coal combustion                                       |
| 11  | `oil`                | Oil/diesel combustion                                 |
| 12  | `storage_discharge`  | Battery or other storage system discharge             |
| 13  | `hydrogen_fuel_cell` | Hydrogen fuel cell                                    |


IDs 1–13 are pre-registered at deployment. A dedicated **energy type admin** role (set to the deployer at construction, transferable) can add or remove types without redeployment.

- Add a type: `registry.registerEnergyType(id, name)` — energy type admin only
- Remove a type: `registry.removeEnergyType(id)` — energy type admin only
- Transfer the admin role: `registry.transferEnergyTypeAdmin(newAdmin)` — current admin only

### Project Types

A project's category is determined by its `energyType`, set **once at registration** and permanent:

- `energyType = 0` → **consumer** — energy consumed by this project (operational load, carbon accounting, etc.)
- `energyType = 1–13+` → **generator** — energy produced by this project; the ID specifies the generation source (solar, wind, hydro, etc.)

`getProjectType(projectId)` returns the conventional 0/1 flag (`0` = generator, `1` = consumer) derived from `energyType`. `getProjectEnergyType(projectId)` returns the raw stored value.

This prevents misclassification: a solar farm is registered with `energyType = 1` and will only ever accumulate generated energy — its attesters cannot accidentally submit consumption readings.

The registry maintains **separate accumulators** for each direction:

- `getTotalGeneratedEnergy(projectId)` / `getTotalGeneratedEnergyByWatcher(watcherId)`
- `getTotalConsumedEnergy(projectId)` / `getTotalConsumedEnergyByWatcher(watcherId)`

Replacements update the correct accumulator automatically, derived from the project's `energyType`.

### Attestation Metadata URI

The `metadataURI` field is **optional** (pass `""` to omit). When populated, it points to a JSON document with any supporting evidence or context for that specific attestation — audit reports, raw IoT readings, certifications, or anything else the attester wants to anchor on-chain.

This makes the schema forward-compatible: future use cases can attach richer data without changing the schema or creating a new schema UID.

**Recommended format** (all fields optional):

```json
{
  "proof": "ipfs://QmAuditReportHash",
  "certifier": "0xAuditorWalletAddress",
  "device_id": "sensor-42",
  "notes": "Monthly aggregate for March 2026. Raw readings available at proof URI."
}
```


| Field       | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `proof`     | URI to the primary evidence document (PDF, CSV, JSON)              |
| `certifier` | Address or identifier of the third-party that verified the reading |
| `device_id` | IoT device or meter identifier                                     |
| `notes`     | Free-text context for the attester                                 |


Add any custom fields your use case requires — indexers that don't recognise them will ignore them.

**URI conventions:**

- Use `ipfs://Qm...` for immutable evidence snapshots (audit PDFs, signed meter exports)
- Use `https://...` for live endpoints (dashboards, APIs)

**Example — attaching an audit PDF:**

```typescript
const metadataURI = "ipfs://QmXyZ..."; // IPFS CID of the uploaded PDF

const data = AbiCoder.defaultAbiCoder().encode(
  ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
  [projectId, readingCount, readingIntervalMinutes, readings, fromTimestamp, "manual", metadataURI]
);
```

Batch reporting is supported via EAS's `multiAttest()` — useful for submitting multiple hourly readings in a single transaction.

---

## Sequential Attestation Model

Attestations for each project form a **gapless, sequential chain**: the `toTimestamp` of attestation N must equal the `fromTimestamp` of attestation N+1. This is enforced on-chain with O(1) cost via a single mapping -- no overlap scans required.

- The **first attestation** for a project can start at any timestamp and establishes the chain's starting point.
- Every subsequent attestation must start exactly where the previous one ended.
- Call `getProjectLastTimestamp(projectId)` to determine where the next attestation must begin. Returns `0` if the project has no attestations yet.

**Disclaimer:** The first attestation should represent the oldest available data for the project. There is no mechanism to retroactively fill gaps before the first attestation's `fromTimestamp`.

### How the Chain Works

After the first attestation, the contract enforces strict continuity:

- **First attestation**: Can start at any timestamp (establishes the chain origin)
- **Subsequent attestations**: Must start exactly at the previous attestation's `toTimestamp`

**Example flow:**

1. Attest period **1000–2000** → chain tip is now `2000`
2. Next attestation **must** start at `2000` → can be `2000–3000`, `2000–4000`, etc.
3. If you submit starting at **1500** (gap backward) → reverts with `NonSequentialAttestation(projectId, 2000, 1500)`
4. If you submit starting at **2100** (gap forward) → reverts with `NonSequentialAttestation(projectId, 2000, 2100)`
5. If you submit starting at **2000** → succeeds, chain extends

This is **O(1) enforcement**: the contract checks one value (`getProjectLastTimestamp`) per attestation, not scanning all prior periods.

---

## Corrections via Replacement

To correct a previously submitted attestation, submit a new EAS attestation with `refUID` set to the UID of the attestation being replaced.

**Rules:**

- The replacement must cover the **exact same time period** -- same `fromTimestamp` and same derived `toTimestamp`. Only the readings, method, and metadataURI can change.
- Any currently-authorized attester for the project can perform the replacement (not restricted to the original attester).
- After the replacement is recorded, the old EAS attestation **can be revoked** by calling `EAS.revoke()` on it — the resolver allows this only for attestations that have already been replaced. The SDK's `overwriteAttestation()` handles this automatically (two transactions: replace, then revoke). On EAS explorer the old attestation will appear as revoked.
- Use `getReplacementUID(uid)` to follow the replacement chain: it returns the new UID if the attestation was replaced, or `bytes32(0)` if it is still current.

**Example flow:**

```typescript
const correctedData = AbiCoder.defaultAbiCoder().encode(
  ["uint64", "uint32", "uint32", "uint256[]", "uint64", "string", "string"],
  [projectId, readingCount, readingIntervalMinutes, correctedReadings, fromTimestamp, "manual", metadataURI]
);

await eas.attest({
  schema: schemaUID,
  data: {
    recipient: ethers.ZeroAddress,
    expirationTime: NO_EXPIRATION_TIME,
    revocable: true,
    refUID: oldAttestationUid, // the UID being replaced
    data: correctedData,
    value: 0,
  },
});
```

### Replacement Chain Behavior

- **Chain tip unchanged** — Replacing any attestation in the chain does not change `getProjectLastTimestamp()`
  - Example: Project has 3 attestations: A (1000–2000), B (2000–3000), C (3000–4000). If you replace B with B', the chain tip stays at 4000. Future attestations must still start at 4000.
- **Follow the replacement trail** — Use `getReplacementUID(oldUid)` to track corrections:
  - Returns new UID if the attestation was replaced, `bytes32(0)` if current
  - Allows auditors to trace the full history: A → B → C (where C supersedes B in the data, but both exist on EAS)
- **Cannot replace an already-replaced attestation** — If you replaced attestation X with Y, you cannot later submit a replacement for X; submit a new replacement for Y instead
  - Reverts with `AttestationAlreadyReplaced(uid)` if you try to replace twice
- **Authorization is permissionless within the attester whitelist** — The IoT device that originally attested can be replaced by a manual backup attester
  - Any wallet authorized for that project (via `isProjectAttester` or `isWatcherAttester`) can submit a replacement
  - Useful for handling sensor failures or data corrections from different sources

### Accumulator Adjustment in Replacement

Replacements **atomically adjust the correct accumulator** (based on project type: generator vs. consumer):


| Scenario                   | Example                                                     | Result                                                                 |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Increase energy            | Replace 5,000 Wh with 7,000 Wh                              | Accumulator += 2,000 Wh                                                |
| Decrease energy            | Replace 5,000 Wh with 3,000 Wh                              | Accumulator -= 2,000 Wh                                                |
| Zero reading (maintenance) | Replace 5,000 Wh with 0 Wh                                  | Accumulator -= 5,000 Wh (valid: represents offline/maintenance period) |
| Project type mismatch      | Try to replace generator attestation for a consumer project | Reverts: `ReplacementProjectMismatch()`                                |


All adjustments are **atomic** in a single transaction — old value subtracted, new value added, no intermediate state.

---

## No Direct Revocation

`EAS.revoke()` is **blocked** at the resolver level for active attestations -- any attempt to directly revoke a current attestation will revert with `DirectRevocationBlocked`. The only way to correct data is the replacement mechanism described above.

**Exception:** once an attestation has been replaced (i.e. `getReplacementUID(uid) != bytes32(0)`), it **can** be revoked on EAS. The SDK's `overwriteAttestation()` does this automatically after recording the replacement, so the old attestation appears as revoked on EAS explorer while the full replacement chain remains traceable via the registry.

---

## Multi-Tenant Architecture

The contract is fully permissionless and multi-tenant. There is no central gatekeeper — any watcher can join and operate independently.

### How it works

**1. Watchers self-register**

Any wallet can call `registerWatcher(name)` and become a watcher owner. No approval needed. The caller's wallet is permanently the watcher owner (until transferred).

**2. Watchers manage their own projects**

The watcher owner registers projects under their watcher via `registerProject(watcherId, name, energyType)`. Each project gets a sequential `projectId` and is declared as either a **consumer** (`energyType = 0`) or a **generator** (`energyType = 1–N`, where the ID specifies the generation source type) at creation time — this cannot be changed later. Only the watcher owner can register, deregister, or manage attesters for their own projects.

**3. Attesters are whitelisted per project (or watcher-wide)**

Watcher owners decide who can attest:

- `addAttester(projectId, wallet)` — authorizes a wallet for a specific project only
- `addAttesters(projectId, wallets[])` — batch version; adds multiple attesters in one transaction
- `removeAttester(projectId, wallet)` / `removeAttesters(projectId, wallets[])` — revoke per-project access
- `addWatcherAttester(watcherId, wallet)` — authorizes a wallet across all projects under the watcher
- `removeWatcherAttester(watcherId, wallet)` — revokes watcher-wide access

This covers the IoT failover case: add both the device wallet and a manual backup wallet. If the device fails, attest manually.

**4. Strong tenant isolation**

- Watcher A's attesters **cannot** attest to Watcher B's projects
- Watcher A's owner **cannot** modify Watcher B's projects or attesters
- The contract enforces this at the EVM level — there is no admin override

**5. Energy accumulators**

Every attestation updates four running totals, split by project type:

- Per-project generated: `getTotalGeneratedEnergy(projectId)`
- Per-project consumed: `getTotalConsumedEnergy(projectId)`
- Per-watcher generated: `getTotalGeneratedEnergyByWatcher(watcherId)`
- Per-watcher consumed: `getTotalConsumedEnergyByWatcher(watcherId)`

Consumer project attestations never inflate generation totals, and vice versa. Replacements adjust the correct accumulator automatically.

**6. No duplicate periods**

The registry prevents the same `(projectId, fromTimestamp, toTimestamp)` combination from being attested twice. To correct a period, use the [replacement mechanism](#corrections-via-replacement) -- submit a new attestation with `refUID` pointing to the original.

**7. Watcher ownership transfer**

Watcher owners can hand off control via `transferWatcherOwnership(watcherId, newOwner)` — useful for key rotation or team changes.

**8. Project transfer**

The current watcher owner can move a project to another watcher via `transferProject(projectId, toWatcherId)`. All accumulated energy totals are migrated to the new watcher automatically. Useful when an external monitoring service takes over or a project is sold to another organization.

### Role summary


| Role                  | Who                                  | Can do                                                                              |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| **Contract owner**    | Deployer wallet                      | Authorize/deauthorize resolvers, emergency pause/unpause                            |
| **Energy type admin** | Deployer wallet (transferable)       | Register and remove generation energy types                                         |
| **Watcher owner**     | Wallet that called `registerWatcher` | Register/deregister/transfer projects, manage attesters, transfer watcher ownership |
| **Attester**          | Wallet whitelisted by watcher owner  | Submit energy attestations for authorized projects                                  |
| **Anyone**            | Any wallet                           | Register a new watcher, read all public data                                        |


### Example: two watchers on the same contract

```
EnergyRegistry (deployed once per network)
├── Watcher 1: "XYZ Solar"         (owner: 0xAlice)
│   ├── Project 1: "Farm A"
│   │   ├── Attester: 0xIoTDevice1
│   │   └── Attester: 0xAlice (manual backup)
│   └── Project 2: "Farm B"
│       └── Watcher-wide attester: 0xAuditor (authorized for all projects)
└── Watcher 2: "Wind Co"            (owner: 0xBob)
    └── Project 3: "Turbine Park"
        └── Attester: 0xIoTDevice2
```

`0xIoTDevice1` can only attest to Project 1. `0xAuditor` can attest to both Project 1 and 2 (watcher-wide). Neither can touch Watcher 2's projects.

---

## Project Metadata Standard

Each project can store a URI pointing to a JSON document with off-chain metadata. Call `setProjectMetadataURI(projectId, uri)` as the watcher owner to set or update it at any time — no contract upgrade needed. A `ProjectMetadataURISet` event is emitted on every update so indexers and explorers know to refresh.

The URI can point to IPFS (`ipfs://Qm...`) for immutable snapshots or HTTPS for a live endpoint. Use IPFS when pinning a finalized certificate, and HTTPS when you want the document to evolve (adding awards, certifications, etc.) without emitting new transactions.

**Click to expand: JSON Schema, Fields, and Design Principles** (reference only, not required for basic use)

### JSON Schema

The format is intentionally based on the **ERC-721 metadata standard** so existing explorers and indexers already understand the base fields. Energy-specific data lives in the `properties` namespace.

> **Unit reminder**: on-chain attestations always report **energy in Wh** (watt-hours accumulated over a reporting period). The metadata JSON may additionally describe the installation's **rated power in kWp** (kilowatts-peak — the maximum rate of generation). These are different physical quantities: a 100 kWp solar installation running for one hour produces 100,000 Wh.

```json
{
  "name": "Solar Farm Alpha",
  "description": "Rooftop solar installation in Nairobi, Kenya. 100 kWp rated power. IoT-monitored.",
  "image": "ipfs://QmImageHash",
  "external_url": "https://myenergyproject.com",

  "attributes": [
    { "trait_type": "Energy Type", "value": "solar" },
    { "trait_type": "Project Type", "value": "generator" },
    { "trait_type": "Installed Power (kWp)", "value": 100 },
    { "trait_type": "Country", "value": "Kenya" },
    { "trait_type": "Country Code", "value": "KE" },
    { "trait_type": "Data Collection", "value": "IoT" },
    { "trait_type": "Commissioned", "value": "2023-06-01" }
  ],

  "properties": {
    "fuel_type": "solar",
    "project_type": "generator",
    "installed_power_kwp": 100,
    "location": {
      "country": "KE",
      "region": "Nairobi",
      "lat": -1.286,
      "lon": 36.817
    },
    "certifications": [
      {
        "name": "REC",
        "issuer": "Gold Standard",
        "valid_until": "2027-01-01",
        "uri": "ipfs://QmCertificateHash"
      }
    ],
    "files": [
      {
        "uri": "ipfs://QmInstallationReport",
        "type": "application/pdf",
        "role": "installation_certificate"
      },
      {
        "uri": "https://dashboard.myenergyproject.com",
        "type": "text/html",
        "role": "live_dashboard"
      }
    ]
  },

  "version": "1",
  "updated_at": "2026-03-13T00:00:00Z"
}
```

### Field Reference

**Top-level (ERC-721 compatible — indexed by most explorers)**


| Field          | Required | Description                                                        |
| -------------- | -------- | ------------------------------------------------------------------ |
| `name`         | **Yes**  | Human-readable project name                                        |
| `description`  | No       | Free-text description                                              |
| `image`        | No       | Cover image URI (IPFS or HTTPS)                                    |
| `external_url` | No       | Project website or dashboard                                       |
| `attributes`   | No       | Array of `{ trait_type, value }` — used for filtering in explorers |


`**attributes[]` — recommended trait types**


| `trait_type`            | Example values                                                      |
| ----------------------- | ------------------------------------------------------------------- |
| `Energy Type`           | `"solar"`, `"wind"`, `"hydro"`, `"biomass"`, `"grid"`               |
| `Project Type`          | `"generator"`, `"consumer"`                                         |
| `Installed Power (kWp)` | `500` (rated power in kilowatts-peak; not the same as energy in Wh) |
| `Country`               | `"Kenya"`                                                           |
| `Country Code`          | `"KE"` (ISO 3166-1 alpha-2)                                         |
| `Data Collection`       | `"IoT"`, `"Manual"`, `"Estimated"`                                  |
| `Commissioned`          | `"2023-06-01"` (ISO 8601)                                           |
| `Grid Zone`             | `"ERCOT"`, `"EU-DE"`                                                |


`**properties` — structured energy data (parsed by EAS-aware indexers)**


| Field                           | Description                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `fuel_type`                     | `"solar"`, `"wind"`, `"hydro"`, `"biomass"`, `"nuclear"`, `"natural_gas"`                       |
| `project_type`                  | `"generator"`, `"consumer"`                                                                     |
| `installed_power_kwp`           | Rated/peak power of the installation in kilowatts (kWp). This is power (rate), not energy (Wh). |
| `location.country`              | ISO 3166-1 alpha-2 country code                                                                 |
| `location.region`               | State, province, or region name                                                                 |
| `location.lat` / `location.lon` | GPS coordinates (decimal degrees)                                                               |
| `certifications[]`              | Array of certification objects (see below)                                                      |
| `files[]`                       | Supporting documents: certificates, reports, dashboards                                         |


`**certifications[]` object**


| Field         | Description                                           |
| ------------- | ----------------------------------------------------- |
| `name`        | Certificate name (`"REC"`, `"I-REC"`, `"REGO"`, etc.) |
| `issuer`      | Issuing organization                                  |
| `valid_until` | Expiry date (ISO 8601)                                |
| `uri`         | Link to the certificate document                      |


### Design Principles

- **Fully extensible** — add any fields to `properties` without touching the contract. Indexers that don't understand custom fields simply ignore them.
- **Backwards compatible** — the base ERC-721 fields (`name`, `description`, `attributes`) are enough. All other fields are optional.
- **Update freely** — call `setProjectMetadataURI` again with a new URI whenever something changes (new certification, updated capacity, new contact). Each update emits `ProjectMetadataURISet`.
- **IPFS for permanence, HTTPS for liveness** — pin a snapshot to IPFS when you receive a certification; use an HTTPS endpoint for a live dashboard that always reflects the current state.

---

## Security: Watcher Ownership

The `watcher.owner` address is the single key that controls all projects and attesters for a watcher. By default this is the wallet that called `registerWatcher`, which is typically a single externally-owned account (EOA). **For any production deployment, strongly consider using a multisig wallet instead.**

**Click to expand: Why multisig matters and how to set it up**

### Why a multisig matters

A single EOA is a single point of failure:

- Lost private key = permanent loss of watcher admin access (projects become unmanageable)
- Compromised private key = attacker can add fraudulent attesters or deregister all projects

### Using Gnosis Safe as watcher owner

The contract treats `watcher.owner` as a plain address — it calls `msg.sender == watcher.owner` with no other constraints. A Gnosis Safe (or any smart contract wallet) works natively as the owner because Safe transactions appear as `msg.sender = safeAddress`.

**Steps:**

1. Deploy a [Gnosis Safe](https://safe.global) with your desired signers and threshold (e.g. 2-of-3)
2. Call `registerWatcher(name)` from the Safe — the Safe address becomes the watcher owner
3. All subsequent management calls (`registerProject`, `addAttester`, etc.) are executed as Safe transactions

**If you already registered with an EOA:**

- Call `transferWatcherOwnership(watcherId, safeAddress)` from the current EOA to transfer control to the Safe

> The contract owner (deployer) address should also be a multisig for the same reasons — it controls resolver authorization and emergency pause.

---

## Contract Architecture

The system is built around a permanent state layer and a replaceable logic layer, each with a distinct upgrade mechanism.

---

### System overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USERS / SDK                                    │
│              (watchers, IoT devices, project operators)                     │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │  EAS.attest() / EAS.revoke()
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    EAS (Ethereum Attestation Service)                     │
│                    — immutable, deployed by EAS team —                    │
│                                                                           │
│  Stores attestations on-chain. On every attest/revoke calls the          │
│  resolver's onAttest() / onRevoke() hook before accepting the tx.        │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │  onAttest() / onRevoke()  (hook)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│              EnergyAttestationResolver   (replaceable logic)              │
│              — deployed once per schema version —                         │
│                                                                           │
│  • Validates: attester authorized, project active, data format valid      │
│  • Stateless: only stores the registry address (immutable)                │
│  • Can be paused by owner to block new attestations                       │
└────────┬──────────────────────────────────────────────────────────────────┘
         │  read: isProjectRegistered(), isProjectAttester(), getProjectType()
         │  write: recordAttestation(), recordReplacement()
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│        EnergyRegistry PROXY   ◄── permanent address, never changes       │
│        ─────────────────────────────────────────────────────────────      │
│        EnergyRegistry IMPL    ◄── swappable via UUPS upgrade             │
│                                                                           │
│  • Owns all state: watchers, projects, attesters, energy accumulators     │
│  • Emits all events from one address → subgraph never needs repointing   │
│  • Multiple resolvers can be authorized simultaneously (migration window) │
│  • Upgradeable via UUPS: impl can change, proxy address is permanent      │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          The Graph Subgraph                               │
│              indexes EnergyRegistry events at the proxy address           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

### `EnergyRegistry.sol` — Permanent State (UUPS proxy)

Deployed **once per network**. Holds all watcher, project, attester, and energy data. Because all events are emitted here, the subgraph always indexes from the same address regardless of how many resolver or registry versions have been deployed.

Deployed as a **UUPS upgradeable proxy** (EIP-1967): the proxy address never changes; the implementation behind it can be upgraded to fix bugs or add features while preserving all on-chain state.

**Ownership:** contract owner. Only the owner can authorize/deauthorize resolvers and upgrade the implementation.

### `EnergyAttestationResolver.sol` — Replaceable Logic

The EAS hook contract. EAS calls it on every `attest`/`revoke`. It validates the data (project registered, attester authorized, data well-formed) and delegates all state reads/writes to the registry.

The resolver is **stateless** except for the immutable registry address. It can be replaced without migrating any data. Multiple versions can run simultaneously during a migration window.

**Ownership:** contract owner. Only the owner can pause/unpause.

---

## On-Chain Query Reference

All state is publicly readable from `EnergyRegistry`. For historical queries, time-series data, and dashboard use cases, see the [Subgraph](#subgraph) section.

### Watcher & Project lookups


| Function                           | Returns          | Notes                                                                                    |
| ---------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `getWatcher(watcherId)`            | `Watcher` struct | `id`, `name`, `owner`                                                                    |
| `isWatcherRegistered(watcherId)`   | `bool`           |                                                                                          |
| `getNextWatcherId()`               | `uint64`         | Iterate `1..nextWatcherId-1` to enumerate all watchers                                   |
| `getProject(projectId)`            | `Project` struct | Fields: `watcherId` (uint64), `registered` (bool), `energyType` (uint8), `name` (string) |
| `getProjectEnergyType(projectId)`  | `uint8`          | Raw stored value: `0` = consumer, `1–N` = generator energy source                        |
| `getProjectType(projectId)`        | `uint8`          | Derived: `0` = generator (energyType≠0), `1` = consumer (energyType=0)                   |
| `isProjectRegistered(projectId)`   | `bool`           | `false` for deregistered projects                                                        |
| `getProjectWatcherId(projectId)`   | `uint64`         | Which watcher owns this project                                                          |
| `getNextProjectId()`               | `uint64`         | Iterate `1..nextProjectId-1` to enumerate all projects                                   |
| `getWatcherProjects(watcherId)`    | `uint64[]`       | All project IDs ever registered under the watcher (including deregistered)               |
| `getProjectMetadataURI(projectId)` | `string`         | Off-chain metadata URI; `""` if not set                                                  |


### Attester checks


| Function                               | Returns | Notes                                           |
| -------------------------------------- | ------- | ----------------------------------------------- |
| `isProjectAttester(projectId, wallet)` | `bool`  | True if wallet is on the per-project whitelist  |
| `isWatcherAttester(watcherId, wallet)` | `bool`  | True if wallet has watcher-wide attester access |


### Energy accumulators


| Function                                      | Returns                                             |
| --------------------------------------------- | --------------------------------------------------- |
| `getTotalGeneratedEnergy(projectId)`          | `uint256` Wh — lifetime generation for the project  |
| `getTotalConsumedEnergy(projectId)`           | `uint256` Wh — lifetime consumption for the project |
| `getTotalGeneratedEnergyByWatcher(watcherId)` | `uint256` Wh — sum across all watcher projects      |
| `getTotalConsumedEnergyByWatcher(watcherId)`  | `uint256` Wh — sum across all watcher projects      |


### Attestation period & chain lookups


| Function                                                      | Returns   | Notes                                                                                |
| ------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `getAttestedPeriodUID(projectId, fromTimestamp, toTimestamp)` | `bytes32` | EAS attestation UID for the given period; `bytes32(0)` if none                       |
| `getAttestedPeriodStartUID(projectId, fromTimestamp)`         | `bytes32` | UID that occupies the start timestamp; `bytes32(0)` if free (strict-start debugging) |
| `getProjectLastTimestamp(projectId)`                          | `uint64`  | `toTimestamp` of the last attestation in the chain; `0` if no attestations yet       |
| `getReplacementUID(uid)`                                      | `bytes32` | New UID if the attestation was replaced; `bytes32(0)` if still current               |


`getProjectLastTimestamp` tells you where the next attestation must start (sequential chain). `getReplacementUID` lets you follow the replacement chain for corrected attestations.

### Energy type registry


| Function                     | Returns  |
| ---------------------------- | -------- |
| `isEnergyTypeRegistered(id)` | `bool`   |
| `getEnergyTypeName(id)`      | `string` |


### Resolver authorization


| Function                         | Returns | Notes                               |
| -------------------------------- | ------- | ----------------------------------- |
| `isAuthorizedResolver(resolver)` | `bool`  | True if the resolver can write data |


---

## Events Reference

All events are emitted by `EnergyRegistry` so they persist across resolver upgrades and can always be indexed from one address.


| Event                                                                                                | Indexed fields                              | Other fields         | Notes                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `WatcherRegistered(watcherId, name, owner)`                                                          | `watcherId`, `owner`                        | `name`               |                                                               |
| `WatcherOwnershipTransferred(watcherId, previousOwner, newOwner)`                                    | `watcherId`, `previousOwner`, `newOwner`    |                      |                                                               |
| `ProjectRegistered(projectId, watcherId, name, energyType)`                                          | `projectId`, `watcherId`                    | `name`, `energyType` | `energyType`: 0=consumer, 1–N=generator                       |
| `ProjectDeregistered(projectId)`                                                                     | `projectId`                                 |                      |                                                               |
| `ProjectTransferred(projectId, fromWatcherId, toWatcherId)`                                          | `projectId`, `fromWatcherId`, `toWatcherId` |                      |                                                               |
| `AttesterAdded(projectId, attester)`                                                                 | `projectId`, `attester`                     |                      | `projectId=0` means watcher-wide scope                        |
| `AttesterRemoved(projectId, attester)`                                                               | `projectId`, `attester`                     |                      | `projectId=0` means watcher-wide scope                        |
| `EnergyAttested(projectId, fromTimestamp, toTimestamp, energyWh, attester, energyType, metadataURI)` | `projectId`, `attester`                     | all others           | `energyType` is read from project (0=consumer, 1–N=generator) |
| `EnergyReplaced(projectId, oldUid, newUid, oldEnergyWh, newEnergyWh, attester, metadataURI, newReadings)` | `projectId`, `oldUid`, `newUid`        | all others           | Emitted when an attestation is replaced via `refUID`; `newReadings` carries the replacement readings for indexers |
| `ProjectMetadataURISet(projectId, uri)`                                                              | `projectId`                                 | `uri`                |                                                               |
| `EnergyTypeRegistered(id, name)`                                                                     | `id`                                        | `name`               |                                                               |
| `EnergyTypeRemoved(id, name)`                                                                        | `id`                                        | `name`               |                                                               |
| `EnergyTypeAdminTransferred(previousAdmin, newAdmin)`                                                | `previousAdmin`, `newAdmin`                 |                      |                                                               |
| `ResolverAuthorized(resolver)`                                                                       | `resolver`                                  |                      |                                                               |
| `ResolverDeauthorized(resolver)`                                                                     | `resolver`                                  |                      |                                                               |


---

## Custom Errors Reference

Errors are reverted by the contracts. Integrations and off-chain tooling should handle these.

`**EnergyRegistry**`


| Error                                                           | Thrown when                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `WatcherNotRegistered(watcherId)`                               | Watcher ID does not exist                                                          |
| `UnauthorizedWatcherOwner(caller, watcherId)`                   | `msg.sender` is not the watcher owner                                              |
| `ProjectNotRegistered(projectId)`                               | Project ID does not exist or was deregistered                                      |
| `AttesterAlreadyAuthorized(attester, projectId)`                | Adding an attester that is already whitelisted                                     |
| `AttesterNotAuthorized(attester, projectId)`                    | Removing an attester that is not whitelisted                                       |
| `EmptyAttesterArray()`                                          | Batch add/remove called with empty array                                           |
| `UnauthorizedResolver(caller)`                                  | Resolver not in authorized list tried to write state                               |
| `PeriodAlreadyAttested(projectId, fromTimestamp, toTimestamp)`  | Exact period already has an active attestation                                     |
| `PeriodStartAlreadyAttested(projectId, fromTimestamp)`          | A different attestation already starts at this timestamp                           |
| `InvalidEnergyType(energyType)`                                 | `registerProject` called with `energyType` that is neither 0 nor a registered type |
| `UnauthorizedEnergyTypeAdmin(caller)`                           | Caller is not the energy type admin                                                |
| `EnergyTypeNotRegistered(id)`                                   | Tried to remove a type that is not registered                                      |
| `NonSequentialAttestation(projectId, expectedFrom, actualFrom)` | Attestation `fromTimestamp` does not match the chain tip                           |
| `DirectRevocationBlocked(projectId)`                            | Direct EAS revocations are blocked                                                 |
| `ReplacementPeriodMismatch(uint64, uint64, uint64, uint64)`     | Replacement period does not match the original                                     |
| `AttestationNotFound(uid)`                                      | Old UID not found at the expected period                                           |
| `AttestationAlreadyReplaced(uid)`                               | Attestation was already replaced                                                   |


`**EnergyAttestationResolver**`


| Error                                                 | Thrown when                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `UnauthorizedAttester(attester)`                      | Submitting wallet is not on the project or watcher-wide whitelist |
| `ProjectNotRegistered(projectId)`                     | Project ID not registered (checked before registry call)          |
| `InvalidTimestamps()`                                 | Derived `toTimestamp <= fromTimestamp`                            |
| `InvalidReadingCount()`                               | `readingCount == 0`                                               |
| `InvalidReadingInterval()`                            | `readingIntervalMinutes == 0`                                     |
| `InvalidReadingsLength(readingCount, readingsLength)` | `readings.length != readingCount`                                 |
| `TimestampOverflow()`                                 | Computed `toTimestamp` exceeds `uint64.max`                       |
| `InvalidMethod()`                                     | `method` field is an empty string                                 |
| `DirectRevocationBlocked()`                           | Direct EAS revocations are blocked                                |
| `ReplacementPeriodMismatch()`                         | Replacement period does not match the original                    |
| `ReplacementProjectMismatch()`                        | Replacement targets a different project                           |


---

## Common Error Scenarios

Quick reference for developers encountering failures:


| Scenario                                           | Error                                                           | Root Cause                                                           | Fix                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Submit second attestation with gap**             | `NonSequentialAttestation(projectId, expectedFrom, actualFrom)` | `fromTimestamp` doesn't match previous `toTimestamp`                 | Call `getProjectLastTimestamp(projectId)` to find the correct starting timestamp; pass `--replace <uid>` flag if correcting existing data |
| **Try to directly revoke an attestation**          | `DirectRevocationBlocked(projectId)`                            | Direct EAS revocation is forbidden to preserve chain integrity       | Use the replacement mechanism instead: submit a new attestation with `refUID = oldUid`                                                    |
| **Replace attestation with different time period** | `ReplacementPeriodMismatch(...)`                                | Replacement must use same `fromTimestamp` and `toTimestamp`          | Keep the period identical; only change readings, method, or metadataURI                                                                   |
| **Replace attestation for wrong project**          | `ReplacementProjectMismatch()`                                  | The `refUID` attestation belongs to a different project              | Ensure the old UID and new data are for the same project                                                                                  |
| **Unauthorized wallet submits attestation**        | `UnauthorizedAttester(wallet)`                                  | Wallet is not on project or watcher-wide whitelist                   | Add the wallet via `addAttester(projectId, wallet)` or `addWatcherAttester(watcherId, wallet)`                                            |
| **Submit attestation with zero readings**          | Succeeds, energy = 0 Wh                                         | Zero energy is valid                                                 | This is intentional — represents maintenance/offline period with no production                                                            |
| **Try to replace an already-replaced attestation** | `AttestationAlreadyReplaced(uid)`                               | Attestation X was already replaced with Y; trying to replace X again | Replace Y instead (the current UID), not the superseded X                                                                                 |
| **Period already attested**                        | `PeriodAlreadyAttested(projectId, from, to)`                    | Same exact period exists as active attestation                       | Use replacement mechanism (with `refUID`) to correct it                                                                                   |
| **Attestation timestamps overflow**                | `TimestampOverflow()`                                           | Computed `toTimestamp` exceeds uint64.max                            | Use smaller `readingCount` or `readingIntervalMinutes`                                                                                    |
| **Empty readings array**                           | `InvalidReadingsLength(readingCount, 0)`                        | Provided 0 readings but `readingCount > 0`                           | Ensure `readings.length == readingCount`                                                                                                  |


---

## Upgrade & Migration Guide

There are three types of protocol changes, each with a different scope, cost, and impact:

| Type | What changes | Subgraph update | Watchers re-register | State lost |
|---|---|---|---|---|
| **Energy type** | runtime call, no deploy | No | No | No |
| **Resolver upgrade** | new resolver contract + new schema | No | Schema UID only | No |
| **Registry upgrade** | new registry implementation (UUPS) | No | No | No |

---

### Type 1 — Add a new energy generation type (no upgrade needed)

Energy types (solar, wind, hydro, etc.) are stored in the registry at runtime. Adding a new type is a single on-chain call — no contract deployment, no subgraph change, no watcher action needed.

```
owner wallet
    │
    └─► registry.registerEnergyType(14, "offshore_solar")
                    │
                    └─► writes to _energyTypeNames[14] and _energyTypeRegistered[14]
                        emits EnergyTypeRegistered(14, "offshore_solar")
```

**When to use:** new energy source needs to be tracked. The `uint8` key supports IDs 0–255 (0 is reserved as consumer sentinel; 1–13 pre-registered at deploy time; 14–255 available).

---

### Type 2 — Resolver upgrade (new validation logic or schema change)

Use this when attestation validation logic needs to change (new field, new rule, bug fix in the hook), or when the EAS schema definition itself changes. Each resolver version is tied to exactly one schema UID on EAS.

**No state is ever migrated.** All watchers, projects, attesters, and energy totals stay in the registry unchanged. Only the schema UID used when submitting attestations changes.

#### During the migration window (both resolvers active)

```
┌─────────────┐           ┌─────────────────────────────────────┐
│    Users    │           │                 EAS                  │
│ (watchers)  │           │                                      │
└──────┬──────┘           └──────────┬──────────────────────────┘
       │                             │
       │  attest with old schemaUID  │  onAttest()
       ├────────────────────────────►│ ─────────────────────────► ResolverV1 ──► Registry
       │                             │                            (authorized)
       │  attest with new schemaUID  │  onAttest()
       └────────────────────────────►│ ─────────────────────────► ResolverV2 ──► Registry
                                     │                            (authorized)
```

Both resolvers write to the same registry. All attestations go to the same state, emit the same events, and appear in the same subgraph — regardless of which resolver version processed them.

#### Step-by-step: deployer actions

```
1. Deploy new EnergyAttestationResolver(easAddress, registryProxyAddress)
        │
        └─► resolverV2Address

2. registry.authorizeResolver(resolverV2Address)
        │
        └─► both V1 and V2 are now active simultaneously

3. eas.schemaRegistry.register(newSchema, resolverV2Address, revocable)
        │
        └─► newSchemaUID  ← share this with all watchers

4. Notify watchers: update your SDK/scripts to use newSchemaUID
```

#### Step-by-step: watcher actions

```
SDK config before:  { schemaUID: "0xOLD..." }
SDK config after:   { schemaUID: "0xNEW..." }
```

That is the only change watchers make. Watcher IDs, project IDs, attester whitelists, and all accumulated energy totals carry over automatically.

#### Ending the migration window (once all watchers have migrated)

```
1. resolverV1.pause()
        │
        └─► blocks new attestations through V1 schema (reverts onAttest)

2. registry.deauthorizeResolver(resolverV1Address)
        │
        └─► removes V1 write access to the registry

3. old schemaUID is retired — existing attestations under it remain on EAS forever
```

**When to use:** changing attestation validation rules, adding new schema fields, fixing a bug in `onAttest`/`onRevoke`, or any change to the EAS schema string.

---

### Type 3 — Registry upgrade (UUPS)

Use this only when the registry's own storage or logic needs to change — new data structures, new on-chain aggregation, bug in registry state management. The **proxy address never changes**, so the subgraph data source, all resolver contracts, and all SDK configs require zero updates.

```
                    BEFORE                              AFTER

EAS ──► ResolverV2 ──► [Proxy: 0xABCD]      EAS ──► ResolverV2 ──► [Proxy: 0xABCD]
                             │                                            │
                        [Impl V1]                                    [Impl V2]
                        (old code)                                   (new code)
                                                                  same storage ✓
                                                              same proxy address ✓
```

#### Step-by-step: deployer actions

```
1. Write and audit RegistryV2.sol
        │
        └─► must inherit from RegistryV1 layout:
            - never reorder or remove existing state variables
            - append new variables BEFORE __gap
            - reduce __gap by N for each N new uint256-equivalent variable added

2. Deploy bare RegistryV2 implementation (initialize() is blocked by _disableInitializers)
        │
        └─► implV2Address

3. registry.upgradeToAndCall(implV2Address, "0x")   ← called from owner wallet
        │
        ├─► proxy now delegates to implV2
        ├─► all storage (watchers, projects, energy totals) is untouched
        └─► subgraph continues indexing from the same proxy address, no reindex needed

4. Verify: registry.getNextWatcherId() still returns expected value
           registry.getWatcher(1) still returns correct data
```

#### Storage safety rules (mandatory)

```
// V1 state variables (DO NOT TOUCH):
mapping(address => bool) private _authorizedResolvers;   // slot 2
mapping(uint64 => Watcher) private _watchers;            // slot 3
uint64 private _nextWatcherId;                           // slot 4
// ... (slots 5–21) ...
address private _energyTypeAdmin;                        // slot 21
uint256[50] private __gap;                               // slots 22–71

// V2: adding 2 new variables → reduce gap from 50 to 48
address private _energyTypeAdmin;                        // slot 21  ← unchanged
address private _newFeatureAddress;                      // slot 22  ← new variable
uint256 private _newFeatureConfig;                       // slot 23  ← new variable
uint256[48] private __gap;                               // slots 24–71  ← 50 - 2 = 48
```

Rule: **consumed slots + remaining gap must always equal 50.**

**When to use:** adding new on-chain aggregation fields, changing registry data structures, fixing a state-management bug in `recordAttestation`/`recordReplacement`. Do not use for attestation validation changes — that is a resolver upgrade.

---

### What each upgrade affects

```
                     Energy type    Resolver upgrade    Registry upgrade
                     (runtime call) (new deploy)        (UUPS)
─────────────────────────────────────────────────────────────────────────
Proxy address          unchanged      unchanged           unchanged
Registry state         unchanged      unchanged           unchanged
Subgraph reindex       no             no                  no
Watchers re-register   no             no                  no
Watchers update SDK    no             schemaUID only       no
EAS schema             unchanged      new schema + UID     unchanged
Resolver address       unchanged      new address          unchanged
```

---

## Subgraph

The Energy Attestation Service subgraph indexes all `EnergyRegistry` events and exposes them via a GraphQL API, enabling dashboards and analytics without reading directly from the chain.

**Endpoint (Polygon Amoy):**
```
https://api.studio.thegraph.com/query/119110/energy-attestation-service/version/latest
```

### Entities

| Entity | Description |
|---|---|
| `Protocol` | Global counters — total watchers, projects, attestations, and energy |
| `Watcher` | Registered watcher with owner, project count, and energy totals |
| `Project` | Energy project with type, accumulated Wh, and attestation count |
| `EnergyAttestation` | Individual attestation with readings array, timestamps, and attester |
| `DailyEnergySnapshot` | Per-project daily aggregates for time-series charts |
| `EnergyType` | Registered energy generation types (solar_pv, wind_onshore, etc.) |
| `ProjectAttester` | Per-project attester whitelist entries |
| `WatcherAttester` | Watcher-wide attester whitelist entries |
| `WatcherOwnershipTransfer` | Historical ownership transfer log |

### Example queries

**Protocol overview:**
```graphql
{
  protocol(id: "protocol") {
    totalWatchers
    totalProjects
    totalAttestations
    totalGeneratedWh
  }
}
```

**Attestations for a project:**
```graphql
{
  energyAttestations(
    where: { project: "1" }
    orderBy: fromTimestamp
    orderDirection: asc
  ) {
    id
    fromTimestamp
    toTimestamp
    energyWh
    readings
    energyType { name }
    attester
    replaced
  }
}
```

**Daily time-series for a project:**
```graphql
{
  dailyEnergySnapshots(
    where: { project: "1" }
    orderBy: timestamp
    orderDirection: asc
  ) {
    date
    generatedWh
    attestationCount
  }
}
```

### Subgraph development

The subgraph source lives in `subgraph/`. After any contract change that modifies events:

```bash
npm run compile          # recompile contracts
npm run copy-abi         # copy fresh ABI to subgraph/abis/
cd subgraph
npm run codegen          # regenerate AssemblyScript types
npm run build            # compile to WASM
npm run deploy:amoy      # deploy to The Graph Studio
```

---

## Supported Networks

**Reference** (contract deployment addresses)


| Network                | EAS                                          | SchemaRegistry                               |
| ---------------------- | -------------------------------------------- | -------------------------------------------- |
| Polygon Mainnet        | `0x5E634ef5355f45A855d02D66eCD687b1502AF790` | `0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7` |
| Polygon Amoy (testnet) | `0xb101275a60d8bfb14529C421899aD7CA1Ae5B5Fc` | `0x23c5701A1BDa89C61d181BD79E5203c730708AE7` |
| Celo Mainnet           | `0x72E1d8ccf5299fb36fEfD8CC4394B8ef7e98Af92` | `0x5ece93bE4BDCF293Ed61FA78698B594F2135AF34` |

**Deployed contracts**

| Network                | EnergyRegistry                               | EnergyAttestationResolver                    | Schema UID                                                           |
| ---------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Celo Mainnet           | `0x644Dd384FCF5d94da98Bf8F6F10C448426974d29` | `0xB6Cefe51DA3bC7cfCEa9D3d7440348a7ac91e14c` | `0xbca196f2a002d6c29cddd85eb41637d2804d50c5c37faae85c15b375253844ef` |
| Polygon Mainnet        | `0x644Dd384FCF5d94da98Bf8F6F10C448426974d29` | `0xB6Cefe51DA3bC7cfCEa9D3d7440348a7ac91e14c` | `0xbca196f2a002d6c29cddd85eb41637d2804d50c5c37faae85c15b375253844ef` |
| Polygon Amoy (testnet) | `0x059D4655941204cf6aaC1cF578Aa9dc5D3ed6B39` | `0x7DF77a7EA812c731Df67559D0277CCdF7A9eEbc3` | `0x4673141c77c3d54962edf6ef7f25a0c62656f9bd08138b4c4f9561413c235435` |


---

## Prerequisites

- Node.js 22.10+ (LTS recommended)
- A wallet private key with testnet/mainnet funds for gas
- For Polygon Amoy: get free MATIC from the [Polygon Amoy faucet](https://faucet.polygon.technology)

---

## Setup

```bash
npm install
```

Copy the environment template and fill in your values:

```bash
cp .env.example .env
```

`.env` fields:

```
PRIVATE_KEY_DEPLOYER=0x...  # deployer / contract owner wallet private key
PRIVATE_KEY_WATCHER=0x...   # watcher owner / attester wallet private key
REGISTRY_ADDRESS=0x...      # filled after step 2
RESOLVER_ADDRESS=0x...      # filled after step 2
SCHEMA_UID=0x...            # filled after step 3
```

---

## Deployment Guide (operators)

Use this flow if you are **deploying the contracts yourself** (e.g. as an operator or protocol owner). The example below uses Polygon Amoy testnet; replace `amoy` with `polygon` or `celo` for production.

### Step 1 — Compile

```bash
npx hardhat compile
```

### Step 2 — Deploy both contracts

```bash
npx hardhat run scripts/deploy.ts --network amoy
```

This deploys the `EnergyRegistry` implementation + `ERC1967Proxy` (calling `initialize` in the same transaction), then deploys `EnergyAttestationResolver` and authorizes it on the registry. Everything is saved to `deployments/amoy.json`.

The script prints two registry addresses:
- **implementation** — the bare logic contract (needed for Etherscan verification only)
- **proxy** — the permanent address that everything else uses

Copy the **proxy** address into `REGISTRY_ADDRESS` and the resolver address into `RESOLVER_ADDRESS` in your `.env`.

> **Wallet roles:** On real networks, Hardhat is configured to use:
>
> - `PRIVATE_KEY_DEPLOYER` as the **deployer/owner** wallet (used by `scripts/deploy.ts`)
> - `PRIVATE_KEY_WATCHER` as the **watcher owner / attester** wallet (used by `scripts/setup.ts`, `scripts/attest.ts`, `scripts/query-watcher.ts`)
>
> This separation lets you exercise realistic permission levels in tests and scripts (owner vs watcher vs attester).

### Step 3 — Register the schema

Set `RESOLVER_ADDRESS` and `REGISTRY_ADDRESS` in `.env` first, then:

```bash
npx hardhat run scripts/register-schema.ts --network amoy
```

This registers the following schema on EAS:

```
uint64 projectId, uint32 readingCount, uint32 readingIntervalMinutes, uint256[] readings, uint64 fromTimestamp, string method, string metadataURI
```

Copy the printed `Schema UID` into `SCHEMA_UID` in your `.env`. The schema UID is deterministic based on the schema string + resolver address — registering the same schema twice on the same network will return the same UID without creating a duplicate.

### Step 4 — Register your watcher and project

```bash
npx hardhat run scripts/setup.ts --network amoy
```

The script is interactive. It first asks what you want to do:

```
What would you like to do?
  1) Register a new watcher
  2) Register a new project
```

**Option 1 — Register a watcher**

```
Watcher name: My Energy Co

✓ Watcher registered!
  Watcher ID : 1
  Name       : My Energy Co
```

Note the watcher ID — you'll need it to register projects.

**Option 2 — Register a project**

```
Watcher ID: 1
Project name: Solar Farm Alpha

Project energy type:
   0  consumer  (grid import, operational load, etc.)
   1  solar_pv
   2  wind_onshore
   ...
  13  hydrogen_fuel_cell
Enter type ID: 1

Attester wallet address (leave blank to use your wallet 0xAbc...):

✓ Project registered!
  Project ID   : 1
  Name         : Solar Farm Alpha
  Energy type  : solar_pv (1)
  Watcher ID   : 1
  Attester     : 0xAbc...
```

The attester defaults to your watcher wallet if left blank. Note the project ID — you'll need it to submit attestations.

> **Security tip:** Consider using a Gnosis Safe as the watcher owner instead of a plain EOA — see the [Security: Watcher Ownership](#security-watcher-ownership) section.

---

## Using an existing deployment (watchers & testers)

Use this flow if the contracts are **already deployed** and you just want to:

- point your `.env` to an existing `EnergyRegistry` / `EnergyAttestationResolver`,
- use your own watcher wallet to register a watcher and projects,
- submit a few example attestations.

### Step A — Point `.env` at the deployment

Ask the deployment owner / protocol operator for:

- `REGISTRY_ADDRESS`
- `RESOLVER_ADDRESS`
- `SCHEMA_UID`

Then update your `.env`:

```bash
PRIVATE_KEY_WATCHER=0x...   # your watcher / attester wallet
REGISTRY_ADDRESS=0x...      # provided by operator
RESOLVER_ADDRESS=0x...      # provided by operator
SCHEMA_UID=0x...            # provided by operator
```

> You **do not** need `PRIVATE_KEY_DEPLOYER` if you are only acting as a watcher/tester against an existing deployment.

### Step B — Register your watcher & project

Run the same setup script, but only with `PRIVATE_KEY_WATCHER` configured:

```bash
npx hardhat run scripts/setup.ts --network amoy
```

The prompts and outputs are identical to the deployment flow: first register a watcher (Option 1), then a project (Option 2). Note the watcher ID and project ID for later.

> The attester defaults to your watcher wallet when you leave the attester address blank.

### Step C — Submit an attestation

Make sure `SCHEMA_UID` is set in `.env`, then:

```bash
npx hardhat run scripts/attest.ts --network amoy
```

The script is fully interactive and guides you through each field:

```
Network  : amoy
Attester : 0xAbc...

Energy report JSON path [default: examples/energy_report.json]:
  → Project: generator (solar_pv)

─────────────────────────────────────────────
  Attestation summary
  Project ID  : 1
  Type        : generator (solar_pv)
  Period      : 1741996800 → 1742000400 (derived)
  Readings    : 60 × 1 min
  Energy      : 5,000 Wh
  Method      : manual
─────────────────────────────────────────────

Submit? (y/N): y

Submitting...

✓ Attestation submitted!
  Tx hash: 0x...
```

**Notes:**

- `energyType` is no longer prompted — it is read from the project registration and shown as context only
- The script loads readings from a JSON report file; a manual entry mode is also available
- Reporting period and energy are derived from `fromTimestamp`, `readingCount`, and `readingIntervalMinutes`
- Collection method defaults to `manual` if not set in the report file
- Metadata URI is optional — paste an IPFS CID or HTTPS URL to attach supporting evidence, or leave blank
- The script calls `getProjectLastTimestamp(projectId)` before submitting and displays the expected `fromTimestamp`
- Pass `--replace <uid>` to correct an existing attestation instead of creating a new one
- The summary shows `Mode: NEW` or `Mode: REPLACE` accordingly

### Step 6 — Query on-chain totals

To verify the attestation was recorded and check energy totals for your watcher:

```bash
npx hardhat run scripts/query-watcher.ts --network amoy
```

The script will prompt for a watcher ID and print a full summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Watcher #1: My Energy Co
  Owner: 0xAbc...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Watcher totals
    Generated : 5.000 kWh  (5,000 Wh)
    Consumed  : 0 Wh

  Projects (1)
  ────────────────────────────────────────────────

  Project #1: Solar Farm Alpha  [active]  [generator]
    Generated : 5.000 kWh  (5,000 Wh)
```

To skip the prompt, pass the watcher ID via env var:

```bash
WATCHER_ID=1 npx hardhat run scripts/query-watcher.ts --network amoy
```

### Step 7 — Verify on EAS Explorer

After attesting, search by your wallet address or schema UID to see all attestations.

**Polygon Amoy (testnet)**

- Attestations: [polygon-amoy.easscan.org](https://polygon-amoy.easscan.org)
- Transactions: [amoy.polygonscan.com](https://amoy.polygonscan.com)

**Polygon Mainnet**

- Attestations: [polygon.easscan.org](https://polygon.easscan.org)
- Transactions: [polygonscan.com](https://polygonscan.com)

**Celo Mainnet**

- Attestations: [celo.easscan.org](https://celo.easscan.org)
- Transactions: [celoscan.io](https://celoscan.io)

---

## Linting

The project has two linters configured — one for Solidity and one for TypeScript.

### Run both

```bash
npm run lint
```

### Solidity — Solhint

```bash
npm run lint:sol
```

Checks all contracts in `contracts/**/*.sol`. Rules enforced:

- Compiler version pinned to `0.8.28`
- Immutable variables must be `SNAKE_CASE`
- Struct fields ordered for storage slot packing
- `++i` increment style in loops (gas saving)

### TypeScript — ESLint

```bash
npm run lint:ts
```

Checks all files in `scripts/` and `test/`. Uses `typescript-eslint` with unused variable warnings. Generated artifacts (`artifacts/`, `cache/`, `typechain-types/`) are ignored.

---

## Running Tests

```bash
npx hardhat test
```

186 tests covering:

**Core Attestation & Chain Enforcement:**

- Watcher registration, ownership transfer, and project transfer
- Attester management (per-project and watcher-wide)
- Project registration and deregistration — including `energyType` validation at registration time
- Project type (generator vs consumer) — routing via `energyType`, `getProjectType`, `getProjectEnergyType`
- Attestation validation (energy, timestamps, method, access control)

**Sequential Attestation Enforcement:**

- Linear chain validation — `toTimestamp(N) == fromTimestamp(N+1)` gapless enforcement
- First attestation can start at any timestamp (chain origin)
- Subsequent attestations must start at chain tip (`getProjectLastTimestamp`)
- Rejections for gaps: `NonSequentialAttestation` when `fromTimestamp != expectedFrom`
- Chain independence: Project A's chain does not affect Project B

**Replacement Mechanism:**

- Corrections via replacement — same period, `refUID` linkage, accumulator adjustment
- Atomic accumulator updates (subtract old, add new in one transaction)
- Replacement chain tracking via `getReplacementUID` — follow the audit trail
- Period enforcement: replacement period must match original exactly
- Authorization: any project/watcher-wide attester can replace (not just original)
- Edge cases: cannot replace already-replaced attestations, replacements don't change chain tip
- Chained replacements: A→B→C via successive `refUID` links

**No Direct Revocation:**

- `EAS.revoke()` blocked at resolver level with `DirectRevocationBlocked` error
- All corrections must use replacement mechanism (preserves chain integrity)

**Additional Coverage:**

- Energy type registry — admin role, register, remove, transfer admin
- Tenant isolation (Watcher A cannot interfere with Watcher B)
- Watcher and project energy accumulators (accumulation + replacement adjustment)
- Duplicate period detection (same project/period rejected) + strict start-time uniqueness
- `getWatcherProjects` (returns all project IDs, including deregistered)
- Project metadata URI (set/update/access control, isolated per project)
- Attestation metadata URI (optional IPFS/HTTPS URI per attestation, emitted in event)
- Resolver authorization (only authorized resolvers can write to the registry)
- Emergency pause (gates attestations and replacements)
- Batch operations and boundary values
- Deregistered project behavior (blocking new attestations and replacements)

---

**Scripts Reference** (quick lookup of available deployment and interaction scripts)


| Script                       | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `scripts/deploy.ts`          | Deploy `EnergyRegistry` + `EnergyAttestationResolver`, authorize resolver  |
| `scripts/register-schema.ts` | Register the energy schema on EAS SchemaRegistry                           |
| `scripts/setup.ts`           | Interactive — register a watcher or a project with attester                |
| `scripts/attest.ts`          | Interactive — submit an energy attestation with guided prompts             |
| `scripts/query-watcher.ts`   | Print a full energy summary for a watcher (totals + per-project breakdown) |



---

## Security Notes

- **Per-project attester whitelisting** — a compromised IoT device can only affect its specific project, not the whole watcher
- **Duplicate period detection** — prevents double-counting; same period can only be attested once per project; use the replacement mechanism to correct. Additionally, the registry enforces **strict start-time uniqueness**: only one attestation per `(projectId, fromTimestamp)` even if durations differ.
- **No direct revocation** — `EAS.revoke()` is blocked at the resolver level; corrections are only possible via the replacement mechanism, preserving sequential chain integrity
- **Metadata URI** — only the watcher owner can update the metadata URI; use IPFS for immutable certificate snapshots
- **Emergency pause** — call `pause()` on the resolver from the contract owner wallet if a bug is discovered; all attestations and replacements are blocked while paused
- **Registry is permanent** — never replace or upgrade the registry; all historical data, accumulators, and event history live there
- **Resolver is replaceable** — deploy a new resolver, authorize it, register a new schema, notify watchers of the new schema UID
- **Contract ownership** — use `transferOwnership()` (two-step via `Ownable2Step`) to hand off the global pause role; `renounceOwnership` is permanently disabled on both contracts
- **Watcher ownership — use `transferWatcherOwnership()` for key rotation; there is no recovery if the watcher owner key is lost, so use a hardware wallet or multisig

---

## License

MIT