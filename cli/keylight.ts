#!/usr/bin/env bun

import { runCommand } from "./commands";

// An exit status, not process.exit: `serve` returns while its viewer goes on listening.
process.exitCode = await runCommand(process.argv.slice(2));
