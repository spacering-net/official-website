// Lets Node run the Worker's TypeScript directly (it strips the types): the
// sources import each other without extensions, as bundlers allow, so try
// ".ts" when a relative import has none. WebAssembly files load as the
// Worker's bundler hands them over: a compiled module, the default export.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
      return next(specifier + '.ts', context);
    }
    throw err;
  }
}
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.wasm')) {
    const source = 'import { readFileSync } from "node:fs"; export default new WebAssembly.Module(readFileSync(new URL(' + JSON.stringify(url) + ')));';
    return { format: 'module', source, shortCircuit: true };
  }
  return next(url, context);
}`),
);
