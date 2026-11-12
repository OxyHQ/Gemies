import { createElement, useState } from 'react';

/**
 * The Gemies welcome animation (clover, frog and paperclip, on transparent), drawn by the
 * browser.
 *
 * The owner's GIF is 24 MB (150 frames at 1024 px). Here it is a VP9 WebM with an alpha channel
 * at 768 px, 1.4 MB and visually the same (`public/welcome/gemies.webm`). WebKit (Safari, and
 * every browser on iOS) plays VP9 but ignores its alpha, which would paint the frogs on a black
 * square, so WebKit gets the same animation as an animated WebP (`gemies.webp`, quality 95 at
 * 576 px). The first frame is the poster, so the space is never empty while either loads.
 */
const POSTER = require('../../../assets/images/gemies-welcome.png');
const WEBM = '/welcome/gemies.webm';
const WEBP = '/welcome/gemies.webp';

/** WebKit without Blink: the engine that drops a WebM's alpha. */
function isWebKitOnly(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua));
}

/** The poster is a module asset: on the web it resolves to its URL (`uri`) or the URL itself. */
function posterUrl(): string {
  const asset = POSTER as string | { uri?: string; default?: string };
  return typeof asset === 'string' ? asset : (asset.uri ?? asset.default ?? '');
}

export function GemiesWelcomeArt({ size }: { size: number }) {
  const [webkit] = useState(isWebKitOnly);
  const box = { width: size, height: size, display: 'block', objectFit: 'contain' } as const;
  if (webkit) {
    return createElement('img', {
      src: WEBP,
      alt: '',
      'aria-hidden': true,
      width: size,
      height: size,
      decoding: 'async',
      style: { ...box, backgroundImage: `url(${posterUrl()})`, backgroundSize: 'contain' },
    });
  }
  return createElement('video', {
    src: WEBM,
    poster: posterUrl(),
    autoPlay: true,
    loop: true,
    muted: true,
    playsInline: true,
    preload: 'auto',
    'aria-hidden': true,
    disablePictureInPicture: true,
    width: size,
    height: size,
    style: box,
  });
}
