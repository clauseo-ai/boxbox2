/* the dictionary as plain data: the envelope, every kind with its props,
   and the device classes, in schema.ts order. `bun scripts/telemetry.ts
   dictionary --json` prints it, telemetry/schema.json is that output
   committed, and the rust server's build generates its ingest from the
   json (decision 17). unlike `schema --json`, nothing here depends on
   what the log holds, so the output is byte-stable. */

import { DEVICE_CLASSES, ENVELOPE, EVENTS } from "./schema";

export type Dictionary = {
  envelope: { name: string; type: string; doc: string }[];
  events: {
    kind: string;
    doc: string;
    props: { name: string; type: string; doc: string; values?: readonly string[]; required?: true }[];
  }[];
  deviceClasses: readonly string[];
};

export function dictionary(): Dictionary {
  return {
    envelope: Object.entries(ENVELOPE).map(([name, spec]) => ({ name, type: spec.type, doc: spec.doc })),
    events: Object.entries(EVENTS).map(([kind, spec]) => ({
      kind,
      doc: spec.doc,
      props: Object.entries(spec.props).map(([name, prop]) => ({
        name,
        type: prop.type,
        doc: prop.doc,
        ...("values" in prop && prop.values ? { values: prop.values } : {}),
        ...("required" in prop && prop.required ? { required: prop.required } : {}),
      })),
    })),
    deviceClasses: DEVICE_CLASSES,
  };
}

/** the exact bytes of telemetry/schema.json */
export function dictionaryJson(): string {
  return `${JSON.stringify(dictionary(), null, 2)}\n`;
}
