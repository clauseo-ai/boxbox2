/* a8: openapi tells the truth. the daemon does not serve its openapi
   document, so this reads the one the pinned commit ships
   (packages/client/openapi.json in the export, the file boxbox vendors):
   409 declared where the routes return it, Part and SessionStatus as
   discriminated unions on type, and queued on the 202 of /prompt. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE } from "../scripts/pinned";
import { type Context, type Json, list, type Probe, record } from "./probe";

type Doc = { paths: Json; components: { schemas: Json } };

function resolveRef(doc: Doc, schema: unknown): Json {
  const ref = record(schema).$ref;
  if (typeof ref !== "string") return record(schema);
  return record(doc.components.schemas[ref.replace("#/components/schemas/", "")]);
}

/** why `name` is not a union discriminated on `type`, or undefined when it is: every arm an object
    whose `type` is one const, no two arms the same */
function notDiscriminated(doc: Doc, name: string): string | undefined {
  const schema = record(doc.components.schemas[name]);
  const arms = list(schema.oneOf ?? schema.anyOf).map((arm) => resolveRef(doc, arm));
  if (arms.length === 0) {
    const type = record(record(schema.properties).type);
    return `${name} is one object with type: ${JSON.stringify(type.type)}${schema.additionalProperties === true ? " and additionalProperties: true" : ""}`;
  }
  const tags = arms.map((arm) => {
    const type = record(record(arm.properties).type);
    const one = list(type.enum);
    return type.const ?? (one.length === 1 ? one[0] : undefined);
  });
  const loose = tags.findIndex((tag) => typeof tag !== "string");
  if (loose >= 0) return `arm ${loose + 1} of ${arms.length} has no single-value type`;
  if (new Set(tags).size !== tags.length) return `two arms share a type: ${tags.join(", ")}`;
  return undefined;
}

export const a8: Probe = {
  ask: "a8",
  title: "openapi tells the truth",
  async run(ctx: Context) {
    const path = join(SOURCE, "packages/client/openapi.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as Doc;
    ctx.note(`reading ${path.replace(`${SOURCE}/`, "the pinned commit's ")}`);
    const conflicts: [string, string][] = [
      ["post", "/session/{sessionID}/message"],
      ["post", "/session/{sessionID}/command"],
      ["delete", "/session/{sessionID}/message/{messageID}"],
    ];
    for (const [method, route] of conflicts) {
      const responses = record(record(record(doc.paths[route])[method]).responses);
      ctx.check(`${method.toUpperCase()} ${route} declares its 409`, "409" in responses, `it declares ${Object.keys(responses).join(", ") || "nothing"}`);
    }
    for (const name of ["Part", "SessionStatus"]) {
      const why = notDiscriminated(doc, name);
      ctx.check(`${name} is a union discriminated on type`, why === undefined, why ?? "");
    }
    const accepted = record(record(record(record(record(record(doc.paths["/session/{sessionID}/prompt"]).post).responses)["202"]).content)["application/json"]);
    const properties = record(record(accepted.schema).properties);
    ctx.check("the 202 of POST /session/{sessionID}/prompt declares queued", "queued" in properties, `it declares ${Object.keys(properties).join(", ")}`);
  },
};
