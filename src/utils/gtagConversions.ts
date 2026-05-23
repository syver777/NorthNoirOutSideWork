// Google Ads Conversion Tracking Utility

declare global {
  interface Window {
    gtag?: (
      command: string,
      eventName: string,
      params?: Record<string, any>
    ) => void;
  }
}

export const trackConversion = (
  eventName: string,
  params?: Record<string, any>
) => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', eventName, params);
    console.log(`Conversion tracked: ${eventName}`, params);
  }
};

export const trackConversionWithCallback = (
  eventName: string,
  url: string | null,
  params?: Record<string, any>
) => {
  const callback = () => {
    if (typeof url === 'string') {
      window.location.href = url;
    }
  };

  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', eventName, {
      event_callback: callback,
      event_timeout: 2000,
      ...params,
    });
    console.log(`Conversion with callback tracked: ${eventName}`, params);
  } else {
    // Fallback if gtag is not available
    callback();
  }
};

// Conversion event names
export const CONVERSION_EVENTS = {
  ABOUT_PAGE_VIEW: 'ads_conversion_About_Us_1',
  ABOUT_PAGE_CLICK: 'ads_conversion_About_Us_Click',
  SIGNUP_COMPLETE: 'conversion_event_signup',
  PURCHASE_INITIATED: 'ads_conversion_Purchase_Initiated',
  PURCHASE_COMPLETE: 'ads_conversion_Purchase_Complete',
  TOKEN_PURCHASE: 'ads_conversion_Token_Purchase',
  AFFILIATE_SIGNUP: 'ads_conversion_Affiliate_Signup',
};
