/**
 * Renders the key reference of docs/configuration.md from the generated JSON
 * Schema of updater.yaml, so the documentation cannot drift from the schema.
 */
import { configObjectSchema, overridableKeys } from "@cicd-updater/protocol";
import { z } from "zod";

type Node = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  anyOf?: Node[];
  oneOf?: Node[];
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  additionalProperties?: Node | boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

interface Row {
  key: string;
  type: string;
  required: boolean;
  default: string;
  env: string;
  description: string;
}

function typeName(node: Node): string {
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    return union.map(typeName).join(" \\| ");
  }
  if (node.const !== undefined) {
    return `\`${JSON.stringify(node.const)}\``;
  }
  if (node.enum) {
    return node.enum.map((value) => `\`${String(value)}\``).join(" \\| ");
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : ["any"];
  return types
    .map((type) => {
      if (type === "array") {
        return `list<${node.items ? typeName(node.items) : "any"}>`;
      }
      if (
        type === "object" &&
        node.additionalProperties &&
        typeof node.additionalProperties === "object"
      ) {
        return "map";
      }
      if (type === "integer" && (node.minimum !== undefined || node.maximum !== undefined)) {
        return `int ${node.minimum ?? ""}–${node.maximum ?? ""}`;
      }
      return type === "integer"
        ? "int"
        : type === "boolean"
          ? "bool"
          : type === "string"
            ? "str"
            : type;
    })
    .join(" \\| ");
}

function walk(
  node: Node,
  path: string,
  required: boolean,
  rows: Row[],
  env: Map<string, string>,
): void {
  const union = node.anyOf ?? node.oneOf;
  const objectMember = union?.find((member) => member.type === "object" && member.properties);
  const target = objectMember ?? node;
  const isObject = target.type === "object" && target.properties;
  if (path) {
    rows.push({
      key: path,
      type: isObject ? (union ? "object \\| null" : "object") : typeName(node),
      required,
      default: node.default === undefined ? "" : `\`${JSON.stringify(node.default)}\``,
      env: env.get(path) ?? "",
      description: (node.description ?? target.description ?? "").replace(/\|/g, "\\|"),
    });
  }
  if (isObject) {
    for (const [key, child] of Object.entries(target.properties ?? {})) {
      walk(child, path ? `${path}.${key}` : key, (target.required ?? []).includes(key), rows, env);
    }
    return;
  }
  const items = target.items;
  if (items && (items.properties || items.anyOf || items.oneOf)) {
    const variants = items.anyOf ?? items.oneOf ?? [items];
    for (const variant of variants) {
      for (const [key, child] of Object.entries(variant.properties ?? {})) {
        const discriminator = variant.properties?.type?.const;
        const prefix =
          discriminator !== undefined ? `${path}[type=${String(discriminator)}]` : `${path}[]`;
        walk(child, `${prefix}.${key}`, (variant.required ?? []).includes(key), rows, env);
      }
    }
  }
  const values = target.additionalProperties;
  if (values && typeof values === "object" && values.properties) {
    for (const [key, child] of Object.entries(values.properties)) {
      walk(child, `${path}.<key>.${key}`, (values.required ?? []).includes(key), rows, env);
    }
  }
}

export function renderConfigReference(): string {
  const schema = z.toJSONSchema(configObjectSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Node;
  const env = new Map(overridableKeys().map((key) => [key.path.join("."), key.envName]));
  const rows: Row[] = [];
  walk(schema, "", true, rows, env);
  const sections = new Map<string, Row[]>();
  for (const row of rows) {
    const section = row.key.split(/[.[]/)[0] as string;
    const list = sections.get(section) ?? [];
    list.push(row);
    sections.set(section, list);
  }
  const out: string[] = [];
  for (const [section, list] of sections) {
    out.push(`### \`${section}\``, "");
    out.push("| Key | Type | Default | Environment override | Meaning |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const row of list) {
      const def = row.default || (row.required ? "required" : "");
      out.push(
        `| \`${row.key}\` | ${row.type} | ${def} | ${row.env ? `\`${row.env}\`` : ""} | ${row.description} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}
