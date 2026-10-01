#!/usr/bin/env node
// Entry point for the `preimage` CLI.
//
// Subcommands:
//   (default)         run the CLI
//   mcp [flags]       run the MCP server on stdio
//
// The MCP server defaults its root to the process cwd, which is where MCP
// clients launch their servers. `--root` overrides that for clients that do
// not control the working directory.

import { main } from "../src/cli.js";
import { runStdio } from "../src/mcp.js";

const argv = process.argv.slice(2);

if (argv[0] === "mcp") {
	const rootFlag = argv.indexOf("--root");
	const explicit = rootFlag !== -1 ? argv[rootFlag + 1] : undefined;
	if (rootFlag !== -1 && !explicit) {
		process.stderr.write("error: --root requires a directory\n");
		process.exit(2);
	}
	await runStdio(explicit ? { root: explicit } : {});
} else {
	process.exitCode = await main(argv);
}