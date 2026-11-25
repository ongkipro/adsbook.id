/**
 * One display name per courier, whatever code a screen holds: the live
 * estimate says `lion`, `spx`, `JT`; a courier rule says `Lion`, `SPX`, `J&T`.
 * Screens printed `${code} · ${service}`, and Mengantar's estimate repeats the
 * code as the service, so operators read "JNE · JNE" and "lion · lion".
 */
const NAMES: Record<string, string> = {
  jne: "JNE",
  sicepat: "SiCepat",
  jt: "J&T Express",
  sap: "SAP Express",
  saplite: "SAP Lite",
  anteraja: "Anteraja",
  lion: "Lion Parcel",
  idexpress: "ID Express",
  paxel: "Paxel",
  pos: "Pos Indonesia",
  spx: "SPX Express",
  ico: "Kurir menyusul",
};

const LOGOS: Record<string, string> = {
  jne: "/images/couriers/jne.webp",
  sicepat: "/images/couriers/sicepat.svg",
  jt: "/images/couriers/jt.webp",
  jtexpress: "/images/couriers/jt.webp",
  sap: "/images/couriers/sap.webp",
  sapexpress: "/images/couriers/sap.webp",
  saplite: "/images/couriers/sap.webp",
  anteraja: "/images/couriers/anteraja.webp",
  lion: "/images/couriers/lion.webp",
  lionparcel: "/images/couriers/lion.webp",
  idexpress: "/images/couriers/idexpress.webp",
  pos: "/images/couriers/pos.svg",
  posindonesia: "/images/couriers/pos.svg",
  spx: "/images/couriers/spx.svg",
  spxexpress: "/images/couriers/spx.svg",
};

const key = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

export function courierDisplayName(code: string | null | undefined) {
  if (!code) return "—";
  return NAMES[key(code)] ?? code;
}

/** Local mark under `public/images/couriers/`, or null when none ships for this courier. */
export function courierLogoUrl(code: string | null | undefined): string | null {
  if (!code) return null;
  return LOGOS[key(code)] ?? null;
}

/** "SiCepat", or "SiCepat · BEST" when the service names something more. */
export function courierServiceLabel(code: string | null | undefined, service?: string | null) {
  const name = courierDisplayName(code);
  if (!service || key(service) === key(code ?? "") || key(service) === key(name)) return name;
  return `${name} · ${service}`;
}
