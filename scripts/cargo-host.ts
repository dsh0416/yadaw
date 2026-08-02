#!/usr/bin/env node
import { cargoExecutable, fail, hostTarget, run } from "./rust-target.ts"

const cargoArgs = process.argv.slice(2)
if (cargoArgs.length === 0) fail("Usage: node scripts/cargo-host.ts <cargo arguments>")

if (!cargoArgs.includes("--target")) {
  const separator = cargoArgs.indexOf("--")
  const insertion = separator === -1 ? cargoArgs.length : separator
  cargoArgs.splice(insertion, 0, "--target", hostTarget())
}

run(cargoExecutable, cargoArgs)
