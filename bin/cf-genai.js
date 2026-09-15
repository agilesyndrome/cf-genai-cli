#!/usr/bin/env node

import { main } from "../src/cli.js";

try {
  const result = await main(process.argv.slice(2));
  if (result?.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
