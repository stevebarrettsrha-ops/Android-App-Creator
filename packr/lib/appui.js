'use strict';

const { escapeXml } = (() => {
  // escapeXml lives in project.js, but requiring it here would be circular —
  // project.js requires this module. Small enough to duplicate.
  return {
    escapeXml: (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;'),
  };
})();

/**
 * The app-chrome layer: custom buttons with icons and actions, an optional
 * title bar, and the paid-features (unlock code) system. This module owns the
 * icon set, the validation, and the files generated into both the Android and
 * the iOS project: `_packr/app-config.json` and `_packr/paywall.html`.
 */

// 24x24 filled path data, drawn to work as Android VectorDrawables, inline
// SVG in the docket preview, and (by name mapping) SF Symbols on iOS.
const ICONS = {
  home:     { sf: 'house.fill',                path: 'M12 3 2.5 11H5v10h5v-6h4v6h5V11h2.5z' },
  back:     { sf: 'arrow.left',                path: 'M20 11H7.8l4.6-4.6L11 5l-7 7 7 7 1.4-1.4L7.8 13H20z' },
  forward:  { sf: 'arrow.right',               path: 'M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z' },
  reload:   { sf: 'arrow.clockwise',           path: 'M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6v3.5L17 7l-5-4.5z' },
  share:    { sf: 'square.and.arrow.up',       path: 'M12 2l4.5 4.5-1.4 1.4L13 5.8V15h-2V5.8L8.9 7.9 7.5 6.5zM5 10h4v2H7v8h10v-8h-2v-2h4v12H5z' },
  star:     { sf: 'star.fill',                 path: 'M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 16.9 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z' },
  heart:    { sf: 'heart.fill',                path: 'M12 21C7 16.6 2 12.8 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 4.3-5 8.1-10 12.5z' },
  cart:     { sf: 'cart.fill',                 path: 'M2 3h3.2l.6 2H22l-3 9H7.6l-.4 2H20v2H4.6l1.2-6L4.4 5H2zM8 19a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm9 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z' },
  person:   { sf: 'person.fill',               path: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-5 0-8.5 2.6-8.5 5.2V21h17v-1.8c0-2.6-3.5-5.2-8.5-5.2z' },
  settings: { sf: 'gearshape.fill',            path: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1L15 3.2H9l-.3 2.7c-.6.3-1.2.6-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 20.8h6l.3-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6z' },
  info:     { sf: 'info.circle.fill',          path: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v2h-2zm0 4h2v6h-2z' },
  phone:    { sf: 'phone.fill',                path: 'M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.5.6 3.6.1.3 0 .7-.3 1z' },
  mail:     { sf: 'envelope.fill',             path: 'M2 5h20v14H2zm10 7.8L4 7.6V17h16V7.6zM5.4 7h13.2L12 11.2z' },
  chat:     { sf: 'bubble.left.fill',          path: 'M2 3h20v14H7.2L2 21.2zM6 8h12v2H6zm0 4h8v2H6z' },
  calendar: { sf: 'calendar',                  path: 'M3 4h4V2h2v2h6V2h2v2h4v18H3zm2 5v11h14V9z' },
  map:      { sf: 'mappin.and.ellipse',        path: 'M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z' },
  camera:   { sf: 'camera.fill',               path: 'M9 3 7.2 5H3v16h18V5h-4.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
  search:   { sf: 'magnifyingglass',           path: 'M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z' },
  document: { sf: 'doc.fill',                  path: 'M6 2h8l6 6v14H6zm7 2v5h5zM8 13h8v2H8zm0 4h8v2H8z' },
  download: { sf: 'arrow.down.circle.fill',    path: 'M11 3h2v10l3.5-3.5 1.4 1.4L12 16.8 6.1 10.9l1.4-1.4L11 13zM4 19h16v2H4z' },
  lock:     { sf: 'lock.fill',                 path: 'M12 2a5 5 0 0 0-5 5v3H5v12h14V10h-2V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3z' },
  crown:    { sf: 'crown.fill',                path: 'M3 7l4.5 4L12 4l4.5 7L21 7l-2 13H5z' },
  bell:     { sf: 'bell.fill',                 path: 'M12 2a6 6 0 0 0-6 6v5l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6zm-2 17h4a2 2 0 0 1-4 0z' },
  grid:     { sf: 'square.grid.2x2.fill',      path: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z' },
  play:     { sf: 'play.fill',                 path: 'M8 5v14l11-7z' },
  help:     { sf: 'questionmark.circle.fill',  path: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 15h2v2h-2zm1-11a4 4 0 0 1 4 4c0 2-1.5 2.7-2.4 3.3-.7.4-.6.7-.6 1.7h-2c0-1.7.3-2.5 1.3-3.1.9-.6 1.7-1 1.7-1.9a2 2 0 0 0-4 0H8a4 4 0 0 1 4-4z' },
};

// What a button can do. `value` explains what the extra field means.
const ACTIONS = {
  home:    { label: 'Go to the start page', value: null },
  back:    { label: 'Go back', value: null },
  forward: { label: 'Go forward', value: null },
  reload:  { label: 'Reload the page', value: null },
  share:   { label: 'Share the current page', value: null },
  page:    { label: 'Open a page', value: 'Page path (shop.html) or full URL' },
  browser: { label: 'Open in the real browser', value: 'Full URL, https://…' },
  call:    { label: 'Call a phone number', value: 'Phone number' },
  email:   { label: 'Compose an email', value: 'Email address' },
  paywall: { label: 'Open the premium screen', value: null },
};

const MAX_BUTTONS = 5;

// ------------------------------------------------------------------ validate

function validateAppUi(input, errors) {
  const topBar = Boolean(input.topBar);

  const rawButtons = Array.isArray(input.navButtons) ? input.navButtons.slice(0, MAX_BUTTONS) : [];
  if (Array.isArray(input.navButtons) && input.navButtons.length > MAX_BUTTONS) {
    errors.push(`A phone-width bar fits ${MAX_BUTTONS} buttons at most.`);
  }

  const navButtons = [];
  rawButtons.forEach((raw, index) => {
    const where = `Button ${index + 1}`;
    const button = {
      label: String(raw.label || '').trim(),
      icon: String(raw.icon || '').trim(),
      action: String(raw.action || '').trim(),
      value: String(raw.value || '').trim(),
      premium: Boolean(raw.premium),
    };
    if (!button.label) errors.push(`${where}: give it a label.`);
    if (button.label.length > 14) errors.push(`${where}: keep the label to 14 characters.`);
    if (!ICONS[button.icon]) errors.push(`${where}: unknown icon "${button.icon}".`);
    if (!ACTIONS[button.action]) {
      errors.push(`${where}: unknown action "${button.action}".`);
      return;
    }
    if (ACTIONS[button.action].value) {
      if (!button.value) {
        errors.push(`${where}: the "${ACTIONS[button.action].label}" action needs a value.`);
      } else if (button.action === 'browser' && !/^https?:\/\/.+/i.test(button.value)) {
        errors.push(`${where}: the browser link must start with http:// or https://`);
      } else if (button.action === 'call' && !/^[+0-9()\-\s.]{3,24}$/.test(button.value)) {
        errors.push(`${where}: that does not look like a phone number.`);
      } else if (button.action === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(button.value)) {
        errors.push(`${where}: that does not look like an email address.`);
      } else if (
        button.action === 'page' &&
        /^[a-z][a-z0-9+.-]*:/i.test(button.value) &&
        !/^https?:\/\//i.test(button.value)
      ) {
        errors.push(`${where}: a page is a relative path or an http(s) URL.`);
      }
    } else {
      button.value = '';
    }
    navButtons.push(button);
  });

  const rawPremium = input.premium && typeof input.premium === 'object' ? input.premium : {};
  const premium = {
    enabled: Boolean(rawPremium.enabled),
    paymentUrl: String(rawPremium.paymentUrl || '').trim(),
    priceText: String(rawPremium.priceText || '').trim(),
    pitch: String(rawPremium.pitch || '').trim(),
    codeHashes: Array.isArray(rawPremium.codeHashes)
      ? rawPremium.codeHashes.filter((hash) => /^[0-9a-f]{64}$/i.test(String(hash))).map((h) => String(h).toLowerCase())
      : [],
  };
  if (premium.paymentUrl && !/^https?:\/\/.+/i.test(premium.paymentUrl)) {
    errors.push('The payment link must start with http:// or https://');
  }
  if (premium.priceText.length > 40) errors.push('Keep the price line to 40 characters.');
  if (premium.pitch.length > 400) errors.push('Keep the premium pitch to 400 characters.');
  if (premium.codeHashes.length > 1000) errors.push('That is more than 1000 unlock codes — generate fewer.');

  if (premium.enabled && premium.codeHashes.length === 0) {
    errors.push('Paid features are on but there are no unlock codes. Generate some in section 06.');
  }
  if (!premium.enabled && navButtons.some((b) => b.premium || b.action === 'paywall')) {
    errors.push('A button is marked premium (or opens the premium screen) but paid features are off.');
  }

  return { topBar, navButtons, premium };
}

// -------------------------------------------------------- generated payloads

/** The runtime config both shells read at startup. */
function appConfigJson(config) {
  return JSON.stringify(
    {
      appName: config.appName,
      themeColor: config.themeColor,
      topBar: config.topBar,
      // `sf` carries the SF Symbol name so the iOS shell needs no icon table.
      navButtons: config.navButtons.map((button) => ({
        ...button,
        sf: (ICONS[button.icon] || {}).sf || 'circle.fill',
      })),
      premium: {
        enabled: config.premium.enabled,
        codeHashes: config.premium.codeHashes,
      },
    },
    null,
    2
  );
}

function isDarkHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return true;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

/**
 * The premium screen. Generated per app with the pitch, price and payment
 * link baked in; talks to the shell through the injected PackrApp bridge.
 * `Promise.resolve()` smooths over the platforms: the Android bridge returns
 * a plain boolean, the iOS one returns a Promise.
 */
function paywallHtml(config) {
  const dark = isDarkHex(config.themeColor);
  const ink = dark ? '#FFFFFF' : '#12181F';
  const dim = dark ? 'rgba(255,255,255,.65)' : 'rgba(18,24,31,.6)';
  const line = dark ? 'rgba(255,255,255,.25)' : 'rgba(18,24,31,.25)';
  const premium = config.premium;

  const payBlock = premium.paymentUrl
    ? `<a class="pay" href="#" onclick="pay();return false">${escapeXml(
        premium.priceText || 'Get premium'
      )}</a>
  <p class="hint">Payment opens in your browser. You will receive an unlock code.</p>`
    : premium.priceText
      ? `<p class="price">${escapeXml(premium.priceText)}</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${escapeXml(config.appName)} — Premium</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;
         background:${config.themeColor}; color:${ink}; padding:24px; }
  .card { width:100%; max-width:420px; text-align:center; }
  .crown { font-size:44px; line-height:1; margin-bottom:14px; }
  h1 { font-size:22px; margin:0 0 10px; }
  .pitch { color:${dim}; font-size:15px; line-height:1.55; margin:0 0 22px; white-space:pre-wrap; }
  .price { font-size:17px; font-weight:700; margin:0 0 18px; }
  .pay { display:block; padding:15px 20px; border-radius:10px; background:${ink}; color:${config.themeColor};
         font-weight:700; font-size:16px; text-decoration:none; margin-bottom:10px; }
  .hint { color:${dim}; font-size:12.5px; margin:0 0 22px; }
  .divider { display:flex; align-items:center; gap:12px; color:${dim}; font-size:12px;
             text-transform:uppercase; letter-spacing:.1em; margin:20px 0 14px; }
  .divider::before, .divider::after { content:""; flex:1; border-top:1px solid ${line}; }
  form { display:flex; gap:8px; }
  input { flex:1; min-width:0; font:inherit; font-size:16px; padding:13px 14px; border-radius:10px;
          border:1px solid ${line}; background:transparent; color:${ink}; text-transform:uppercase;
          letter-spacing:.06em; }
  input::placeholder { color:${dim}; text-transform:none; letter-spacing:0; }
  button { font:inherit; font-weight:700; padding:13px 18px; border-radius:10px; border:0;
           background:${ink}; color:${config.themeColor}; }
  .msg { min-height:20px; font-size:13.5px; margin-top:12px; }
  .msg[data-tone=bad] { color:#FF7A6B; }
  .msg[data-tone=ok] { color:#37E0C8; }
  #done { display:none; }
  #done .crown { font-size:52px; }
  .continue { display:inline-block; margin-top:18px; padding:14px 34px; border-radius:10px;
              background:${ink}; color:${config.themeColor}; font-weight:700; text-decoration:none; }
</style>
</head>
<body>
  <div class="card" id="ask">
    <div class="crown">&#9813;</div>
    <h1>${escapeXml(config.appName)} Premium</h1>
    <p class="pitch">${escapeXml(premium.pitch || 'Unlock all features of this app.')}</p>
    ${payBlock}
    <div class="divider">Have a code?</div>
    <form onsubmit="redeem();return false">
      <input id="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters">
      <button type="submit">Unlock</button>
    </form>
    <div class="msg" id="msg"></div>
  </div>
  <div class="card" id="done">
    <div class="crown">&#10003;</div>
    <h1>Premium unlocked</h1>
    <p class="pitch">Everything is switched on. Thank you!</p>
    <a class="continue" href="#" onclick="goOn();return false">Continue</a>
  </div>
<script>
  var PAY_URL = ${JSON.stringify(premium.paymentUrl || '')};
  function bridge() { return window.PackrApp || null; }
  function show(id) {
    document.getElementById('ask').style.display = id === 'ask' ? 'block' : 'none';
    document.getElementById('done').style.display = id === 'done' ? 'block' : 'none';
  }
  function message(text, tone) {
    var el = document.getElementById('msg');
    el.textContent = text; el.setAttribute('data-tone', tone || '');
  }
  function pay() {
    if (!PAY_URL) return;
    if (bridge() && bridge().openExternal) bridge().openExternal(PAY_URL);
    else window.location = PAY_URL;
  }
  async function redeem() {
    var code = document.getElementById('code').value;
    if (!code.trim()) { message('Enter the code you received.', 'bad'); return; }
    if (!bridge()) { message('The app shell is not available in this preview.', 'bad'); return; }
    var ok = await Promise.resolve(bridge().unlock(code));
    if (ok) { show('done'); }
    else { message('That code was not recognised. Check it and try again.', 'bad'); }
  }
  function goOn() {
    if (bridge() && bridge().goHome) bridge().goHome();
    else history.back();
  }
  if (bridge() && bridge().isPremium && bridge().isPremium()) show('done');
</script>
</body>
</html>
`;
}

// ------------------------------------------------------------ android icons

/** One VectorDrawable per icon, tinted at runtime. */
function vectorDrawableXml(iconName) {
  const icon = ICONS[iconName];
  if (!icon) throw new Error(`Unknown icon: ${iconName}`);
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="${icon.path}" />
</vector>
`;
}

function usedIcons(navButtons) {
  return [...new Set(navButtons.map((b) => b.icon))];
}

module.exports = {
  ICONS,
  ACTIONS,
  MAX_BUTTONS,
  validateAppUi,
  appConfigJson,
  paywallHtml,
  vectorDrawableXml,
  usedIcons,
  isDarkHex,
};
