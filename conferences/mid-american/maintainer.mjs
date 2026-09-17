// Generated from the reviewed NCAA catalog. Run from any working directory.
import { run } from '../../src/cli.mjs';
await run([...["--conference","mid-american"], ...process.argv.slice(2)]);
