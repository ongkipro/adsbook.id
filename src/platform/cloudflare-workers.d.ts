// Merges with the `cloudflare:workers` declaration in src/env.d.ts (which
// declares `env`): the Durable Object base class `TenantStore` extends.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState, env: Env);
  }
}
