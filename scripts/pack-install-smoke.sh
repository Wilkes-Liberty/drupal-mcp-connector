#!/usr/bin/env bash
# Fresh `npm pack` + production install. Fails if any installed package
# declares an engines.node that the running Node does not satisfy (#544).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

tgz=$(npm pack --silent)
tmp=$(mktemp -d)
log=$(mktemp)
cleanup() {
  rm -rf "$tmp" "$log" "$root/$tgz"
}
trap cleanup EXIT

# engine-strict turns EBADENGINE into a hard failure (npm otherwise warns
# and continues, which is how graphql@17.1.0 shipped against Node 20).
if ! npm install --ignore-scripts --omit=dev --engine-strict --prefix "$tmp" "$root/$tgz" >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -q EBADENGINE "$log"; then
  cat "$log" >&2
  echo "packed install emitted EBADENGINE" >&2
  exit 1
fi

cd "$tmp"
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { parse } from "graphql";

const pkg = JSON.parse(readFileSync("node_modules/graphql/package.json", "utf8"));
const major = Number.parseInt(String(pkg.version).split(".")[0], 10);
if (major !== 16) {
  throw new Error(`expected graphql 16.x in the packed install, got ${pkg.version}`);
}
parse("{ __typename }");
process.stdout.write(`pack-install-smoke: graphql@${pkg.version} parse ok on ${process.version}\n`);
JS
