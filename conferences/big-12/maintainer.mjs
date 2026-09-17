// Generated from the reviewed NCAA catalog. Run from any working directory.
import { run } from '../../src/cli.mjs';
await run([...["--conference","big-12"], ...process.argv.slice(2)]);
