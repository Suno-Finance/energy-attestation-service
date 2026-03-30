export interface NetworkAddresses {
  eas: string;
  schemaRegistry: string;
}

// https://docs.attest.org/docs/quick--start/contracts#deployments
export const EAS_NETWORK_ADDRESSES: Record<string, NetworkAddresses> = {
  amoy: {
    eas: "0xb101275a60d8bfb14529C421899aD7CA1Ae5B5Fc",
    schemaRegistry: "0x23c5701A1BDa89C61d181BD79E5203c730708AE7",
  },
  polygon: {
    eas: "0x5E634ef5355f45A855d02D66eCD687b1502AF790",
    schemaRegistry: "0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7",
  },
  celo: {
    eas: "0x72E1d8ccf5299fb36fEfD8CC4394B8ef7e98Af92",
    schemaRegistry: "0x5ece93bE4BDCF293Ed61FA78698B594F2135AF34",
  }
};

export function getNetworkAddresses(networkName: string): NetworkAddresses {
  const addresses = EAS_NETWORK_ADDRESSES[networkName];
  if (!addresses) {
    throw new Error(
      `No EAS addresses configured for network: "${networkName}". ` +
      `Supported networks: ${Object.keys(EAS_NETWORK_ADDRESSES).join(", ")}`
    );
  }
  return addresses;
}
