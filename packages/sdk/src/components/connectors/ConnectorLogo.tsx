import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';
import { useConnectorLogoUrl } from '../../runtime/connectors';
import { Image } from '../Image';

export interface ConnectorLogoProps {
  /** The connector's name, for the monogram and for screen readers. */
  name: string;
  /** The logo path the API answered (`/mcp/logos/<id>`), or `null`. */
  logoUrl: string | null | undefined;
  /** Its side, in points. */
  size?: number;
}

/**
 * A connector's logo, wherever a connector appears: the store, Settings, a gemie's editor and a
 * tool call in the chat. The image is always one the API stores and serves from its own origin
 * (`lib/connector-logos.ts`): the server's own MCP icon, its MCP Registry icon or its provider's
 * brand mark. Without one, or when it does not load, a monogram — never a broken image.
 */
export function ConnectorLogo({ name, logoUrl, size = 40 }: ConnectorLogoProps) {
  const src = useConnectorLogoUrl(logoUrl);
  const [failed, setFailed] = useState(false);
  const radius = Math.round(size * 0.22);

  if (!src || failed) {
    const letter = name.trim().charAt(0).toUpperCase() || '·';
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={name}
        className="items-center justify-center bg-background-tertiary-default"
        style={{ width: size, height: size, borderRadius: radius }}
      >
        <Text
          variant="body-medium"
          className="text-text-secondary"
          style={{ fontSize: Math.round(size * 0.45), lineHeight: Math.round(size * 0.6) }}
        >
          {letter}
        </Text>
      </View>
    );
  }

  return (
    <View
      className="overflow-hidden border border-border bg-white"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Image
        source={{ uri: src }}
        accessibilityLabel={name}
        contentFit="contain"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    </View>
  );
}
