// Merges with the `cloudflare:workers` declaration in src/env.d.ts, which
// declares only `env`. lazy: spike-only; T-18 moves this into src/env.d.ts.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState, env: Env);
  }
}
