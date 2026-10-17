/* machines as cmx2's GET /global/system describes them, for the card's tests and stories. the shapes are the contract's
   (vendor/cmx2/openapi.json, SystemResponse); the numbers follow what real daemons answered (a mac and a linux
   container, cmx2 abfde5b), with placeholder models so nothing names a real machine. `sampledAt` is set by the caller. */

import type { HostSystem } from "./system";

const GIB = 1024 ** 3;

/** a desk mac, comfortable */
export function macMini(sampledAt: number): HostSystem {
  return {
    os: { platform: "darwin", name: "macOS", version: "26.1", kernel: "25.1.0", arch: "arm64" },
    machine: { model: "Mac mini", identifier: "Mac16,11", virtual: false },
    cpu: { model: "Apple M4 Pro", cores: 14, load: [2.41, 1.98, 1.7] },
    memory: { total: 64 * GIB, available: 22.8 * GIB },
    disk: { path: "/System/Volumes/Data", total: 994_662_584_320, available: 212_633_266_688 },
    uptime: 9 * 86_400 + 4 * 3600,
    daemon: { rss: 312 * 1024 * 1024, uptime: 3 * 3600 + 120 },
    at: sampledAt,
    sampledAt,
  };
}

/** a cloud vm, the model its hypervisor reports */
export function cloudVm(sampledAt: number): HostSystem {
  return {
    os: { platform: "linux", name: "Ubuntu", version: "24.04", kernel: "6.8.0-1015-gcp", arch: "x64" },
    machine: { model: "Google Compute Engine", identifier: null, virtual: true },
    cpu: { model: "AMD EPYC 7B13", cores: 4, load: [0.62, 0.48, 0.51] },
    memory: { total: 16 * GIB, available: 11.1 * GIB },
    disk: { path: "/", total: 103_865_303_040, available: 61_203_525_632 },
    uptime: 41 * 86_400,
    daemon: { rss: 148 * 1024 * 1024, uptime: 6 * 86_400 },
    at: sampledAt,
    sampledAt,
  };
}

/** a linux box that does not say what it is: no model, not virtual, a distribution boxbox has no mark for */
export function bareLinux(sampledAt: number): HostSystem {
  return {
    os: { platform: "linux", name: "Arch Linux", version: "", kernel: "6.19.13-arch1-1", arch: "x64" },
    machine: { model: null, identifier: null, virtual: false },
    cpu: { model: "Intel Core i7-12700", cores: 20, load: [0.11, 0.06, 0.02] },
    memory: { total: 7.8 * GIB, available: 7 * GIB },
    disk: { path: "/", total: 61_751_468_032, available: 47_886_880_768 },
    uptime: 18 * 3600,
    daemon: { rss: 142 * 1024 * 1024, uptime: 7 },
    at: sampledAt,
    sampledAt,
  };
}

/** a laptop under strain: its load past its cores, memory nearly gone, the disk nearly full */
export function strainedLaptop(sampledAt: number): HostSystem {
  return {
    os: { platform: "darwin", name: "macOS", version: "27.0.1", kernel: "27.0.0", arch: "arm64" },
    machine: { model: "MacBook Pro", identifier: "MacBookPro18,3", virtual: false },
    cpu: { model: "Apple M1 Pro", cores: 8, load: [17.3, 12.37, 7.46] },
    memory: { total: 16 * GIB, available: 1.2 * GIB },
    disk: { path: "/System/Volumes/Data", total: 494_353_338_368, available: 4_887_507_456 },
    uptime: 152_439,
    daemon: { rss: 110 * 1024 * 1024, uptime: 7 * 3600 },
    at: sampledAt,
    sampledAt,
  };
}
