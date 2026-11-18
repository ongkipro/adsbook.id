export type TrafficSourceType = 'meta' | 'google' | 'tiktok' | 'organic' | 'custom';

export type TrafficSourceInfo = {
  type: TrafficSourceType;
  label: string;
  badgeClass: string;
  textClass: string;
  iconName?: string;
  details: {
    gclid?: string;
    fbclid?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
  };
};

/**
 * Parses ad click IDs JSON string and resolves canonical lead traffic source
 */
export function parseTrafficSource(rawClickIds?: string | null): TrafficSourceInfo {
  let parsed: Record<string, unknown> = {};

  if (rawClickIds && typeof rawClickIds === 'string') {
    try {
      const json = JSON.parse(rawClickIds);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      // Ignore JSON parse errors for corrupt cookies/payloads
    }
  }

  const gclid = typeof parsed.gclid === 'string' ? parsed.gclid : undefined;
  const gbraid = typeof parsed.gbraid === 'string' ? parsed.gbraid : undefined;
  const wbraid = typeof parsed.wbraid === 'string' ? parsed.wbraid : undefined;
  const fbclid = typeof parsed.fbclid === 'string' ? parsed.fbclid : undefined;
  const fbc = typeof parsed._fbc === 'string' ? parsed._fbc : undefined;
  const fbp = typeof parsed._fbp === 'string' ? parsed._fbp : undefined;
  const ttclid = typeof parsed.ttclid === 'string' ? parsed.ttclid : undefined;

  const utmSource = typeof parsed.utm_source === 'string' ? parsed.utm_source.toLowerCase().trim() : undefined;
  const utmMedium = typeof parsed.utm_medium === 'string' ? parsed.utm_medium.trim() : undefined;
  const utmCampaign = typeof parsed.utm_campaign === 'string' ? parsed.utm_campaign.trim() : undefined;

  const details = {
    gclid: gclid || gbraid || wbraid,
    fbclid: fbclid || (fbc ? fbc : undefined),
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
  };

  // Precedence (tracking chapter 11 review): an explicit click id or a
  // platform's own utm_source beats a passive browser cookie. `_fbp` is minted
  // by MetaPixelBase on every first visit to a store with a Meta pixel, so on a
  // store running Meta and TikTok (or Google) it rides along with a ttclid or
  // gclid and used to turn that paid click into "Meta". It now decides only when
  // nothing explicit says otherwise.
  const utmMeta = Boolean(
    utmSource && (utmSource.includes('meta') || utmSource.includes('facebook') || utmSource.includes('fb') || utmSource.includes('instagram') || utmSource.includes('ig')),
  );
  const utmGoogle = Boolean(utmSource && (utmSource.includes('google') || utmSource.includes('gads') || utmSource.includes('cpc')));
  const explicitGoogle = Boolean(gclid || gbraid || wbraid || utmGoogle);
  const explicitTikTok = Boolean(ttclid || (utmSource && utmSource.includes('tiktok')));

  // 1. Meta Ads (fbclid, _fbc, or a Meta utm_source; or `_fbp` alone)
  const isMeta = Boolean(fbclid || fbc || utmMeta || (fbp && !explicitGoogle && !explicitTikTok));

  if (isMeta) {
    let label = 'Meta Ads';
    if (utmSource?.includes('instagram') || utmSource?.includes('ig')) {
      label = 'Instagram Ads';
    } else if (utmSource?.includes('facebook') || utmSource?.includes('fb')) {
      label = 'Facebook Ads';
    }

    return {
      type: 'meta',
      label,
      badgeClass: 'bg-blue-50 text-blue-700 border-blue-200/80 hover:bg-blue-100/70',
      textClass: 'text-blue-600 font-semibold',
      details,
    };
  }

  // 2. Google Ads (gclid, gbraid, wbraid, or utm_source contains google/gads/cpc)
  const isGoogle = explicitGoogle;

  if (isGoogle) {
    return {
      type: 'google',
      label: 'Google Ads',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200/80 hover:bg-emerald-100/70',
      textClass: 'text-emerald-600 font-semibold',
      details,
    };
  }

  // 3. TikTok Ads (ttclid, or utm_source contains tiktok): first-party since
  //    tracking chapter 11 Phase 1 restored ttclid capture.
  if (explicitTikTok) {
    return {
      type: 'tiktok',
      label: 'TikTok Ads',
      badgeClass: 'bg-slate-100 text-slate-800 border-slate-300 hover:bg-slate-200/70',
      textClass: 'text-slate-800 font-semibold',
      details,
    };
  }

  // 4. Custom UTM Referral
  if (utmSource && utmSource !== 'organic' && utmSource !== 'direct') {
    const formattedSource = utmSource.charAt(0).toUpperCase() + utmSource.slice(1);
    return {
      type: 'custom',
      label: `${formattedSource} Referral`,
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200/80 hover:bg-amber-100/70',
      textClass: 'text-amber-600 font-semibold',
      details,
    };
  }

  // 5. Organic / Direct
  return {
    type: 'organic',
    label: 'Organic / Direct',
    badgeClass: 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200/60',
    textClass: 'text-slate-500 font-medium',
    details,
  };
}
