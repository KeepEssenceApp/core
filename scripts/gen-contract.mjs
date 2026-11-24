// Writes src/generated/contract.ts from contract/openapi.yaml.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { buildContract, renderModule } from "./contract-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = parse(readFileSync(join(root, "contract/openapi.yaml"), "utf8"));
mkdirSync(join(root, "src/generated"), { recursive: true });
writeFileSync(join(root, "src/generated/contract.ts"), renderModule(buildContract(doc)));
console.log("src/generated/contract.ts written");
