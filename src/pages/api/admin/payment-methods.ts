import type { APIRoute } from "astro";
import { GET as publicPaymentMethods } from "../payment-methods.ts";

export const prerender = false;

/**
 * The checkout's payment-method list, for the signed-in seller (owner and
 * admin: Pembayaran, an order's payment switch). The same answer as the
 * public `/api/payment-methods`, served under the admin session — the public
 * route is behind the store-readiness gate (PR-23), and a new store's own
 * Pembayaran page answered "Toko belum siap" on the screen where the seller
 * sets payments up.
 */
export const GET: APIRoute = (context) => publicPaymentMethods(context);
