import type { Request } from 'express';

/** The platforms with a system bot. Telegram is not one: its bots are gemies' (ADR 0037). */
export type ChannelId = 'discord' | 'whatsapp' | 'slack';

interface ChannelMeta {
  id: ChannelId;
  name: string;
  icon: string;
  color: string;
  textChunkLimit: number;
  supportsMedia: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
}

export interface ChannelPlugin {
  id: ChannelId;
  meta: ChannelMeta;
  config: ChannelConfigAdapter;
  outbound: ChannelOutboundAdapter;
  security?: ChannelSecurityAdapter;
  normalize: ChannelNormalizeAdapter;
  webhook?: ChannelWebhookAdapter;
}

interface ChannelConfigAdapter {
  isConfigured: () => boolean;
  getEnvPrefix: () => string;
}

export interface ChannelOutboundAdapter {
  deliveryMode: 'direct' | 'gateway';
  sendText: (ctx: OutboundContext) => Promise<OutboundResult>;
  sendMedia?: (ctx: OutboundContext) => Promise<OutboundResult>;
  chunker?: (text: string, limit: number) => string[];
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  metadata?: Record<string, any>;
}

export interface OutboundResult {
  channel: ChannelId;
  ok: boolean;
  messageId?: string;
  error?: string;
}

interface ChannelSecurityAdapter {
  resolveDmPolicy: (accountId: string) => DmPolicy;
}

interface DmPolicy {
  policy: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allowFrom?: string[];
}

interface ChannelNormalizeAdapter {
  normalizeTarget: (raw: string) => string | undefined;
  looksLikeTarget: (raw: string) => boolean;
}

interface ChannelWebhookAdapter {
  verifySignature: (req: Request) => boolean;
  parseMessage: (body: any) => ChannelInboundMessage | null;
}

export interface ChannelInboundMessage {
  platformUserId: string;
  chatId: string;
  text: string;
  username?: string;
  displayName?: string;
  replyToId?: string;
  threadId?: string;
  attachments?: { type: string; url: string }[];
}
