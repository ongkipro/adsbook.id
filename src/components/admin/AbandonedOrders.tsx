import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  PackageSearch,
  RefreshCw,
  UserRoundPlus,
  PanelsTopLeft,
} from "lucide-react";
import { SOURCE_SLUG_NONE_FILTER, SOURCE_SLUG_NONE_LABEL } from "@/lib/source-slug";
import { ADMIN_CUSTOM_DATE_FILTER, adminDateSelectionFromQuery } from "@/lib/admin-date-filter";
import { AdminDateRangeFilter, type AdminDateSelection } from "@/components/admin/AdminDateRangeFilter";
import { LEAD_FOLLOW_UP_LABELS, LEAD_FOLLOW_UP_STATUSES, LEAD_FOLLOW_UP_TONE, LEAD_STATUS_TRIGGER_CLASS, isLeadFollowUpStatus, leadAge, leadDaysLeft } from "@/lib/lead-follow-up";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildWaUrl } from "@/lib/crm-template";
import { formatIdr } from "@/lib/format-idr";
import { courierServiceLabel } from "@/lib/courier-names";
import { etaLabel } from "@/lib/rate-check";
import { groupLocationResults } from "@/lib/location-search";
import { Button } from "@/components/ui/button";
import { ExportCsvButton } from "@/components/admin/ExportCsvButton";
import { FilterBar, FilterField, FilterSelect, SearchInput } from "@/components/admin/filter-bar";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DistrictCombobox, type DistrictOption } from "@/components/admin/DistrictCombobox";

type FollowUpStatus = "new" | "contacted" | "qualified" | "not_interested";
type StatusCounts = Record<FollowUpStatus | "all", number>;

type Lead = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  productName: string;
  /** null when the lead has no product yet. */
  productType: "physical" | "digital" | null;
  variantName: string;
  variantId: number | null;
  quantity: number;
  followUpStatus: FollowUpStatus;
  followUpNote: string;
  followedUpAt: string | null;
  followedUpBy: string;
  createdAt: string;
  sourcePath: string | null;
  sourceLabel: string | null;
};

type Product = {
  id: number;
  title: string;
  productType: "physical" | "digital";
  is_active: boolean;
  variants: Array<{
    id: number;
    title: string;
    sku: string;
    price: number;
    stock: number | null;
  }>;
};

/** One row of /api/admin/payment-methods (the checkout's list); COD is left out for a digital lead. */
type PaymentMethod = {
  code: string;
  payment_method: string;
  channel_code: string | null;
  seller_bank_account_id?: number;
  name: string;
  fee_description?: string;
  is_active: boolean;
};

type LocationOption = {
  id: string;
  label: string;
  district: string;
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

const followUpLabels: Record<FollowUpStatus, string> = LEAD_FOLLOW_UP_LABELS;

const formatDate = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date)} WIB`;
};

function normalizeLead(row: Record<string, unknown>): Lead {
  const status = String(row.follow_up_status ?? row.lead_follow_up_status ?? "new");
  return {
    id: Number(row.id),
    orderNumber: String(row.order_number ?? row.orderNumber ?? ""),
    customerName: String(row.customer_name ?? row.customerName ?? ""),
    customerPhone: String(row.customer_phone ?? row.customerPhone ?? ""),
    productName: String(row.product_title ?? row.product_name ?? row.productName ?? ""),
    productType: row.product_type === "digital" ? "digital" : row.product_type === "physical" ? "physical" : null,
    variantName: String(row.variant_title ?? row.variant_name ?? row.variantName ?? ""),
    variantId: Number(row.variant_id ?? row.variantId) || null,
    quantity: Math.max(1, Number(row.quantity) || 1),
    followUpStatus: isLeadFollowUpStatus(status) ? status : "new",
    followUpNote: String(row.follow_up_note ?? row.lead_follow_up_note ?? ""),
    followedUpAt:
      String(row.followed_up_at ?? row.lead_followed_up_at ?? "") || null,
    followedUpBy: String(row.followed_up_by ?? row.lead_followed_up_by ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    sourcePath: typeof row.source_page_path === "string" ? row.source_page_path : null,
    sourceLabel: typeof row.source_label === "string" ? row.source_label : null,
  };
}

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || "Permintaan gagal diproses.");
  }
  return payload;
}

const leadRequest = {
  async list(input: {
    search: string;
    status: FollowUpStatus | "all";
    sourceSlug: string;
    dateSelection: AdminDateSelection;
    withSourceOptions: boolean;
    page: number;
    signal?: AbortSignal;
  }) {
    const query = new URLSearchParams({
      page: String(input.page),
      limit: "25",
      follow_up_status: input.status,
    });
    if (input.search.trim()) query.set("search", input.search.trim());
    if (input.sourceSlug !== "all") query.set("source_slug", input.sourceSlug);
    if (input.dateSelection.filter && input.dateSelection.filter !== "all") {
      query.set("date_filter", input.dateSelection.filter);
      if (input.dateSelection.filter === ADMIN_CUSTOM_DATE_FILTER) {
        query.set("date_start", input.dateSelection.start);
        query.set("date_end", input.dateSelection.end);
      }
    }
    if (input.withSourceOptions) query.set("source_options", "1");
    const payload = await readJson(
      await fetch(`/api/admin/abandoned-orders?${query}`, {
        headers: { Accept: "application/json" },
        signal: input.signal,
      }),
    );
    const rows = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.data?.items)
        ? payload.data.items
        : Array.isArray(payload.items)
          ? payload.items
          : [];
    const rawOptions = Array.isArray(payload.product_options)
      ? payload.product_options
      : Array.isArray(payload.data?.product_options)
        ? payload.data.product_options
        : [];
    const productsById = new Map<number, Product>();
    for (const row of rawOptions as Array<Record<string, unknown>>) {
      const productId = Number(row.product_id);
      const variantId = Number(row.variant_id);
      if (!productId || !variantId) continue;
      const product = productsById.get(productId) ?? {
        id: productId,
        title: String(row.product_title || "Produk"),
        productType: row.product_type === "digital" ? "digital" : "physical",
        is_active: true,
        variants: [],
      };
      product.variants.push({
        id: variantId,
        title: String(row.variant_title || "Varian"),
        sku: String(row.sku || ""),
        price: Number(row.price) || 0,
        stock: row.stock == null ? null : Number(row.stock),
      });
      productsById.set(productId, product);
    }
    const products = [...productsById.values()];
    return {
      leads: rows.map((row: Record<string, unknown>) => normalizeLead(row)),
      sourceOptions: Array.isArray(payload.source_options)
        ? (payload.source_options as Array<{ value: string; label: string; count: number }>).map((option) => ({
            value: String(option.value),
            label: `${option.label} (${Number(option.count) || 0})`,
          }))
        : null,
      products,
      pagination: {
        page: Number(payload.pagination?.page) || input.page,
        totalItems: Number(payload.pagination?.total_items) || 0,
        totalPages: Number(payload.pagination?.total_pages) || 0,
      },
      statusCounts: Object.fromEntries(
        ["all", ...LEAD_FOLLOW_UP_STATUSES].map((key) => [key, Number(payload.status_counts?.[key]) || 0]),
      ) as StatusCounts,
    };
  },
  // Status only: the server leaves the note alone when the field is absent, so a
  // status change never writes back a note loaded before another operator edited it.
  async followUp(lead: Lead, status: FollowUpStatus) {
    return readJson(
      await fetch("/api/admin/abandoned-orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: lead.id, follow_up_status: status }),
      }),
    );
  },
  async convert(payload: Record<string, unknown>) {
    return readJson(
      await fetch("/api/admin/abandoned-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert", ...payload }),
      }),
    );
  },
};

function ConversionDialog({
  lead,
  products,
  onClose,
}: {
  lead: Lead | null;
  products: Product[];
  /** `warning`: the order was made but its payment instruction was not. */
  onClose: (convertedOrderNumber?: string, warning?: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<{ id: string; message: string } | null>(null);
  // The combobox shows labels; the order needs the full row behind one.
  const locationRows = useRef(new Map<string, LocationOption>());
  const searchLocations = useCallback(async (query: string, signal: AbortSignal): Promise<DistrictOption[]> => {
    const payload = await readJson(
      await fetch(`/api/locations?search=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" }, signal }),
    );
    const rows = groupLocationResults((payload.items || payload.locations || []) as LocationOption[]).map((group) => group.items[0]);
    for (const row of rows) locationRows.current.set(String(row.id), row);
    return rows.map((row) => ({ id: String(row.id), label: row.label }));
  }, []);
  const [rates, setRates] = useState<ShippingRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[] | null>(null);
  const [paymentLoadError, setPaymentLoadError] = useState("");
  const [paymentCode, setPaymentCode] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    customerName: "",
    customerPhone: "",
    address: "",
    district: "",
    city: "",
    province: "",
    postalCode: "",
    destinationAreaId: "",
    variantId: "",
    quantity: "1",
    courierServiceId: "",
  });

  useEffect(() => {
    if (!lead) return;
    setError("");
    setFieldError(null);
    setRates([]);
    setPaymentCode("");
    // Read fresh per lead: a bank account added in another tab shows up, and one failed load does not stick.
    setPaymentMethods(null);
    setPaymentLoadError("");
    setForm({
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      address: "",
      district: "",
      city: "",
      province: "",
      postalCode: "",
      destinationAreaId: "",
      variantId: lead.variantId ? String(lead.variantId) : "",
      quantity: String(lead.quantity || 1),
      courierServiceId: "",
    });
  }, [lead]);

  // The product decides the order (DIGITAL-PRODUCTS-SPEC §5.1): a digital one
  // is paid first with no address or courier, a physical one ships COD.
  const selectedVariant = products
    .flatMap((product) => product.variants.map((variant) => ({ product, variant })))
    .find(({ variant }) => String(variant.id) === form.variantId);
  const digital = selectedVariant?.product.productType === "digital";

  // The checkout's own list, loaded the first time a digital product is picked.
  useEffect(() => {
    if (!lead || !digital || paymentMethods) return;
    const controller = new AbortController();
    void fetch("/api/admin/payment-methods", { cache: "no-store", signal: controller.signal })
      .then(readJson)
      .then((body: { data?: PaymentMethod[] }) =>
        setPaymentMethods((body.data || []).filter((method) => method.is_active && method.payment_method !== "cod")))
      .catch((reason) => {
        if (!(reason instanceof Error && reason.name === "AbortError")) setPaymentLoadError("Metode pembayaran gagal dimuat.");
      });
    return () => controller.abort();
  }, [digital, lead, paymentMethods]);

  useEffect(() => {
    if (!lead || digital || !form.destinationAreaId || !form.variantId) {
      setRates([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      destination_id: form.destinationAreaId,
      payment_method: "cod",
      variant_id: form.variantId,
      quantity: form.quantity || "1",
    });
    // The warehouse follows the buyer's province, as the conversion does (PRD A42).
    if (form.province) params.set("province", form.province);
    setRatesLoading(true);
    void fetch(`/api/shipping-rates?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
      .then(readJson)
      .then((payload) => {
        setRates((payload.items || payload.rates || []) as ShippingRate[]);
        setForm((current) => ({ ...current, courierServiceId: "" }));
      })
      .catch((reason) => {
        if (!(reason instanceof Error && reason.name === "AbortError")) {
          setRates([]);
          setError(reason instanceof Error ? reason.message : "Ongkir gagal dimuat.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRatesLoading(false);
      });
    return () => controller.abort();
  }, [digital, form.destinationAreaId, form.province, form.quantity, form.variantId, lead]);

  const selectedRate = rates.find(
    (rate) => String(rate.courier_service_id) === form.courierServiceId,
  );
  const chosenPayment = paymentMethods?.find((method) => method.code === paymentCode) ?? null;
  const submit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    if (!lead) return;
    const firstInvalid = !selectedVariant
      ? ["lead-variant", "Pilih produk dan varian aktif."]
      : !Number.isInteger(Number(form.quantity)) || Number(form.quantity) < 1 || Number(form.quantity) > 100
        ? ["lead-quantity", "Jumlah produk harus 1 sampai 100."]
      : form.customerName.trim().length < 2
        ? ["lead-customer-name", "Nama pembeli minimal 2 karakter."]
        : !/^(08|628)\d{8,11}$/.test(form.customerPhone.replace(/\D/g, ""))
          ? ["lead-customer-phone", "Nomor WhatsApp belum valid."]
          : digital
            ? !chosenPayment
              ? ["lead-payment", "Pilih metode pembayaran."]
              : null
          : form.address.trim().length < 10
            ? ["lead-address", "Alamat lengkap minimal 10 karakter."]
            : !form.destinationAreaId
              ? ["lead-location", "Pilih kecamatan dari hasil pencarian."]
              : !selectedRate
                ? ["lead-location", "Pilih kurir dan ongkir."]
                : null;
    if (firstInvalid) {
      setError("");
      setFieldError({ id: firstInvalid[0], message: firstInvalid[1] });
      window.requestAnimationFrame(() => document.getElementById(firstInvalid[0])?.focus());
      return;
    }
    setSaving(true);
    setError("");
    setFieldError(null);
    try {
      if (digital) {
        if (!chosenPayment) return;
        const response = await leadRequest.convert({
          order_id: lead.id,
          customer_name: form.customerName.trim(),
          customer_phone: form.customerPhone.replace(/\D/g, ""),
          variant_id: Number(form.variantId),
          quantity: Number(form.quantity),
          payment: chosenPayment.payment_method === "manual_transfer"
            ? { payment_method: "manual_transfer", seller_bank_account_id: chosenPayment.seller_bank_account_id }
            : { payment_method: chosenPayment.payment_method, payment_channel: chosenPayment.channel_code },
        });
        onClose(String(response.data?.order_number || ""), response.data?.payment_error ? String(response.message || "") : undefined);
        return;
      }
      if (!selectedRate) return;
      const response = await leadRequest.convert({
        order_id: lead.id,
        customer_name: form.customerName.trim(),
        customer_phone: form.customerPhone.replace(/\D/g, ""),
        address: form.address.trim(),
        district: form.district,
        city: form.city,
        province: form.province,
        postal_code: form.postalCode,
        destination_area_id: form.destinationAreaId,
        variant_id: Number(form.variantId),
        quantity: Number(form.quantity),
        courier_code: selectedRate.courier_code,
        courier_service_id: selectedRate.courier_service_id,
      });
      onClose(String(response.data?.order_number || response.order_number || ""));
    } catch (reason) {
      setFieldError(null);
      setError(reason instanceof Error ? reason.message : "Lead gagal diubah menjadi order.");
      window.requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(lead)} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="px-5 pt-5 text-left">
          <DialogTitle>{digital ? "Jadikan order produk digital" : "Edit & jadikan order"}</DialogTitle>
          <DialogDescription>
            {digital
              ? `Lengkapi pesanan ${lead?.orderNumber ?? ""}. Produk digital dibayar di muka tanpa alamat dan kurir; akses terbuka otomatis setelah lunas.`
              : `Lengkapi pesanan ${lead?.orderNumber ?? ""}. Konversi membuat order COD, tetapi belum mengirimkannya ke Mengantar.`}
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <form onSubmit={submit} noValidate className="space-y-6 px-5 pb-5">
          {error && (
            <div ref={errorRef} role="alert" tabIndex={-1} className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {error}
            </div>
          )}
          <section aria-labelledby="lead-buyer-heading" className="space-y-4">
            <div>
              <h3 id="lead-buyer-heading" className="font-medium">Data pembeli</h3>
              <p className="text-sm text-muted-foreground">Pastikan nama dan nomor WhatsApp dapat dihubungi.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium" htmlFor="lead-customer-name">
                <span>Nama pembeli</span>
                <Input id="lead-customer-name" autoComplete="name" aria-invalid={fieldError?.id === "lead-customer-name"} aria-describedby={fieldError?.id === "lead-customer-name" ? "lead-customer-name-error" : undefined} value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} required />
                {fieldError?.id === "lead-customer-name" && <span id="lead-customer-name-error" className="block text-xs text-destructive">{fieldError.message}</span>}
              </label>
              <label className="space-y-1.5 text-sm font-medium" htmlFor="lead-customer-phone">
                <span>Nomor WhatsApp</span>
                <Input id="lead-customer-phone" autoComplete="tel" inputMode="tel" aria-invalid={fieldError?.id === "lead-customer-phone"} aria-describedby={fieldError?.id === "lead-customer-phone" ? "lead-customer-phone-error" : undefined} value={form.customerPhone} onChange={(event) => setForm({ ...form, customerPhone: event.target.value })} required />
                {fieldError?.id === "lead-customer-phone" && <span id="lead-customer-phone-error" className="block text-xs text-destructive">{fieldError.message}</span>}
              </label>
            </div>
          </section>
          <Separator />
          <section aria-labelledby="lead-product-heading" className="space-y-4">
            <div>
              <h3 id="lead-product-heading" className="font-medium">Produk</h3>
              <p className="text-sm text-muted-foreground">Harga tetap diverifikasi dari data produk aktif.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem]">
              <div className="space-y-1.5">
                <label htmlFor="lead-variant" className="text-sm font-medium">Produk & varian</label>
                <Select
                  items={Object.fromEntries(products.filter((product) => product.is_active).flatMap((product) => product.variants.map((variant) => [String(variant.id), `${product.title} · ${variant.title} (${formatIdr(variant.price)})${product.productType === "digital" ? " · Digital" : ""}`])))}
                  value={form.variantId}
                  onValueChange={(value) => { setForm({ ...form, variantId: value ?? "", courierServiceId: "" }); setPaymentCode(""); }}
                >
                  <SelectTrigger id="lead-variant" aria-invalid={fieldError?.id === "lead-variant"} aria-describedby={fieldError?.id === "lead-variant" ? "lead-variant-error" : undefined}><SelectValue placeholder="Pilih produk" /></SelectTrigger>
                  <SelectContent>
                    {products.filter((product) => product.is_active).flatMap((product) => product.variants.map((variant) => (
                      <SelectItem key={variant.id} value={String(variant.id)}>
                        {product.title} · {variant.title} ({formatIdr(variant.price)}){product.productType === "digital" ? " · Digital" : ""}
                      </SelectItem>
                    )))}
                  </SelectContent>
                </Select>
                {fieldError?.id === "lead-variant" && <p id="lead-variant-error" className="text-xs text-destructive">{fieldError.message}</p>}
              </div>
              <label className="space-y-1.5 text-sm font-medium" htmlFor="lead-quantity">
                <span>Jumlah</span>
                <Input id="lead-quantity" type="number" min="1" max="100" aria-invalid={fieldError?.id === "lead-quantity"} aria-describedby={fieldError?.id === "lead-quantity" ? "lead-quantity-error" : undefined} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value, courierServiceId: "" })} required />
                {fieldError?.id === "lead-quantity" && <span id="lead-quantity-error" className="block text-xs text-destructive">{fieldError.message}</span>}
              </label>
            </div>
          </section>
          <Separator />
          {digital ? (
          <section aria-labelledby="lead-payment-heading" className="space-y-4">
            <div>
              <h3 id="lead-payment-heading" className="font-medium">Pembayaran</h3>
              <p className="text-sm text-muted-foreground">Tanpa ongkir dan tanpa COD. Setelah order dibuat, kirim link pembayaran ke pembeli dari halaman order.</p>
            </div>
            {paymentLoadError ? (
              <p role="alert" className="text-sm text-destructive">{paymentLoadError}</p>
            ) : !paymentMethods ? (
              <Skeleton className="h-14 w-full" />
            ) : paymentMethods.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
                Belum ada metode non-COD yang aktif. <a className="font-medium text-foreground underline underline-offset-4" href="/admin/payments#rekening-bank-section">Tambahkan rekening toko</a> atau aktifkan AutoLaris.
              </div>
            ) : (
              <div id="lead-payment" tabIndex={-1} className="grid grid-cols-1 gap-2 outline-none sm:grid-cols-2" role="radiogroup" aria-label="Metode pembayaran" aria-invalid={fieldError?.id === "lead-payment"} aria-describedby={fieldError?.id === "lead-payment" ? "lead-payment-error" : undefined}>
                {paymentMethods.map((method) => {
                  const selected = method.code === paymentCode;
                  return (
                    <Button key={method.code} type="button" variant={selected ? "secondary" : "outline"} role="radio" aria-checked={selected} className="h-auto items-start justify-start whitespace-normal p-3 text-left" onClick={() => setPaymentCode(method.code)}>
                      <span>
                        <span className="block font-semibold">{method.name}</span>
                        {method.fee_description && <span className="mt-0.5 block text-xs text-muted-foreground">{method.fee_description}</span>}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}
            {fieldError?.id === "lead-payment" && <p id="lead-payment-error" className="text-xs text-destructive">{fieldError.message}</p>}
            {selectedVariant && (
              <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Harga produk<span className="sr-only">,</span> <span className="text-xs">(biaya admin mengikuti metode)</span></span>
                <strong>{formatIdr(selectedVariant.variant.price * Math.max(1, Number(form.quantity) || 1))}</strong>
              </div>
            )}
          </section>
          ) : (
          <section aria-labelledby="lead-shipping-heading" className="space-y-4">
            <div>
              <h3 id="lead-shipping-heading" className="font-medium">Alamat & pengiriman</h3>
              <p className="text-sm text-muted-foreground">Pilih kecamatan agar ongkir COD dapat dihitung.</p>
            </div>
            <label className="block space-y-1.5 text-sm font-medium" htmlFor="lead-address">
              <span>Alamat lengkap</span>
              <Textarea id="lead-address" autoComplete="street-address" aria-invalid={fieldError?.id === "lead-address"} aria-describedby={fieldError?.id === "lead-address" ? "lead-address-error" : undefined} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Jalan, nomor rumah, RT/RW, dan patokan" required />
              {fieldError?.id === "lead-address" && <span id="lead-address-error" className="block text-xs text-destructive">{fieldError.message}</span>}
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="lead-location">Kecamatan tujuan</label>
              <DistrictCombobox
                id="lead-location"
                minChars={2}
                placeholder="Ketik minimal 2 huruf"
                value={form.destinationAreaId ? { id: form.destinationAreaId, label: [form.district, form.city].filter(Boolean).join(", ") } : null}
                onChange={(option) => {
                  const row = option ? locationRows.current.get(option.id) : undefined;
                  setForm({
                    ...form,
                    district: row?.district ?? "",
                    city: row?.city ?? "",
                    province: row?.province ?? "",
                    postalCode: row?.postal_code || "",
                    destinationAreaId: row ? String(row.id) : "",
                    courierServiceId: "",
                  });
                }}
                search={searchLocations}
                invalid={fieldError?.id === "lead-location"}
                describedBy={fieldError?.id === "lead-location" ? "lead-location-error" : "lead-location-help"}
              />
              <p id="lead-location-help" className="text-xs text-muted-foreground">
                {form.destinationAreaId ? `${form.district}, ${form.city}, ${form.province}` : "Pilih hasil pencarian agar ongkir dapat dihitung."}
              </p>
              {fieldError?.id === "lead-location" && <p id="lead-location-error" className="text-xs text-destructive">{fieldError.message}</p>}
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Kurir & ongkir</p>
              {ratesLoading ? <Skeleton className="h-14 w-full" /> : rates.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Pilihan kurir dan ongkir">
                  {rates.map((rate) => {
                    const selected = form.courierServiceId === String(rate.courier_service_id);
                    return <Button key={rate.courier_service_id} type="button" variant={selected ? "secondary" : "outline"} role="radio" aria-checked={selected} className="h-auto items-start justify-start whitespace-normal p-3 text-left" onClick={() => setForm({ ...form, courierServiceId: String(rate.courier_service_id) })}>
                      <span>
                        <span className="block font-semibold">{courierServiceLabel(rate.courier_code, rate.courier_service)}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{formatIdr(rate.shipping_cost)}{etaLabel(rate.estimated_days ?? "") ? ` · ${etaLabel(rate.estimated_days ?? "")}` : ""}</span>
                      </span>
                    </Button>;
                  })}
                </div>
              ) : <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">Pilih produk dan kecamatan untuk melihat kurir.</div>}
            </div>
          </section>
          )}
          <DialogFooter className="mx-0 mb-0 border-t px-0 pt-5 pb-0">
            <Button type="button" variant="outline" onClick={() => onClose()} disabled={saving}>Batal</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
              {digital ? "Jadikan order digital" : "Jadikan order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// `initialQuery` is the page's own query string, from `Astro.url.search`:
// filters start from it rather than `window.location`, so the server-rendered
// first paint and the hydrating client agree (a mismatch is React error #418).
// `operator` is the signed-in username: the server records it on every status change, and the row shows it at once.
export function AbandonedOrders({ initialQuery = "", operator = "" }: { initialQuery?: string; operator?: string } = {}) {
  const [initialParams] = useState(() => new URLSearchParams(initialQuery));
  const [leads, setLeads] = useState<Lead[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState(() => initialParams.get("search") || "");
  // A deep link (the dashboard's "Lead belum dihubungi") opens the list on its status.
  const [status, setStatus] = useState<FollowUpStatus | "all">(() => {
    const value = initialParams.get("follow_up_status");
    return value && Object.hasOwn(followUpLabels, value) ? (value as FollowUpStatus) : "all";
  });
  const [sourceSlug, setSourceSlug] = useState(() => initialParams.get("source_slug") || "all");
  const [dateSelection, setDateSelection] = useState<AdminDateSelection>(() =>
    adminDateSelectionFromQuery(initialParams),
  );
  const [sourceOptions, setSourceOptions] = useState<Array<{ value: string; label: string }> | null>(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, totalItems: 0, totalPages: 0 });
  // Rows with a save in flight. Per row: one shared id let a finished save re-enable another row mid-save.
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [statusCounts, setStatusCounts] = useState<StatusCounts | null>(null);

  const hasLoadedRef = useRef(false);
  const load = async (signal?: AbortSignal) => {
    setRefreshing(true);
    setError("");
    try {
      const result = await leadRequest.list({
        search,
        status,
        sourceSlug,
        dateSelection,
        withSourceOptions: !sourceOptions,
        page,
        signal,
      });
      if (result.sourceOptions) setSourceOptions(result.sourceOptions);
      setLeads(result.leads);
      setProducts(result.products);
      setPagination(result.pagination);
      setStatusCounts(result.statusCounts);
      hasLoadedRef.current = true;
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === "AbortError")) {
        const message = reason instanceof Error ? reason.message : "Pesanan tertinggal gagal dimuat.";
        if (hasLoadedRef.current) setNotice(message);
        else setError(message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [page, search, status, sourceSlug, dateSelection]);

  // One path for every status change: the label menu and the WhatsApp auto-mark.
  // The row and the chip counts move at once; a failure puts both back. A row
  // with a save in flight takes no second change, so two saves never race.
  const setFollowUp = async (lead: Lead, next: FollowUpStatus, announce: string) => {
    if (lead.followUpStatus === next || busyIds.has(lead.id)) return;
    const before = lead;
    const followedUpAt = new Date().toISOString();
    setBusyIds((ids) => new Set(ids).add(lead.id));
    setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, followUpStatus: next, followedUpAt, followedUpBy: operator } : item));
    setStatusCounts((counts) => counts && { ...counts, [before.followUpStatus]: Math.max(0, counts[before.followUpStatus] - 1), [next]: counts[next] + 1 });
    try {
      await leadRequest.followUp(lead, next);
      setNotice(announce);
    } catch (reason) {
      setLeads((current) => current.map((item) => item.id === lead.id ? before : item));
      setStatusCounts((counts) => counts && { ...counts, [before.followUpStatus]: counts[before.followUpStatus] + 1, [next]: Math.max(0, counts[next] - 1) });
      setNotice(reason instanceof Error ? reason.message : "Status follow-up gagal dicatat.");
    } finally {
      setBusyIds((ids) => {
        const rest = new Set(ids);
        rest.delete(lead.id);
        return rest;
      });
    }
  };

  // Opening the chat is the contact (owner, 2026-11-27): a lead not yet contacted becomes
  // "Sudah dihubungi". The record says the chat was opened, not that a message was sent,
  // and a blocked pop-up records nothing.
  const openWhatsApp = (lead: Lead) => {
    const phone = lead.customerPhone.replace(/\D/g, "").replace(/^0/, "62");
    const message = `Halo Kak ${lead.customerName || "Pelanggan"}, kami ingin membantu melanjutkan pesanan ${lead.productName || "produk pilihan Kakak"}. Apakah ada yang bisa kami bantu?`;
    // Opened without "noopener" in the features so a blocked window is detectable (null); the opener is cut right after.
    const opened = window.open(buildWaUrl(phone, message), "_blank");
    if (!opened) {
      setNotice("WhatsApp tidak terbuka: izinkan pop-up untuk halaman ini, lalu coba lagi.");
      return;
    }
    opened.opener = null;
    if (lead.followUpStatus === "new") {
      void setFollowUp(lead, "contacted", `${lead.orderNumber} ditandai Sudah dihubungi karena chat WhatsApp dibuka. Status ini tidak memastikan pesan terkirim.`);
    }
  };

  if (loading) return (
    // Shaped like the page below: filters, status chips, then rows with the same four columns.
    <div className="space-y-4" aria-label="Memuat pesanan tertinggal" aria-busy="true">
      <Skeleton className="h-[5.5rem] w-full rounded-lg" />
      <div className="flex gap-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-28 rounded-lg" />)}</div>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="grid grid-cols-1 gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_11rem_auto] lg:items-center lg:gap-5">
            <div className="space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
            <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
            <div className="space-y-2"><Skeleton className="h-8 w-36" /><Skeleton className="h-3 w-24" /></div>
            <Skeleton className="h-10 w-full lg:w-64" />
          </div>
        ))}
      </div>
    </div>
  );

  if (error) return (
    <Card role="alert" className="border-destructive/20">
      <CardContent className="py-6 text-center">
        <AlertCircle className="mx-auto size-8 text-destructive" aria-hidden="true" />
        <h2 className="mt-3 font-semibold">Pesanan tertinggal gagal dimuat</h2>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}><RefreshCw />Coba lagi</Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      {/* No card title here: the page header above already names this screen and
          describes it, so a second heading only cost vertical space. */}
      <Card size="sm">
        <CardContent>
          {/* FilterBar/FilterField (DESIGN-SYSTEM.md §7.1), the same row as
              OrdersTable: one label style, widths from `size`, and the row
              wraps instead of overlapping. */}
          <FilterBar>
            <FilterField label="Cari lead" htmlFor="abandoned-search" size="lg">
              <SearchInput id="abandoned-search" value={search} onValueChange={(value) => { setSearch(value); setPage(1); }} placeholder="Produk, nama, WhatsApp, atau ABN" />
            </FilterField>
            <FilterField label="Halaman sumber" htmlFor="source-page-filter" size="md">
              <FilterSelect
                id="source-page-filter"
                icon={PanelsTopLeft}
                value={sourceSlug}
                onValueChange={(value) => { setSourceSlug(value); setPage(1); }}
                options={[
                  { value: "all", label: "Semua halaman" },
                  ...(sourceOptions ?? []),
                  ...(sourceSlug !== "all" && sourceSlug !== SOURCE_SLUG_NONE_FILTER && !(sourceOptions ?? []).some((option) => option.value === sourceSlug)
                    ? [{ value: sourceSlug, label: sourceSlug }]
                    : []),
                  { value: SOURCE_SLUG_NONE_FILTER, label: SOURCE_SLUG_NONE_LABEL },
                ]}
              />
            </FilterField>
            <FilterField label="Periode lead" htmlFor="abandoned-date" size="sm">
              <AdminDateRangeFilter
                value={dateSelection}
                onChange={(next) => {
                  setDateSelection(next);
                  setPage(1);
                }}
              />
            </FilterField>
            <ExportCsvButton
              kind="abandoned"
              query={new URLSearchParams({
                follow_up_status: status,
                ...(search.trim() ? { search: search.trim() } : {}),
                ...(sourceSlug !== "all" ? { source_slug: sourceSlug } : {}),
                ...(dateSelection.filter && dateSelection.filter !== "all"
                  ? {
                      date_filter: dateSelection.filter,
                      ...(dateSelection.filter === ADMIN_CUSTOM_DATE_FILTER
                        ? { date_start: dateSelection.start, date_end: dateSelection.end }
                        : {}),
                    }
                  : {}),
              })}
              title="Semua pesanan tertinggal dengan filter ini"
            />
            {/* The count sits on the row's trailing edge, which is otherwise blank. */}
            <p className="w-full text-xs font-medium text-muted-foreground sm:ml-auto sm:w-auto sm:pb-2.5" role="status" aria-live="polite">
              {refreshing ? "Memperbarui pesanan tertinggal…" : `${pagination.totalItems} pesanan tertinggal`}
            </p>
          </FilterBar>
        </CardContent>
      </Card>
      {/* The queue by follow-up status: one chip per status with its count and colour.
          Counts are the whole queue (the API ignores search, source and date for them). */}
      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Filter status follow-up (jumlah dari semua lead)" data-lead-status-chips>
        {(["all", ...LEAD_FOLLOW_UP_STATUSES] as const).map((value) => {
          const active = status === value;
          const count = statusCounts?.[value];
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => { setStatus(value); setPage(1); }}
              className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {value !== "all" && <span className={`size-2 shrink-0 rounded-full ${LEAD_FOLLOW_UP_TONE[value].dot}`} aria-hidden="true" />}
              {value === "all" ? "Semua" : followUpLabels[value]}
              {count !== undefined && (
                <span className={`tabular-nums ${active ? "text-white/70" : "text-slate-500"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </nav>
      {notice && (
        <p role="status" aria-live="polite" className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{notice}</p>
      )}
      {leads.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <PackageSearch className="mx-auto size-9 text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-3 font-semibold">{search.trim() || status !== "all" || sourceSlug !== "all" ? "Tidak ada hasil yang cocok" : "Belum ada pesanan tertinggal"}</h2>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{search.trim() || status !== "all" || sourceSlug !== "all" ? "Ubah pencarian atau filter." : "Lead akan muncul ketika pembeli sudah mengisi nama dan WhatsApp tetapi belum menyelesaikan order."}</p>
          </CardContent>
        </Card>
      ) : (
        /* One divided list rather than a card per lead. This is a work queue: at
           a card each, seven leads ran 2097px in an 832px viewport - roughly
           240px per lead, most of it padding and a footer holding two buttons.
           The row keeps every field and both actions, and stacks on small
           screens. */
        <section className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white" aria-label="Daftar pesanan tertinggal">
          {leads.map((lead) => {
            const tone = LEAD_FOLLOW_UP_TONE[lead.followUpStatus];
            const age = leadAge(lead.createdAt);
            const daysLeft = leadDaysLeft(lead.createdAt);
            const busy = busyIds.has(lead.id);
            return (
              <div
                key={lead.id}
                role="article"
                aria-labelledby={`lead-${lead.id}-title`}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_11rem_auto] lg:items-center lg:gap-5"
                data-lead-status={lead.followUpStatus}
              >
                {/* Buyer first: the queue is worked by person, the product is context.
                    On a phone the status sits beside the buyer (order-2), the product
                    and actions span the row below; from lg the four columns read left to right. */}
                <div className="order-1 min-w-0 lg:order-none">
                  <p id={`lead-${lead.id}-title`} className="truncate font-medium text-slate-950">{lead.customerName || "Tanpa nama"}</p>
                  <p className="truncate font-mono text-xs text-slate-500">{lead.customerPhone}</p>
                </div>
                <div className="order-3 col-span-2 min-w-0 lg:order-none lg:col-span-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm text-slate-900">
                    <span className="truncate">{lead.productName || "Produk belum dipilih"}</span>
                    {/* The kind decides the conversion: digital is paid first with no address. */}
                    {lead.productType && (
                      <span
                        className={`shrink-0 rounded px-1.5 py-px text-xs font-medium ${lead.productType === "digital" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`}
                        data-lead-kind={lead.productType}
                      >
                        {lead.productType === "digital" ? "Digital" : "Fisik"}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {lead.variantName || "Varian belum dipilih"} · {lead.orderNumber}
                    {lead.sourceLabel && <span title={lead.sourcePath ?? lead.sourceLabel}> · {lead.sourceLabel}</span>}
                  </p>
                  {!lead.variantId && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-rose-700">
                      <AlertCircle className="size-3.5" aria-hidden="true" />Pilih produk sebelum konversi
                    </p>
                  )}
                </div>

                {/* The status is the one coloured thing on the row, and it is the control that changes it. */}
                <div className="order-2 min-w-0 text-right lg:order-none lg:text-left">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={busy}
                      aria-label={`Status follow-up ${lead.orderNumber}: ${followUpLabels[lead.followUpStatus]}. Ubah status`}
                      className={`${LEAD_STATUS_TRIGGER_CLASS} ${tone.label}`}
                      data-lead-status-trigger
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />}
                      <span className="truncate">{followUpLabels[lead.followUpStatus]}</span>
                      <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Status follow-up</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={lead.followUpStatus}
                          onValueChange={(value) => { if (isLeadFollowUpStatus(value)) void setFollowUp(lead, value, `${lead.orderNumber}: ${followUpLabels[value]}.`); }}
                        >
                          {LEAD_FOLLOW_UP_STATUSES.map((value) => (
                            // A pick closes the menu, as a select does: Base UI radio items stay open by default.
                            <DropdownMenuRadioItem key={value} value={value} closeOnClick className="gap-2">
                              <span className={`size-2 shrink-0 rounded-full ${LEAD_FOLLOW_UP_TONE[value].dot}`} aria-hidden="true" />
                              {followUpLabels[value]}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <p className="mt-1 text-xs text-slate-500">
                    {lead.followedUpAt ? (
                      <time dateTime={lead.followedUpAt} title={formatDate(lead.followedUpAt)}>
                        Dicatat {leadAge(lead.followedUpAt) ?? formatDate(lead.followedUpAt)}
                        {lead.followedUpBy ? ` oleh ${lead.followedUpBy}` : ""}
                      </time>
                    ) : (
                      <time dateTime={lead.createdAt} title={formatDate(lead.createdAt)}>Masuk {age ?? formatDate(lead.createdAt)}</time>
                    )}
                    {daysLeft !== null && (
                      <span className="text-rose-700"> · {daysLeft === 0 ? "dihapus hari ini" : `dihapus ${daysLeft} hari lagi`}</span>
                    )}
                  </p>
                </div>

                <div className="order-4 col-span-2 flex gap-2 lg:order-none lg:col-span-1 lg:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 lg:flex-none"
                    onClick={() => openWhatsApp(lead)}
                    title={lead.followUpStatus === "new" ? "Buka WhatsApp dan tandai sudah dihubungi" : "Buka WhatsApp"}
                  >
                    <MessageCircle aria-hidden="true" />
                    WhatsApp
                    {lead.followUpStatus === "new" && <span className="sr-only">, lalu tandai sudah dihubungi</span>}
                  </Button>
                  <Button type="button" className="flex-1 lg:flex-none" onClick={() => setSelectedLead(lead)}>
                    <UserRoundPlus aria-hidden="true" />
                    Jadikan order
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {pagination.totalPages > 1 && (
        <Pagination aria-label="Halaman pesanan tertinggal" className="justify-between">
          <PaginationContent className="w-full justify-between gap-3">
            <PaginationItem>
              <Button type="button" variant="outline" disabled={refreshing || pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                <ChevronLeft /> <span className="hidden sm:inline">Sebelumnya</span>
              </Button>
            </PaginationItem>
            <PaginationItem>
              <span className="text-sm font-medium text-muted-foreground" aria-current="page">Halaman {pagination.page} dari {pagination.totalPages}</span>
            </PaginationItem>
            <PaginationItem>
              <Button type="button" variant="outline" disabled={refreshing || pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}>
                <span className="hidden sm:inline">Berikutnya</span> <ChevronRight />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
      <ConversionDialog lead={selectedLead} products={products} onClose={(orderNumber, warning) => {
        setSelectedLead(null);
        if (!orderNumber) return;
        // A converted order whose payment instruction failed stays here with the
        // warning in view (a navigation would drop it); every other conversion
        // opens the order page, where a digital order's payment link is sent from.
        if (warning) {
          setNotice(warning);
          void load();
          return;
        }
        window.location.assign(`/admin/orders/${encodeURIComponent(orderNumber)}`);
      }} />
    </div>
  );
}
