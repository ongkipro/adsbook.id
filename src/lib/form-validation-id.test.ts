import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { indonesianValidityMessage, installIndonesianValidation, type FieldDescription, type ValidityLike } from "./form-validation-id.ts";

const VALID: ValidityLike = {
  valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false,
  rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false,
};
const failing = (reason: keyof ValidityLike): ValidityLike => ({ ...VALID, valid: false, [reason]: true });
const say = (reason: keyof ValidityLike, field: Partial<FieldDescription> = {}) =>
  indonesianValidityMessage({ kind: "text", ...field, validity: failing(reason) });

test("every constraint reason reads as plain Indonesian, worded from the field's label", () => {
  assert.equal(indonesianValidityMessage({ kind: "text", validity: VALID }), "");
  assert.equal(say("valueMissing", { label: "Nama toko" }), "Kolom Nama toko wajib diisi.");
  assert.equal(say("valueMissing"), "Kolom ini wajib diisi.");
  assert.equal(say("valueMissing", { kind: "select", label: "Kurir" }), "Pilih Kurir terlebih dahulu.");
  assert.equal(say("valueMissing", { kind: "checkbox", label: "Saya setuju" }), "Centang kotak ini untuk melanjutkan.");
  assert.equal(say("valueMissing", { kind: "radio", label: "metode bayar" }), "Pilih salah satu metode bayar.");
  assert.equal(say("valueMissing", { kind: "file", label: "Logo" }), "Pilih file Logo terlebih dahulu.");
  assert.equal(say("typeMismatch", { kind: "email" }), "Format email belum benar (contoh: nama@domain.com).");
  assert.equal(say("typeMismatch", { kind: "url" }), "Masukkan alamat URL lengkap (diawali https://).");
  assert.equal(say("patternMismatch", { label: "Warna tema", placeholder: "#2563EB" }), "Format Warna tema belum sesuai (contoh: #2563EB).");
  assert.equal(say("patternMismatch"), "Format ini belum sesuai.");
  assert.equal(say("tooShort", { minLength: 10 }), "Minimal 10 karakter.");
  assert.equal(say("tooLong", { maxLength: 40 }), "Maksimal 40 karakter.");
  assert.equal(say("rangeUnderflow", { kind: "number", min: "1" }), "Nilai minimal 1.");
  assert.equal(say("rangeOverflow", { kind: "number", max: "100" }), "Nilai maksimal 100.");
  assert.equal(say("rangeUnderflow", { kind: "date", min: "2026-01-01" }), "Paling awal 2026-01-01.");
  assert.equal(say("stepMismatch", { kind: "number" }), "Masukkan bilangan bulat.");
  assert.equal(say("stepMismatch", { kind: "number", step: "500" }), "Masukkan kelipatan 500.");
  assert.equal(say("badInput", { kind: "number" }), "Masukkan angka yang valid.");
  // A page's own wording wins.
  assert.equal(say("valueMissing", { kind: "email", msgMissing: "Masukkan alamat email Anda terlebih dahulu." }), "Masukkan alamat email Anda terlebih dahulu.");
  assert.equal(say("typeMismatch", { kind: "email", msgInvalid: "Format email belum benar (contoh: nama@toko.id)." }), "Format email belum benar (contoh: nama@toko.id).");
  // Not one English word the browser would have said.
  for (const reason of Object.keys(VALID).filter((key) => key !== "valid" && key !== "customError") as (keyof ValidityLike)[]) {
    assert.doesNotMatch(say(reason, { label: "Nama" }), /\b(Please|field|must|value|enter|match)\b/i, reason);
  }
});

/** Just enough of an input for the net: native constraints, custom validity, attributes, its form. */
class FakeField {
  custom = "";
  attrs = new Map<string, string>();
  form: { elements: FakeField[] } | null = null;
  reason: keyof ValidityLike | null;
  label: string;
  constructor(reason: keyof ValidityLike | null, label = "Email") {
    this.reason = reason;
    this.label = label;
  }
  get validity(): ValidityLike {
    const base = this.reason ? failing(this.reason) : { ...VALID };
    return this.custom ? { ...base, valid: false, customError: true } : base;
  }
  get validationMessage() {
    return this.custom || (this.reason ? "Please fill out this field." : "");
  }
  setCustomValidity(message: string) { this.custom = message; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
}

function fakeRoot() {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    fire(type: string, target: unknown) {
      const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of listeners.get(type) ?? []) listener(event as unknown as Event);
      return event;
    },
  };
}

const describe = (el: FakeField): FieldDescription => ({ validity: el.validity, kind: "email", label: el.label });

function netWith() {
  const root = fakeRoot();
  installIndonesianValidation(root, describe as never);
  return root;
}

test("the net speaks Indonesian on invalid, marks the field, and lets go as soon as it is edited", () => {
  const root = netWith();
  const email = new FakeField("valueMissing");
  root.fire("invalid", email);
  assert.equal(email.validationMessage, "Kolom Email wajib diisi.");
  assert.equal(email.getAttribute("aria-invalid"), "true");
  email.reason = null; // the seller typed a valid address
  root.fire("input", email);
  assert.equal(email.validity.valid, true, "no message of ours outlives the edit");
  assert.equal(email.hasAttribute("aria-invalid"), false);
});

test("the net never touches a page's own message, nor an aria-invalid the page manages", () => {
  const root = netWith();
  const phone = new FakeField(null, "Nomor WhatsApp");
  phone.setCustomValidity("Maaf, nomor WhatsApp harus diawali 62.");
  phone.setAttribute("aria-invalid", "true");
  root.fire("invalid", phone);
  root.fire("input", phone);
  assert.equal(phone.validationMessage, "Maaf, nomor WhatsApp harus diawali 62.");
  assert.equal(phone.getAttribute("aria-invalid"), "true");
  // Even a native failure on such a field keeps the page's own aria-invalid when ours is released.
  const name = new FakeField("valueMissing", "Nama");
  name.setAttribute("aria-invalid", "false");
  root.fire("invalid", name);
  assert.equal(name.validationMessage, "Kolom Nama wajib diisi.");
  root.fire("change", name);
  assert.equal(name.getAttribute("aria-invalid"), "false");
});

test("a field fixed without an input event (set by code) is never stuck: a submit click clears ours, a stale one shows no empty bubble", () => {
  const root = netWith();
  const email = new FakeField("valueMissing");
  root.fire("invalid", email);
  email.reason = null; // React set the value; no input event
  // A submit click on its form starts a clean pass.
  const form = { elements: [email] };
  const button = { type: "submit", form, closest: () => button };
  root.fire("click", { closest: () => button });
  assert.equal(email.validity.valid, true);
  // If a pass reaches it with our stale message (requestSubmit, no click), it is dropped and no empty bubble shows.
  email.reason = "valueMissing";
  root.fire("invalid", email);
  email.reason = null;
  assert.equal(email.validity.valid, false, "only our stale message holds it");
  const event = root.fire("invalid", email);
  assert.equal(event.defaultPrevented, true);
  assert.equal(email.validity.valid, true);
});

// --- Static guard: every HTML document installs the net; the first-met forms validate inline. ---

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(astro|tsx|ts)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
});
const SOURCES = files("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("every HTML document the app serves installs the Indonesian validation net", () => {
  // An .astro document can render any slot or island; a document built as a string in .ts
  // (state pages, the handoff auto-post) needs it only once it carries a field a person fills in.
  const field = /<(?:input(?![^>]*type=["']?hidden)|select|textarea)\b/;
  const documents = SOURCES
    .filter((file) => /<html[\s>]/.test(file.text) && (file.path.endsWith(".astro") || field.test(file.text)))
    .map((file) => file.path)
    .sort();
  assert.ok(documents.length >= 7, documents.join(", "));
  const missing = documents.filter((path) => !/installIndonesianValidation\(\)/.test(SOURCES.find((file) => file.path === path)!.text));
  assert.deepEqual(missing, [], "a document without the net lets the browser speak English");
});

test("sign-in, recovery and the home dialog validate inline (novalidate, a message slot per field), and no English validation text ships", () => {
  const inline: Record<string, string[]> = {
    "src/pages/hello.astro": ["username", "password"],
    "src/pages/pemulihan.astro": ["token", "password"],
    "src/pages/platform/login.astro": ["email", "password", "totp"],
    "src/platform/site/KineticHero3D.astro": ["hero-email", "hero-store"],
  };
  for (const [path, ids] of Object.entries(inline)) {
    const text = readFileSync(path, "utf8");
    for (const form of text.match(/<form\b[^>]*>/g) ?? []) {
      if (/method="dialog"/.test(form)) continue;
      assert.match(form, /\bnovalidate\b/, `${path}: ${form}`);
    }
    assert.match(text, /validateInline\(|setFieldError\(/, path);
    assert.doesNotMatch(text, /reportValidity\(|checkValidity\(/, `${path}: a native bubble`);
    for (const id of ids) assert.match(text, new RegExp(`id="${id}-error"`), `${path}: #${id}-error`);
  }
  const english = SOURCES.filter((file) => /Please (fill|enter|match|select|lengthen|shorten)/.test(file.text) && !file.path.endsWith("form-validation-id.ts"));
  assert.deepEqual(english.map((file) => file.path), []);
});
