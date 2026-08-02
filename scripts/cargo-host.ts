#!/usr/bin/env node
import { cargoExecutable, ensureHostCargoTarget, fail, run } from "./rust-target.ts"

const cargoArgs = process.argv.slice(2)
if (cargoArgs.length === 0) fail("Usage: node scripts/cargo-host.ts <cargo arguments>")

run(cargoExecutable, ensureHostCargoTarget(cargoArgs))
