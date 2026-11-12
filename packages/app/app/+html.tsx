import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * Root HTML component for static rendering
 * This file runs during static rendering in Node.js for SEO optimization
 * Don't wrap your app with Providers here - that should be in _layout.tsx
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />

        {/* Viewport and mobile optimization */}
        {/* `interactive-widget=resizes-content`: Chrome on Android shrinks
            the layout viewport under the keyboard, as iOS Safari does, so the
            composer rises with it instead of being covered. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, interactive-widget=resizes-content"
        />

        {/* Security and Performance */}
        <meta httpEquiv="Content-Security-Policy" content="upgrade-insecure-requests" />
        <meta name="referrer" content="origin-when-cross-origin" />
        {/* Browsers read Permissions-Policy only as a header, so this line is
            inert — but it must not deny what the app uses: dictation and
            voice calls need the microphone, and the camera attaches photos. */}
        <meta
          httpEquiv="Permissions-Policy"
          content="camera=(self), microphone=(self), geolocation=()"
        />

        {/* Primary Meta Tags */}
        <meta name="title" content="Gemies" />
        <meta
          name="description"
          content="Create your Gemies. Let them work together. Gemies are AI teammates you shape, and Alia is one of them."
        />
        <meta name="keywords" content="Gemies, AI agents, AI teammates, AI assistant, Alia, Oxy" />

        {/* Open Graph / Facebook Meta Tags for social sharing */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://gemies.ai/" />
        <meta property="og:title" content="Gemies" />
        <meta
          property="og:description"
          content="Create your Gemies. Let them work together. Gemies are AI teammates you shape, and Alia is one of them."
        />
        <meta property="og:image" content="/og-image.png" />

        {/* Twitter Card Meta Tags */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content="https://gemies.ai/" />
        <meta property="twitter:title" content="Gemies" />
        <meta
          property="twitter:description"
          content="Create your Gemies. Let them work together. Gemies are AI teammates you shape, and Alia is one of them."
        />
        <meta property="twitter:image" content="/og-image.png" />

        {/* Startup fallback; Bloom adopts one entry and becomes the runtime owner. */}
        <meta name="theme-color" content="#f9f2f6" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#100d11" media="(prefers-color-scheme: dark)" />

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* Favicons */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="shortcut icon" href="/icon-192.png" />

        {/* Apple Touch Icons for iOS home screen */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

        {/* Apple Mobile Web App */}
        <meta name="apple-mobile-web-app-title" content="Gemies" />

        {/* Disable body scrolling for native-like feel on web */}
        <ScrollViewStyleReset />

        {/* Preconnect to important domains for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

        {/* JSON-LD Structured Data for SEO */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'Gemies',
              url: 'https://gemies.ai',
              description:
                'Create your Gemies. Let them work together. Gemies are AI teammates you shape, and Alia is one of them.',
              applicationCategory: 'BusinessApplication',
              operatingSystem: 'Web, iOS, Android',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
            }),
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
