/* ESM half of trace-register.mjs: records every module the loader resolves
 * inside node_modules. Used only by package.sh. */
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.includes('/node_modules/')) appendFileSync(process.env.SCC_TRACE_FILE, result.url + '\n');
  return result;
}
