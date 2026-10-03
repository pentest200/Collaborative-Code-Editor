import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const source = readFileSync(new URL("../contracts/openapi.yaml", import.meta.url), "utf8");
const document = YAML.parseDocument(source, { uniqueKeys: true, strict: true });
if (document.errors.length) throw new AggregateError(document.errors, "OpenAPI YAML is invalid");
const api = document.toJS();
assert.equal(api.openapi, "3.1.0");
assert.match(api.paths["/api/v1/healthz"].get.responses["200"].description, /Process is serving HTTP/);
for (const name of ["realtime.md", "authorization.md", "document-lifecycle.md", "checkpoints.md"]) {
  assert.ok(readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8").length > 100);
}
console.log(`Contracts parse: OpenAPI 3.1, ${Object.keys(api.paths).length} reserved/active paths`);
