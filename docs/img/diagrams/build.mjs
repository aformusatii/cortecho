#!/usr/bin/env node
// Builds the README diagrams as plain SVG, in a light and a dark variant:
//   architecture-{light,dark}.svg   the high-level picture (who talks to whom)
//   turn-sequence-{light,dark}.svg  one voice turn, message by message
//
// Run: node docs/img/diagrams/build.mjs
//
// Why generated, hand-written SVG and not Mermaid/PlantUML: GitHub renders
// Mermaid without custom icons or colours per block, and does not render
// PlantUML at all. SVG in an <img> renders everywhere, scales, supports the
// <picture> light/dark switch, and stays diffable. Text uses system fonts
// (an <img> SVG cannot load web fonts), so every label keeps some slack.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// One colour per concern, the same in both themes.
const ACCENT = {
  echo: '#1fb3e6', // the Echo, audio, the light ring
  link: '#6b6cf6', // the ESPHome link
  voice: '#f0a13a', // the voice pipeline (close to the logo's amber)
  brain: '#ec6a72', // conversation, follow-ups
  tools: '#1fae8c', // tools and connectors
  web: '#9d6cf0', // web UI and HTTP API
  data: '#7d8ca5', // storage
  cloud: '#3d8bfd', // the model provider
  off: '#e5534b', // removed
};

const THEMES = {
  light: {
    bg: '#ffffff',
    frame: '#e3e8ef',
    card: '#ffffff',
    cardStroke: '#d3dae5',
    text: '#1b2337',
    muted: '#566377',
    faint: '#8a95a7',
    line: '#7b879a',
    zone: '#f5f8fb',
    zoneStroke: '#b9c4d4',
    tint: 0.11,
    shadow: '#1b2337',
    shadowOpacity: 0.1,
    person: '#1b2337',
    logoStroke: 'none',
  },
  dark: {
    bg: '#0d1117',
    frame: '#232b38',
    card: '#151c28',
    cardStroke: '#2f3a4b',
    text: '#e6edf3',
    muted: '#9eabbe',
    faint: '#6f7d92',
    line: '#8592a8',
    zone: '#111823',
    zoneStroke: '#36445a',
    tint: 0.17,
    shadow: '#000000',
    shadowOpacity: 0.5,
    person: '#dfe6ee',
    logoStroke: '#3d4a63',
  },
};

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attrs(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

function text(x, y, s, o = {}) {
  return `<text ${attrs({
    x,
    y,
    'font-size': o.size ?? 13,
    'font-weight': o.weight,
    'font-family': o.mono ? MONO : undefined,
    'font-style': o.italic ? 'italic' : undefined,
    fill: o.fill,
    'text-anchor': o.anchor,
    'letter-spacing': o.ls,
    class: o.cls,
    style: o.halo ? `stroke:${o.halo}` : undefined,
  })}>${esc(s)}</text>`;
}

// Mixed styles on one line: parts flow one after the other.
function rich(x, y, parts, o = {}) {
  const spans = parts
    .map((p) =>
      typeof p === 'string'
        ? `<tspan>${esc(p)}</tspan>`
        : `<tspan ${attrs({
            fill: p.fill,
            'font-weight': p.weight,
            'font-family': p.mono ? MONO : undefined,
            'letter-spacing': p.ls,
            dx: p.dx,
          })}>${esc(p.s)}</tspan>`,
    )
    .join('');
  return `<text ${attrs({
    x,
    y,
    'font-size': o.size ?? 13,
    fill: o.fill,
    'text-anchor': o.anchor,
    class: o.cls,
    style: o.halo ? `stroke:${o.halo}` : undefined,
  })}>${spans}</text>`;
}

// Rough text width, used only to size note boxes. DejaVu-wide on purpose.
const textWidth = (s, size, mono) => s.length * size * (mono ? 0.62 : 0.56);

// Solid mix of two hex colours: lets a label halo match a tinted band exactly.
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [ca, cb] = [p(a), p(b)];
  return `#${ca
    .map((v, i) =>
      Math.round(v + (cb[i] - v) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function defs(t) {
  const markers = Object.entries({ ...ACCENT, line: t.line })
    .map(
      ([k, c]) =>
        `<marker id="a-${k}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0.5 L10,5 L0,9.5 z" fill="${c}"/></marker>` +
        `<marker id="s-${k}" viewBox="0 0 10 10" refX="0.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M10,0.5 L0,5 L10,9.5 z" fill="${c}"/></marker>`,
    )
    .join('');
  return `<defs>
  ${markers}
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="${t.shadow}" flood-opacity="${t.shadowOpacity}"/></filter>
  <filter id="glow" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="soft" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
  <linearGradient id="echoSide" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#191d26"/><stop offset="0.45" stop-color="#3b4354"/><stop offset="1" stop-color="#1e222c"/>
  </linearGradient>
  <radialGradient id="echoTop" cx="0.45" cy="0.35" r="0.7">
    <stop offset="0" stop-color="#454e62"/><stop offset="1" stop-color="#262b37"/>
  </radialGradient>
  <linearGradient id="ring" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#1394d6"/><stop offset="0.5" stop-color="#8be9ff"/><stop offset="1" stop-color="#1394d6"/>
  </linearGradient>
</defs>`;
}

function style() {
  return `<style>
  .halo { paint-order: stroke; stroke-width: 6px; stroke-linejoin: round; }
  .flow { stroke-dasharray: 7 6; animation: flow 1.1s linear infinite; }
  .packets { stroke-dasharray: 2 6; animation: flow 0.9s linear infinite; }
  .pulse { animation: pulse 2.8s ease-in-out infinite; }
  @keyframes flow { to { stroke-dashoffset: -13; } }
  @keyframes pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .flow, .packets, .pulse { animation: none; } }
</style>`;
}

function line(x1, y1, x2, y2, o = {}) {
  const key = o.color ?? 'line';
  return `<line ${attrs({
    x1,
    y1,
    x2,
    y2,
    stroke: o.stroke,
    'stroke-width': o.width ?? 1.8,
    'stroke-dasharray': o.dash,
    'stroke-linecap': 'round',
    'marker-end': o.end === false ? undefined : `url(#a-${key})`,
    'marker-start': o.both ? `url(#s-${key})` : undefined,
    class: o.cls,
    opacity: o.opacity,
  })}/>`;
}

const strokeOf = (t, key) => (key === 'line' || !key ? t.line : ACCENT[key]);

function arrow(t, x1, y1, x2, y2, o = {}) {
  return line(x1, y1, x2, y2, { ...o, stroke: strokeOf(t, o.color) });
}

function card(t, x, y, w, h, o = {}) {
  return `<rect ${attrs({
    x,
    y,
    width: w,
    height: h,
    rx: o.rx ?? 16,
    fill: t.card,
    stroke: t.cardStroke,
    filter: o.flat ? undefined : 'url(#shadow)',
  })}/>`;
}

function chip(t, x, y, w, h, color, title, sub, o = {}) {
  const c = ACCENT[color];
  const ty = sub ? y + h / 2 - 3 : y + h / 2 + 5;
  const tx = o.badge ? x + 34 : x + 16;
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.card}"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c}" fill-opacity="${t.tint}" stroke="${c}" stroke-opacity="0.55"/>
  ${o.badge ? `<circle cx="${x + 18}" cy="${y + h / 2}" r="10" fill="${c}"/>${text(x + 18, y + h / 2 + 4.5, o.badge, { size: 12, weight: 700, fill: '#ffffff', anchor: 'middle' })}` : `<rect x="${x}" y="${y + 9}" width="4" height="${h - 18}" rx="2" fill="${c}"/>`}
  ${text(tx, ty, title, { size: 14, weight: 700, fill: t.text })}
  ${sub ? text(tx, y + h / 2 + 13, sub, { size: 11.5, fill: t.muted }) : ''}
</g>`;
}

// A pinout-style label, as on ESP32 board diagrams.
function pill(x, y, label, color, w = 52) {
  const dark = color === ACCENT.voice || color === ACCENT.echo;
  return `<rect x="${x}" y="${y}" width="${w}" height="22" rx="6" fill="${color}"/>${text(
    x + w / 2,
    y + 15,
    label,
    {
      size: 10.5,
      weight: 700,
      fill: dark ? '#0f1726' : '#ffffff',
      anchor: 'middle',
      ls: 0.6,
      mono: true,
    },
  )}`;
}

function zone(t, x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${t.zone}" stroke="${t.zoneStroke}" stroke-width="1.4" stroke-dasharray="7 6"/>`;
}

// ------------------------------------------------------------------ icons

// Echo Dot (2nd gen) in three-quarter view; (0,0) is the centre of the top.
function echoDot(cx, cy, s = 1, o = {}) {
  const mics = [
    [0, 0],
    [22, 0],
    [11, 5.6],
    [-11, 5.6],
    [-22, 0],
    [-11, -5.6],
    [11, -5.6],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="#7d879b"/>`)
    .join('');
  const btn = (x, y) =>
    `<ellipse cx="${x}" cy="${y}" rx="8" ry="3.6" fill="#2e3442" stroke="#68728a" stroke-width="1.2"/>`;
  return `<g transform="translate(${cx} ${cy}) scale(${s})">
  ${o.noShadow ? '' : '<ellipse cx="0" cy="38" rx="86" ry="16" fill="#000" opacity="0.22" filter="url(#soft)"/>'}
  <ellipse class="pulse" cx="0" cy="2" rx="84" ry="27" fill="none" stroke="${ACCENT.echo}" stroke-width="9" opacity="0.7" filter="url(#glow)"/>
  <path d="M-80,0 L-80,28 A80,24 0 0 0 80,28 L80,0 A80,24 0 0 1 -80,0 z" fill="url(#echoSide)"/>
  <path d="M-80,28 A80,24 0 0 0 80,28" fill="none" stroke="#5b6478" stroke-width="1"/>
  <ellipse cx="0" cy="0" rx="80" ry="24" fill="url(#echoTop)" stroke="#5b6478" stroke-width="1"/>
  <ellipse cx="0" cy="0" rx="76" ry="22" fill="none" stroke="url(#ring)" stroke-width="4"/>
  <ellipse cx="0" cy="0" rx="70" ry="19.5" fill="none" stroke="#1d212b" stroke-width="1"/>
  ${btn(-40, 0)}${btn(40, 0)}${btn(0, -12.5)}${btn(0, 12.5)}
  <path d="M-43,0 h6 M37,0 h6 M40,-2.6 v5.2" stroke="#aeb6c6" stroke-width="1.2"/>
  <circle cx="0" cy="-12.5" r="1.6" fill="#aeb6c6"/>
  <circle cx="0" cy="12.5" r="1.6" fill="none" stroke="#aeb6c6" stroke-width="1"/>
  ${mics}
</g>`;
}

// The Cortecho mark from docs/img/logo-*.svg, at (x, y) with the given size.
function logoMark(t, x, y, size) {
  return `<g transform="translate(${x} ${y}) scale(${size / 512})">
  <rect width="512" height="512" rx="112" fill="#1b2337" stroke="${t.logoStroke}" stroke-width="16"/>
  <path d="M 342 379 A 150 150 0 1 1 342 133" fill="none" stroke="#f2b443" stroke-width="48" stroke-linecap="round"/>
  <g fill="none" stroke-width="20" stroke-linecap="round">
    <path d="M 190 212 C 228 176 296 190 314 236" stroke="#e9edf2"/>
    <path d="M 178 272 C 218 242 282 258 328 286" stroke="#7fb5b5"/>
    <path d="M 204 324 C 238 302 286 310 318 332" stroke="#e9edf2"/>
  </g>
</g>`;
}

function person(cx, cy, s, fill) {
  return `<g transform="translate(${cx} ${cy}) scale(${s})" fill="${fill}">
  <circle cx="0" cy="-15" r="9.5"/>
  <path d="M-17,19 C-17,4 -10,-2 0,-2 C10,-2 17,4 17,19 Z"/>
</g>`;
}

function cloudIcon(cx, cy, s, color) {
  return `<g transform="translate(${cx} ${cy}) scale(${s})">
  <path d="M-13,9 H13 A8.5,8.5 0 0 0 12.5,-8 A12,12 0 0 0 -10,-6 A7.5,7.5 0 0 0 -13,9 Z" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M0,-4 L1.6,0.4 L6,2 L1.6,3.6 L0,8 L-1.6,3.6 L-6,2 L-1.6,0.4 Z" fill="${color}"/>
</g>`;
}

function plugIcon(cx, cy, s, color) {
  return `<g transform="translate(${cx} ${cy}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M-4.5,-12 V-6 M4.5,-12 V-6"/>
  <path d="M-9,-6 H9 V0 A9,9 0 0 1 -9,0 Z" fill="${color}" fill-opacity="0.16"/>
  <path d="M0,9 V14"/>
</g>`;
}

function lockIcon(cx, cy, color) {
  return `<g transform="translate(${cx} ${cy})">
  <path d="M-3.2,-1 V-3.8 A3.2,3.2 0 0 1 3.2,-3.8 V-1" fill="none" stroke="${color}" stroke-width="1.6"/>
  <rect x="-5" y="-1.2" width="10" height="7.6" rx="1.6" fill="${color}"/>
</g>`;
}

function browserIcon(t, cx, cy, color) {
  return `<g transform="translate(${cx} ${cy})">
  <rect x="-22" y="-16" width="44" height="32" rx="5" fill="${t.card}" stroke="${color}" stroke-width="1.6"/>
  <path d="M-22,-7 H22" stroke="${color}" stroke-width="1.2"/>
  <circle cx="-16.5" cy="-11.5" r="1.6" fill="${color}"/><circle cx="-11.5" cy="-11.5" r="1.6" fill="${color}"/><circle cx="-6.5" cy="-11.5" r="1.6" fill="${color}"/>
  <path d="M-14,0 H6 M-14,6 H12" stroke="${color}" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
</g>`;
}

function houseIcon(x, y, color) {
  return `<path transform="translate(${x} ${y})" d="M0,7 V0 L6.5,-5.5 L13,0 V7 Z" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function bubble(t, x, y, w, h, lines, o = {}) {
  const fill = o.color ? mix(t.card, o.color, t.tint + 0.05) : t.card;
  const stroke = o.color ?? t.cardStroke;
  let tail = '';
  if (o.tail === 'down') {
    const tx = o.tailX;
    tail = `<path d="M${tx - 9},${y + h - 1} L${tx},${y + h + 12} L${tx + 9},${y + h - 1}" fill="${fill}" stroke="${stroke}" stroke-linejoin="round"/><path d="M${tx - 8},${y + h - 1} H${tx + 8}" stroke="${fill}" stroke-width="2.5"/>`;
  } else if (o.tail === 'right') {
    const ty = o.tailY;
    tail = `<path d="M${x + w - 1},${ty - 8} L${x + w + 13},${ty} L${x + w - 1},${ty + 8}" fill="${fill}" stroke="${stroke}" stroke-linejoin="round"/><path d="M${x + w - 1},${ty - 7} V${ty + 7}" stroke="${fill}" stroke-width="2.5"/>`;
  }
  const lh = 18;
  const y0 = y + h / 2 - ((lines.length - 1) * lh) / 2 + 4.5;
  const body = lines
    .map((s, i) =>
      text(x + w / 2, y0 + i * lh, s, {
        size: 13,
        fill: t.text,
        anchor: 'middle',
        italic: true,
        weight: 500,
      }),
    )
    .join('');
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" filter="url(#shadow)"/>${tail}${body}</g>`;
}

function svgDoc(t, w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="title desc" font-family="${FONT.replace(/"/g, "'")}">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
${style()}
${defs(t)}
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="20" fill="${t.bg}" stroke="${t.frame}"/>
${body}
</svg>
`;
}

// ----------------------------------------------------------- architecture

function architecture(t) {
  const W = 1320;
  const H = 640;
  const p = [];

  // Zones: the house and the services you choose.
  p.push(zone(t, 16, 16, 964, 608), zone(t, 1000, 16, 304, 608));
  p.push(houseIcon(40, 40, t.muted));
  p.push(
    rich(62, 45, [
      { s: 'YOUR HOME NETWORK', weight: 700, ls: 1.4, fill: t.muted },
      { s: '  ·  nothing goes to Amazon', fill: t.faint },
    ]),
  );
  p.push(cloudIcon(1030, 40, 0.75, t.muted));
  p.push(rich(1054, 45, [{ s: 'SERVICES YOU CHOOSE', weight: 700, ls: 1.4, fill: t.muted }]));

  // The person.
  p.push(
    bubble(t, 24, 112, 152, 58, ['“Computer, what’s on', 'my calendar today?”'], {
      tail: 'down',
      tailX: 100,
    }),
  );
  p.push(person(100, 236, 1.75, t.person));
  p.push(
    `<g fill="none" stroke="${ACCENT.echo}" stroke-width="2" stroke-linecap="round">` +
      [12, 20, 28]
        .map((r, i) => {
          const a = 0.6;
          const x0 = 126 + r * Math.cos(-a);
          const y0 = 208 + r * Math.sin(-a);
          const x1 = 126 + r * Math.cos(a);
          const y1 = 208 + r * Math.sin(a);
          return `<path class="pulse" style="animation-delay:${i * 0.25}s" d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}"/>`;
        })
        .join('') +
      '</g>',
  );
  p.push(
    bubble(t, 24, 330, 152, 58, ['“Stand-up at ten,', 'dentist at four.”'], {
      tail: 'right',
      tailY: 359,
      color: ACCENT.echo,
    }),
  );

  // The Echo: a stack of cards (one Cortecho serves every Echo).
  const ex = 192;
  const ey = 64;
  const ew = 270;
  const eh = 516;
  p.push(
    `<rect x="${ex + 12}" y="${ey + 12}" width="${ew}" height="${eh}" rx="16" fill="${t.card}" stroke="${t.cardStroke}" opacity="0.45"/>`,
    `<rect x="${ex + 6}" y="${ey + 6}" width="${ew}" height="${eh}" rx="16" fill="${t.card}" stroke="${t.cardStroke}" opacity="0.75"/>`,
    card(t, ex, ey, ew, eh),
  );
  p.push(text(ex + 20, ey + 32, 'Echo Dot', { size: 19, weight: 700, fill: t.text }));
  p.push(text(ex + 20, ey + 51, 'rooted, runs echo-dot-assist', { size: 12, fill: t.muted }));
  p.push(echoDot(ex + ew / 2, 160, 1));

  const rowsAt = (y0, label, rows) => {
    const out = [text(ex + 18, y0, label, { size: 10.5, weight: 700, fill: t.faint, ls: 1.2 })];
    rows.forEach(([tag, color, s], i) => {
      const y = y0 + 12 + i * 36;
      out.push(pill(ex + 18, y, tag, color));
      const struck = color === ACCENT.off;
      out.push(
        text(ex + 80, y + 15.5, s, { size: 13, fill: struck ? t.muted : t.text, weight: struck ? 400 : 500 }),
      );
    });
    return out.join('');
  };
  p.push(
    rowsAt(262, 'AMAZON HARDWARE, KEPT', [
      ['MIC', ACCENT.echo, '7 far-field mics'],
      ['DSP', ACCENT.echo, 'beamforming, echo cancel'],
      ['WAKE', ACCENT.echo, 'wake word “Computer”'],
      ['SPK', ACCENT.echo, 'speaker + light ring'],
    ]),
  );
  p.push(
    rowsAt(428, 'ECHO-DOT-ASSIST', [
      ['API', ACCENT.link, 'hassmic, ESPHome server'],
      ['CLK', ACCENT.link, 'clock set by Cortecho'],
      ['CLOUD', ACCENT.off, 'Amazon cloud: removed'],
    ]),
  );
  p.push(
    text(ex + ew / 2 + 6, 608, 'one Cortecho serves every Echo in the house', {
      size: 11.5,
      fill: t.muted,
      anchor: 'middle',
      italic: true,
    }),
  );

  // Cortecho.
  const cx = 612;
  const cw = 350;
  const ix = cx + 18;
  const iw = cw - 36;
  const half = (iw - 16) / 2;
  p.push(card(t, cx, 64, cw, 516));
  p.push(logoMark(t, ix, 80, 40));
  p.push(text(ix + 52, 103, 'Cortecho', { size: 21, weight: 700, fill: t.text }));
  p.push(text(ix + 52, 121, 'Node 24 · one Docker container', { size: 12, fill: t.muted }));

  p.push(chip(t, ix, 150, iw, 52, 'link', 'Echo link', 'ESPHome client · Noise · auto-discovery'));

  // Voice pipeline: a 2×2 snake Listen → Transcribe ↓ Think → Speak.
  const gx = ix;
  const gy = 218;
  const gw = iw;
  const gh = 148;
  p.push(
    `<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="12" fill="${ACCENT.voice}" fill-opacity="${t.tint * 0.8}" stroke="${ACCENT.voice}" stroke-opacity="0.5"/>`,
  );
  p.push(text(gx + 14, gy + 19, 'VOICE PIPELINE', { size: 10.5, weight: 700, fill: ACCENT.voice, ls: 1.2 }));
  const pw = (gw - 24 - 20) / 2;
  const c1 = gx + 12;
  const c2 = c1 + pw + 20;
  const r1 = gy + 30;
  const r2 = r1 + 44 + 18;
  p.push(chip(t, c1, r1, pw, 44, 'voice', 'Listen', 'end of speech', { badge: '1' }));
  p.push(chip(t, c2, r1, pw, 44, 'voice', 'Transcribe', 'speech to text', { badge: '2' }));
  p.push(chip(t, c2, r2, pw, 44, 'voice', 'Think', 'agent + tools', { badge: '3' }));
  p.push(chip(t, c1, r2, pw, 44, 'voice', 'Speak', 'text to speech', { badge: '4' }));
  p.push(arrow(t, c1 + pw + 2, r1 + 22, c2 - 2, r1 + 22, { color: 'voice' }));
  p.push(arrow(t, c2 + pw / 2, r1 + 46, c2 + pw / 2, r2 - 2, { color: 'voice' }));
  p.push(arrow(t, c2 - 2, r2 + 22, c1 + pw + 2, r2 + 22, { color: 'voice' }));
  p.push(arrow(t, c1 + pw / 2, 202, c1 + pw / 2, r1 - 2, { color: 'link' }));

  const rowC = gy + gh + 16; // 382
  p.push(chip(t, ix, rowC, half, 52, 'voice', 'Reply audio', 'WAV, streamed'));
  p.push(chip(t, ix + half + 16, rowC, half, 52, 'tools', 'Tools & MCP', 'run by the agent'));
  p.push(arrow(t, c1 + pw / 2, r2 + 46, c1 + pw / 2, rowC - 2, { color: 'voice' }));
  p.push(arrow(t, c2 + pw / 2, r2 + 46, c2 + pw / 2, rowC - 2, { color: 'tools', both: true }));

  const rowD = rowC + 66; // 448
  p.push(
    chip(t, ix, rowD, iw, 52, 'brain', 'Conversation memory', 'per-Echo prompt · follow-ups, no wake word'),
  );
  const rowE = rowD + 66; // 514
  p.push(chip(t, ix, rowE, half, 52, 'web', 'Web UI · API', 'status · /api/say'));
  p.push(chip(t, ix + half + 16, rowE, half, 52, 'data', 'SQLite', 'settings · history'));
  p.push(arrow(t, ix + half + 2, rowE + 26, ix + half + 14, rowE + 26, { color: 'data', both: true }));

  // The link between the Echo and Cortecho.
  const g1 = ex + ew; // 462
  const g2 = ix; // 630
  const gm = (ex + ew + cx) / 2; // centre of the gap between the cards
  p.push(text(gm, 128, 'ESPHome API', { size: 13.5, weight: 700, fill: ACCENT.link, anchor: 'middle' }));
  p.push(text(gm, 145, 'TCP 26053 · encrypted', { size: 11.5, fill: t.muted, anchor: 'middle' }));
  p.push(arrow(t, g1 + 2, 168, g2 - 2, 168, { color: 'echo', width: 2.4, cls: 'flow' }));
  p.push(arrow(t, g2 - 2, 184, g1 + 2, 184, { color: 'link', width: 2.4, cls: 'flow' }));
  p.push(
    `<circle cx="${gm}" cy="176" r="13" fill="${t.card}" stroke="${ACCENT.link}" stroke-width="1.6"/>`,
    lockIcon(gm, 176, ACCENT.link),
  );
  const gapLines = [
    ['→ ', ACCENT.echo, 'mic audio, 16 kHz'],
    ['← ', ACCENT.link, 'ring, reply link'],
    ['← ', ACCENT.link, 'time, announcements'],
  ];
  gapLines.forEach(([a, c, s], i) => {
    p.push(rich(g1 + 8, 213 + i * 17, [{ s: a, fill: c, weight: 700 }, { s }], { size: 11, fill: t.text }));
  });

  p.push(
    text(gm, rowC + 16, 'reply audio', { size: 13.5, weight: 700, fill: ACCENT.voice, anchor: 'middle' }),
  );
  p.push(arrow(t, g2 - 2, rowC + 26, g1 + 2, rowC + 26, { color: 'voice', width: 2.4, cls: 'flow' }));
  p.push(text(gm, rowC + 46, 'HTTP GET · WAV', { size: 11.5, fill: t.muted, anchor: 'middle' }));

  p.push(browserIcon(t, g1 + 36, rowE + 26, ACCENT.web));
  p.push(text(g1 + 36, rowE + 60, 'browser,', { size: 11.5, fill: t.muted, anchor: 'middle' }));
  p.push(text(g1 + 36, rowE + 75, 'automations', { size: 11.5, fill: t.muted, anchor: 'middle' }));
  p.push(arrow(t, g1 + 62, rowE + 26, g2 - 2, rowE + 26, { color: 'web', width: 2 }));

  // Services.
  const sx = 1016;
  const sw = 272;
  const serviceRows = (y0, rows) =>
    rows
      .map(([tag, color, s], i) => {
        const y = y0 + i * 36;
        return (
          pill(sx + 16, y, tag, color) + text(sx + 78, y + 15.5, s, { size: 13, fill: t.text, weight: 500 })
        );
      })
      .join('');
  p.push(card(t, sx, 168, sw, 196));
  p.push(cloudIcon(sx + 30, 199, 1.15, ACCENT.cloud));
  p.push(text(sx + 64, 198, 'OpenAI API', { size: 16, weight: 700, fill: t.text }));
  p.push(text(sx + 64, 215, 'or any compatible server', { size: 11.5, fill: t.muted }));
  p.push(
    serviceRows(240, [
      ['STT', ACCENT.cloud, 'speech to text'],
      ['LLM', ACCENT.cloud, 'agent, tool calls'],
      ['TTS', ACCENT.cloud, 'natural voice'],
    ]),
  );
  p.push(card(t, sx, 384, sw, 214));
  p.push(plugIcon(sx + 30, 414, 1.05, ACCENT.tools));
  p.push(text(sx + 64, 413, 'Tools & connectors', { size: 16, weight: 700, fill: t.text }));
  p.push(text(sx + 64, 430, 'automatic or confirm first', { size: 11.5, fill: t.muted }));
  p.push(
    serviceRows(452, [
      ['MCP', ACCENT.tools, 'Gmail, Calendar, any'],
      ['HA', ACCENT.tools, 'Home Assistant'],
      ['HTTP', ACCENT.tools, 'your scripts, APIs'],
      ['WEB', ACCENT.tools, 'web search'],
    ]),
  );

  const yPipe = gy + gh / 2;
  p.push(arrow(t, gx + gw + 2, yPipe, sx - 2, yPipe, { color: 'cloud', width: 2, both: true }));
  p.push(
    text((cx + cw + sx) / 2, yPipe - 9, 'HTTPS', {
      size: 10.5,
      weight: 700,
      fill: t.muted,
      anchor: 'middle',
      cls: 'halo',
      halo: t.bg,
    }),
  );
  const yTools = rowC + 26;
  p.push(arrow(t, ix + iw + 2, yTools, sx - 2, yTools, { color: 'tools', width: 2, both: true }));
  p.push(
    text((cx + cw + sx) / 2, yTools - 9, 'MCP', {
      size: 10.5,
      weight: 700,
      fill: t.muted,
      anchor: 'middle',
      cls: 'halo',
      halo: t.bg,
    }),
  );

  return svgDoc(
    t,
    W,
    H,
    'How Cortecho works',
    'A person asks a rooted Echo Dot a question. The Echo (Amazon microphones, wake word and speaker, ' +
      'running hassmic from echo-dot-assist, without the Amazon cloud) streams the audio over the encrypted ' +
      'ESPHome API to Cortecho, a Docker container on the same network. Cortecho listens for the end of ' +
      'speech, transcribes, runs an agent with tools and MCP connectors, turns the answer into speech ' +
      'with an OpenAI-compatible API, and the Echo downloads the reply audio over HTTP and plays it. ' +
      'A web UI and an HTTP API manage it; one Cortecho serves every Echo in the house.',
    p.join('\n'),
  );
}

// --------------------------------------------------------------- sequence

const PHASES = {
  CONNECT: 'link',
  LISTEN: 'echo',
  THINK: 'voice',
  SPEAK: 'tools',
  'FOLLOW-UP': 'brain',
};

// from/to: you, echo, cortecho, openai, tools.
// kind: call (solid), back (dashed reply), stream (animated), speech.
const TURN = [
  { phase: 'CONNECT' },
  { from: 'cortecho', to: 'echo', label: 'Noise handshake · Hello · Connect', mono: true, color: 'link' },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'SubscribeVoiceAssistant',
    note: 'after every connect: one client per Echo',
    mono: true,
    color: 'link',
  },
  { from: 'echo', to: 'cortecho', label: 'GetTimeRequest', mono: true, color: 'link' },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'GetTimeResponse',
    note: 'sets the Echo’s clock and time zone',
    mono: true,
    color: 'link',
    kind: 'back',
  },
  { phase: 'LISTEN' },
  {
    from: 'you',
    to: 'echo',
    label: '“Computer, what’s on my calendar today?”',
    kind: 'speech',
    color: 'echo',
  },
  { box: 'echo', label: 'wake word heard · chime', color: 'echo' },
  {
    from: 'echo',
    to: 'cortecho',
    label: 'VoiceAssistantRequest{start}',
    note: 'with the wake word phrase',
    mono: true,
    color: 'link',
    activate: true,
    mark: 'listen',
  },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'RUN_START · STT_START',
    note: 'ring: listening',
    mono: true,
    color: 'link',
  },
  {
    from: 'echo',
    to: 'cortecho',
    label: 'VoiceAssistantAudio × n',
    note: '16 kHz mono PCM, while you speak',
    mono: true,
    color: 'echo',
    kind: 'stream',
  },
  { box: 'cortecho', label: 'VAD: 800 ms of silence = end of speech', color: 'voice' },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'STT_VAD_END',
    note: 'mic off · ring: thinking',
    mono: true,
    color: 'link',
    mark: 'think',
  },
  { phase: 'THINK' },
  {
    from: 'cortecho',
    to: 'openai',
    label: 'transcribe',
    note: 'starts 300 ms into the pause',
    color: 'cloud',
  },
  { from: 'openai', to: 'cortecho', label: '“what’s on my calendar today?”', color: 'cloud', kind: 'back' },
  { from: 'cortecho', to: 'echo', label: 'STT_END{text} · INTENT_START', mono: true, color: 'link' },
  {
    from: 'cortecho',
    to: 'openai',
    label: 'agent turn',
    note: 'prompt, memory, tool list',
    color: 'cloud',
  },
  { from: 'openai', to: 'cortecho', label: 'tool call: list_events', color: 'cloud', kind: 'back' },
  { from: 'cortecho', to: 'tools', label: 'run the tool (MCP)', color: 'tools', labelAt: 'start' },
  { from: 'tools', to: 'cortecho', label: '2 events', color: 'tools', kind: 'back', labelAt: 'start' },
  { from: 'cortecho', to: 'openai', label: 'tool result', color: 'cloud' },
  {
    from: 'openai',
    to: 'cortecho',
    label: 'answer text',
    note: 'streamed, sentence by sentence',
    color: 'cloud',
    kind: 'stream',
  },
  { phase: 'SPEAK' },
  {
    from: 'cortecho',
    to: 'openai',
    label: 'text to speech',
    note: 'from the first sentence',
    color: 'cloud',
  },
  { from: 'openai', to: 'cortecho', label: 'audio', color: 'cloud', kind: 'stream' },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'INTENT_END · TTS_START · TTS_END{url} · RUN_END',
    note: 'the reply link, on your network',
    mono: true,
    color: 'link',
    mark: 'reply',
  },
  { from: 'echo', to: 'cortecho', label: 'GET /api/reply-audio/<id>.wav', mono: true, color: 'voice' },
  {
    from: 'cortecho',
    to: 'echo',
    label: 'WAV',
    note: 'streams while it is still generated',
    color: 'voice',
    kind: 'stream',
  },
  { from: 'echo', to: 'you', label: '“Stand-up at ten, dentist at four.”', kind: 'speech', color: 'echo' },
  {
    from: 'echo',
    to: 'cortecho',
    label: 'VoiceAssistantAnnounceFinished',
    note: 'turn saved with its timings',
    mono: true,
    color: 'link',
    deactivate: true,
  },
  { phase: 'FOLLOW-UP' },
  { frame: 'opt', label: 'only when the agent called listen_for_reply' },
  { box: 'echo', label: 'chime · listens again, no wake word', color: 'brain' },
  {
    from: 'echo',
    to: 'cortecho',
    label: 'VoiceAssistantRequest{start}',
    note: 'a new turn: back to Listen',
    mono: true,
    color: 'link',
  },
  { endFrame: true },
];

function sequence(t) {
  const W = 1320;
  const X = { you: 160, echo: 410, cortecho: 745, openai: 1000, tools: 1180 };
  const BAND_X1 = 70;
  const BAND_X2 = 1236;
  const top = 150;
  const fg = [];
  const bands = [];
  const marks = {};
  let y = top + 26;
  let band = null;
  let bandColor = t.bg;
  let frame = null;
  let act = null;
  const acts = [];

  const closeBand = (yEnd) => {
    if (band) bands.push({ ...band, y2: yEnd });
    band = null;
  };

  const off = (who) => (who === 'cortecho' && act !== null ? 7 : 0);

  for (const it of TURN) {
    if (it.phase) {
      closeBand(y - 6);
      if (bands.length) y += 12;
      band = { name: it.phase, color: ACCENT[PHASES[it.phase]], y1: y - 6 };
      bandColor = mix(t.bg, band.color, t === THEMES.dark ? 0.07 : 0.05);
      y += 22;
      continue;
    }
    if (it.frame) {
      frame = { label: it.label, y1: y - 10 };
      y += 30;
      continue;
    }
    if (it.endFrame) {
      const x1 = X.echo - 150;
      const x2 = X.cortecho + 130;
      fg.push(
        `<rect x="${x1}" y="${frame.y1}" width="${x2 - x1}" height="${y - frame.y1 - 4}" rx="8" fill="none" stroke="${ACCENT.brain}" stroke-width="1.3" stroke-dasharray="5 4"/>`,
        `<path d="M${x1},${frame.y1 + 8} a8,8 0 0 1 8,-8 H${x1 + 44} V${frame.y1 + 14} L${x1 + 36},${frame.y1 + 22} H${x1} Z" fill="${ACCENT.brain}"/>`,
        text(x1 + 18, frame.y1 + 15.5, 'opt', {
          size: 11.5,
          weight: 700,
          fill: '#ffffff',
          anchor: 'middle',
          mono: true,
        }),
        text(x1 + 54, frame.y1 + 16, `[ ${frame.label} ]`, {
          size: 12,
          fill: t.muted,
          italic: true,
          cls: 'halo',
          halo: bandColor,
        }),
      );
      y += 6;
      frame = null;
      continue;
    }
    if (it.box) {
      const w = textWidth(it.label, 12) + 26;
      const c = ACCENT[it.color];
      const bx = X[it.box] - w / 2;
      fg.push(
        `<rect x="${bx}" y="${y - 13}" width="${w}" height="26" rx="13" fill="${mix(t.bg, c, 0.16)}" stroke="${c}" stroke-opacity="0.8"/>`,
        text(X[it.box], y + 4.5, it.label, { size: 12, fill: t.text, anchor: 'middle', weight: 500 }),
      );
      y += 36;
      continue;
    }

    // A message.
    if (it.activate) act = y - 14;
    if (it.mark) marks[it.mark] = y;
    const x1 = X[it.from];
    const x2 = X[it.to];
    const dir = Math.sign(x2 - x1);
    const ax1 = x1 + dir * off(it.from);
    const ax2 = x2 - dir * (off(it.to) + 1);
    const key = it.color ?? 'line';
    const kind = it.kind ?? 'call';
    const speech = kind === 'speech';
    fg.push(
      arrow(t, ax1, y, ax2, y, {
        color: key,
        width: kind === 'stream' ? 3.2 : speech ? 2.6 : 1.8,
        dash: kind === 'back' ? '6 5' : undefined,
        cls: kind === 'stream' ? 'packets' : undefined,
      }),
    );
    const startLabel = it.labelAt === 'start';
    const lx = startLabel ? Math.min(ax1, ax2) + 14 : (x1 + x2) / 2;
    const anchor = startLabel ? 'start' : 'middle';
    fg.push(
      text(lx, y - 8, it.label, {
        size: it.mono ? 12 : 13,
        mono: it.mono,
        weight: it.mono ? 500 : 600,
        italic: speech,
        fill: speech ? t.text : t.text,
        anchor,
        cls: 'halo',
        halo: bandColor,
      }),
    );
    if (it.note) {
      fg.push(
        text(lx, y + 17, it.note, {
          size: 11.5,
          fill: t.muted,
          anchor,
          cls: 'halo',
          halo: bandColor,
        }),
      );
    }
    y += it.note ? 48 : 36;
    if (it.deactivate) {
      acts.push([act, y - 30]);
      act = null;
    }
  }
  closeBand(y - 6);
  const lifeEnd = y + 6;

  // Timing brackets on the right edge.
  const bracket = (y1, y2, big, small) => {
    const bx = 1252;
    return `<path d="M${bx - 6},${y1} H${bx} V${y2} H${bx - 6}" fill="none" stroke="${t.muted}" stroke-width="1.4"/>${text(bx + 8, (y1 + y2) / 2 - 2, big, { size: 13, weight: 700, fill: t.text })}${text(bx + 8, (y1 + y2) / 2 + 14, small, { size: 10.5, fill: t.muted })}`;
  };
  const brackets = [
    bracket(marks.listen, marks.think, '≤ 15 s', 'listening'),
    bracket(marks.think, marks.reply, '≤ 24 s', 'to a reply'),
  ];

  // Header cards.
  const heads = [
    ['you', 'You', 'in the room'],
    ['echo', 'Echo Dot', 'hassmic, ESPHome server'],
    ['cortecho', 'Cortecho', 'voice assistant client'],
    ['openai', 'OpenAI API', 'STT · agent · TTS'],
    ['tools', 'Tools & MCP', 'Calendar, Gmail, HA…'],
  ];
  const head = heads
    .map(([k, name, sub]) => {
      const x = X[k];
      const w = k === 'tools' || k === 'openai' ? 168 : 190;
      let icon = '';
      if (k === 'you') icon = person(x, 66, 1.25, t.person);
      if (k === 'echo') icon = echoDot(x, 58, 0.42, { noShadow: true });
      if (k === 'cortecho') icon = logoMark(t, x - 22, 38, 44);
      if (k === 'openai') icon = cloudIcon(x, 62, 1.6, ACCENT.cloud);
      if (k === 'tools') icon = plugIcon(x, 62, 1.5, ACCENT.tools);
      return `${card(t, x - w / 2, 24, w, 112, { rx: 14 })}${icon}${text(x, 106, name, { size: 15, weight: 700, fill: t.text, anchor: 'middle' })}${text(x, 124, sub, { size: 11.5, fill: t.muted, anchor: 'middle' })}`;
    })
    .join('');

  const lifelines = Object.values(X)
    .map(
      (x) =>
        `<line x1="${x}" y1="136" x2="${x}" y2="${lifeEnd}" stroke="${t.line}" stroke-opacity="0.55" stroke-width="1.3" stroke-dasharray="4 5"/>`,
    )
    .join('');
  const activations = acts
    .map(
      ([a, b]) =>
        `<rect x="${X.cortecho - 7}" y="${a}" width="14" height="${b - a}" rx="3" fill="${t.card}" stroke="${ACCENT.link}" stroke-width="1.4"/>`,
    )
    .join('');
  const bandSvg = bands
    .map((b) => {
      const mid = (b.y1 + b.y2) / 2;
      const fill = mix(t.bg, b.color, t === THEMES.dark ? 0.07 : 0.05);
      return `<rect x="${BAND_X1}" y="${b.y1}" width="${BAND_X2 - BAND_X1}" height="${b.y2 - b.y1}" rx="10" fill="${fill}"/><rect x="${BAND_X1}" y="${b.y1}" width="5" height="${b.y2 - b.y1}" rx="2.5" fill="${b.color}"/><text transform="translate(50 ${mid}) rotate(-90)" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="1.6" fill="${b.color}">${b.name}</text>`;
    })
    .join('');

  // Legend and the rule behind the limits.
  const ly = lifeEnd + 34;
  const legendItem = (x, label, o) =>
    `${arrow(t, x, ly - 4, x + 40, ly - 4, o)}${text(x + 50, ly, label, { size: 12, fill: t.muted })}`;
  const legend = [
    legendItem(BAND_X1 + 10, 'request', { color: 'line' }),
    legendItem(BAND_X1 + 140, 'reply', { color: 'line', dash: '6 5' }),
    legendItem(BAND_X1 + 250, 'stream', { color: 'line', width: 3.2, cls: 'packets' }),
    legendItem(BAND_X1 + 370, 'speech', { color: 'echo', width: 2.6 }),
    text(BAND_X2, ly, 'hassmic gives up after 30 s in one state, so every limit stays under it', {
      size: 12,
      fill: t.muted,
      anchor: 'end',
      italic: true,
    }),
  ].join('');
  const H = ly + 26;

  return svgDoc(
    t,
    W,
    H,
    'One voice turn, step by step',
    'Sequence diagram of one Cortecho voice turn between you, the Echo Dot, Cortecho, the OpenAI API ' +
      'and tools. Connect: Noise handshake, subscribe to the voice assistant, time sync. Listen: the wake ' +
      'word starts a run, the Echo streams 16 kHz audio until Cortecho’s VAD hears 800 ms of silence. ' +
      'Think: transcription, agent turn, an MCP tool call, the answer streamed. Speak: text to speech from ' +
      'the first sentence, the reply link sent in TTS_END, the Echo downloads the WAV while it is generated ' +
      'and plays it. Follow-up: when the agent called listen_for_reply, the Echo listens again without the ' +
      'wake word.',
    `${bandSvg}${lifelines}${activations}${head}${fg.join('\n')}${brackets.join('')}${legend}`,
  );
}

// ------------------------------------------------------------------ write

for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `architecture-${name}.svg`), architecture(t));
  writeFileSync(join(OUT, `turn-sequence-${name}.svg`), sequence(t));
}
console.log(`diagrams written to ${OUT}`);
