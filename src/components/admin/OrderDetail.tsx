import { formatIdr } from "@/lib/format-idr";
import { isVoidOrder } from "@/lib/order-lifecycle";
import { acceptedShipmentId, isDispatchOutcomeUnknown } from "@/lib/payment-dispatch-policy";
import { useConfirm } from "./useConfirm";
import { calculateCodCustomerTotal, calculateCodFeeBreakdown, paymentFeeIsSellers } from "@/lib/payment-fee-policy";
import { TrafficSourceBadge } from "./TrafficSourceBadge";
import { type CSSProperties, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildWaUrl, defaultCrmTemplates, renderCrmMessage } from "../../lib/crm-template";
import { CrmActionGroup } from "./CrmActionGroup";
import { PaymentSwitchDialog } from "./PaymentSwitchDialog";
import { MengantarPushDialog } from "./MengantarPushDialog";
import type { MengantarPickupChoice } from "@/lib/mengantar-order";
import { CRM_STEPS } from "./CrmActionButton";
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { toast } from "sonner";
import { SHIPPING_STATUS_LABELS, fulfillmentSteps, storeRelativeHref } from "@/lib/shipping-status";
import { courierServiceLabel } from "@/lib/courier-names";
import { DistrictCombobox, type DistrictOption } from "@/components/admin/DistrictCombobox";
import { FilterSelect } from "@/components/admin/filter-bar";
import { etaLabel } from "@/lib/rate-check";
import {
  CURRENT_WEIGHT_LABEL,
  RECORDED_WEIGHT_LABEL,
  formatGrams,
  formatWeight,
  quoteUnitWeightKg,
  summarizeOrderWeight,
} from "@/lib/weight";
import { cn } from "@/lib/utils";
import { groupLocationResults } from "../../lib/location-search";
import {
  ArrowLeft,
  Copy,
  Check,
  Phone,
  Truck,
  Trash2,
  ExternalLink,
  RefreshCw,
  Edit3,
  Loader2,
  Lock as LockIcon,
} from "lucide-react";

type OrderItem = {
  id: number | string;
  variant_id: number;
  quantity: number;
  unit_price: number;
  variant_title: string | null;
  variant_sku: string | null;
  variant_compare_price?: number | null;
  weight_grams?: number | null;
  weight_recorded?: boolean;
  product_title: string | null;
};

type ReceiverPerformance = {
  checkedAt?: string;
  grade?: string | null;
  totals?: {
    total?: number;
    delivered?: number;
    rts?: number;
    undelivered?: number;
    inProgress?: number;
  };
};

type PaymentDetails = {
  provider_transaction_id: string | null;
  reference_id: string;
  channel_code: string;
  fee_bearer: string | null;
  status: string;
  amount: number;
  admin_fee: number;
  total_amount: number;
  expires_at: string | null;
  paid_at: string | null;
  failed_reason: string | null;
};

type Order = {
  id: number | string;
  order_number: string;
  warehouse_id: number | null;
  warehouse_name: string | null;
  customer_name: string;
  customer_phone: string;
  address: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  postal_code: string | null;
  destination_area_id: string | null;
  total_amount: number;
  shipping_cost: number;
  discount_amount?: number;
  cod_service_fee: number;
  cod_service_fee_vat: number;
  cod_fee_bearer: "buyer" | "seller";
  payment_method: string;
  /** Set when an operator moved this order off COD (src/lib/payment-switch.ts). */
  payment_switched_from?: string | null;
  payment_switched_at?: string | null;
  payment_switched_by?: string | null;
  /** COD only: whether it can still move to transfer/VA, and the total then. */
  payment_switch?: { available: boolean; reason: string | null; total_amount: number } | null;
  /** The buyer's /payment page for an unpaid prepaid order (fragment locator). */
  payment_link?: string | null;
  /** Follow-up context served with the order (templates, store, accounts, buyer links). */
  crm?: {
    templates?: Record<string, string>;
    seller_name?: string;
    bank_accounts?: string;
    epayment_link?: string | null;
    order_details_link?: string | null;
  };
  payment_status: string;
  shipping_status: string;
  /** Set once the order is void; see `isVoidOrder`. */
  stock_restored_at?: string | null;
  confirmed_at: string | null;
  courier_code: string | null;
  courier_service: string | null;
  cnote_no: string | null;
  /** DIGITAL-PRODUCTS-SPEC §4.3. */
  fulfillment_type?: string | null;
  /** MENGANTAR-WEBHOOK-AUTOSYNC-SPEC §5A. */
  shipping_channel?: "mengantar" | "external";
  digital_accessed_at?: string | null;
  public_status_token?: string | null;
  provider_order_id: string | null;
  provider_dispatch_error: string | null;
  provider_status_text?: string | null;
  provider_status_at?: string | null;
  provider_synced_at?: string | null;
  dispatchEligible?: boolean;
  dispatchReason?: string | null;
  receiver_delivery_rate: number | null;
  receiver_risk_label: string | null;
  receiver_performance: ReceiverPerformance | null;
  /** "not-whitelisted" when Mengantar refused the lookup for this account. */
  receiver_performance_unavailable?: string | null;
  receiver_performance_checked_at: string | null;
  ad_click_ids?: string | null;
  source_page_path?: string | null;
  created_at: string;
  kelola?: KelolaSync | null;
  payment: PaymentDetails | null;
  items: OrderItem[];
};

type KelolaSync = {
  configured: boolean;
  synced_at: string | null;
  attempts: number;
  last_error: string | null;
  voided: boolean;
};

type LocationOption = {
  id: string;
  label: string;
  district: string;
  subdistrict_name?: string;
  city: string;
  province: string;
  postal_code?: string;
};

type ShippingRate = {
  courier_service_id: number;
  courier_code: string;
  courier_service: string;
  shipping_cost: number;
  estimated_days?: string;
};

const shippingLabels = SHIPPING_STATUS_LABELS;

const shippingStatusDots: Record<string, string> = {
  abandoned: "bg-rose-500",
  pending: "bg-amber-500",
  processing: "bg-sky-500",
  shipped: "bg-blue-500",
  delivered: "bg-emerald-500",
  returned: "bg-rose-600",
  cancelled: "bg-slate-400",
};

const paymentLabels: Record<string, string> = {
  unpaid: "Belum dibayar",
  pending: "Menunggu pembayaran",
  paid: "Lunas",
  settled: "Lunas",
  success: "Lunas",
  expired: "Kedaluwarsa",
  failed: "Gagal",
  refunded: "Dikembalikan",
};

const paymentMethodLabels: Record<string, string> = {
  cod: "COD",
  manual_transfer: "Transfer bank manual",
  bank_transfer: "Virtual Account",
  qris: "QRIS",
  invoice: "Pembayaran online",
};

const currency = formatIdr;

const formatDate = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date)} WIB`;
};

// "27 Nov, 03.49 WIB": the journey row has a fifth of the width for each step.
const formatShortDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(date)} WIB`;
};

function EditCustomerDialog({
  order,
  onUpdated,
}: {
  order: Order;
  onUpdated: (order: Order) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!order.provider_order_id && new URLSearchParams(window.location.search).get("edit") === "shipping") {
      setOpen(true);
    }
  }, [order.provider_order_id]);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const submitErrorRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [shippingRates, setShippingRates] = useState<ShippingRate[]>([]);
  const [useSubdistrict] = useState(false);
  const [selectedCourierServiceId, setSelectedCourierServiceId] = useState("");
  const [formData, setFormData] = useState({
    customer_name: order.customer_name || "",
    customer_phone: order.customer_phone || "",
    address: order.address || "",
    district: order.district || "",
    city: order.city || "",
    province: order.province || "",
    postal_code: order.postal_code || "",
    destination_area_id: order.destination_area_id || "",
  });

  useEffect(() => {
    setFormData({
      customer_name: order.customer_name || "",
      customer_phone: order.customer_phone || "",
      address: order.address || "",
      district: order.district || "",
      city: order.city || "",
      province: order.province || "",
      postal_code: order.postal_code || "",
      destination_area_id: order.destination_area_id || "",
    });
    setShowValidation(false);
  }, [order, open]);

  useEffect(() => {
    if (submitError) submitErrorRef.current?.focus();
  }, [submitError]);

  const customerEditable = !order.provider_order_id;
  // A digital order has no address or courier (DIGITAL-PRODUCTS-SPEC §2.3):
  // only the buyer's name and WhatsApp are edited, and the server refuses the rest.
  const digital = order.fulfillment_type === "digital";
  const courierEditable =
    !digital &&
    customerEditable &&
    order.payment_method === "cod" &&
    order.shipping_status === "pending";
  const locationEditable = courierEditable;
  const firstItem = order.items?.[0];

  // The combobox shows labels; saving needs the full row behind one.
  const locationRows = useRef(new Map<string, LocationOption>());
  const searchLocations = useCallback(
    async (query: string, signal: AbortSignal): Promise<DistrictOption[]> => {
      const response = await fetch(`/api/locations?search=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" }, signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal mencari kecamatan");
      const items = ((payload.items && payload.items.length ? payload.items : payload.alternatives) || payload.locations || []) as LocationOption[];
      const rows = useSubdistrict ? items : groupLocationResults(items).map((group) => group.items[0]);
      for (const row of rows) locationRows.current.set(String(row.id), row);
      return rows.map((row) => ({ id: String(row.id), label: row.label, detail: [row.district, row.city, row.province].filter(Boolean).join(", ") }));
    },
    [useSubdistrict],
  );

  useEffect(() => {
    if (
      !open ||
      !courierEditable ||
      !formData.destination_area_id ||
      !firstItem
    ) {
      setShippingRates([]);
      setSelectedCourierServiceId("");
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      destination_id: formData.destination_area_id,
      payment_method: order.payment_method || "cod",
      quantity: String(firstItem?.quantity || 1),
    });
    // The weight recorded on the order line, not the variant's current one:
    // the save re-quotes and dispatch ships at this weight (A-397). Sent in kg,
    // which the rate route reads as kg up to 100 kg a unit.
    // lazy: a unit over 100 kg would be read as grams; the save caps variants
    // at 50 kg (A-398). Upgrade path: an explicit unit on the rate route.
    const unitWeightKg = quoteUnitWeightKg(firstItem.weight_grams);
    if (unitWeightKg === null) params.set("variant_id", String(firstItem.variant_id || 1));
    else params.set("weight", String(unitWeightKg));
    // The same warehouse the save re-quotes from (PRD A42, REQ-241): the
    // order's own while it is active, else the one chosen by province.
    if (order.warehouse_id) params.set("warehouse_id", String(order.warehouse_id));
    if (formData.province) params.set("province", formData.province);
    setRatesLoading(true);
    void fetch(`/api/shipping-rates?${params}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Tarif pengiriman gagal dimuat.");
        }
        const rates = ((payload.items || payload.rates || []) as ShippingRate[]);
        setShippingRates(rates);
        const current = rates.find(
          (rate) =>
            rate.courier_code === order.courier_code &&
            rate.courier_service === order.courier_service
        );
        setSelectedCourierServiceId(
          current ? String(current.courier_service_id) : ""
        );
      })
      .catch((reason) => {
        if (!(reason instanceof Error && reason.name === "AbortError")) {
          setShippingRates([]);
          setSelectedCourierServiceId("");
          toast.error(
            reason instanceof Error
              ? reason.message
              : "Tarif pengiriman gagal dimuat."
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRatesLoading(false);
      });
    return () => controller.abort();
  }, [
    firstItem,
    formData.destination_area_id,
    formData.province,
    open,
    order.warehouse_id,
    order.courier_code,
    order.courier_service,
    courierEditable,
  ]);

  const selectedRate = shippingRates.find(
    (rate) => String(rate.courier_service_id) === selectedCourierServiceId
  );
  const editableFields = (digital
    ? ["customer_name", "customer_phone"]
    : ["customer_name", "customer_phone", "address", "district", "city", "province", "postal_code", "destination_area_id"]) as readonly (
    "customer_name" | "customer_phone" | "address" | "district" | "city" | "province" | "postal_code" | "destination_area_id"
  )[];
  const customerDirty = editableFields.some(
    (field) => formData[field].trim() !== String(order[field] || "").trim(),
  );
  const isFieldDirty = (field: (typeof editableFields)[number]) =>
    formData[field].trim() !== String(order[field] || "").trim();
  const fieldErrors = {
    customer_name:
      isFieldDirty("customer_name") && formData.customer_name.trim().length < 2
        ? "Nama minimal 2 karakter."
        : "",
    customer_phone:
      isFieldDirty("customer_phone") &&
      !/^(08|628)\d{8,11}$/.test(formData.customer_phone.replace(/[^\d]/g, ""))
        ? "Nomor HP harus berisi 10–13 digit, misalnya 081234567890."
        : "",
    address:
      isFieldDirty("address") && formData.address.trim().length < 10
        ? "Alamat lengkap minimal 10 karakter."
        : "",
    district:
      isFieldDirty("district") && formData.district.trim().length < 2
        ? "Pilih kecamatan dari hasil pencarian."
        : "",
    city:
      isFieldDirty("city") && formData.city.trim().length < 2
        ? "Kota/kabupaten belum valid."
        : "",
    province:
      isFieldDirty("province") && formData.province.trim().length < 2
        ? "Provinsi belum valid."
        : "",
    postal_code:
      isFieldDirty("postal_code") &&
      Boolean(formData.postal_code) &&
      !/^\d{5}$/.test(formData.postal_code)
        ? "Kode pos harus 5 digit."
        : "",
    destination_area_id: "",
  } satisfies Record<(typeof editableFields)[number], string>;
  const selectedRateChanged = Boolean(
    courierEditable &&
    selectedRate &&
    (selectedRate.courier_code !== order.courier_code ||
      selectedRate.courier_service !== order.courier_service ||
      formData.destination_area_id !== String(order.destination_area_id || "")),
  );
  const locationChanged =
    formData.destination_area_id.trim() !==
    String(order.destination_area_id || "").trim();
  const rateRequired = courierEditable && locationChanged && !selectedRate;
  const formValid =
    !Object.values(fieldErrors).some(Boolean) &&
    !rateRequired;

  const handleSubmit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>
  ) => {
    event.preventDefault();
    setShowValidation(true);
    if (!customerEditable || (!customerDirty && !selectedRateChanged)) return;
    if (!formValid) {
      window.requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-validation-error="true"]')
          ?.focus();
      });
      return;
    }
    setLoading(true);
    setSubmitError("");
    try {
      const customerPayload = Object.fromEntries(
        editableFields
          .filter((field) => formData[field].trim() !== String(order[field] || "").trim())
          .map((field) => [field, formData[field].trim()]),
      );
      const shippingPayload =
        selectedRateChanged && selectedRate
          ? {
              destination_area_id: formData.destination_area_id,
              courier_code: selectedRate.courier_code,
              courier_service_id: selectedRate.courier_service_id,
            }
          : {};
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(String(order.id))}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...customerPayload, ...shippingPayload }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Gagal menyimpan data.");
      }
      onUpdated({ ...order, ...payload.data });
      setOpen(false);
      toast.success(digital ? "Data pembeli berhasil diperbarui." : "Data pembeli dan pengiriman berhasil diperbarui.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terjadi kesalahan.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center">
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!loading) {
        setSubmitError("");
        setOpen(nextOpen);
      }
    }}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={!customerEditable}
            title={!customerEditable ? "Data terkunci karena shipment Mengantar sudah dibuat." : undefined}
          />
        }
      >
        {customerEditable ? <Edit3 aria-hidden="true" /> : <LockIcon aria-hidden="true" />}
        Edit<span className="sr-only">{digital ? " pembeli" : " pembeli & alamat"}</span>
      </DialogTrigger>
      <DialogContent className={`max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto p-0 rounded-xl ${digital ? "sm:max-w-lg" : "sm:max-w-4xl"}`}>
        <DialogHeader className="border-b border-slate-100 px-6 py-4 text-left">
          <DialogTitle className="text-base font-semibold text-slate-900">
            {digital ? "Edit Pembeli" : "Edit Pembeli & Pengiriman"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {digital
              ? "Produk digital tidak memakai alamat atau kurir. Perbarui nama dan nomor WhatsApp pembeli."
              : "Data pembeli dapat diperbarui sebelum shipment dibuat. Kurir hanya dapat diganti untuk order COD yang masih menunggu."}
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={handleSubmit} noValidate className={`grid grid-cols-1 gap-6 px-6 py-5 ${digital ? "" : "md:grid-cols-[minmax(0,1fr)_17rem]"}`}>
          {/* Two columns: what the operator edits on the left, what it costs
              and the save action on the right, where they stay in view. */}
          <div className="min-w-0 space-y-4">
          {submitError && (
            <div ref={submitErrorRef} className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 outline-none" role="alert" tabIndex={-1}>
              {submitError}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs font-semibold text-slate-700">
              <span>Nama Lengkap</span>
              <Input
                id="edit-customer-name"
                name="customer_name"
                value={formData.customer_name}
                onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                autoComplete="name"
                maxLength={100}
                aria-invalid={showValidation && Boolean(fieldErrors.customer_name)}
                aria-describedby={fieldErrors.customer_name ? "edit-customer-name-error" : undefined}
                className="font-semibold"
              />
              {showValidation && fieldErrors.customer_name && (
                <span id="edit-customer-name-error" className="block text-xs font-semibold text-rose-700">
                  {fieldErrors.customer_name}
                </span>
              )}
            </label>
            <label className="block space-y-1 text-xs font-semibold text-slate-700">
              <span>Nomor WhatsApp / HP</span>
              <Input
                id="edit-customer-phone"
                name="customer_phone"
                value={formData.customer_phone}
                onChange={(e) => setFormData({ ...formData, customer_phone: e.target.value })}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={40}
                aria-invalid={showValidation && Boolean(fieldErrors.customer_phone)}
                aria-describedby={fieldErrors.customer_phone ? "edit-customer-phone-error" : undefined}
                className="font-semibold font-mono"
              />
              {showValidation && fieldErrors.customer_phone && (
                <span id="edit-customer-phone-error" className="block text-xs font-semibold text-rose-700">
                  {fieldErrors.customer_phone}
                </span>
              )}
            </label>
          </div>

          {!digital && (<>
          <label className="block space-y-1 text-xs font-semibold text-slate-700">
            <span>Alamat Jalan / Rumah</span>
            <Textarea
              id="edit-customer-address"
              name="address"
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              autoComplete="street-address"
              maxLength={500}
              aria-invalid={showValidation && Boolean(fieldErrors.address)}
              aria-describedby={fieldErrors.address ? "edit-customer-address-error" : undefined}
              rows={2}
              className="resize-y"
              placeholder="Contoh: Jl. Merdeka No. 12 RT 01/02"
            />
            {showValidation && fieldErrors.address && (
              <span id="edit-customer-address-error" className="block text-xs font-semibold text-rose-700">
                {fieldErrors.address}
              </span>
            )}
          </label>

          <div className="space-y-2 border-t border-slate-100 pt-3">
            <div className="space-y-1.5">
              <label htmlFor="edit-customer-location-search" className="text-sm font-medium text-slate-700">Kecamatan tujuan</label>
              <DistrictCombobox
                id="edit-customer-location-search"
                minChars={2}
                disabled={!locationEditable}
                placeholder="Ketik minimal 2 huruf, misalnya Kebayoran Baru"
                value={formData.destination_area_id ? { id: formData.destination_area_id, label: [formData.district, formData.city].filter(Boolean).join(", ") } : null}
                onChange={(option) => {
                  const loc = option ? locationRows.current.get(option.id) : undefined;
                  if (!loc) return;
                  setFormData({
                    ...formData,
                    district: loc.district || "",
                    city: loc.city || "",
                    province: loc.province || "",
                    postal_code: loc.postal_code || formData.postal_code || "",
                    destination_area_id: String(loc.id || (loc as any).location_id || "").trim(),
                  });
                }}
                search={searchLocations}
              />
            </div>

            <p className="text-xs text-slate-500">
              {formData.district
                ? [formData.district, formData.city, formData.province, formData.postal_code].filter(Boolean).join(", ")
                : "Belum ada kecamatan tujuan."}
            </p>
          </div>

          {/* Opsi Kurir & Biaya Pengiriman (Ongkir) */}
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                <Truck className="size-4 text-emerald-600" />
                <span>Pilih Kurir & Biaya Pengiriman (Ongkir)</span>
              </span>
              {ratesLoading && (
                <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1 animate-pulse">
                  <Loader2 className="size-3 animate-spin" /> Memuat tarif...
                </span>
              )}
            </div>

            {ratesLoading ? (
              <div className="space-y-2">
                <div className="h-12 w-full rounded-xl bg-slate-100 animate-pulse border border-slate-200" />
                <div className="h-12 w-full rounded-xl bg-slate-100 animate-pulse border border-slate-200" />
              </div>
            ) : shippingRates.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Pilihan kurir dan ongkir">
                {shippingRates.map((rate) => {
                  const isSelected = String(rate.courier_service_id) === selectedCourierServiceId;
                  return (
                    <button
                      key={rate.courier_service_id}
                      type="button"
                      onClick={() => setSelectedCourierServiceId(String(rate.courier_service_id))}
                      role="radio"
                      aria-checked={isSelected}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border p-2.5 text-left transition-colors",
                        isSelected
                          ? "border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600/30 shadow-xs"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "size-4 rounded-full border flex items-center justify-center transition-colors shrink-0",
                            isSelected ? "border-emerald-600 bg-emerald-600" : "border-slate-300 bg-white"
                          )}
                        >
                          {isSelected && <Check className="size-2.5 text-white stroke-[3]" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-900">
                              {courierServiceLabel(rate.courier_code, rate.courier_service)}
                            </span>
                          </div>
                          {etaLabel(rate.estimated_days ?? "") && (
                            <span className="mt-0.5 block text-xs text-slate-500">{etaLabel(rate.estimated_days ?? "")}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-semibold text-xs text-emerald-700">
                          {currency(rate.shipping_cost)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : !courierEditable ? (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                <span className="font-semibold block text-slate-800">Biaya Ongkir Terkunci</span>
                <span>
                  Layanan pengiriman & ongkir saat ini:{" "}
                  <strong className="text-slate-900">
                    {order.courier_code ? courierServiceLabel(order.courier_code, order.courier_service) : "Belum ditentukan"}
                  </strong>{" "}
                  ({currency(order.shipping_cost || 0)})
                </span>
              </div>
            ) : formData.destination_area_id ? (
              <p className="text-xs text-amber-700 font-semibold bg-amber-50 p-3 rounded-xl border border-amber-200">
                Tidak ada pilihan kurir otomatis yang tersedia untuk lokasi ini ({formData.district || formData.destination_area_id}). Silakan ketik dan pilih ulang kecamatan dari menu pencarian di atas.
              </p>
            ) : (
              <p className="text-xs text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 font-medium">
                Cari & pilih kecamatan pada kolom pencarian di atas untuk menampilkan opsi kurir & biaya pengiriman.
              </p>
            )}
            {showValidation && rateRequired && (
              <p
                tabIndex={-1}
                data-validation-error="true"
                className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800 outline-none"
                role="alert"
              >
                Pilih layanan kurir untuk lokasi COD yang baru sebelum menyimpan.
              </p>
            )}
          </div>
          </>)}

          </div>
          <aside className="space-y-3 md:sticky md:top-0 md:self-start md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto">
          {/* Ringkasan Real-Time Total Order (Preview); a digital order's total never changes here. */}
          {!digital && (() => {
            const itemTotal =
              (order.items || []).reduce(
                (acc, item) => acc + Number(item.unit_price || 0) * Number(item.quantity || 1),
                0
              ) || Math.max(0, Number(order.total_amount || 0) - Number(order.shipping_cost || 0));
            const newShippingCost = selectedRate
              ? Number(selectedRate.shipping_cost || 0)
              : Number(order.shipping_cost || 0);
            const discount = Number(order.discount_amount || 0);
            const orderAmount = Math.max(0, itemTotal - discount + newShippingCost);
            const codFee = order.payment_method === "cod"
              ? calculateCodFeeBreakdown(orderAmount)
              : null;
            const newTotalAmount = order.payment_method === "cod"
              ? calculateCodCustomerTotal(orderAmount, order.cod_fee_bearer)
              : orderAmount;
            return (
              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 space-y-1.5 text-xs">
                <span className="block text-sm font-semibold text-slate-900">Total setelah disimpan</span>
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal Produk</span>
                  <span className="font-semibold text-slate-900">{currency(itemTotal)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Ongkir</span>
                  <span className="font-semibold text-emerald-700">{currency(newShippingCost)}</span>
                </div>
                {discount > 0 && (
                  <div className="flex justify-between text-slate-600">
                    <span>Diskon</span>
                    <span className="font-semibold text-slate-900">−{currency(discount)}</span>
                  </div>
                )}
                {codFee && order.cod_fee_bearer === "buyer" && (
                  <div className="flex justify-between text-slate-600">
                    <span>Fee COD + PPN</span>
                    <span className="font-semibold text-slate-900">{currency(codFee.totalFee)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-sm text-slate-900 pt-1.5 border-t border-slate-200">
                  <span>Total tagihan</span>
                  <span className="text-emerald-700">{currency(newTotalAmount)}</span>
                </div>
              </div>
            );
          })()}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={loading}
              className="w-full"
            >
              Batal
            </Button>
            <Button
              type="submit"
              disabled={loading || (!customerDirty && !selectedRateChanged)}
              className="w-full"
            >
              {loading ? "Menyimpan..." : "Simpan Perubahan"}
            </Button>
          </DialogFooter>
          </aside>
        </form>
      </DialogContent>
    </Dialog>
    </div>
  );
}

export function OrderDetail({
  invoice,
  mayReleaseDispatch = false,
  splitByKind = false,
}: {
  invoice: string;
  /** A hybrid store lists digital orders on their own page; the back link returns there. */
  splitByKind?: boolean;
  // Owner and admin only; the API refuses anyone else (403).
  mayReleaseDispatch?: boolean;
}) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const pushAccepted = useRef(false);
  const [notice, setNotice] = useState("");
  const [copiedTarget, setCopiedTarget] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [channelChoice, setChannelChoice] = useState<"mengantar" | "external">("mengantar");
  const [externalCourier, setExternalCourier] = useState("");
  const [externalService, setExternalService] = useState("");
  const [externalCnote, setExternalCnote] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");

    void fetch(`/api/admin/orders/${encodeURIComponent(invoice)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || "Detail order tidak ditemukan.");
        return payload.data as Order;
      })
      .then((data) => {
        setOrder(data);
        setChannelChoice(data.shipping_channel === "external" ? "external" : "mengantar");
        setExternalCourier(data.courier_code || "");
        setExternalService(data.courier_service || "");
        setExternalCnote(data.cnote_no || "");
      })
      .catch((reason) => {
        if (!(reason instanceof Error && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "Detail order gagal dimuat.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [invoice, reloadKey]);

  const allCrmMessages = useMemo<Record<string, string>>(() => {
    if (!order) return {};
    const crm = order.crm;
    const safePhone = String(order.customer_phone || "").trim();
    const items = Array.isArray(order.items) ? order.items : [];
    const messages: Record<string, string> = {};
    for (const step of CRM_STEPS) {
      messages[step.key] = renderCrmMessage(crm?.templates?.[step.key] || defaultCrmTemplates[step.key] || "", {
        customerName: order.customer_name || "Pelanggan",
        customerPhone: safePhone,
        address: order.address || undefined,
        district: order.district || "",
        city: order.city || undefined,
        province: order.province || "",
        postalCode: order.postal_code || undefined,
        orderNumber: order.order_number,
        productName:
          items
            .map((item) => item.product_title || item.variant_title)
            .filter(Boolean)
            .join(", ") || "Produk",
        items: items.map((item) => ({
          productName: item.product_title || item.variant_title,
          variantName: item.variant_title,
          quantity: item.quantity || 1,
          unitPrice: item.unit_price || 0,
          comparePrice: item.variant_compare_price ?? null,
        })),
        productPrice: items.reduce(
          (total, item) =>
            total + (item.quantity || 1) * (item.unit_price || 0),
          0,
        ),
        shippingCost: order.shipping_cost || 0,
        totalAmount: order.total_amount || 0,
        courierCode: order.courier_code || "",
        cnoteNo: order.cnote_no || undefined,
        sellerName: crm?.seller_name || "",
        bankAccounts: crm?.bank_accounts || "",
        epaymentLink: crm?.epayment_link || "",
        orderDetailsLink: crm?.order_details_link || "",
      });
    }
    return messages;
  }, [order]);

  const allCrmUrls = useMemo<Record<string, string>>(() => {
    if (!order) return {};
    const safePhone = String(order.customer_phone || "").trim();
    return Object.fromEntries(
      CRM_STEPS.map((step) => [
        step.key,
        buildWaUrl(safePhone, allCrmMessages[step.key] || ""),
      ]),
    );
  }, [allCrmMessages, order]);

  const copyToClipboard = async (
    text: string,
    target: string,
    label: string,
  ) => {
    if (!text.trim()) {
      toast.error(`${label} belum tersedia.`);
      return;
    }
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API tidak tersedia");
      }
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      toast.success(`${label} berhasil disalin.`);
      window.setTimeout(
        () =>
          setCopiedTarget((current) => (current === target ? "" : current)),
        2000,
      );
    } catch {
      toast.error(`${label} gagal disalin. Periksa izin clipboard browser.`);
    }
  };

  const updateStatus = async (shippingStatus: string) => {
    if (!order) return;
    const previous = order.shipping_status;
    setOrder({ ...order, shipping_status: shippingStatus });
    setSaving(true);
    setNotice("Menyimpan status pengiriman…");
    try {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(String(order.id))}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipping_status: shippingStatus }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Status pengiriman gagal diperbarui.");
      }
      setNotice(payload.message || "Status pengiriman berhasil diperbarui.");
      toast.success("Status pengiriman berhasil diperbarui.");
    } catch (reason) {
      setOrder((current) => (current ? { ...current, shipping_status: previous } : current));
      const msg = reason instanceof Error ? reason.message : "Status pengiriman gagal diperbarui.";
      setNotice(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // A manual transfer lands in the seller's own account, so the operator is the
  // only one who can confirm it. Marking it paid also sends the order's Meta
  // Purchase from the server: the buyer left /thanks long before.
  const confirmManualTransfer = async () => {
    if (!order) return;
    if (
      !(await confirm({
        title: `Transfer ${order.order_number} sudah masuk?`,
        description: `Pastikan ${currency(order.total_amount || 0)} sudah diterima di rekening toko. Order ditandai lunas dan Purchase dikirim ke Meta.`,
        confirmLabel: "Ya, transfer diterima",
        tone: "default",
      }))
    ) {
      return;
    }
    setSaving(true);
    setNotice("Menyimpan konfirmasi transfer…");
    try {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(String(order.id))}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_status: "paid" }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Konfirmasi transfer gagal disimpan.");
      }
      // A paid order has nothing left to pay: the FU chips must stop sending
      // the payment link, as the server stops issuing one (buyerPaymentPath).
      setOrder((current) =>
        current
          ? { ...current, ...payload.data, crm: current.crm && { ...current.crm, epayment_link: null } }
          : current,
      );
      setNotice(payload.message || "Transfer dikonfirmasi.");
      toast.success(payload.message || "Transfer dikonfirmasi.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Konfirmasi transfer gagal disimpan.";
      setNotice(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const saveExternalShipping = async (nextStatus?: "processing" | "shipped") => {
    if (!order) return;
    const courier = externalCourier.trim();
    const service = externalService.trim();
    const cnote = externalCnote.trim();
    if (nextStatus === "shipped" && (!courier || !cnote)) {
      toast.error("Isi kurir dan nomor resi sebelum menandai order terkirim.");
      return;
    }
    setSaving(true);
    setNotice("Menyimpan pengiriman luar Mengantar…");
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipping_channel: "external",
          courier_code: courier,
          courier_service: service,
          cnote_no: cnote,
          ...(nextStatus ? { shipping_status: nextStatus } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Pengiriman luar Mengantar gagal disimpan.");
      }
      setOrder((current) => (current ? { ...current, ...payload.data } : current));
      setChannelChoice("external");
      const msg =
        nextStatus === "shipped"
          ? "Resi disimpan dan status ditandai dikirim (luar Mengantar)."
          : "Pengiriman luar Mengantar disimpan.";
      setNotice(msg);
      toast.success(msg);
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : "Pengiriman luar Mengantar gagal disimpan.";
      setNotice(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const selectChannelChoice = async (next: "mengantar" | "external") => {
    setChannelChoice(next);
    if (!order || order.provider_order_id || order.shipping_status !== "pending") return;
    if (next === "mengantar" && order.shipping_channel === "external") {
      setSaving(true);
      try {
        const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipping_channel: "mengantar" }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Gagal mengganti jalur pengiriman.");
        }
        setOrder((current) => (current ? { ...current, ...payload.data } : current));
        setExternalCnote(payload.data?.cnote_no || "");
        toast.success("Jalur pengiriman dikembalikan ke Mengantar.");
      } catch (reason) {
        setChannelChoice("external");
        toast.error(reason instanceof Error ? reason.message : "Gagal mengganti jalur pengiriman.");
      } finally {
        setSaving(false);
      }
    }
  };

  // The push opens the dialog first: drop-off or a scheduled pickup (PRD A46).
  const pushToMengantar = () => {
    if (order) setPushOpen(true);
  };
  const submitPush = async (pickup: MengantarPickupChoice) => {
    if (!order) throw new Error("Order belum dimuat.");
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch-order", pickup }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Order gagal dikirim ke Mengantar.");
      }
      setOrder((current) => (current ? { ...current, ...payload.data } : current));
      pushAccepted.current = true;
      const message = payload.message || "Shipment diterima Mengantar.";
      setNotice(message);
      return {
        message,
        results: [{ orderId: order.id, status: payload.data?.dispatch_status || "dispatched", cnoteNo: payload.data?.cnote_no || undefined }],
      };
    } finally {
      setSaving(false);
    }
  };
  const closePush = (open: boolean) => {
    if (open) return;
    setPushOpen(false);
    if (pushAccepted.current && order) window.location.assign(`/admin/shipping?order=${encodeURIComponent(order.order_number)}`);
  };

  const linkAcceptedDispatch = async () => {
    if (!order) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link-accepted-dispatch" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal menautkan paket Mengantar.");
      toast.success(payload.message || "Paket Mengantar ditautkan.");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal menautkan paket Mengantar.");
    } finally {
      setSaving(false);
    }
  };
  const releaseUnknownDispatch = async () => {
    if (!order) return;
    if (!(await confirm({
      title: "Izinkan push ulang?",
      description: `Pastikan ${order.order_number} tidak ada di dashboard Mengantar. Kalau ternyata sudah ada, push ulang membuat paket kedua.`,
      confirmLabel: "Sudah dicek, izinkan",
    }))) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release-dispatch-unknown" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal mengizinkan push ulang.");
      toast.success(payload.message || "Order boleh di-push ulang.");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal mengizinkan push ulang.");
    } finally {
      setSaving(false);
    }
  };

  /**
   * A digital order is closed from its own page: cancelled while unpaid, refunded
   * once paid. Either one voids it, which closes the buyer's access on the next
   * request (digitalAccessOpen). The money itself is returned outside the app.
   */
  const closeDigitalOrder = async () => {
    if (!order) return;
    const paid = ["paid", "settled", "success"].includes(String(order.payment_status || "").toLowerCase());
    const confirmed = await confirm(
      paid
        ? {
            title: `Refund pesanan ${order.order_number}?`,
            description: "Order ditandai dikembalikan dan link akses pembeli langsung tertutup. Kembalikan dananya ke pembeli di luar aplikasi.",
            confirmLabel: "Refund & tutup akses",
          }
        : {
            title: `Batalkan pesanan ${order.order_number}?`,
            description: "Pesanan dibatalkan dan link pembayarannya tidak bisa dipakai lagi.",
            confirmLabel: "Batalkan pesanan",
          },
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(paid ? { payment_status: "refunded", shipping_status: "cancelled" } : { shipping_status: "cancelled" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || "Pesanan gagal ditutup.");
      toast.success(paid ? "Pesanan direfund. Akses pembeli tertutup." : "Pesanan dibatalkan.");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Pesanan gagal ditutup.";
      setNotice(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const deleteOrder = async () => {
    if (!order) return;
    if (!(await confirm({ title: `Hapus pesanan ${order.order_number}?`, description: "Pesanan terhapus permanen dan tidak dapat dikembalikan.", confirmLabel: "Hapus pesanan" }))) {
      return;
    }
    setSaving(true);
    setNotice("Menghapus order…");
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Gagal menghapus order.");
      }
      toast.success(`Order ${order.order_number} berhasil dihapus.`);
      window.location.assign(splitByKind && order.fulfillment_type === "digital" ? "/admin/orders/digital" : "/admin/orders");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Gagal menghapus order.";
      setNotice(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };
  const refreshRtsScoring = async () => {
    if (!order) return;
    setSaving(true);
    setNotice("Memeriksa risiko RTS dari Mengantar…");
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-scoring" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        message?: string;
        data?: Partial<typeof order>;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Gagal memperbarui risiko RTS dari Mengantar.");
      }
      toast.success(payload.message || "Risiko RTS berhasil diperbarui dari Mengantar.");
      setNotice(payload.message || "");
      if (payload.data) {
        setOrder((prev) => (prev ? { ...prev, ...payload.data } : prev));
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Gagal memperbarui risiko RTS.";
      setNotice(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const [kelolaPending, setKelolaPending] = useState(false);
  const pushToKelola = async () => {
    if (!order) return;
    setKelolaPending(true);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(String(order.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push-kelola" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        message?: string;
        data?: { kelola?: KelolaSync };
      };
      if (payload.data?.kelola) {
        const kelola = payload.data.kelola;
        setOrder((prev) => (prev ? { ...prev, kelola } : prev));
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || "Gagal mengirim order ke Kelola.");
      toast.success(payload.message || "Order terkirim ke Kelola.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Gagal mengirim order ke Kelola.");
    } finally {
      setKelolaPending(false);
    }
  };

  if (loading) {
    // Shaped like the page below (header, journey, two columns), so nothing moves when it lands.
    return (
      <div className="space-y-5 pb-16" aria-busy="true" aria-label="Memuat order">
        <div className="space-y-4">
          <div className="h-5 w-24 animate-pulse rounded bg-slate-200/70" />
          <div className="h-8 w-48 animate-pulse rounded bg-slate-200/70" />
          <div className="h-5 w-80 max-w-full animate-pulse rounded bg-slate-200/70" />
          <div className="h-[4.5rem] animate-pulse border-y border-slate-200 bg-slate-100/70" />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <div className="h-80 animate-pulse rounded-lg bg-slate-200/70" />
            <div className="h-56 animate-pulse rounded-lg bg-slate-200/70" />
          </div>
          <div className="space-y-4">
            <div className="h-64 animate-pulse rounded-lg bg-slate-200/70" />
            <div className="h-44 animate-pulse rounded-lg bg-slate-200/70" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <section className="mx-auto my-12 max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-center" role="alert">
        <h2 className="text-lg font-semibold text-slate-950">Order tidak ditemukan</h2>
        <p className="mt-2 text-sm text-slate-600">{error || "Nomor invoice ini tidak ada di toko ini."}</p>
        <a href="/admin/orders" className={buttonVariants({ variant: "outline", className: "mt-5" })}>
          <ArrowLeft aria-hidden="true" />
          Kembali ke Pesanan
        </a>
      </section>
    );
  }

  const safePhone = String(order.customer_phone || "").trim();
  const waNumber = safePhone.replace(/\D/g, "").replace(/^0/, "62");
  const riskValue = String(order.receiver_risk_label || "").toUpperCase();
  const risk = riskValue.includes("HIGH")
    ? { label: "Risiko tinggi", short: "Tinggi", dot: "bg-rose-500" }
    : riskValue.includes("MEDIUM")
    ? { label: "Risiko sedang", short: "Sedang", dot: "bg-amber-500" }
    : riskValue.includes("LOW")
    ? { label: "Risiko rendah", short: "Rendah", dot: "bg-emerald-500" }
    : { label: "Belum dinilai", short: "Belum dinilai", dot: "bg-slate-400" };

  const paymentStatus = String(order.payment_status || "unpaid").toLowerCase();
  const paymentPaid = ["paid", "settled", "success"].includes(paymentStatus);
  const digital = order.fulfillment_type === "digital";
  const digitalOpen = digital && paymentPaid && !isVoidOrder(order);
  // One tap for CS: the buyer's own order page carries the access once paid (/thanks locator).
  const digitalPaymentWaUrl = () => {
    const product = order.items?.[0]?.product_title || "produk digital";
    const message = `Halo ${order.customer_name || "Kak"}, pesanan ${product} (${order.order_number}) menunggu pembayaran. Total dan cara bayar ada di sini:\n${order.crm?.epayment_link ?? ""}\n\nAkses produk terbuka otomatis setelah pembayaran diterima.`;
    return `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
  };
  const digitalAccessWaUrl = () => {
    const page = `${window.location.origin}/thanks#o=${encodeURIComponent(String(order.id))}&t=${encodeURIComponent(order.public_status_token || "")}`;
    const product = order.items?.[0]?.product_title || "produk digital";
    const message = `Halo ${order.customer_name || "Kak"}, terima kasih sudah membeli ${product} (${order.order_number}). Pembayaran sudah kami terima. Buka produk digital Anda di sini:\n${page}\n\nSimpan link ini untuk membukanya lagi kapan saja.`;
    return `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
  };
  const paymentFailed = ["failed", "expired"].includes(paymentStatus);
  const paymentRefunded = paymentStatus === "refunded";
  const isCodPending = order.payment_method === "cod" && !paymentPaid && !paymentFailed && !paymentRefunded;

  const paymentDotColor = paymentPaid
    ? "bg-emerald-500"
    : paymentFailed
      ? "bg-rose-500"
      : paymentRefunded
        ? "bg-purple-500"
        : isCodPending
          ? "bg-slate-400"
          : "bg-amber-500";

  const paymentStatusText = isCodPending
    ? "Bayar di tempat (COD)"
    : paymentLabels[paymentStatus] || order.payment_status;

  const paymentReady =
    order.payment_method === "cod" ||
    ["paid", "settled", "success"].includes(order.payment_status);

  const shippingDataComplete = Boolean(
    order.address &&
      order.address.trim().length >= 10 &&
      order.district &&
      order.city &&
      order.province &&
      order.destination_area_id &&
      order.courier_code &&
      order.courier_service &&
      order.warehouse_id
  );

  const isExternalShipping =
    !digital && order.shipping_channel === "external" && !order.provider_order_id;

  const canConfirm =
    order.shipping_status === "pending" &&
    paymentReady &&
    shippingDataComplete &&
    !order.provider_order_id &&
    !isExternalShipping;

  const journey = fulfillmentSteps(order);
  const sourceHref = storeRelativeHref(order.source_page_path);
  const statusOptions =
    order.shipping_status === "pending"
      ? isExternalShipping
        ? ["pending", "processing", "shipped", "cancelled"]
        : ["pending", "cancelled"]
      : order.shipping_status === "cancelled"
      ? ["cancelled"]
      : ["processing", "shipped", "delivered", "returned", "cancelled"];

  const items = Array.isArray(order.items) ? order.items : [];
  const weight = summarizeOrderWeight(items);
  const formattedAddress = [
    order.address,
    order.district,
    order.city,
    order.province,
    order.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
  const deliveryTotals = order.receiver_performance?.totals;

  return (
    <div className="space-y-5 pb-16">
      {confirmDialog}
      <MengantarPushDialog
        open={pushOpen}
        onOpenChange={closePush}
        orderLabels={[{ id: order.id, label: order.order_number }]}
        submit={submitPush}
      />
      {/* Header: identity, the three status axes as text, and the order's actions. */}
      <div className="space-y-4">
        <a
          href={splitByKind && digital ? "/admin/orders/digital" : "/admin/orders"}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {splitByKind ? (digital ? "Pesanan produk digital" : "Pesanan produk fisik") : "Pesanan"}
        </a>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-2xl font-semibold tracking-tight text-slate-950">{order.order_number}</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void copyToClipboard(order.order_number, "invoice", "Nomor order")}
                aria-label="Salin nomor order"
                title="Salin nomor order"
              >
                {copiedTarget === "invoice" ? <Check className="text-emerald-600" aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {formatDate(order.created_at)} · ID {order.id}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
            {/* A digital order moves with its payment (delivered when paid); it is closed by Batalkan / Refund below, never by a shipping status. */}
            {!digital && (
            <div className="w-full sm:w-52">
              <FilterSelect
                id="order-shipping-status"
                ariaLabel="Status pengiriman"
                icon={Truck}
                value={order.shipping_status}
                onValueChange={(value) => void updateStatus(value)}
                disabled={saving}
                options={statusOptions.map((value) => ({ value, label: shippingLabels[value] || value }))}
              />
            </div>
            )}
            {safePhone && (
              <a
                href={`https://wa.me/${waNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "outline" })}
              >
                <Phone aria-hidden="true" />
                WhatsApp
              </a>
            )}
            <EditCustomerDialog order={order} onUpdated={setOrder} />
            {digital && !isVoidOrder(order) && (
              <Button type="button" variant="outline" onClick={() => void closeDigitalOrder()} disabled={saving} data-close-digital-order>
                {paymentPaid ? "Refund & tutup akses" : "Batalkan pesanan"}
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteOrder()}
              disabled={saving}
            >
              <Trash2 aria-hidden="true" />
              Hapus
            </Button>
          </div>
        </div>

    {/* One line per axis; colour is a dot, the word carries the meaning. */}
        <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm" data-order-status-axes>
          <div className="flex items-center gap-2">
            <dt className="text-slate-500">Pembayaran</dt>
            <dd className="flex items-center gap-1.5 font-medium text-slate-900">
              <span className={`size-2 rounded-full ${paymentDotColor}`} aria-hidden="true" />
              {paymentStatusText}
            </dd>
          </div>
          {/* A digital order's second axis is its access, not a shipment. */}
          <div className="flex items-center gap-2">
            <dt className="text-slate-500">{digital ? "Akses" : "Pengiriman"}</dt>
            <dd className="flex items-center gap-1.5 font-medium text-slate-900">
              <span className={`size-2 rounded-full ${digital ? (digitalOpen ? "bg-emerald-500" : isVoidOrder(order) ? "bg-slate-400" : "bg-amber-500") : shippingStatusDots[order.shipping_status] || "bg-slate-400"}`} aria-hidden="true" />
              {digital ? (digitalOpen ? "Akses terbuka" : isVoidOrder(order) ? "Akses ditutup" : "Terbuka setelah lunas") : shippingLabels[order.shipping_status] || order.shipping_status}
            </dd>
          </div>
          {!digital && (
            <div className="flex items-center gap-2">
              <dt className="text-slate-500">Risiko RTS</dt>
              <dd className="flex items-center gap-1.5 font-medium text-slate-900">
                <span className={`size-2 rounded-full ${risk.dot}`} aria-hidden="true" />
                {risk.short}
              </dd>
            </div>
          )}
        </dl>

        {notice && (
          <p role="status" className="flex items-center justify-between gap-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
            <span>{notice}</span>
            {saving && <RefreshCw className="size-4 animate-spin text-slate-500" aria-hidden="true" />}
          </p>
        )}

        {journey && (
          <ol
            className="grid grid-cols-1 gap-y-2 border-y border-slate-200 py-3 sm:grid-cols-[repeat(var(--steps),minmax(0,1fr))] sm:gap-y-0"
            style={{ "--steps": journey.length } as CSSProperties}
            aria-label="Alur pengiriman"
            data-order-journey
          >
            {journey.map((step, index) => (
              <li key={step.key} className="relative flex min-w-0 items-center gap-2.5 sm:block sm:pr-2" aria-current={step.state === "current" ? "step" : undefined}>
                {index > 0 && (
                  <span
                    className={`absolute top-[5px] right-[calc(100%-5px)] hidden h-px w-[calc(100%-10px)] sm:block ${step.state === "upcoming" ? "bg-slate-200" : "bg-slate-400"}`}
                    aria-hidden="true"
                  />
                )}
                <span
                  className={cn(
                    "relative block size-2.5 shrink-0 rounded-full border-2",
                    step.state === "done" && "border-slate-700 bg-slate-700",
                    step.state === "current" && "border-[var(--admin-accent)] bg-white",
                    step.state === "upcoming" && "border-slate-300 bg-white",
                    step.state === "stopped" && (step.key === "returned" ? "border-rose-600 bg-rose-600" : "border-slate-400 bg-slate-400"),
                  )}
                  aria-hidden="true"
                />
                <p className={cn(
                  "min-w-0 truncate text-sm sm:mt-2",
                  step.state === "upcoming" ? "text-slate-400" : "font-medium text-slate-900",
                  step.state === "stopped" && step.key === "returned" && "text-rose-700",
                )}>
                  {step.label}
                  <span className="sr-only">{step.state === "done" ? " (selesai)" : step.state === "current" ? " (sekarang)" : step.state === "stopped" ? " (berhenti)" : " (belum)"}</span>
                </p>
                <p className="ml-auto shrink-0 text-xs text-slate-500 sm:ml-0 sm:truncate">{step.at ? formatShortDate(step.at) : <span className="hidden sm:inline">{"\u00a0"}</span>}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {/* Buyer, address, source and items: one panel, sections divided by a rule. */}
          <section className="rounded-lg border border-slate-200 bg-white" aria-label="Pembeli dan produk">
            <div className={`grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:p-5 ${digital ? "" : "sm:grid-cols-2"}`}>
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-slate-500">Pembeli</h3>
                <p className="mt-1 text-base font-semibold text-slate-950">{order.customer_name || "—"}</p>
                <p className="mt-0.5 font-mono text-sm text-slate-700">{safePhone || "—"}</p>
                {/* Why Edit is disabled, in words: a disabled button cannot take focus, so a title alone is never read. */}
                {order.provider_order_id && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500" data-customer-locked>
                    <LockIcon className="size-3.5" aria-hidden="true" />
                    Data terkunci, shipment Mengantar sudah dibuat.
                  </p>
                )}
              </div>
              {!digital && (
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-medium text-slate-500">Alamat kirim</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!formattedAddress}
                    onClick={() => void copyToClipboard(formattedAddress, "address", "Alamat pelanggan")}
                    className="-my-1 -mr-2"
                  >
                    {copiedTarget === "address" ? <Check className="text-emerald-600" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copiedTarget === "address" ? "Tersalin" : "Salin"}
                  </Button>
                </div>
                <address className="mt-1 text-sm not-italic leading-relaxed text-slate-900">
                  {order.address || <span className="text-slate-500">Alamat jalan belum diisi</span>}
                  <br />
                  <span className="text-slate-600">
                    {[order.district, order.city, order.province].filter(Boolean).join(", ")}
                    {order.postal_code ? ` ${order.postal_code}` : ""}
                  </span>
                </address>
                {order.destination_area_id && (
                  <p className="mt-1 text-xs text-slate-500">
                    Area Mengantar <span className="font-mono text-slate-700">{order.destination_area_id}</span>
                  </p>
                )}
              </div>
              )}
            </div>

            {/* Where the order came from: plain text, the landing path a link to the live page. */}
            <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-slate-100 px-4 py-3 sm:px-5">
              <dt className="text-xs font-medium text-slate-500">Sumber</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <TrafficSourceBadge adClickIds={order.ad_click_ids} plain />
                {order.source_page_path && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">·</span>
                    {sourceHref ? (
                      <a
                        href={sourceHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 truncate font-mono text-xs text-slate-700 underline-offset-2 hover:underline"
                        title={order.source_page_path}
                      >
                        {order.source_page_path}
                      </a>
                    ) : (
                      <span className="min-w-0 truncate font-mono text-xs text-slate-700" title={order.source_page_path}>{order.source_page_path}</span>
                    )}
                  </>
                )}
              </dd>
            </dl>

            <div className="border-t border-slate-200">
              <div className="flex items-baseline justify-between px-4 pt-3 sm:px-5">
                <h3 className="text-xs font-medium text-slate-500">Produk</h3>
                <span className="text-xs text-slate-500">{items.length} item</span>
              </div>
              {items.length === 0 ? (
                <p className="px-4 py-4 text-sm text-slate-500 sm:px-5">Rincian item produk belum tersedia.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {items.map((item, index) => {
                    const itemWeight = weight.items[index];
                    return (
                      <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3 sm:px-5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-950">{item.product_title || "Produk"}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {item.variant_title || "Standard"}
                            {item.variant_sku ? ` · SKU ${item.variant_sku}` : ""}
                            {digital ? null : " · "}
                            {digital ? null : itemWeight?.unit != null && itemWeight.line != null ? (
                              <>
                                {item.quantity > 1 ? `${item.quantity} × ${formatGrams(itemWeight.unit)} = ` : ""}
                                {formatWeight(itemWeight.line)}
                                {weight.items.some((line) => line?.recorded !== itemWeight.recorded)
                                  ? ` (${itemWeight.recorded ? RECORDED_WEIGHT_LABEL : CURRENT_WEIGHT_LABEL})`
                                  : ""}
                              </>
                            ) : (
                              "berat tidak diketahui (varian dihapus)"
                            )}
                          </p>
                        </div>
                        <div className="shrink-0 text-right tabular-nums">
                          <p className="text-sm font-medium text-slate-950">{currency(item.unit_price * item.quantity)}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{item.quantity} × {currency(item.unit_price)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!digital && items.length > 0 && (
                <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-slate-100 px-4 py-3 text-sm sm:px-5">
                  <span className="text-slate-500">
                    Total berat
                    <span className="ml-1 text-xs">· {weight.recorded ? RECORDED_WEIGHT_LABEL : CURRENT_WEIGHT_LABEL}, dipakai saat kirim ke Mengantar</span>
                  </span>
                  <span className="font-medium tabular-nums text-slate-950">
                    {weight.total != null ? formatWeight(weight.total) : "Tidak diketahui"}
                  </span>
                </p>
              )}
            </div>
          </section>

          {digital && (
            <section className="rounded-lg border border-slate-200 bg-white" aria-labelledby="order-digital-title" data-digital-access-panel>
              <h3 id="order-digital-title" className="px-4 pt-4 text-sm font-semibold text-slate-950 sm:px-5">Akses produk digital</h3>
              <div className="space-y-4 p-4 text-sm sm:p-5">
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-slate-500">Status akses</dt>
                    <dd className={`font-semibold ${digitalOpen ? "text-emerald-700" : "text-slate-700"}`}>
                      {digitalOpen ? "Akses aktif" : isVoidOrder(order) ? "Akses ditutup (batal/refund)" : "Menunggu pembayaran"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Dibuka pembeli</dt>
                    <dd className={`font-semibold ${order.digital_accessed_at ? "text-emerald-700" : "text-slate-700"}`} data-digital-accessed={order.digital_accessed_at ? "yes" : "no"}>
                      {order.digital_accessed_at
                        ? `Sudah dibuka pembeli · ${new Date(order.digital_accessed_at).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}`
                        : "Belum dibuka"}
                    </dd>
                  </div>
                </dl>
                <p className="text-xs text-slate-500">Tanpa ekspedisi dan tanpa resi: link akses terbuka di halaman pesanan pembeli begitu pembayaran lunas.</p>
                {digitalOpen && waNumber && order.public_status_token ? (
                  <a href={digitalAccessWaUrl()} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "default" })} data-send-digital-access>
                    Kirim Akses via WhatsApp
                  </a>
                ) : !isVoidOrder(order) && waNumber && order.crm?.epayment_link ? (
                  // Unpaid: the buyer's /payment page, which shows the total with any admin fee.
                  <a href={digitalPaymentWaUrl()} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })} data-send-digital-payment>
                    Kirim Link Bayar via WhatsApp
                  </a>
                ) : null}
              </div>
            </section>
          )}

          {/* Shipping: the facts as one list, then the next action for this status. */}
          {!digital && (
          <section className="rounded-lg border border-slate-200 bg-white" aria-labelledby="order-shipping-title">
            <div className="flex items-center justify-between gap-2 px-4 pt-4 sm:px-5">
              <h3 id="order-shipping-title" className="text-sm font-semibold text-slate-950">Pengiriman</h3>
              <span className="text-xs text-slate-500">{isExternalShipping ? "Luar Mengantar" : "Mengantar"}</span>
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-500">Kurir</dt>
                <dd className="text-slate-900">
                  {order.courier_code ? courierServiceLabel(order.courier_code, order.courier_service) : <span className="text-slate-500">Belum dipilih</span>}
                </dd>
                <dt className="text-slate-500">Nomor resi</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  {order.cnote_no ? (
                    <>
                      <span className="min-w-0 break-all font-mono font-medium text-slate-950">{order.cnote_no}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void copyToClipboard(order.cnote_no || "", "tracking", "Nomor resi")}
                        aria-label="Salin nomor resi"
                        title="Salin nomor resi"
                        className="-my-1.5 shrink-0"
                      >
                        {copiedTarget === "tracking" ? <Check className="text-emerald-600" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      </Button>
                    </>
                  ) : (
                    <span className="text-slate-500">Belum terbit</span>
                  )}
                </dd>
                {order.provider_status_text && (
                  <>
                    <dt className="text-slate-500">Status kurir</dt>
                    <dd className="min-w-0 text-slate-900" data-provider-status>
                      {order.provider_status_text}
                      {order.provider_status_at && <span className="ml-1.5 text-xs text-slate-500">{formatDate(order.provider_status_at)}</span>}
                    </dd>
                  </>
                )}
                <dt className="text-slate-500">Gudang</dt>
                <dd className="text-slate-900">{order.warehouse_name || "Default Warehouse"}</dd>
                {order.provider_order_id && (
                  <>
                    <dt className="text-slate-500">ID Mengantar</dt>
                    <dd className="min-w-0 break-all font-mono text-xs leading-5 text-slate-700">{order.provider_order_id}</dd>
                  </>
                )}
              </dl>

              {order.provider_dispatch_error && isDispatchOutcomeUnknown(order.provider_dispatch_error) ? (
                // Audit 2026-10-31 M-1: Mengantar may have created the shipment.
                <div role="status" className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-semibold">Hasil push ke Mengantar belum pasti</p>
                  {acceptedShipmentId(order.provider_dispatch_error) ? (
                    <>
                      <p className="leading-relaxed">Mengantar sudah menerima paket ini (ID {acceptedShipmentId(order.provider_dispatch_error)}), tetapi hasilnya gagal disimpan di sini. Jangan push ulang: tautkan paketnya, lalu resi terisi saat sinkron status.</p>
                      <Button type="button" variant="outline" className="self-start" disabled={saving} onClick={() => void linkAcceptedDispatch()}>
                        Tautkan paket Mengantar
                      </Button>
                    </>
                  ) : (
                    <p className="leading-relaxed">Koneksi terputus atau respons tidak terbaca, jadi paket mungkin sudah dibuat. Cari {order.order_number} di dashboard Mengantar. Push ulang hanya kalau paketnya memang belum ada, supaya tidak terkirim dua kali.</p>
                  )}
                  {acceptedShipmentId(order.provider_dispatch_error) ? null : mayReleaseDispatch ? (
                    <Button type="button" variant="outline" className="self-start" disabled={saving} onClick={() => void releaseUnknownDispatch()}>
                      Sudah dicek, izinkan push ulang
                    </Button>
                  ) : (
                    <p className="leading-relaxed">Setelah dicek, owner atau admin yang dapat mengizinkan push ulang.</p>
                  )}
                </div>
              ) : order.provider_dispatch_error ? (
                <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                  <p className="font-medium">Gagal push ke Mengantar</p>
                  <p className="mt-0.5 leading-relaxed text-rose-800">{order.provider_dispatch_error}</p>
                </div>
              ) : null}

              {order.shipping_status === "pending" && !order.provider_order_id ? (
                <div className="space-y-3 border-t border-slate-100 pt-4">
                  {/* The channel is a choice, not an action: one segmented control, so the push below is the only primary button. */}
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <span id="order-channel-label" className="text-sm text-slate-500">Kirim lewat</span>
                  <div role="radiogroup" aria-labelledby="order-channel-label" className="inline-flex w-full rounded-lg bg-muted p-[3px] sm:w-auto">
                    {([
                      ["mengantar", "Mengantar", "Push ke Mengantar"],
                      ["external", "Di luar Mengantar", "Kirim di luar Mengantar"],
                    ] as const).map(([value, label, name]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-label={name}
                        aria-checked={channelChoice === value}
                        disabled={saving}
                        onClick={() => void selectChannelChoice(value)}
                        className="flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm sm:flex-none"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  </div>

                  {channelChoice === "mengantar" ? (
                    <Button
                      type="button"
                      onClick={pushToMengantar}
                      disabled={saving || !canConfirm}
                      className="w-full"
                    >
                      {!paymentReady
                        ? order.payment_method === "manual_transfer"
                          ? "Menunggu Konfirmasi Transfer"
                          : "Menunggu Pembayaran Online"
                        : !shippingDataComplete
                        ? "Lengkapi Alamat & Ekspedisi"
                        : "Push Order ke Mengantar"}
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-600">
                        Untuk paket lewat agregator lain atau langsung ke kurir. Statusnya diperbarui manual, tidak tersinkron dari Mengantar.
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <label htmlFor="external-courier-code" className="block text-sm font-medium text-slate-700">
                            Kurir
                          </label>
                          <Input
                            id="external-courier-code"
                            value={externalCourier}
                            onChange={(event) => setExternalCourier(event.target.value)}
                            maxLength={50}
                            placeholder="Contoh: JNE, J&T, SiCepat"
                            disabled={saving}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="external-courier-service" className="block text-sm font-medium text-slate-700">
                            Layanan (opsional)
                          </label>
                          <Input
                            id="external-courier-service"
                            value={externalService}
                            onChange={(event) => setExternalService(event.target.value)}
                            maxLength={120}
                            placeholder="Contoh: REG, EZ"
                            disabled={saving}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="external-cnote-no" className="block text-sm font-medium text-slate-700">
                          Nomor resi
                        </label>
                        <Input
                          id="external-cnote-no"
                          value={externalCnote}
                          onChange={(event) => setExternalCnote(event.target.value)}
                          maxLength={120}
                          placeholder="Masukkan nomor resi dari kurir/agregator"
                          className="font-mono"
                          disabled={saving}
                        />
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          onClick={() => void saveExternalShipping("shipped")}
                          disabled={saving || !externalCourier.trim() || !externalCnote.trim()}
                          className="flex-1"
                        >
                          Simpan &amp; Tandai Dikirim
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void saveExternalShipping("processing")}
                          disabled={saving}
                          className="sm:w-auto"
                        >
                          Simpan sebagai Diproses
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {isExternalShipping && (order.shipping_status === "processing" || order.shipping_status === "shipped") && (
                    <div className="space-y-3 border-t border-slate-100 pt-4">
                      <p className="text-sm text-slate-600">
                        Dikirim di luar Mengantar. Perbarui kurir dan resi di sini; majukan status lewat menu Status di atas.
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <label htmlFor="external-courier-code-edit" className="block text-sm font-medium text-slate-700">
                            Kurir
                          </label>
                          <Input
                            id="external-courier-code-edit"
                            value={externalCourier}
                            onChange={(event) => setExternalCourier(event.target.value)}
                            maxLength={50}
                            placeholder="Contoh: JNE, J&T, SiCepat"
                            disabled={saving}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="external-cnote-no-edit" className="block text-sm font-medium text-slate-700">
                            Nomor resi
                          </label>
                          <Input
                            id="external-cnote-no-edit"
                            value={externalCnote}
                            onChange={(event) => setExternalCnote(event.target.value)}
                            maxLength={120}
                            placeholder="Masukkan nomor resi"
                            className="font-mono"
                            disabled={saving}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void saveExternalShipping()}
                          disabled={saving}
                        >
                          Simpan Kurir &amp; Resi
                        </Button>
                        {order.shipping_status === "processing" && (
                          <Button
                            type="button"
                            onClick={() => void saveExternalShipping("shipped")}
                            disabled={saving || !externalCourier.trim() || !externalCnote.trim()}
                          >
                            Simpan &amp; Tandai Dikirim
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  <a
                    href={`/admin/shipping?order=${encodeURIComponent(order.order_number)}`}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--admin-accent)] hover:underline"
                  >
                    Buka di Pengiriman
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                </div>
              )}
            </div>
          </section>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {/* Payment: method and status once, then the bill as a ledger. */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="order-payment-title">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id="order-payment-title" className="text-sm font-semibold text-slate-950">Pembayaran</h3>
              <span className="text-sm text-slate-600">
                {paymentMethodLabels[order.payment_method] || String(order.payment_method || "COD").toUpperCase()}
              </span>
            </div>
            <div className="mt-3 space-y-3 text-sm">
              {order.payment_switched_at && (
                <p className="text-slate-600">
                  Diganti dari {String(order.payment_switched_from || "cod").toUpperCase()} pada {formatDate(order.payment_switched_at)}
                  {order.payment_switched_by ? ` oleh ${order.payment_switched_by}` : ""}.
                </p>
              )}
              {order.payment_switch?.available ? (
                <PaymentSwitchDialog
                  invoice={order.order_number}
                  totalAmount={order.payment_switch.total_amount}
                  onSwitched={() => setReloadKey((value) => value + 1)}
                />
              ) : order.payment_switch?.reason && !isVoidOrder(order) ? (
                <p className="text-xs text-slate-500">Ganti ke transfer/VA tidak tersedia: {order.payment_switch.reason}</p>
              ) : null}
              {order.payment_link && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`${window.location.origin}${order.payment_link}`)
                      .then(() => toast.success("Link pembayaran disalin. Kirim ke pembeli."))
                      .catch(() => toast.error("Link gagal disalin."));
                  }}
                >
                  Salin link pembayaran
                </Button>
              )}
              {order.payment_method === "manual_transfer" &&
                !paymentPaid &&
                !paymentFailed &&
                !isVoidOrder(order) && (
                  <Button
                    type="button"
                    onClick={() => void confirmManualTransfer()}
                    disabled={saving}
                    className="w-full"
                  >
                    Transfer Diterima
                  </Button>
                )}

              <dl className="space-y-1.5 border-t border-slate-100 pt-3 tabular-nums">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Subtotal produk</dt>
                  <dd className="text-slate-900">{currency(items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0))}</dd>
                </div>
                {!digital && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Ongkir</dt>
                    <dd className="text-slate-900">{currency(order.shipping_cost || 0)}</dd>
                  </div>
                )}
                {order.payment_method === "cod" && (
                  <>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Biaya COD 3%</dt>
                      <dd className="text-slate-900">{currency(order.cod_service_fee || 0)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">PPN 11% biaya COD</dt>
                      <dd className="text-slate-900">{currency(order.cod_service_fee_vat || 0)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Biaya COD ditanggung</dt>
                      <dd className="text-slate-900">{order.cod_fee_bearer === "buyer" ? "Pembeli" : "Seller"}</dd>
                    </div>
                  </>
                )}
              </dl>

              <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-3">
                <span className="font-medium text-slate-950">Total tagihan</span>
                <span className="text-lg font-semibold tabular-nums text-slate-950">{currency(order.total_amount || 0)}</span>
              </div>

              {/* The QRIS/VA admin fee (Paduka, 2026-11-02). Seller-borne: not
                  shown as a fee, it only lowers what the store receives.
                  Buyer-borne: shown, and the store receives the whole order. */}
              {order.payment_method !== "cod" && order.payment && Number(order.payment.admin_fee) > 0 && (() => {
                const payment = order.payment;
                const sellers = paymentFeeIsSellers(payment);
                return (
                  <div className="space-y-1.5 rounded-md bg-slate-50 p-3 tabular-nums">
                    {!sellers && (
                      <>
                        <div className="flex justify-between items-center gap-3">
                          <span className="text-slate-500 font-medium">Biaya admin {payment.channel_code} (pembeli)</span>
                          <span className="font-semibold text-slate-900">{currency(payment.admin_fee)}</span>
                        </div>
                        <div className="flex justify-between items-center gap-3">
                          <span className="text-slate-500 font-medium">Ditagih ke pembeli</span>
                          <span className="font-semibold text-slate-900">{currency(payment.total_amount)}</span>
                        </div>
                      </>
                    )}
                    <div className={`flex justify-between items-center gap-3 ${sellers ? "" : "border-t border-slate-200 pt-2"}`}>
                      <span className="font-semibold text-slate-900">Diterima toko</span>
                      <span className="font-semibold text-slate-900">
                        {currency(sellers ? Math.max(0, payment.total_amount - payment.admin_fee) : payment.amount)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          </section>

          {/* Receiver Risk Card: a digital order has no receiver to score. */}
          {!digital && (
          <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="order-receiver-title">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id="order-receiver-title" className="text-sm font-semibold text-slate-950">Riwayat penerima (RTS)</h3>
              <span className="flex items-center gap-1.5 text-sm text-slate-700">
                <span className={`size-2 rounded-full ${risk.dot}`} aria-hidden="true" />
                {risk.label}
              </span>
            </div>
            {order.receiver_delivery_rate == null ? (
              <p className="mt-3 text-sm text-slate-600">Belum ada skor untuk nomor ini.</p>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                <span className="text-2xl font-semibold tabular-nums text-slate-950">{order.receiver_delivery_rate}%</span>
                <span className="ml-2">sukses kirim</span>
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {order.receiver_performance?.grade && order.receiver_performance.grade !== "-"
                ? `Skor Mengantar ${order.receiver_performance.grade}, dari seluruh riwayat nomor ini.`
                : "Dari seluruh riwayat paket nomor ini."}
            </p>

            {order.receiver_performance_unavailable === "not-whitelisted" && !order.receiver_risk_label && (
              <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                Akses skor penerima Mengantar belum aktif untuk akun ini. Minta whitelist
                Receiver Score ke CS Mengantar; order akan dinilai otomatis setelah akses dibuka.
              </p>
            )}

            {deliveryTotals && typeof deliveryTotals === "object" && (
              <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-sm tabular-nums">
                <div><dt className="text-xs text-slate-500">Terkirim</dt><dd className="font-semibold text-slate-950">{deliveryTotals.delivered ?? 0}</dd></div>
                <div><dt className="text-xs text-slate-500">RTS</dt><dd className="font-semibold text-rose-700">{deliveryTotals.rts ?? 0}</dd></div>
                <div><dt className="text-xs text-slate-500">Diproses</dt><dd className="font-semibold text-slate-950">{deliveryTotals.inProgress ?? 0}</dd></div>
              </dl>
            )}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void refreshRtsScoring()}
              disabled={saving}
              className="mt-2 -ml-2"
            >
              <RefreshCw className={cn(saving && "animate-spin")} aria-hidden="true" />
              {saving ? "Memeriksa…" : "Perbarui riwayat"}
            </Button>
          </section>
          )}

          {order.kelola?.configured && (
            <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="order-kelola-title">
              <h3 id="order-kelola-title" className="text-sm font-semibold text-slate-950">Kelola CRM</h3>
              <div className="mt-3 space-y-3 text-sm">
                {order.kelola.synced_at ? (
                  <>
                    <p className="flex items-center gap-2 font-medium text-emerald-700">
                      <Check className="size-4" aria-hidden="true" />
                      Terkirim {formatDate(order.kelola.synced_at)}
                    </p>
                    {/* Kelola answers a resend of the same order code as a
                        duplicate, so a switch after the push cannot reach it. */}
                    {order.payment_switched_at && order.payment_switched_at > order.kelola.synced_at && (
                      <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 font-medium text-amber-900">
                        Pembayaran diganti ke {paymentMethodLabels[order.payment_method] || order.payment_method} setelah order terkirim. Kelola masih mencatat COD — perbarui pembayaran dan nilai COD di Kelola secara manual.
                      </p>
                    )}
                  </>
                ) : order.kelola.voided ? (
                  <p className="text-slate-500">Order dibatalkan, tidak dikirim ke Kelola.</p>
                ) : (
                  <>
                    <p className={cn("font-medium", order.kelola.attempts > 0 ? "text-rose-700" : "text-slate-600")}>
                      {order.kelola.attempts > 0
                        ? `Belum diterima Kelola (${order.kelola.attempts}× dicoba)`
                        : "Belum terkirim ke Kelola"}
                    </p>
                    {order.kelola.last_error && (
                      <p className="break-words rounded-lg bg-rose-50 px-3 py-2 font-mono text-rose-800">{order.kelola.last_error}</p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void pushToKelola()}
                      disabled={kelolaPending}
                      className="w-full"
                    >
                      <RefreshCw className={cn(kelolaPending && "animate-spin")} aria-hidden="true" />
                      {kelolaPending ? "Mengirim…" : order.kelola.attempts > 0 ? "Kirim ulang ke Kelola" : "Kirim ke Kelola"}
                    </Button>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Follow-up WhatsApp: the parcel journey's ten steps (address, shipping,
              "sudah dikirim"). A digital order sends its payment and access links
              from the panel above instead. */}
          {!digital && (
          <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="order-followup-title">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id="order-followup-title" className="text-sm font-semibold text-slate-950">Follow-up WhatsApp</h3>
              <a href="/admin/settings/crm" className="text-xs font-medium text-slate-500 hover:text-slate-900 hover:underline">
                Template
              </a>
            </div>
            <div className="mt-3">
              <CrmActionGroup crmUrls={allCrmUrls} orderId={order.id} />
            </div>
          </section>
          )}
        </div>
      </div>
    </div>
  );
}
