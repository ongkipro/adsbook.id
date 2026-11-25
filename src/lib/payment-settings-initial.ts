import type { PaymentChannel, PaymentSettingsInitial } from '../components/admin/PaymentSettings';
import { GET as getSettings } from '../pages/api/admin/settings';
import { GET as getPaymentMethods } from '../pages/api/admin/payment-methods';
import { AUTOLARIS_CHECKOUT_CHANNELS, autoLarisChannelLockReason } from './autolaris-client';
import { paymentFeeDescription } from './payment-fee-policy';

const CHANNEL_LABELS: Record<(typeof AUTOLARIS_CHECKOUT_CHANNELS)[number], string> = {
  QRIS: 'QRIS (BCA, Mandiri, GoPay, OVO, ShopeePay, Dana, LinkAja)',
  VABCA: 'Virtual Account BCA',
  VAMANDIRI: 'Virtual Account Mandiri',
  VABNI: 'Virtual Account BNI',
  VABRI: 'Virtual Account BRI',
  VAPERMATA: 'Virtual Account Permata',
  VABSI: 'Virtual Account BSI',
  VACIMB: 'Virtual Account CIMB Niaga',
  VADANAMON: 'Virtual Account Danamon',
};

export function getPaymentChannelsList(): PaymentChannel[] {
  return AUTOLARIS_CHECKOUT_CHANNELS.map((code) => ({
    code,
    label: CHANNEL_LABELS[code],
    feeDescription: paymentFeeDescription(code),
    lockReason: autoLarisChannelLockReason(code) || undefined,
  }));
}

export async function loadPaymentSettingsInitial(
  astro: { url: URL; request: Request; locals: App.Locals },
): Promise<PaymentSettingsInitial | undefined> {
  try {
    const ctx = {
      url: astro.url,
      request: astro.request,
      locals: astro.locals,
    } as Parameters<typeof getSettings>[0];
    const [settingsResponse, methodsResponse] = await Promise.all([
      getSettings(ctx),
      getPaymentMethods(ctx),
    ]);
    const settings = (await settingsResponse.json()) as {
      success?: boolean;
      data?: {
        store?: Record<string, unknown>;
        credentials?: { autolaris?: { api_key_configured?: boolean; api_key_masked?: string } };
      };
    };
    const methods = (await methodsResponse.json()) as {
      success?: boolean;
      data?: Array<{ payment_method?: string; is_active?: number | boolean }>;
    };
    if (settingsResponse.ok && settings.success && settings.data?.store && methodsResponse.ok && methods.success) {
      const store = settings.data.store;
      const autolaris = settings.data.credentials?.autolaris;
      return {
        codEnabled: Boolean(store.is_cod_enabled),
        autolarisEnabled: Boolean(store.is_autolaris_enabled),
        apiReady: Boolean(autolaris?.api_key_configured),
        apiMasked: autolaris?.api_key_masked || 'Belum dikonfigurasi',
        disabledChannels: Array.isArray(store.disabled_autolaris_channels)
          ? (store.disabled_autolaris_channels as string[])
          : [],
        paymentFeeBearer: store.payment_fee_bearer === 'seller' ? 'seller' : 'buyer',
        codFeeBearer: store.cod_fee_bearer === 'seller' ? 'seller' : 'buyer',
        manualActiveCount: (Array.isArray(methods.data) ? methods.data : []).filter(
          (m) => m.payment_method === 'manual_transfer' && Boolean(m.is_active),
        ).length,
      };
    }
  } catch (error) {
    console.error('admin-payments-initial-load', error);
  }
  return undefined;
}
