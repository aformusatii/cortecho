import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// `npm run icons` turns public/logo.svg into every icon the PWA needs
// (favicon.ico, 64/192/512 PNGs, maskable 512 and apple-touch-icon 180).
// The generated PNG/ICO files are committed; rerun this after changing the logo.
const INK = '#1b2337';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // Maskable and Apple icons are cropped/rounded by the OS, so they need a
    // solid background and extra padding instead of transparent corners.
    maskable: { ...minimal2023Preset.maskable, padding: 0.25, resizeOptions: { background: INK } },
    apple: { ...minimal2023Preset.apple, padding: 0.2, resizeOptions: { background: INK } },
  },
  images: ['public/logo.svg'],
});
