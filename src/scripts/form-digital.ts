/**
 * The digital checkout (DIGITAL-PRODUCTS-SPEC §5.1): variant, name, WhatsApp,
 * optional email, one prepaid rail — no address, no courier, no COD. The ad
 * funnel runs as on the physical forms: AddToCart once the buyer is
 * identifiable, InitiateCheckout on the payment choice, both through
 * `__PS_META_TRACK__` (MetaPixelBase owns the one init), TikTok's own pair and
 * the server leg, on one event id. Purchase stays where it always is: the
 * server on the paid transition, and `/thanks`.
 */
import { trackTikTokFunnel } from "../lib/tiktok-browser.ts";
import { META_EXTERNAL_ID_COOKIE } from "../lib/click-ids.ts";
import { formatIdr } from "../lib/format-idr";
import { isValidWa62, missingCheckoutContact, normalizePhone } from "../lib/validation";
import { pushGtmEcomEvent } from "../lib/gtm";
import { navigateAfterCheckout } from "../lib/checkout-navigation";
import { digitalEventId, digitalOrderBody, digitalPaymentOptions, digitalSubmitToken, type DigitalPaymentOption } from "../lib/digital-checkout.ts";
import {
  AbandonedLeadCaptureGate,
  createAbandonedLeadFingerprint,
  readAbandonedLeadFingerprints,
  writeAbandonedLeadFingerprint,
} from "../lib/abandoned-lead-session";

type DigitalConfig = { instanceId: string; productSlug: string; productId: string; productName: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cookie = (name: string) =>
  document.cookie.split("; ").find((row) => row.startsWith(`${name}=`))?.split("=")[1] || "";

function initOne(root: HTMLElement) {
  const configEl = root.querySelector<HTMLScriptElement>("script[data-digital-form-config]");
  const form = root.querySelector<HTMLFormElement>("form[data-digital-form]");
  if (!configEl || !form || form.dataset.ready === "1") return;
  form.dataset.ready = "1";
  const config = JSON.parse(configEl.textContent || "{}") as DigitalConfig;
  const nameInput = form.querySelector<HTMLInputElement>('[name="customer_name"]')!;
  const phoneInput = form.querySelector<HTMLInputElement>('[name="customer_phone"]')!;
  const emailInput = form.querySelector<HTMLInputElement>('[name="customer_email"]')!;
  const optionsEl = form.querySelector<HTMLElement>("[data-digital-payments]")!;
  const totalEl = form.querySelector<HTMLElement>("[data-digital-total]")!;
  const labelEl = form.querySelector<HTMLElement>("[data-digital-variant]")!;
  const errorEl = form.querySelector<HTMLElement>("[data-digital-error]")!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const submitLabel = submit.querySelector<HTMLElement>("[data-label]") ?? submit;
  let options: DigitalPaymentOption[] = [];
  let chosen: DigitalPaymentOption | null = null;
  const tracked = new Set<string>();

  const variant = () => form.querySelector<HTMLInputElement>('input[name="variant"]:checked');
  const price = () => Number(variant()?.dataset.price || 0);
  const sync = () => {
    totalEl.textContent = formatIdr(price());
    labelEl.textContent = variant()?.dataset.label || "";
  };
  const showError = (message: string) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };

  const track = (eventName: "AddToCart" | "InitiateCheckout") => {
    if (tracked.has(eventName)) return;
    tracked.add(eventName);
    const eventId = digitalEventId(eventName.toLowerCase(), config.productSlug);
    const value = price() || 1;
    const contentName = variant()?.dataset.label || config.productName;
    const phone = normalizePhone(phoneInput.value || "");
    const email = emailInput.value.trim();
    const metaTrack = (window as { __PS_META_TRACK__?: (...args: unknown[]) => void }).__PS_META_TRACK__;
    if (typeof metaTrack === "function") {
      metaTrack(eventName, { content_name: contentName, content_ids: [config.productId], content_type: "product", value, currency: "IDR" }, { eventID: eventId });
    }
    trackTikTokFunnel(eventName, { contentId: config.productId, contentName, value }, eventId, isValidWa62(phone) ? phone : undefined);
    void fetch("/api/meta-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_name: eventName,
        event_id: eventId,
        lp_name: config.productSlug,
        product_id: config.productId,
        content_name: contentName,
        value,
        currency: "IDR",
        content_type: "product",
        event_source_url: window.location.href,
        user_data: {
          customer_name: nameInput.value.trim() || undefined,
          customer_phone: isValidWa62(phone) ? phone : undefined,
          customer_email: EMAIL.test(email) ? email : undefined,
          country: "id",
          external_id: cookie(META_EXTERNAL_ID_COOKIE) || undefined,
          fbp: cookie("_fbp") || undefined,
          fbc: cookie("_fbc") || undefined,
        },
      }),
    }).catch(() => undefined);
    pushGtmEcomEvent(eventName === "AddToCart" ? "add_to_cart" : "begin_checkout", {
      currency: "IDR",
      value,
      item_id: config.productId,
      item_name: contentName,
      item_variant: variant()?.value || undefined,
      event_id: eventId,
    });
  };

  // A buyer who leaves after name and WhatsApp is still a lead for CS (§8.5).
  const leads = new AbandonedLeadCaptureGate(readAbandonedLeadFingerprints(sessionStorage));
  let leadTimer: number | undefined;
  const identity = () => {
    const name = nameInput.value.trim();
    const phone = normalizePhone(phoneInput.value || "");
    if (name.length < 3 || !isValidWa62(phone)) return;
    track("AddToCart");
    const variantId = Number(variant()?.value);
    const fingerprint = createAbandonedLeadFingerprint({ customerName: name, customerPhone: phone, productId: config.productId, variantId });
    if (!leads.shouldStart(fingerprint)) return;
    window.clearTimeout(leadTimer);
    leadTimer = window.setTimeout(() => {
      if (!leads.start(fingerprint)) return;
      void fetch("/api/record-abandoned-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: name,
          customer_phone: phone,
          website: String(new FormData(form).get("contact_url_confirm") || ""),
          product_id: config.productId,
          variant_id: Number.isFinite(variantId) && variantId > 0 ? variantId : undefined,
          total_amount: price() || undefined,
          product_title: config.productName,
        }),
      })
        .then((response) => {
          if (!response.ok) throw new Error("rejected");
          leads.finish(fingerprint, true);
          writeAbandonedLeadFingerprint(sessionStorage, fingerprint);
        })
        .catch(() => leads.finish(fingerprint, false));
    }, 600);
  };
  nameInput.addEventListener("blur", identity);
  phoneInput.addEventListener("blur", () => {
    if (phoneInput.value) phoneInput.value = normalizePhone(phoneInput.value);
    identity();
  });
  form.addEventListener("change", (event) => {
    if ((event.target as HTMLElement).matches('input[name="variant"]')) sync();
  });

  // Grey until name, WhatsApp and a payment method are set (owner,
  // 2026-11-23), like the COD forms; never natively disabled for that, so a
  // tap still reaches the handler below, which says what is missing.
  let submitting = false;
  const syncSubmit = () => {
    const ready = !submitting && missingCheckoutContact({ name: nameInput.value, phone: phoneInput.value, address: null }) === null && Boolean(chosen);
    submit.dataset.state = submitting ? "loading" : ready ? "ready" : "disabled";
    submit.setAttribute("aria-disabled", String(!ready));
    if (ready) errorEl.hidden = true;
  };
  form.addEventListener("input", syncSubmit);
  form.addEventListener("change", syncSubmit);

  const render = () => {
    optionsEl.replaceChildren();
    if (!options.length) {
      const empty = document.createElement("p");
      empty.className = "digital-pay-empty";
      empty.textContent = "Pembayaran online belum tersedia di toko ini. Hubungi penjual.";
      optionsEl.append(empty);
      return;
    }
    for (const option of options) {
      const label = document.createElement("label");
      label.className = "digital-pay-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "digital_payment";
      input.value = option.code;
      input.addEventListener("change", () => {
        chosen = option;
        showError("");
        track("InitiateCheckout");
      });
      const text = document.createElement("span");
      text.className = "digital-pay-text";
      const title = document.createElement("strong");
      title.textContent = option.label;
      const desc = document.createElement("small");
      desc.textContent = option.description;
      text.append(title, desc);
      label.append(input, text);
      optionsEl.append(label);
    }
    // One way to pay is no choice: select it, so the buyer is not asked.
    if (options.length === 1) {
      const only = optionsEl.querySelector<HTMLInputElement>('input[name="digital_payment"]');
      if (only) {
        only.checked = true;
        chosen = options[0];
      }
    }
    syncSubmit();
  };

  fetch("/api/payment-methods", { cache: "no-store" })
    .then((response) => response.json())
    .then((payload) => {
      options = digitalPaymentOptions(payload);
    })
    .catch(() => {
      options = [];
    })
    .finally(render);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    if (phoneInput.value) phoneInput.value = normalizePhone(phoneInput.value);
    const name = nameInput.value.trim();
    const phone = normalizePhone(phoneInput.value || "");
    const email = emailInput.value.trim();
    if (name.length < 2) return showError("Isi nama lengkap Anda."), nameInput.focus();
    if (!isValidWa62(phone)) return showError("Nomor WhatsApp belum benar. Contoh: 081234567890"), phoneInput.focus();
    if (email && !EMAIL.test(email)) return showError("Format email belum benar (contoh: nama@email.com)."), emailInput.focus();
    if (!variant()) return showError("Pilih paket terlebih dahulu.");
    if (!chosen) return showError("Pilih metode pembayaran.");
    track("InitiateCheckout");
    submitting = true;
    syncSubmit();
    submit.disabled = submitting;
    submitLabel.textContent = "Membuat pesanan…";
    try {
      const eventId = digitalEventId("order", config.productSlug);
      const response = await fetch("/api/submit-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          digitalOrderBody({
            submitToken: digitalSubmitToken(),
            honeypot: String(new FormData(form).get("contact_url_confirm") || ""),
            customerName: name,
            customerPhone: phone,
            customerEmail: email,
            variantId: String(variant()!.value),
            option: chosen,
            sourcePagePath: window.location.pathname,
          }),
        ),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || "Pesanan belum bisa dibuat. Coba lagi.");
      const order = data.order ?? {};
      const payment = data.payment ?? {};
      const thanksState = {
        order_id: order.order_number,
        order_pk: order.id,
        status_token: order.status_token,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        order_status: "pending",
        fulfillment_type: "digital",
        event_id: eventId,
        value: price(),
        name,
        phone,
        email,
        product_id: config.productId,
        product_name: config.productName,
        product_price: price(),
        quantity: 1,
        shipping_cost: 0,
        total_payment: Number(payment.total_amount || order.total_payment || price()),
        variant_unique_id: String(variant()!.value),
        variant_label: variant()!.dataset.label || "",
        payment_channel: String(payment.channel_code || chosen.channelCode || ""),
        payment_amount: Number(payment.amount || price()),
        payment_admin_fee: Number(payment.admin_fee || 0),
        payment_fee_bearer: payment.fee_bearer === "seller" ? "seller" : "buyer",
        payment_virtual_account: String(payment.virtual_account || ""),
        payment_qr_payload: String(payment.qr_payload || ""),
        payment_code: String(payment.payment_code || ""),
        payment_expires_at: String(payment.expires_at || ""),
        payment_error: String(payment.error || ""),
        payment_account_holder: String(payment.account_holder || ""),
        payment_bank_name: String(payment.bank_name || ""),
        payment_manual_transfer: Boolean(payment.manual_transfer),
        payment_url: String(payment.payment_url || ""),
      };
      try {
        sessionStorage.setItem("thanks_state", JSON.stringify(thanksState));
      } catch {
        // The fragment locator below carries the order on its own.
      }
      submitLabel.textContent = "Membuka instruksi pembayaran…";
      navigateAfterCheckout(`/payment#o=${encodeURIComponent(String(order.id ?? ""))}&t=${encodeURIComponent(String(order.status_token ?? ""))}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Pesanan belum bisa dibuat. Coba lagi.");
      submitting = false;
      submit.disabled = submitting;
      submitLabel.textContent = "Bayar & Dapatkan Akses";
      syncSubmit();
    }
  });
  sync();
  syncSubmit();
}

export function initDigitalOrderForms(root: Document | HTMLElement = document) {
  root.querySelectorAll<HTMLElement>("[data-digital-form-root]").forEach(initOne);
}
