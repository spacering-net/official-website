// What Vite sets on import.meta where it builds the script (astro build) or
// runs it (astro dev).
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean };
}
