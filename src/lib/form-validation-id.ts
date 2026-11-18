/**
 * Form validation in Bahasa Indonesia (Paduka, 2026-11-18: "please fill out
 * this field" must never reach a seller or a buyer).
 *
 * The English bubbles are the browser's own constraint validation, spoken in
 * the visitor's browser language. Three pieces replace them:
 *
 * - `indonesianValidityMessage` — the one translation of every ValidityState
 *   reason, worded from the field's own label (pure; unit-tested).
 * - `installIndonesianValidation` — the safety net every HTML document installs
 *   (a guard test enforces it): on `invalid` it gives the browser's bubble an
 *   Indonesian message and marks the field `aria-invalid` (the admin inputs
 *   already draw that red). It only ever touches a message it set itself — a
 *   page's own `setCustomValidity` (the checkout forms) wins — and it clears
 *   its message on input, change and the next submit click, so a field can
 *   never stay invalid after it was fixed.
 * - `validateInline` / `bindInlineValidation` — for the forms people meet
 *   first (sign-in, recovery, the home dialog): `novalidate`, the message
 *   under the field in `#<id>-error`, focus on the first invalid field.
 *   `data-msg-missing` / `data-msg-invalid` on a field override the wording.
 */

export type ValidityLike = {
  valid: boolean;
  valueMissing: boolean;
  typeMismatch: boolean;
  patternMismatch: boolean;
  tooLong: boolean;
  tooShort: boolean;
  rangeUnderflow: boolean;
  rangeOverflow: boolean;
  stepMismatch: boolean;
  badInput: boolean;
  customError: boolean;
};

export type FieldDescription = {
  validity: ValidityLike;
  /** `select`, `textarea`, or an input's type (`email`, `url`, `number`, `checkbox`, …). */
  kind: string;
  label?: string;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  /** A page's own wording for this field. */
  msgMissing?: string;
  msgInvalid?: string;
};

const DATE_KINDS = new Set(["date", "datetime-local", "month", "week", "time"]);

/** The Indonesian message for the first failing constraint, or "" when the field is valid. */
export function indonesianValidityMessage(field: FieldDescription): string {
  const v = field.validity;
  if (v.valid) return "";
  const label = field.label?.trim();
  const named = label ? ` ${label}` : " ini";
  const invalid = (text: string) => field.msgInvalid || text;

  if (v.valueMissing) {
    if (field.msgMissing) return field.msgMissing;
    if (field.kind === "checkbox") return "Centang kotak ini untuk melanjutkan.";
    if (field.kind === "radio") return label ? `Pilih salah satu ${label}.` : "Pilih salah satu opsi.";
    if (field.kind === "select" || field.kind === "select-one" || field.kind === "select-multiple") return label ? `Pilih ${label} terlebih dahulu.` : "Pilih salah satu opsi terlebih dahulu.";
    if (field.kind === "file") return label ? `Pilih file ${label} terlebih dahulu.` : "Pilih file terlebih dahulu.";
    return `Kolom${named} wajib diisi.`;
  }
  if (v.badInput) {
    if (field.kind === "number" || field.kind === "range") return invalid("Masukkan angka yang valid.");
    if (DATE_KINDS.has(field.kind)) return invalid("Masukkan tanggal atau waktu yang valid.");
    return invalid("Isian belum valid.");
  }
  if (v.typeMismatch) {
    if (field.kind === "email") return invalid("Format email belum benar (contoh: nama@domain.com).");
    if (field.kind === "url") return invalid("Masukkan alamat URL lengkap (diawali https://).");
    return invalid("Format isian belum sesuai.");
  }
  if (v.patternMismatch) {
    const example = field.placeholder?.trim();
    return invalid(`Format${named} belum sesuai${example ? ` (contoh: ${example})` : ""}.`);
  }
  if (v.tooLong) return invalid(`Maksimal ${field.maxLength} karakter.`);
  if (v.tooShort) return invalid(`Minimal ${field.minLength} karakter.`);
  if (v.rangeUnderflow) return invalid(DATE_KINDS.has(field.kind) ? `Paling awal ${field.min}.` : `Nilai minimal ${field.min}.`);
  if (v.rangeOverflow) return invalid(DATE_KINDS.has(field.kind) ? `Paling akhir ${field.max}.` : `Nilai maksimal ${field.max}.`);
  if (v.stepMismatch) return invalid(!field.step || field.step === "1" ? "Masukkan bilangan bulat." : `Masukkan kelipatan ${field.step}.`);
  return invalid("Isian belum valid.");
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isField = (target: EventTarget | null): target is Field =>
  !!target && typeof (target as Field).setCustomValidity === "function" && "validity" in (target as object);

/** The field's human label: an explicit `data-validity-label`, its `<label>`, then `aria-label`. */
function fieldLabel(el: Field): string {
  const explicit = el.getAttribute("data-validity-label");
  if (explicit) return explicit;
  const label = el.labels?.[0];
  let text = "";
  if (label?.contains(el)) {
    // <label><span>Slug</span><input/><span>hint…</span></label>: the name is the text before the field.
    const walker = el.ownerDocument.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      text += ` ${node.textContent ?? ""}`;
    }
  }
  // A checkbox's text follows it; a <label for> holds only the name.
  if (!text.trim()) text = label?.textContent ?? el.getAttribute("aria-label") ?? "";
  return text.replace(/\s+/g, " ").replace(/[*:]+\s*$/, "").trim().slice(0, 60);
}

export function describeField(el: Field): FieldDescription {
  const input = el as HTMLInputElement;
  return {
    validity: el.validity,
    kind: el instanceof HTMLSelectElement ? "select" : el instanceof HTMLTextAreaElement ? "textarea" : input.type || "text",
    label: fieldLabel(el),
    placeholder: el.getAttribute("placeholder") ?? undefined,
    minLength: (el as HTMLInputElement).minLength,
    maxLength: (el as HTMLInputElement).maxLength,
    min: el.getAttribute("min") ?? undefined,
    max: el.getAttribute("max") ?? undefined,
    step: el.getAttribute("step") ?? undefined,
    msgMissing: el.getAttribute("data-msg-missing") ?? undefined,
    msgInvalid: el.getAttribute("data-msg-invalid") ?? undefined,
  };
}

type Listener = (event: Event) => void;
export type ValidationRoot = { addEventListener(type: string, listener: Listener, capture: boolean): void };

const INSTALLED = new WeakSet<object>();

/**
 * The safety net. `describe` is injectable for the unit test (no DOM there).
 * Installing twice on the same root is a no-op.
 */
export function installIndonesianValidation(root: ValidationRoot = document, describe: (el: Field) => FieldDescription = describeField) {
  if (INSTALLED.has(root)) return;
  INSTALLED.add(root);
  /** The message this net set on a field, and whether it set `aria-invalid` too. */
  const ours = new WeakMap<Field, { message: string; aria: boolean }>();

  const release = (el: Field) => {
    const mark = ours.get(el);
    if (!mark) return;
    ours.delete(el);
    if (el.validity.customError && el.validationMessage === mark.message) el.setCustomValidity("");
    if (mark.aria) el.removeAttribute("aria-invalid");
  };

  root.addEventListener("invalid", (event) => {
    const el = event.target;
    if (!isField(el)) return;
    // A message the page set itself (the checkout forms) is already Indonesian: leave it.
    if (el.validity.customError && ours.get(el)?.message !== el.validationMessage) return;
    release(el);
    if (el.validity.valid) {
      // Only our stale message made it invalid: no empty bubble, the next attempt passes.
      event.preventDefault();
      return;
    }
    const message = indonesianValidityMessage(describe(el));
    el.setCustomValidity(message);
    const aria = !el.hasAttribute("aria-invalid");
    if (aria) el.setAttribute("aria-invalid", "true");
    ours.set(el, { message, aria });
  }, true);

  const onEdit: Listener = (event) => {
    if (isField(event.target)) release(event.target);
  };
  root.addEventListener("input", onEdit, true);
  root.addEventListener("change", onEdit, true);
  // A submit click starts a fresh validation pass: nothing of ours may linger into it.
  root.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("button, input[type=submit], input[type=image]") as (HTMLButtonElement | HTMLInputElement) | null;
    const form = button?.form;
    if (!form || !["submit", "image"].includes(button.type)) return;
    for (const el of Array.from(form.elements)) if (isField(el)) release(el);
  }, true);
}

/** Show or clear one field's inline message (`#<id>-error`, created by the page). */
export function setFieldError(el: Field, message: string) {
  const slot = el.id ? el.ownerDocument.getElementById(`${el.id}-error`) : null;
  if (message) el.setAttribute("aria-invalid", "true");
  else el.removeAttribute("aria-invalid");
  if (slot) {
    slot.textContent = message;
    slot.hidden = !message;
  }
}

/** Inline validation of a `novalidate` form: messages under the fields, focus on the first invalid one. */
export function validateInline(form: HTMLFormElement): boolean {
  let first: Field | null = null;
  for (const el of Array.from(form.elements)) {
    if (!isField(el) || !el.willValidate) continue;
    // A page's own custom message is shown as it is; everything else is translated.
    const message = el.validity.customError ? el.validationMessage : indonesianValidityMessage(describeField(el));
    setFieldError(el, message);
    if (message && !first) first = el;
  }
  first?.focus();
  return !first;
}

/** After a failed attempt, each field's message clears as soon as it becomes valid. */
export function bindInlineValidation(form: HTMLFormElement) {
  const recheck = (event: Event) => {
    const el = event.target;
    if (!isField(el) || el.getAttribute("aria-invalid") !== "true") return;
    if (el.validity.valid) setFieldError(el, "");
  };
  form.addEventListener("input", recheck);
  form.addEventListener("change", recheck);
}
