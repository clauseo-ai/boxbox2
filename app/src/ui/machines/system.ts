/* what a machine card says about the machine itself, from the host's `system` sample (server/src/upstream/system.rs,
   cmx2's GET /global/system): which os mark it wears, the line that names it, three meters (cpu, memory, disk) and the
   spec line under them. pure, so the words and the thresholds are tested without a page (system.test.ts) and the card
   only lays them out (design.md, the machines: what a machine is). */

import type { HostStatus } from "../../api/client";

export type HostSystem = NonNullable<HostStatus["system"]>;
export type OsMark = "apple" | "windows" | "ubuntu" | "debian" | "linux" | "machine";
export type MeterKind = "cpu" | "memory" | "disk";

export type Meter = {
  kind: MeterKind;
  /** how full, 0 to 1, as the track draws it */
  fill: number;
  /** the right-hand figure: a percent of the cores' capacity, or of the memory or disk in use */
  value: string;
  /** the words between the name and the figure */
  detail: string;
  /** the load over 5 and 15 minutes as fills, for the cpu's two marks; none for the others */
  marks: [number, number] | null;
  /** past the line where the machine is short of it: the cpu saturated (its figure then past 100%), memory or disk
      nearly gone (its detail then ends "low") */
  warn: boolean;
  /** everything the meter says, for a screen reader */
  label: string;
};

/** the cpu is saturated once its 1 minute load reaches its cores */
export const LOAD_WARN = 1;
/** memory or disk is short under a tenth free */
export const FREE_WARN = 0.1;
/** and a disk under 5 gb free is short whatever its size */
export const DISK_FLOOR = 5e9;

const GIB = 1024 ** 3;

/** the mark the card's tile draws: the os's own where boxbox draws one, a generic linux for other distributions, a
    plain machine where the os is not known (an older cmx2, a host never reached) */
export function osMark(system: HostSystem | null | undefined): OsMark {
  if (!system) return "machine";
  const platform = system.os.platform.toLowerCase();
  if (platform === "darwin") return "apple";
  if (platform === "win32") return "windows";
  if (platform !== "linux") return "machine";
  const name = system.os.name.toLowerCase();
  if (name.includes("ubuntu")) return "ubuntu";
  if (name.includes("debian")) return "debian";
  return "linux";
}

/** "Mac mini · macOS 26.1", "Google Compute Engine · Ubuntu 24.04", "Ubuntu 24.04". the machine's own words keep their
    case: they are names. a vm that does not say what it is says it is a vm */
export function identity(system: HostSystem): string {
  const model = system.machine.model?.trim() || (system.machine.virtual ? "virtual machine" : "");
  const os = `${system.os.name} ${system.os.version}`.trim();
  return [model, os].filter(Boolean).join(" · ");
}

/** the three meters, in the order a person reads a machine's health */
export function meters(system: HostSystem): Meter[] {
  const out = [cpuMeter(system), memoryMeter(system)];
  const disk = diskMeter(system);
  if (disk) out.push(disk);
  return out;
}

function cpuMeter(system: HostSystem): Meter {
  const cores = Math.max(1, system.cpu.cores);
  const [one = 0, five = 0, fifteen = 0] = system.cpu.load;
  const share = one / cores;
  const warn = share >= LOAD_WARN;
  const load = loadText(one);
  const coreWord = `${cores} ${cores === 1 ? "core" : "cores"}`;
  return {
    kind: "cpu",
    fill: clamp(share),
    value: `${Math.round(share * 100)}%`,
    // past 100% the figure says the cores are saturated in words of its own; the detail stays short enough for a phone
    detail: `load ${load} · ${coreWord}`,
    marks: [clamp(five / cores), clamp(fifteen / cores)],
    warn,
    label: `cpu${warn ? ", load high" : ""}: load ${load} on ${coreWord}, ${loadText(five)} over 5 minutes, ${loadText(fifteen)} over 15`,
  };
}

function memoryMeter(system: HostSystem): Meter {
  const { total, available } = system.memory;
  const used = Math.max(0, total - available);
  const share = total > 0 ? used / total : 0;
  const warn = total > 0 && available / total < FREE_WARN;
  const detail = warn ? `${size(available, GIB)} gb free · low` : `${size(used, GIB)} of ${size(total, GIB)} gb`;
  return {
    kind: "memory",
    fill: clamp(share),
    value: `${Math.round(share * 100)}%`,
    detail,
    marks: null,
    warn,
    label: `memory${warn ? ", low" : ""}: ${size(used, GIB)} of ${size(total, GIB)} gb in use, ${size(available, GIB)} gb free`,
  };
}

/* a disk is counted in the drive's own units (1 gb is 10^9 bytes, as its box and the finder say), memory in the binary
   ones its size is sold in (16 gb is 2^34 bytes) */
function diskMeter(system: HostSystem): Meter | null {
  const disk = system.disk;
  if (!disk || disk.total <= 0) return null;
  const used = Math.max(0, disk.total - disk.available);
  const share = used / disk.total;
  const warn = disk.available / disk.total < FREE_WARN || disk.available < DISK_FLOOR;
  return {
    kind: "disk",
    fill: clamp(share),
    value: `${Math.round(share * 100)}%`,
    detail: `${bytes(disk.available)} free${warn ? " · low" : ""}`,
    marks: null,
    warn,
    label: `disk${warn ? ", low" : ""}: ${bytes(disk.available)} free of ${bytes(disk.total)}`,
  };
}

/** the spec line under the meters: the cpu's model and the architecture, then how long the host has been up (only
    while it is connected and the sample is this connection's) or, while it is away, when the meters were read */
export function spec(system: HostSystem, upFor: string | null, readAt: string | null): string {
  const parts = [system.cpu.model.trim(), system.os.arch.trim()];
  if (upFor) parts.push(`up ${upFor}`);
  else if (readAt) parts.push(`as of ${readAt}`);
  return parts.filter(Boolean).join(" · ");
}

/** a span of time in the largest unit that fits it, whole: "12 s", "4 min", "3 h", "2 days" */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  const days = Math.floor(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** a load average to two places under 10 and one above, as uptime prints it short */
function loadText(load: number): string {
  return load < 10 ? load.toFixed(2) : load.toFixed(1);
}

/** a size in a unit, one place under 10 and whole above: "3.6", "41", "64" */
function size(n: number, unit: number): string {
  const v = n / unit;
  return v < 10 ? trim(v.toFixed(1)) : String(Math.round(v));
}

/** a disk's bytes in gb, or tb from a thousand gb */
function bytes(n: number): string {
  return n >= 1e12 ? `${size(n, 1e12)} tb` : `${size(n, 1e9)} gb`;
}

/** "64.0" reads as "64" */
function trim(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
