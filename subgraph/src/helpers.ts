import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Protocol } from "../generated/schema";

export function loadOrCreateProtocol(): Protocol {
  let protocol = Protocol.load("protocol");
  if (protocol == null) {
    protocol = new Protocol("protocol");
    protocol.totalWatchers = 0;
    protocol.totalProjects = 0;
    protocol.totalAttestations = 0;
    protocol.totalGeneratedWh = BigInt.fromI32(0);
    protocol.totalConsumedWh = BigInt.fromI32(0);
    protocol.energyTypeAdmin = Bytes.empty();
  }
  return protocol;
}

// Converts a Unix timestamp (BigInt, seconds) to a YYYY-MM-DD string.
// Uses the proleptic Gregorian calendar algorithm.
export function timestampToDateString(timestamp: BigInt): string {
  let totalDays = timestamp.toI64() / 86400;

  let z = totalDays + 719468;
  let era = (z >= 0 ? z : z - 146096) / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y = y + 1;

  let monthStr = m < 10 ? "0" + m.toString() : m.toString();
  let dayStr = d < 10 ? "0" + d.toString() : d.toString();

  return y.toString() + "-" + monthStr + "-" + dayStr;
}

// Returns the Unix timestamp for the start of the day (midnight UTC).
export function dayStartTimestamp(timestamp: BigInt): BigInt {
  let seconds = timestamp.toI64();
  return BigInt.fromI64((seconds / 86400) * 86400);
}
