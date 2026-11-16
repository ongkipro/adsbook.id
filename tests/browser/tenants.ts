import { PORT } from "../../playwright.config.ts";

/** The two stores the suite signs up; the owner credentials are dev-seed's fixed local ones. */
export const TENANTS = [
  { slug: "toko-alfa", name: "Toko Alfa" },
  { slug: "toko-beta", name: "Toko Beta" },
] as const;

export const origin = (slug: string) => `http://${slug}.localhost:${PORT}`;
export const PLATFORM = `http://app.localhost:${PORT}`;
export const owner = (slug: string) => ({ username: `owner@${slug}.local.test`, password: "dev-local-password-123" });
