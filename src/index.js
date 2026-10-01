// Programmatic entry points. Exposed so preimage can be embedded in a hook
// script or another Node tool without shelling out.

export { main } from "./cli.js";
export { Journal, openJournal } from "./journal.js";
export { scanTree, persistTree, diffTree, loadTree, DEFAULT_MAX_FILE_BYTES } from "./capture.js";
export { restoreFiles } from "./restore.js";
export { captureTables, restoreTables, diffTables, listTables } from "./dbadapter.js";
export { createServer, runStdio } from "./mcp.js";