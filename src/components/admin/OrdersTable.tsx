import { formatIdr } from "@/lib/format-idr";
import { useConfirm } from "./useConfirm";
import { paymentInstructionHint } from "../../lib/order-instruction-hint";
import { TrafficSourceBadge } from "./TrafficSourceBadge";
import { CrmActionGroup } from "./CrmActionGroup";
import { MengantarPushDialog, type MengantarPushResult } from "./MengantarPushDialog";
import type { MengantarPickupChoice } from "../../lib/mengantar-order";
import type { OrderFollowUp } from "../../lib/order-follow-up";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildWaUrl,
  defaultCrmTemplates,
  renderCrmMessage,
  type CrmOrderItem,
} from "../../lib/crm-template";
import { initialOrderListFilters, orderListQuery } from "../../lib/admin-orders-initial";
import type { OrderListKind } from "../../lib/order-list-filter";
import { digitalAccessStage } from "../../lib/digital-access";
import { providerDispatchErrorText } from "../../lib/payment-dispatch-policy";
import { SOURCE_SLUG_NONE_FILTER, SOURCE_SLUG_NONE_LABEL } from "../../lib/source-slug";
import { buyerAreaLines } from "../../lib/province";
import {
  AdminDateRangeFilter,
  type AdminDateSelection,
} from "./AdminDateRangeFilter";
import { Button, buttonVariants } from "../ui/button";
import { DataTableShell } from "./DataTableShell";
import { ExportCsvButton } from "./ExportCsvButton";
import { SHIPPING_STATUS_LABELS } from "@/lib/shipping-status";
import { FilterBar, FilterField, FilterSelect, SearchInput, type FilterOption } from "./filter-bar";
import { Checkbox } from "../ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationEllipsis,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../ui/pagination";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  MoreHorizontal,
  Eye,
  Truck,
  Filter,
  Trash2,
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
  CreditCard,
  Megaphone,
  PanelsTopLeft,
  RotateCcw,
  Send,
} from "lucide-react";

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export type OrderItem = {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  address: string;
  productName: string;
  variantName?: string;
  items?: CrmOrderItem[];
  productPrice: number;
  shippingCost: number;
  district: string;
  city: string;
  province: string;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  /**
   * The latest AutoLaris instruction's state — failed/expired means the buyer
   * has nothing to pay with.
   *
   * Optional because this row has two independent producers: `mapOrder` for
   * the client fetch, and the SQL in `src/pages/admin/orders/index.astro` for
   * the server-rendered first paint. The second one omitted it and every
   * admin order page rendered blank, so the type now forces both readers to
   * cope rather than trusting a field that may not be there.
   */
  paymentInstructionStatus?: string;
  shippingStatus: string;
  courierCode: string;
  cnoteNo: string;
  /** DIGITAL-PRODUCTS-SPEC §4.3; optional for the same reason as above (two producers). */
  fulfillmentType?: string;
  digitalAccessedAt?: string | null;
  sellerName: string;
  bankAccounts: string;
  epaymentLink: string;
  orderDetailsLink: string;
  receiverDeliveryRate: number;
  receiverRiskLabel: RiskLevel;
  createdAt: string;
  dispatchEligible: boolean;
  dispatchReason: string;
  providerDispatchError: string | null;
  providerOrderId: string | null;
  adClickIds?: string | null;
  sourcePath?: string | null;
  sourceLabel?: string | null;
  /** The page's follow-up records, read with the list; null when that read failed. */
  followUps?: OrderFollowUp[] | null;
};

type OrderRow = {
  id: number | string;
  order_number: string;
  customer_name: string;
  customer_phone: string;
  address: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  product_name: string | null;
  variant_name?: string | null;
  product_price: number;
  items?: Array<{ product: string | null; variant: string | null; quantity: number; unit_price: number; compare_price: number | null }>;
  shipping_cost: number;
  total_amount: number;
  payment_method: string;
  payment_status: string;
  payment_instruction_status?: string | null;
  shipping_status: string;
  courier_code: string | null;
  cnote_no: string | null;
  fulfillment_type?: string | null;
  digital_accessed_at?: string | null;
  seller_name: string | null;
  bank_accounts: string;
  epayment_link: string | null;
  order_details_link: string | null;
  receiver_delivery_rate: number | null;
  receiver_risk_label: string | null;
  created_at: string;
  follow_ups?: OrderFollowUp[] | null;
  dispatch_eligible?: boolean;
  dispatch_reason?: string;
  provider_dispatch_error?: string | null;
  provider_order_id?: string | null;
  ad_click_ids?: string | null;
  source_page_path?: string | null;
  source_label?: string | null;
};

type OrdersPagination = {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
};

type OrdersSummary = {
  totalOrders: number;
  unpaidCount: number;
  highRiskCount: number;
  unopenedCount: number;
  totalValue: number;
};

const toRiskLevel = (value: string | null | undefined): RiskLevel => {
  const normalized = String(value || "").toUpperCase();
  if (normalized.includes("HIGH")) return "HIGH";
  if (normalized.includes("MEDIUM")) return "MEDIUM";
  if (normalized.includes("LOW")) return "LOW";
  return "UNKNOWN";
};

export const mapOrder = (row: OrderRow): OrderItem => ({
  id: String(row.id),
  orderNumber: row.order_number,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  address: row.address || "",
  productName: row.product_name || "",
  variantName: row.variant_name || "",
  items: (row.items ?? []).map((item) => ({
    productName: item.product,
    variantName: item.variant,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    comparePrice: item.compare_price,
  })),
  productPrice: Number(row.product_price) || 0,
  shippingCost: Number(row.shipping_cost) || 0,
  district: row.district || "",
  city: row.city || "",
  province: row.province || "",
  totalAmount: Number(row.total_amount) || 0,
  paymentMethod: row.payment_method,
  paymentStatus: row.payment_status,
  paymentInstructionStatus: row.payment_instruction_status || "",
  shippingStatus: row.shipping_status,
  courierCode: row.courier_code || "",
  cnoteNo: row.cnote_no || "",
  fulfillmentType: row.fulfillment_type === "digital" ? "digital" : "physical",
  digitalAccessedAt: row.digital_accessed_at ?? null,
  sellerName: row.seller_name || "",
  bankAccounts: row.bank_accounts || "",
  epaymentLink: row.epayment_link || "",
  orderDetailsLink: row.order_details_link || "",
  receiverDeliveryRate:
    row.receiver_delivery_rate == null
      ? -1
      : Number(row.receiver_delivery_rate),
  receiverRiskLabel: toRiskLevel(row.receiver_risk_label),
  createdAt: row.created_at,
  followUps: row.follow_ups ?? null,
  dispatchEligible: Boolean(row.dispatch_eligible),
  dispatchReason: row.dispatch_reason || "",
  providerDispatchError: row.provider_dispatch_error || null,
  providerOrderId: row.provider_order_id || null,
  adClickIds: row.ad_click_ids || null,
  sourcePath: row.source_page_path || null,
  sourceLabel: row.source_label || null,
});

/** DIGITAL-PRODUCTS-SPEC §4.3: a digital order shows this instead of a courier and an airway bill. */
function DigitalOrderBadge({ accessedAt }: { accessedAt?: string | null }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
      <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700" data-fulfillment="digital">Digital</span>
      <span className={accessedAt ? "text-emerald-700" : "text-slate-500"}>{accessedAt ? "Sudah dibuka" : "Belum dibuka"}</span>
    </span>
  );
}


/**
 * The digital list's WhatsApp column. The ten CRM steps are written for a
 * parcel (address, shipping cost, "sudah dikirim"); a digital order has two
 * messages: the payment link while it waits, the access link once paid.
 */
function DigitalWaActions({ order }: { order: OrderItem }) {
  const stage = digitalAccessState(order).label;
  const product = order.items?.[0]?.productName || order.productName || "produk digital";
  const action =
    stage === "Akses terbuka" && order.orderDetailsLink
      ? { label: "Kirim link akses", text: digitalAccessMessage(order) }
      : order.epaymentLink && stage !== "Batal" && stage !== "Dikembalikan"
        ? {
            label: "Kirim link bayar",
            // No amount: a QRIS/VA admin fee lives on the payment, and /payment shows the exact total.
            text: `Halo ${order.customerName || "Kak"}, pesanan ${product} (${order.orderNumber}) menunggu pembayaran. Total dan cara bayar ada di sini:\n${order.epaymentLink}\n\nAkses produk terbuka otomatis setelah pembayaran diterima.`,
          }
        : null;
  return (
    <div className="flex flex-col items-start gap-1" data-digital-wa={action?.label ?? "none"}>
      {action ? (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={buildWaUrl(order.customerPhone, action.text)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Send aria-hidden="true" />
          {action.label}
        </a>
      ) : (
        <span className="text-xs text-slate-500">Tidak ada pesan yang perlu dikirim</span>
      )}
      <a className="text-xs font-medium text-slate-600 hover:text-slate-950 hover:underline" href={buildWaUrl(order.customerPhone, `Halo ${order.customerName || "Kak"}`)} target="_blank" rel="noopener noreferrer">
        Chat WhatsApp
      </a>
    </div>
  );
}

/** The access message CS sends: the buyer's own order page, which carries the link once paid (as OrderDetail). */
function digitalAccessMessage(order: OrderItem) {
  const product = order.items?.[0]?.productName || order.productName || "produk digital";
  return `Halo ${order.customerName || "Kak"}, terima kasih sudah membeli ${product} (${order.orderNumber}). Pembayaran sudah kami terima. Buka produk digital Anda di sini:\n${order.orderDetailsLink}\n\nSimpan link ini untuk membukanya lagi kapan saja.`;
}

/**
 * The digital list's one status: where the buyer's access stands. Read from
 * the same fields `digitalAccessOpen` gates on, so "Akses terbuka" is shown
 * exactly when the buyer's link works.
 */
function digitalAccessState(order: OrderItem): { label: string; detail: string; dot: string; text: string } {
  const stage = digitalAccessStage({ payment_status: order.paymentStatus, shipping_status: order.shippingStatus });
  if (stage === "void") {
    return { label: order.paymentStatus === "refunded" ? "Dikembalikan" : "Batal", detail: "Akses ditutup", dot: "bg-slate-400", text: "text-slate-600" };
  }
  if (stage === "open") {
    return order.digitalAccessedAt
      ? { label: "Akses terbuka", detail: `Dibuka pembeli ${formatDateTime(order.digitalAccessedAt)}`, dot: "bg-emerald-500", text: "text-emerald-700" }
      : { label: "Akses terbuka", detail: "Belum dibuka pembeli", dot: "bg-emerald-500", text: "text-emerald-700" };
  }
  const payment = prepaidPaymentState(order);
  if (payment && !payment.paid) return { label: payment.label, detail: "Terbuka otomatis saat lunas", dot: payment.dot, text: payment.text };
  return { label: "Menunggu pembayaran", detail: "Terbuka otomatis saat lunas", dot: "bg-amber-500", text: "text-amber-700" };
}

function DigitalAccessCell({ order }: { order: OrderItem }) {
  const state = digitalAccessState(order);
  return (
    <div className="min-w-0" data-digital-access={state.label}>
      <p className={`flex items-center gap-1.5 truncate font-semibold ${state.text}`}>
        <span className={`size-2 shrink-0 rounded-full ${state.dot}`} aria-hidden="true" />
        {state.label}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-500" title={state.detail}>{state.detail}</p>
    </div>
  );
}

const shippingLabels = SHIPPING_STATUS_LABELS;

const shippingStatusStyles: Record<string, string> = {
  pending: "bg-amber-500",
  processing: "bg-sky-500",
  shipped: "bg-blue-600",
  delivered: "bg-emerald-600",
  returned: "bg-rose-600",
  cancelled: "bg-slate-500",
};


const quickStatusFilters = [
  { value: "all", label: "Semua" },
  { value: "pending", label: "Menunggu" },
  { value: "processing", label: "Diproses" },
  { value: "shipped", label: "Dalam pengiriman" },
  { value: "delivered", label: "Terkirim" },
  { value: "returned", label: "Retur (RTS)" },
  { value: "cancelled", label: "Batal" },
] as const;

/**
 * A digital order has no shipment (DIGITAL-PRODUCTS-SPEC §2.3): it waits for
 * payment, then its access is open (`markDigitalOrderDelivered` moves it to
 * `delivered`), or it is void. The chips filter the same status column, in
 * the words of that journey; processing, shipped and returned never occur.
 */
const digitalStatusFilters = [
  { value: "all", label: "Semua" },
  { value: "pending", label: "Menunggu pembayaran" },
  { value: "delivered", label: "Akses terbuka" },
  { value: "cancelled", label: "Batal" },
] as const;

type QuickStatus = (typeof quickStatusFilters)[number]["value"];
type StatusCounts = Record<QuickStatus, number>;

function HighlightSearchMatch({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase("id-ID");
  if (!normalizedQuery) return text;
  const matchIndex = text.toLocaleLowerCase("id-ID").indexOf(normalizedQuery);
  if (matchIndex < 0) return text;
  const matchEnd = matchIndex + normalizedQuery.length;
  return (
    <>
      {text.slice(0, matchIndex)}
      <mark className="rounded bg-amber-200 px-0.5 text-inherit">
        {text.slice(matchIndex, matchEnd)}
      </mark>
      {text.slice(matchEnd)}
    </>
  );
}

function OrderActionMenu({
  order,
  updatingOrderId,
  dispatching,
  onDispatch,
  onDelete,
  onShippingStatusChange,
  onRefreshScoring,
}: {
  order: OrderItem;
  updatingOrderId: string | number | null;
  dispatching: boolean;
  onDispatch: (orderId: string) => void;
  onDelete: (orderId: string) => void;
  onShippingStatusChange: (orderId: string, status: string) => void;
  onRefreshScoring: (orderId: string) => void;
}) {
  const isUpdating = updatingOrderId === order.id;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={isUpdating}
            aria-label={`Aksi order ${order.orderNumber}`}
          />
        }
      >
        {isUpdating ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800" aria-hidden="true" />
        ) : (
          <MoreHorizontal className="size-4 text-slate-600" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-slate-500">
          Order {order.orderNumber}
        </DropdownMenuLabel>

        <DropdownMenuItem render={<a href={`/admin/orders/${encodeURIComponent(order.orderNumber)}`} />}>
          <Eye className="text-slate-500" aria-hidden="true" />
          <span>Lihat Detail Order</span>
        </DropdownMenuItem>

        {order.fulfillmentType === "digital" ? (
          digitalAccessState(order).label === "Akses terbuka" && order.orderDetailsLink ? (
            <DropdownMenuItem
              render={<a href={buildWaUrl(order.customerPhone, digitalAccessMessage(order))} target="_blank" rel="noopener noreferrer" />}
            >
              <Send className="text-slate-500" aria-hidden="true" />
              <span>Kirim link akses via WA</span>
            </DropdownMenuItem>
          ) : null
        ) : (
          <DropdownMenuItem
            onClick={() => onRefreshScoring(order.id)}
            disabled={isUpdating}
          >
            <ShieldAlert className="text-slate-500" aria-hidden="true" />
            <span>Cek risiko RTS</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />

        {order.fulfillmentType === "digital" ? null : order.providerOrderId ? (
          <>
            <DropdownMenuLabel className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              Status ekspedisi
            </DropdownMenuLabel>
            {Object.entries(shippingLabels).map(([value, label]) => {
              const isCurrent = order.shippingStatus === value;
              return (
                <DropdownMenuItem
                  key={value}
                  onClick={() => onShippingStatusChange(order.id, value)}
                  className={isCurrent ? "justify-between bg-emerald-50 font-medium text-emerald-900" : "justify-between"}
                >
                  <span className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${shippingStatusStyles[value] || "bg-slate-400"}`} />
                    {label}
                  </span>
                  {isCurrent && <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden="true" />}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : order.dispatchEligible ? (
          <DropdownMenuItem
            onClick={() => onDispatch(order.id)}
            disabled={isUpdating || dispatching}
            className="font-medium text-emerald-700 focus:bg-emerald-50 focus:text-emerald-900"
          >
            <Truck className="text-emerald-600" aria-hidden="true" />
            <span>Push ke Mengantar</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <AlertCircle className="text-amber-500" aria-hidden="true" />
            <span className="truncate">{order.dispatchReason || "Belum siap dipush"}</span>
          </DropdownMenuItem>
        )}

        {order.fulfillmentType !== "digital" && <DropdownMenuSeparator />}

        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDelete(order.id)}
          disabled={dispatching}
        >
          <Trash2 aria-hidden="true" />
          <span>Hapus pesanan</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
// The filter menus list the payment and source choices an operator filters by.
const PAYMENT_FILTER_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "Semua status" },
  { value: "unpaid", label: "Belum dibayar (online)" },
  { value: "paid", label: "Lunas" },
  { value: "expired", label: "Kedaluwarsa" },
  { value: "failed", label: "Gagal" },
];
const SOURCE_FILTER_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "Semua traffic" },
  { value: "meta", label: "Meta Ads" },
  { value: "google", label: "Google Ads" },
  { value: "organic", label: "Organic / Direct" },
];

const paymentMethodLabels: Record<string, string> = {
  cod: "COD",
  manual_transfer: "Transfer bank manual",
  bank_transfer: "Virtual Account",
  qris: "QRIS",
  invoice: "Pembayaran online",
};

const formatCurrency = formatIdr;
const formatDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date)} WIB`;
};
const crmSteps = ["welcome", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function RiskBadge({
  level,
  deliveryRate,
  compact = false,
}: {
  level?: RiskLevel | string | null;
  deliveryRate?: number | null;
  /** One small pill for the phone card; the guidance moves to its title. */
  compact?: boolean;
}) {
  const safeLevel: RiskLevel =
    level === "HIGH" || level === "MEDIUM" || level === "LOW" ? level : "UNKNOWN";
  const styles = {
    LOW: {
      badge: "bg-emerald-100 text-emerald-800",
      bar: "bg-emerald-500",
      label: "Rendah",
      guidance: "Riwayat pengiriman kuat",
    },
    MEDIUM: {
      badge: "bg-amber-100 text-amber-800",
      bar: "bg-amber-500",
      label: "Sedang",
      guidance: "Konfirmasi sebelum kirim",
    },
    HIGH: {
      badge: "bg-rose-100 text-rose-800",
      bar: "bg-rose-500",
      label: "Tinggi",
      guidance: "Verifikasi sebelum kirim",
    },
    UNKNOWN: {
      badge: "bg-slate-100 text-slate-700",
      bar: "bg-slate-300",
      label: "Belum dinilai",
      guidance: "Periksa riwayat penerima",
    },
  }[safeLevel];

  const hasValidRate =
    typeof deliveryRate === "number" && Number.isFinite(deliveryRate) && deliveryRate >= 0;

  if (compact) {
    return (
      <span
        title={styles.guidance}
        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}
      >
        RTS {styles.label}{hasValidRate ? ` · sukses ${deliveryRate}%` : ""}
      </span>
    );
  }

  return (
    <div
      className="min-w-28"
      aria-label={
        hasValidRate
          ? `Risiko RTS ${styles.label}, tingkat keberhasilan pengiriman ${deliveryRate} persen`
          : `Risiko RTS ${styles.label}`
      }
    >
      <span
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}
      >
        RTS {styles.label}
      </span>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"
        aria-hidden="true"
      >
        <div
          className={`h-full rounded-full ${styles.bar}`}
          style={{
            width: `${hasValidRate ? Math.max(0, Math.min(100, deliveryRate)) : 0}%`,
          }}
        ></div>
      </div>
      {/* The rate is delivery success, not RTS: a bare "16%" beside "RTS Tinggi"
          read as a 16% RTS rate (audit 2026-10-31 L3), so it never sits there.
          `w-0 min-w-full`: these lines take the column's width and never set it. */}
      <p className="mt-1 w-0 min-w-full truncate text-xs text-slate-500">
        {hasValidRate ? <>Sukses kirim <span className="font-mono font-semibold text-slate-900">{deliveryRate}%</span></> : "Belum ada riwayat"}
      </p>
      <p className="w-0 min-w-full truncate text-xs font-medium text-slate-500" title={styles.guidance}>
        {styles.guidance}
      </p>
    </div>
  );
}

/**
 * An order can be `pending` while its payment instruction is dead — the
 * provider failed at checkout, or the VA expired unpaid. Without this the two
 * were indistinguishable in the list, and an operator would tell a buyer to
 * pay a VA that no longer exists.
 */
/**
 * A prepaid order's payment state: paid, still inside its payment window,
 * expired or failed (the order's own status, or its latest instruction), or
 * refunded. COD has none: it is paid on delivery. The dot beside the method
 * and the delivery column read this one rule.
 */
function prepaidPaymentState(order: { paymentMethod: string; paymentStatus?: string; paymentInstructionStatus?: string }) {
  if (order.paymentMethod === "cod") return null;
  const status = (order.paymentStatus || "").toLowerCase();
  const hint = paymentInstructionHint(order.paymentStatus, order.paymentInstructionStatus);
  if (["paid", "settled", "success"].includes(status)) return { paid: true, dot: "bg-emerald-500", text: "text-emerald-700", label: "Sudah dibayar" };
  if (status === "refunded") return { paid: false, dot: "bg-slate-400", text: "text-slate-600", label: "Dikembalikan" };
  if (status === "cancelled") return { paid: false, dot: "bg-slate-400", text: "text-slate-600", label: "Pembayaran dibatalkan" };
  if (["failed", "expired"].includes(status) || hint) {
    const failed = status === "failed" || hint === "failed";
    return { paid: false, dot: "bg-rose-500", text: "text-rose-700", label: failed ? "Pembayaran gagal" : "Pembayaran kedaluwarsa" };
  }
  return { paid: false, dot: "bg-amber-500", text: "text-amber-700", label: "Menunggu pembayaran" };
}

/** The payment state as one dot beside the method; the words on hover. */
function PaymentDot({ order }: { order: OrderItem }) {
  const state = prepaidPaymentState(order);
  if (!state) return null;
  return <span role="img" aria-label={state.label} title={state.label} className={`size-2 shrink-0 cursor-help rounded-full ${state.dot}`} />;
}

/** The payment method under the invoice number; a red dot marks a dead instruction. */
function OrderPaymentLine({ order, className = "" }: { order: OrderItem; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-700 ${className}`}>
      <span className="truncate">{paymentMethodLabels[order.paymentMethod] || order.paymentMethod}</span>
      <PaymentDot order={order} />
    </div>
  );
}

/**
 * The delivery column's status. A pending prepaid order not yet paid shows
 * its payment state (waiting, expired, failed) instead of the shipping
 * "Menunggu konfirmasi"; COD and paid orders read their shipping status.
 */
function deliveryStatus(order: OrderItem) {
  const payment = prepaidPaymentState(order);
  if (order.shippingStatus === "pending" && payment && !payment.paid) return { label: payment.label, tone: payment.text };
  return { label: shippingLabels[order.shippingStatus] || order.shippingStatus, tone: "text-slate-900" };
}

/** Where the order came from: traffic source and page, plain small text. */
/**
 * The traffic source under the invoice. The landing page an order came from
 * (A36) is its tooltip, not a visible line: on a store whose landing pages are
 * named after their products it repeated the Produk column on every row
 * (Paduka, 2026-11-01). The "Halaman sumber" filter and the order detail still
 * show it.
 */
function OrderSourceLine({ order, className = "" }: { order: OrderItem; className?: string }) {
  const page = order.sourceLabel
    ? `Halaman sumber: ${order.sourceLabel}${order.sourcePath ? ` (${order.sourcePath})` : ""}`
    : undefined;
  return (
    <div className={`flex min-w-0 items-center text-xs text-slate-500 ${className}`} title={page}>
      <TrafficSourceBadge adClickIds={order.adClickIds} plain className="shrink-0" />
    </div>
  );
}

/** Name, WhatsApp, then the area on two lines: "district, city" and the province. */
function BuyerArea({ order, className = "" }: { order: OrderItem; className?: string }) {
  const area = buyerAreaLines(order.district, order.city, order.province);
  if (!area.local && !area.region) {
    return <p className={`text-xs text-slate-500 ${className}`}>Alamat belum lengkap</p>;
  }
  return (
    <div className={`min-w-0 text-xs leading-5 ${className}`} title={area.full}>
      {area.local && <p className="truncate text-slate-600">{area.local}</p>}
      {area.region && <p className="truncate text-slate-500">{area.region}</p>}
    </div>
  );
}

export function OrdersTable({
  kind = "all",
  view = "physical",
  initialOrders,
  initialStatusCounts,
  initialOtherKindCount,
  initialSummary,
  initialTotalItems,
  initialQuery = "",
}: {
  /** The list API's `summary` and `pagination.total_items` for the same first request, so the cards and the count paint right. */
  initialSummary?: { total_orders?: number; unpaid_count?: number; high_risk_count?: number; unopened_count?: number; total_value?: number };
  initialTotalItems?: number;
  /** Which orders the list holds; fixed by the page (`OrdersPage.astro`). */
  kind?: OrderListKind;
  /** Physical: shipping, RTS risk and the Mengantar push. Digital: payment and buyer access only. */
  view?: "physical" | "digital";
  /** On a kind-scoped list: how many orders of the other kind match the same filters. */
  initialOtherKindCount?: number;
  initialOrders?: OrderItem[];
  /** The list API's `status_counts` for the same first request (server-rendered chips). */
  initialStatusCounts?: Partial<Record<QuickStatus, number>>;
  // The page's own query string, from `Astro.url.search`. Filters start from
  // it rather than `window.location`, so the server-rendered first paint and
  // the hydrating client agree (a mismatch is React error #418).
  initialQuery?: string;
}) {
  const [initialFilters] = useState(() => initialOrderListFilters(new URLSearchParams(initialQuery), kind));
  const digitalView = view === "digital";
  const statusFilters = digitalView ? digitalStatusFilters : quickStatusFilters;
  const [otherKindCount, setOtherKindCount] = useState(initialOtherKindCount ?? 0);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [orders, setOrders] = useState<OrderItem[]>(initialOrders || []);
  const [searchTerm, setSearchTerm] = useState(initialFilters.search);
  const [shippingFilter, setShippingFilter] = useState(initialFilters.shippingFilter);
  const [paymentFilter, setPaymentFilter] = useState(initialFilters.paymentFilter);
  const [dateSelection, setDateSelection] = useState<AdminDateSelection>(initialFilters.dateSelection);
  const [sourceFilter, setSourceFilter] = useState(initialFilters.sourceFilter);
  // The landing page filter (PRD A36). Opened from Analitik with
  // `?source_slug=`, so it starts from the URL.
  const [sourceSlugFilter, setSourceSlugFilter] = useState(initialFilters.sourceSlugFilter);
  const [sourceSlugOptions, setSourceSlugOptions] = useState<FilterOption<string>[] | null>(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<OrdersPagination>({
    page: 1,
    limit: 20,
    totalItems: Number(initialTotalItems) || 0,
    totalPages: Math.ceil((Number(initialTotalItems) || 0) / 20),
  });
  const [summary, setSummary] = useState<OrdersSummary>({
    totalOrders: Number(initialSummary?.total_orders) || 0,
    unpaidCount: Number(initialSummary?.unpaid_count) || 0,
    highRiskCount: Number(initialSummary?.high_risk_count) || 0,
    unopenedCount: Number(initialSummary?.unopened_count) || 0,
    totalValue: Number(initialSummary?.total_value) || 0,
  });
  const [crmTemplates, setCrmTemplates] = useState({ ...defaultCrmTemplates });
  const [updatingOrderId, setUpdatingOrderId] = useState("");
  const [updateNotice, setUpdateNotice] = useState("");
  const [loading, setLoading] = useState(initialOrders ? false : true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const [pushIds, setPushIds] = useState<string[] | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkStatusTarget, setBulkStatusTarget] = useState("");
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    all: Number(initialStatusCounts?.all) || 0,
    pending: Number(initialStatusCounts?.pending) || 0,
    processing: Number(initialStatusCounts?.processing) || 0,
    shipped: Number(initialStatusCounts?.shipped) || 0,
    delivered: Number(initialStatusCounts?.delivered) || 0,
    returned: Number(initialStatusCounts?.returned) || 0,
    cancelled: Number(initialStatusCounts?.cancelled) || 0,
  });






  useEffect(() => {
    const controller = new AbortController();
    const delay = orders.length === 0 ? 0 : 250;
    const timer = window.setTimeout(async () => {
      setRefreshing(true);
      setLoadError("");
      try {
        const query = orderListQuery(
          { search: searchTerm, shippingFilter, paymentFilter, dateSelection, sourceFilter, sourceSlugFilter, kind },
          page,
          !sourceSlugOptions,
        );
        const response = await fetch(`/api/admin/orders?${query}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success)
          throw new Error(payload.error || "Daftar order gagal dimuat.");
        const nextOrders: OrderItem[] = Array.isArray(payload.data)
          ? payload.data.map(mapOrder)
          : [];
        if (payload.crm_templates) {
          setCrmTemplates((current) => ({
            ...current,
            ...payload.crm_templates,
          }));
        }
        if (Array.isArray(payload.source_options)) {
          setSourceSlugOptions(
            (payload.source_options as Array<{ value: string; label: string; count: number }>).map((option) => ({
              value: String(option.value),
              label: `${option.label} (${Number(option.count) || 0})`,
            })),
          );
        }
        setOrders(nextOrders);
        setSelectedOrderIds((current) =>
          current.filter((id) =>
            nextOrders.some((order) => order.id === id),
          ),
        );
        setPagination({
          page: Number(payload.pagination?.page) || page,
          limit: Number(payload.pagination?.limit) || 25,
          totalItems: Number(payload.pagination?.total_items) || 0,
          totalPages: Number(payload.pagination?.total_pages) || 0,
        });
        setSummary({
          totalOrders: Number(payload.summary?.total_orders) || 0,
          unpaidCount: Number(payload.summary?.unpaid_count) || 0,
          highRiskCount: Number(payload.summary?.high_risk_count) || 0,
          unopenedCount: Number(payload.summary?.unopened_count) || 0,
          totalValue: Number(payload.summary?.total_value) || 0,
        });
        setOtherKindCount(Number(payload.other_kind_count) || 0);
        setStatusCounts({
          all: Number(payload.status_counts?.all) || 0,
          pending: Number(payload.status_counts?.pending) || 0,
          processing: Number(payload.status_counts?.processing) || 0,
          shipped: Number(payload.status_counts?.shipped) || 0,
          delivered: Number(payload.status_counts?.delivered) || 0,
          returned: Number(payload.status_counts?.returned) || 0,
          cancelled: Number(payload.status_counts?.cancelled) || 0,
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Daftar order gagal dimuat.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    page,
    paymentFilter,
    requestVersion,
    searchTerm,
    shippingFilter,
    dateSelection,
    sourceFilter,
    sourceSlugFilter,
  ]);

  const filteredOrders = orders;
  const firstVisibleOrder =
    pagination.totalItems === 0
      ? 0
      : (pagination.page - 1) * pagination.limit + 1;
  const lastVisibleOrder =
    pagination.totalItems === 0
      ? 0
      : firstVisibleOrder + filteredOrders.length - 1;
  const activeFilterCount = [
    dateSelection.filter !== "all",
    paymentFilter !== "all",
    sourceFilter !== "all",
    sourceSlugFilter !== "all",
  ].filter(Boolean).length;
  // The other list under the filters its count used: everything but the status
  // (the two kinds name their states differently) and the page.
  const otherKindQuery = (() => {
    const query = orderListQuery({ search: searchTerm, shippingFilter: "all", paymentFilter, dateSelection, sourceFilter, sourceSlugFilter, kind: "all" }, 1, false);
    query.delete("page");
    query.delete("limit");
    return query.toString();
  })();
  const hasFilters =
    searchTerm.trim() !== "" ||
    dateSelection.filter !== "all" ||
    shippingFilter !== "all" ||
    paymentFilter !== "all" ||
    sourceFilter !== "all" ||
    sourceSlugFilter !== "all";
  const handleShippingStatusChange = async (
    orderId: string,
    shippingStatus: string,
  ) => {
    setUpdatingOrderId(orderId);
    setUpdateNotice("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_status: shippingStatus }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || "Gagal memperbarui status pengiriman");
      }
      setOrders((current) =>
        current.map((order) =>
          order.id === orderId ? { ...order, shippingStatus } : order,
        ),
      );
      setUpdateNotice("Status pengiriman berhasil diperbarui.");
    } catch (error) {
      setUpdateNotice(
        error instanceof Error
          ? error.message
          : "Gagal memperbarui status pengiriman.",
      );
    } finally {
      setUpdatingOrderId("");
    }
  };
  const handleRefreshScoring = async (orderId: string) => {
    setUpdatingOrderId(orderId);
    setUpdateNotice("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-scoring" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        message?: string;
        data?: {
          receiver_delivery_rate?: number | null;
          receiver_risk_label?: RiskLevel | string | null;
        };
      };
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || "Gagal memperbarui risiko RTS dari Mengantar.");
      }
      if (payload.data) {
        const nextRate =
          payload.data.receiver_delivery_rate == null
            ? -1
            : Number(payload.data.receiver_delivery_rate);
        const nextRisk = toRiskLevel(payload.data.receiver_risk_label);
        setOrders((current) =>
          current.map((order) =>
            order.id === orderId
              ? { ...order, receiverDeliveryRate: nextRate, receiverRiskLabel: nextRisk }
              : order,
          ),
        );
      }
      setUpdateNotice(payload.message || "Risiko RTS berhasil diperbarui dari Mengantar.");
    } catch (error) {
      setUpdateNotice(
        error instanceof Error ? error.message : "Gagal memperbarui risiko RTS.",
      );
    } finally {
      setUpdatingOrderId("");
    }
  };

  const handleBulkStatusChange = async (shippingStatus: string) => {
    const orderIds = [...selectedOrderIds];
    if (orderIds.length === 0 || !shippingLabels[shippingStatus]) return;
    // A bulk change is one click away from many orders; voiding ones cannot be undone.
    const voids = shippingStatus === "cancelled" || shippingStatus === "returned";
    if (!(await confirm({
      title: `Ubah ${orderIds.length} pesanan ke ${shippingLabels[shippingStatus]}?`,
      description: voids
        ? "Pesanan jadi batal dan tidak bisa dikirim lagi. Langkah ini tidak dapat dibatalkan."
        : "Status pengiriman pesanan terpilih akan diganti.",
      confirmLabel: `Ubah ke ${shippingLabels[shippingStatus]}`,
      cancelLabel: "Kembali",
      tone: voids ? "destructive" : "default",
    }))) return;

    const previousOrders = orders;
    const previousStatusCounts = statusCounts;
    const selectedOrders = previousOrders.filter((order) =>
      orderIds.includes(order.id),
    );
    setBulkUpdating(true);
    setBulkStatusTarget(shippingStatus);
    setUpdateNotice("");
    setOrders((current) =>
      current.map((order) =>
        orderIds.includes(order.id)
          ? { ...order, shippingStatus }
          : order,
      ),
    );
    setStatusCounts((current) => {
      const next = { ...current };
      for (const order of selectedOrders) {
        const previousStatus = order.shippingStatus as QuickStatus;
        if (previousStatus in next && previousStatus !== shippingStatus) {
          next[previousStatus] = Math.max(0, next[previousStatus] - 1);
        }
      }
      if (shippingStatus in next) {
        next[shippingStatus as QuickStatus] += selectedOrders.filter(
          (order) => order.shippingStatus !== shippingStatus,
        ).length;
      }
      return next;
    });

    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_ids: orderIds, status: shippingStatus }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        message?: string;
        data?: { updated_count?: number };
      };
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || "Gagal memperbarui status order.");
      }
      const updatedCount =
        payload.data?.updated_count == null
          ? orderIds.length
          : Number(payload.data.updated_count);
      setSelectedOrderIds([]);
      setUpdateNotice(
        payload.message ||
          `${updatedCount} order berhasil diubah ke ${shippingLabels[shippingStatus]}.`,
      );
      setRequestVersion((current) => current + 1);
    } catch (error) {
      setOrders(previousOrders);
      setStatusCounts(previousStatusCounts);
      setUpdateNotice(
        error instanceof Error
          ? error.message
          : "Gagal memperbarui status order.",
      );
    } finally {
      setBulkUpdating(false);
      setBulkStatusTarget("");
    }
  };

  // Every push opens the dialog first: drop-off or a scheduled pickup (PRD A46).
  // Whether this dialog sent anything: closing it after Batal keeps the selection.
  const pushSent = useRef(false);
  const dispatchOrders = (orderIds: string[]) => {
    if (!orderIds.length) return;
    pushSent.current = false;
    setPushIds(orderIds);
  };
  const submitPush = async (pickup: MengantarPickupChoice) => {
    const orderIds = pushIds ?? [];
    // Set before the request: a failed answer may still have pushed some.
    pushSent.current = true;
    setDispatching(true);
    setUpdateNotice("");
    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch-orders", orderIds, pickup }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Gagal push order ke Mengantar.");
      }
      const message = payload.message || "Push selesai.";
      setUpdateNotice(message);
      return { message, results: (payload.data?.results ?? []) as MengantarPushResult[] };
    } finally {
      setDispatching(false);
    }
  };
  const closePush = (open: boolean) => {
    if (open) return;
    setPushIds(null);
    if (!pushSent.current) return;
    setSelectedOrderIds([]);
    setRequestVersion((v) => v + 1);
  };
  const deleteOrders = async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    const affectedInvoices = orderIds
      .map((id) => orders.find((order) => order.id === id)?.orderNumber ?? `#${id}`)
      .slice(0, 5);
    const extraCount = orderIds.length - affectedInvoices.length;
    const invoiceSummary = `${affectedInvoices.join(", ")}${extraCount > 0 ? ` dan ${extraCount} lainnya` : ""}`;
    if (
      !(await confirm({
        title: `Hapus ${orderIds.length} pesanan permanen?`,
        description: `Pesanan (${invoiceSummary}) akan dihapus permanen dan tidak dapat dikembalikan.`,
        confirmLabel: `Hapus ${orderIds.length} pesanan`,
      }))
    ) {
      return;
    }
    setDispatching(true);
    setUpdateNotice("");
    try {
      const response = await fetch("/api/admin/orders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: orderIds }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Gagal menghapus pesanan.");
      }
      setUpdateNotice(payload.message || `Berhasil menghapus ${orderIds.length} pesanan.`);
      setSelectedOrderIds([]);
      setRequestVersion((v) => v + 1);
    } catch (error) {
      setUpdateNotice(
        error instanceof Error ? error.message : "Gagal menghapus pesanan.",
      );
    } finally {
      setDispatching(false);
    }
  };

  const resetFilters = () => {
    setSearchTerm("");
    setShippingFilter("all");
    setPaymentFilter("all");
    setDateSelection({ filter: "all", start: "", end: "" });
    setSourceFilter("all");
    setSourceSlugFilter("all");
    setPage(1);
  };
  const crmUrls = useMemo(
    () =>
      new Map(
        orders.map((order) => {
          const urls = Object.fromEntries(
            crmSteps.map((step) => {
              const text = renderCrmMessage(crmTemplates[step], {
                customerName: order.customerName,
                customerPhone: order.customerPhone,
                address: order.address,
                district: order.district,
                city: order.city,
                province: order.province,
                orderNumber: order.orderNumber,
                productName: order.productName,
                variantName: order.variantName,
                items: order.items,
                productPrice: order.productPrice,
                shippingCost: order.shippingCost,
                totalAmount: order.totalAmount,
                courierCode: order.courierCode,
                cnoteNo: order.cnoteNo,
                sellerName: order.sellerName,
                bankAccounts: order.bankAccounts,
                epaymentLink: order.epaymentLink,
                orderDetailsLink: order.orderDetailsLink,
              });
              return [
                String(step),
                buildWaUrl(order.customerPhone, text),
              ] as const;
            }),
          );
          return [order.id, urls] as const;
        }),
      ),
    [crmTemplates, orders],
  );

  const renderCrmActions = (order: OrderItem) => {
    const urls = crmUrls.get(order.id) || {};
    return (
      <CrmActionGroup
        crmUrls={urls}
        orderId={order.id}
        initialRows={order.followUps}
      />
    );
  };
  if (loading)
    return (
      <div
        className="h-96 animate-pulse rounded-xl bg-slate-100"
        aria-label="Memuat daftar order"
        aria-busy="true"
      />
    );
  if (loadError && orders.length === 0)
    return (
      <section
        className="rounded-xl border border-rose-200 bg-white p-8 text-center shadow-sm"
        role="alert"
      >
        <h3 className="text-base font-semibold text-slate-950">
          Order gagal dimuat
        </h3>
        <p className="mt-2 text-sm text-slate-600">{loadError}</p>
        <Button
          onClick={() => {
            setLoading(true);
            setRequestVersion((current) => current + 1);
          }} className="mt-5"
        >
          Coba lagi
        </Button>
      </section>
    );

  const dispatchableOrders = filteredOrders.filter((order) => order.dispatchEligible);
  const visibleDispatchableIds = dispatchableOrders.map((order) => order.id);
  const visibleOrderIds = filteredOrders.map((order) => order.id);
  const selectedDispatchIds = visibleDispatchableIds.filter((orderId) =>
    selectedOrderIds.includes(orderId),
  );
  const allVisibleSelected =
    visibleOrderIds.length > 0 &&
    visibleOrderIds.every((orderId) => selectedOrderIds.includes(orderId));
  return (
    <div className="space-y-5">
      {confirmDialog}
      <MengantarPushDialog
        open={pushIds !== null}
        onOpenChange={closePush}
        orderLabels={(pushIds ?? []).map((id) => ({ id, label: orders.find((order) => order.id === id)?.orderNumber ?? `#${id}` }))}
        submit={submitPush}
      />
      {loadError && (
        <div
          className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-800 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <span>{loadError}</span>
          <Button
            variant="secondary"
            onClick={() => setRequestVersion((current) => current + 1)}
            size="lg" className="shrink-0"
          >
            Coba lagi
          </Button>
        </div>
      )}
      <section
        className="grid grid-cols-2 gap-2.5 xl:grid-cols-4"
        aria-label="Ringkasan order"
      >
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 sm:px-3.5 sm:py-3">
          <p className="text-xs font-medium text-slate-500">Total order</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-slate-950 sm:mt-1 sm:text-2xl">
            {summary.totalOrders}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 sm:px-3.5 sm:py-3">
          <p className="text-xs font-medium text-slate-500">Belum dibayar (online)</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-amber-700 sm:mt-1 sm:text-2xl">
            {summary.unpaidCount}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 sm:px-3.5 sm:py-3">
          {digitalView ? (
            <>
              <p className="text-xs font-medium text-slate-500">Lunas, belum dibuka</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-blue-700 sm:mt-1 sm:text-2xl">
                {summary.unopenedCount}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-slate-500">Risiko RTS tinggi</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-rose-700 sm:mt-1 sm:text-2xl">
                {summary.highRiskCount}
              </p>
            </>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 sm:px-3.5 sm:py-3">
          <p className="text-xs font-medium text-slate-500">Nilai bruto</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-slate-950 sm:mt-1 sm:text-2xl">
            {formatCurrency(summary.totalValue)}
          </p>
        </div>
      </section>

      <nav
        className="flex gap-2 overflow-x-auto pb-1"
        aria-label="Filter cepat status order"
      >
        {statusFilters.map((filter) => {
          const active = shippingFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setShippingFilter(filter.value);
                setPage(1);
              }}
              className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-xs font-semibold transition-colors ${
                active
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {filter.value !== "all" && (
                <span
                  className={`size-2 shrink-0 rounded-full ${shippingStatusStyles[filter.value] || "bg-slate-400"}`}
                  aria-hidden="true"
                />
              )}
              {filter.label}
              <span
                className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs tabular-nums ${
                  active
                    ? "bg-white/20 text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {statusCounts[filter.value]}
              </span>
            </button>
          );
        })}
      </nav>

      {selectedOrderIds.length > 0 && (
        <section
          className="sticky top-3 z-20 flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          aria-label="Aksi bulk order"
        >
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {selectedOrderIds.length} pesanan dipilih
            </p>
            <button
              type="button"
              onClick={() => setSelectedOrderIds([])}
              className="mt-1 text-xs font-semibold text-blue-700 hover:underline"
            >
              Batalkan pilihan
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {!digitalView && (
            <Select
              value={bulkStatusTarget}
              disabled={bulkUpdating || dispatching}
              onValueChange={(value) => {
                if (value) void handleBulkStatusChange(value);
              }}
            >
              <SelectTrigger
                aria-label="Ubah status order terpilih"
                className="w-full min-w-48 sm:w-auto"
              >
                {bulkUpdating ? (
                  <span
                    className="size-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-700"
                    aria-hidden="true"
                  />
                ) : null}
                <SelectValue placeholder="Ubah status ke…" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(shippingLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
            {selectedDispatchIds.length > 0 && (
              <Button
                type="button"
                onClick={() => dispatchOrders(selectedDispatchIds)}
                disabled={dispatching || bulkUpdating || updatingOrderId !== ""}
                className="w-full sm:w-auto"
              >
                {dispatching ? (
                  <span
                    className="mr-2 size-4 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-white"
                    aria-hidden="true"
                  />
                ) : null}
                Push {selectedDispatchIds.length} ke Mengantar
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteOrders(selectedOrderIds)}
              disabled={dispatching || bulkUpdating}
              className="w-full sm:w-auto"
            >
              Hapus {selectedOrderIds.length} pesanan
            </Button>
          </div>
        </section>
      )}

      <DataTableShell
        toolbar={
          <FilterBar>
            <FilterField label="Cari pesanan" htmlFor="search-order" size="grow">
              <SearchInput
                id="search-order"
                placeholder="Invoice, nama, WA, atau resi"
                value={searchTerm}
                onValueChange={(value) => {
                  setSearchTerm(value);
                  setPage(1);
                }}
              />
            </FilterField>
            {/* Phones: search stays, the rest folds behind "Filter" so the first
                order shows on the first screen; `contents` keeps them flex items. */}
            <Button type="button" variant="outline" className="md:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
              <Filter aria-hidden="true" />Filter{activeFilterCount ? ` (${activeFilterCount})` : ""}
            </Button>
            <div className={filtersOpen ? "contents" : "contents max-md:hidden"}>
              <FilterField label="Periode order" htmlFor="filter-date" size="sm">
                <AdminDateRangeFilter
                  value={dateSelection}
                  onChange={(next) => {
                    setDateSelection(next);
                    setPage(1);
                  }}
                />
              </FilterField>
              <FilterField label="Status pembayaran" htmlFor="filter-payment" size="sm">
                <FilterSelect
                  id="filter-payment"
                  icon={CreditCard}
                  value={paymentFilter}
                  onValueChange={(value) => {
                    setPaymentFilter(value);
                    setPage(1);
                  }}
                  options={PAYMENT_FILTER_OPTIONS}
                />
              </FilterField>
              <FilterField label="Sumber lead" htmlFor="filter-source" size="sm">
                <FilterSelect
                  id="filter-source"
                  icon={Megaphone}
                  value={sourceFilter}
                  onValueChange={(value) => {
                    setSourceFilter(value);
                    setPage(1);
                  }}
                  options={SOURCE_FILTER_OPTIONS}
                />
              </FilterField>
              <FilterField label="Halaman sumber" htmlFor="filter-source-page" size="sm">
                <FilterSelect
                  id="filter-source-page"
                  icon={PanelsTopLeft}
                  value={sourceSlugFilter}
                  onValueChange={(value) => {
                    setSourceSlugFilter(value);
                    setPage(1);
                  }}
                  options={[
                    { value: "all", label: "Semua halaman" },
                    ...(sourceSlugOptions ?? []),
                    ...(sourceSlugFilter !== "all" &&
                    sourceSlugFilter !== SOURCE_SLUG_NONE_FILTER &&
                    !(sourceSlugOptions ?? []).some((option) => option.value === sourceSlugFilter)
                      ? [{ value: sourceSlugFilter, label: sourceSlugFilter }]
                      : []),
                    { value: SOURCE_SLUG_NONE_FILTER, label: SOURCE_SLUG_NONE_LABEL },
                  ]}
                />
              </FilterField>
            </div>
            <Button variant="outline" onClick={resetFilters} disabled={!hasFilters}>
              <RotateCcw aria-hidden="true" /> Reset
            </Button>
          </FilterBar>
        }
        meta={
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs font-medium text-slate-600" aria-live="polite">
                {refreshing
                  ? "Memperbarui…"
                  : `Menampilkan ${firstVisibleOrder}–${lastVisibleOrder} dari ${pagination.totalItems} order`}
              </p>
              {updateNotice && (
                <p className="text-xs font-medium text-blue-700" role="status">
                  {updateNotice}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* lazy: the ready orders of this page and filter (≤ 20), not every page; the
                  endpoint takes 50 a call. Upgrade: a server-side "all ready" query. */}
              {visibleDispatchableIds.length > 0 && selectedOrderIds.length === 0 && (
                <Button type="button" variant="outline" size="sm" disabled={dispatching} onClick={() => dispatchOrders(visibleDispatchableIds)}>
                  <Truck aria-hidden="true" />
                  Push semua yang siap ({visibleDispatchableIds.length}) ke Mengantar
                </Button>
              )}
              <ExportCsvButton
                kind="orders"
                query={new URLSearchParams(
                  orderListQuery({ search: searchTerm, shippingFilter, paymentFilter, dateSelection, sourceFilter, sourceSlugFilter, kind }, 1, false),
                )}
                title="Semua order dengan filter ini, satu baris per produk"
              />
            </div>
          </>
        }
        footer={
          pagination.totalPages > 1 ? (
            <Pagination>
              <PaginationContent className="w-full justify-between">
                <div className="flex items-center">
                  <p className="text-xs font-medium text-slate-600">
                    Halaman {pagination.page} dari {pagination.totalPages}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (!refreshing && pagination.page > 1)
                          setPage((c) => Math.max(1, c - 1));
                      }}
                      className={
                        refreshing || pagination.page <= 1
                          ? "pointer-events-none opacity-50"
                          : "cursor-pointer"
                      }
                    />
                  </PaginationItem>
                  <PaginationItem className="hidden sm:block">
                    <PaginationLink
                      href="#"
                      isActive
                      onClick={(e) => e.preventDefault()}
                    >
                      {pagination.page}
                    </PaginationLink>
                  </PaginationItem>
                  {pagination.totalPages > pagination.page && (
                    <PaginationItem className="hidden sm:block">
                      <PaginationEllipsis />
                    </PaginationItem>
                  )}
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (
                          !refreshing &&
                          pagination.page < pagination.totalPages
                        )
                          setPage((c) =>
                            Math.min(pagination.totalPages, c + 1),
                          );
                      }}
                      className={
                        refreshing || pagination.page >= pagination.totalPages
                          ? "pointer-events-none opacity-50"
                          : "cursor-pointer"
                      }
                    />
                  </PaginationItem>
                </div>
              </PaginationContent>
            </Pagination>
          ) : undefined
        }
      >
        {/* grid-cols-1 expands to minmax(0, 1fr); without it a card's min-content
            width widens the implicit column past the viewport and the wrapper clips
            the right-hand controls out of reach on mobile. */}
        <div className="grid grid-cols-1 gap-3 p-3 lg:hidden" aria-label="Daftar order mobile">
            {filteredOrders.map((order) => {
              const selected = selectedOrderIds.includes(order.id);
              return (
              // Phone card (Paduka, 2026-10-31): one header row with the
              // selector, invoice and RTS pill; two plain lines for goods and
              // delivery; the follow-up chips; actions in the header.
              <article
                key={order.id}
                className="rounded-xl border border-slate-200 bg-white p-3.5 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <label className="-m-2.5 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) =>
                        setSelectedOrderIds((current) =>
                          checked
                            ? [...new Set([...current, order.id])]
                            : current.filter((id) => id !== order.id),
                        )
                      }
                      aria-label={`Pilih order ${order.orderNumber}`}
                      className="size-5 data-checked:border-blue-600 data-checked:bg-blue-600"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/admin/orders/${encodeURIComponent(order.orderNumber)}`}
                      className="break-all font-semibold text-slate-950 hover:text-blue-600 hover:underline"
                    >
                      <HighlightSearchMatch text={order.orderNumber} query={searchTerm} />
                    </a>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs text-slate-500">{formatDateTime(order.createdAt)}</span>
                      {order.fulfillmentType !== "digital" && (
                        <RiskBadge level={order.receiverRiskLabel} deliveryRate={order.receiverDeliveryRate} compact />
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <OrderPaymentLine order={order} />
                      <OrderSourceLine order={order} />
                    </div>
                  </div>
                  <OrderActionMenu
                    order={order}
                    updatingOrderId={updatingOrderId}
                    dispatching={dispatching}
                    onDispatch={(id) => dispatchOrders([id])}
                    onDelete={(id) => void deleteOrders([id])}
                    onShippingStatusChange={(id, status) => void handleShippingStatusChange(id, status)}
                    onRefreshScoring={(id) => void handleRefreshScoring(id)}
                  />
                </div>

                <div className="mt-3 border-t border-slate-100 pt-3 text-sm">
                  <p className="flex min-w-0 items-baseline justify-between gap-2">
                    <a href={`/admin/orders/${encodeURIComponent(order.orderNumber)}`} className="min-w-0 truncate font-semibold text-slate-900 hover:underline">
                      {order.customerName}
                    </a>
                    <span className="shrink-0 font-mono text-xs text-slate-500">{order.customerPhone}</span>
                  </p>
                  {order.fulfillmentType !== "digital" && <BuyerArea order={order} className="mt-0.5" />}
                  <p className="mt-2 flex min-w-0 items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-slate-700">
                      {[order.productName, order.variantName].filter(Boolean).join(" · ") || "Produk"}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-950">{formatCurrency(order.totalAmount)}</span>
                  </p>
                  {order.fulfillmentType === "digital" ? (
                    digitalView ? (
                      <div className="mt-1.5 text-xs"><DigitalAccessCell order={order} /></div>
                    ) : (
                      <p className="mt-0.5 flex min-w-0 items-baseline justify-between gap-2 text-xs">
                        <span className={`min-w-0 truncate font-semibold ${deliveryStatus(order).tone}`}>{deliveryStatus(order).label}</span>
                        <DigitalOrderBadge accessedAt={order.digitalAccessedAt} />
                      </p>
                    )
                  ) : (
                    <p className="mt-0.5 flex min-w-0 items-baseline justify-between gap-2 text-xs">
                      <span className={`min-w-0 truncate font-semibold ${deliveryStatus(order).tone}`}>{deliveryStatus(order).label}</span>
                      <span className="shrink-0 font-mono text-slate-500">
                        {order.courierCode || "—"}{order.cnoteNo ? ` · ${order.cnoteNo}` : ""}
                      </span>
                    </p>
                  )}
                </div>

                {order.providerDispatchError && (
                  <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
                    <span className="font-semibold">Kendala push:</span> {providerDispatchErrorText(order.providerDispatchError)}
                  </p>
                )}
                <div className="mt-3">{digitalView && order.fulfillmentType === "digital" ? <DigitalWaActions order={order} /> : renderCrmActions(order)}</div>
              </article>
            ); })}
          </div>
        <div className="hidden lg:block" aria-label="Tabel order desktop">
            <Table className="w-full min-w-[1040px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 pl-3 pr-1">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={
                        !allVisibleSelected &&
                        selectedOrderIds.some((orderId) => visibleOrderIds.includes(orderId))
                      }
                      onCheckedChange={(checked) =>
                        setSelectedOrderIds((current) =>
                          checked
                            ? [
                                ...new Set([
                                  ...current,
                                  ...visibleOrderIds,
                                ]),
                              ]
                            : current.filter(
                                (orderId) =>
                                  !visibleOrderIds.includes(orderId),
                              ),
                        )
                      }
                      aria-label="Pilih semua order di halaman ini"
                      className="data-checked:border-blue-600 data-checked:bg-blue-600"
                    />
                  </TableHead>
                  <TableHead className="w-36 border-r border-slate-100 px-2">
                    Invoice
                  </TableHead>
                  <TableHead className="w-36 px-2">Pemesan</TableHead>
                  {!digitalView && <TableHead className="w-32 px-2">Risiko RTS</TableHead>}
                  <TableHead className="w-40 px-2">{digitalView ? "Akses produk" : "Pengiriman"}</TableHead>
                  <TableHead className="w-32 px-2 text-right">
                    Produk & Total
                  </TableHead>
                  <TableHead className="w-[244px] px-2">{digitalView ? "WhatsApp" : "WhatsApp CRM"}</TableHead>
                  <TableHead className="sticky right-0 z-10 w-12 bg-slate-50/95 pl-1.5 pr-3 text-right">
                    Aksi
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => {
                  const selected = selectedOrderIds.includes(order.id);
                  return (
                  <TableRow
                    key={order.id}
                    data-state={selected ? "selected" : undefined}
                    className="align-top"
                  >
                    <TableCell className="pl-3 pr-1 py-3">
                      <Checkbox
                        checked={selected}
                        onCheckedChange={(checked) =>
                          setSelectedOrderIds((current) =>
                            checked
                              ? [...new Set([...current, order.id])]
                              : current.filter((id) => id !== order.id),
                          )
                        }
                        aria-label={`Pilih order ${order.orderNumber}`}
                        className="data-checked:border-blue-600 data-checked:bg-blue-600"
                      />
                    </TableCell>
                    <TableCell className="border-r border-slate-100 px-2 py-3">
                      <a
                        href={`/admin/orders/${encodeURIComponent(order.orderNumber)}`}
                        className="whitespace-nowrap font-semibold text-slate-950 hover:text-blue-600 hover:underline"
                      >
                        <HighlightSearchMatch
                          text={order.orderNumber}
                          query={searchTerm}
                        />
                      </a>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {formatDateTime(order.createdAt)}
                      </p>
                      {/* `w-0 min-w-full`: these rows take the column's width and never
                          set it, so they wrap instead of widening the invoice column. */}
                      <OrderPaymentLine order={order} className="mt-1 w-0 min-w-full" />
                      <OrderSourceLine order={order} className="mt-0.5 w-0 min-w-full" />
                    </TableCell>
                    <TableCell className="max-w-[144px] px-2 py-3">
                      <a
                        href={`/admin/orders/${encodeURIComponent(order.orderNumber)}`}
                        className="block truncate font-semibold text-slate-900 hover:underline"
                      >
                        {order.customerName}
                      </a>
                      <p className="mt-0.5 font-mono text-xs text-slate-500">
                        {order.customerPhone}
                      </p>
                      {order.fulfillmentType !== "digital" && <BuyerArea order={order} className="mt-0.5" />}
                    </TableCell>
                    {!digitalView && (
                      <TableCell className="px-2 py-3">
                        {order.fulfillmentType === "digital" ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <RiskBadge
                            level={order.receiverRiskLabel}
                            deliveryRate={order.receiverDeliveryRate}
                          />
                        )}
                      </TableCell>
                    )}
                    {digitalView && order.fulfillmentType === "digital" ? (
                      <TableCell className="max-w-[200px] px-2 py-3"><DigitalAccessCell order={order} /></TableCell>
                    ) : (
                    <TableCell className="max-w-[156px] px-2 py-3">
                      <p className={`truncate font-semibold ${deliveryStatus(order).tone}`}>
                        {deliveryStatus(order).label}
                      </p>
                      {order.fulfillmentType === "digital" ? (
                        <p className="mt-1"><DigitalOrderBadge accessedAt={order.digitalAccessedAt} /></p>
                      ) : (
                        <p className="mt-0.5 truncate font-mono text-xs text-slate-500" title={`${order.courierCode || ""}${order.cnoteNo ? ` · ${order.cnoteNo}` : ""}`}>
                          {order.courierCode}
                          {order.cnoteNo
                            ? ` · ${order.cnoteNo}`
                            : " · belum ada resi"}
                        </p>
                      )}
                      {order.providerDispatchError && (
                        <p className="mt-1 max-w-[150px] whitespace-normal text-xs font-semibold leading-tight text-rose-600">
                          Error: {providerDispatchErrorText(order.providerDispatchError)}
                        </p>
                      )}
                    </TableCell>
                    )}
                    <TableCell className="px-2 py-3 text-right">
                      {order.productName && (
                        <p className="ml-auto max-w-[126px] truncate text-xs font-semibold text-slate-900">
                          {order.productName}
                        </p>
                      )}
                      {order.variantName && (
                        <p className="ml-auto mt-0.5 max-w-[126px] truncate text-xs text-slate-500">
                          {order.variantName}
                        </p>
                      )}
                      <p className="mt-1 text-sm font-semibold tabular-nums text-slate-950">
                        {formatCurrency(order.totalAmount)}
                      </p>
                    </TableCell>
                    <TableCell className="px-2 py-3">
                      <div className="w-[244px] whitespace-normal">{digitalView && order.fulfillmentType === "digital" ? <DigitalWaActions order={order} /> : renderCrmActions(order)}</div>
                    </TableCell>
                    <TableCell className="sticky right-0 z-10 bg-white pl-1.5 pr-3 py-3 text-right group-hover:bg-slate-50 group-data-[state=selected]:bg-blue-50">
                      <OrderActionMenu
                        order={order}
                        updatingOrderId={updatingOrderId}
                        dispatching={dispatching}
                        onDispatch={(id) => dispatchOrders([id])}
                        onDelete={(id) => void deleteOrders([id])}
                        onShippingStatusChange={(id, status) => void handleShippingStatusChange(id, status)}
                        onRefreshScoring={(id) => void handleRefreshScoring(id)}
                      />
                    </TableCell>
                  </TableRow>
                ); })}
              </TableBody>
            </Table>
          </div>

        {kind !== "all" && otherKindCount > 0 && hasFilters && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-600" role="status">
            {otherKindCount} pesanan {kind === "physical" ? "produk digital" : "produk fisik"} juga cocok dengan pencarian dan filter ini (semua status).{" "}
            <a
              className="font-semibold text-blue-700 hover:underline"
              href={`${kind === "physical" ? "/admin/orders/digital" : "/admin/orders"}?${otherKindQuery}`}
            >
              Lihat di {kind === "physical" ? "Produk Digital" : "Produk Fisik"}
            </a>
          </p>
        )}
        {filteredOrders.length === 0 && (
          <div className="border-t border-slate-100 p-10 text-center">
            {hasFilters ? (
              <>
                <p className="text-sm font-semibold text-slate-950">
                  Order tidak ditemukan
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Ubah kata pencarian atau reset filter untuk melihat semua order.
                </p>
                <Button
                  variant="secondary"
                  onClick={resetFilters}
                  size="lg"
                  className="mt-4"
                >
                  Reset filter
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-950">
                  {kind === "digital" ? "Belum ada pesanan produk digital" : kind === "physical" ? "Belum ada pesanan produk fisik" : "Belum ada pesanan masuk"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Pesanan baru dari storefront atau landing page Anda akan muncul otomatis di sini.
                </p>
              </>
            )}
          </div>
        )}
      </DataTableShell>
    </div>
  );
}
