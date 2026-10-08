// WebAssembly files imported as modules (api/rings/render.ts): the Worker's
// bundler, the Cloudflare Vite plugin, hands them over compiled, and the
// tests' loader does the same (tests/harness/register.mjs).
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
