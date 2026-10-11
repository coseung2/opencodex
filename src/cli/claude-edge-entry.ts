// Dedicated local entrypoint: never initialize the global CLI, service or provider pool.
import { runClaudeEdgeWorker } from "./claude-edge-worker";
process.exit(await runClaudeEdgeWorker(process.argv.slice(2)).catch(() => 1));
