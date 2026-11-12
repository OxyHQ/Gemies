/**
 * The chat components of the root entry: each draws the voice call (`withVoiceCall`). The same
 * components without it — and without bundling it — are `@gemies/sdk/text`.
 */

import { GemieChatContent as TextChatContent } from './GemieChatContent';
import { GemieChatScreen as TextChatScreen } from './GemieChatScreen';
import { GemieChatSheet as TextChatSheet } from './GemieChatSheet';
import { withVoiceCall } from './voice/withVoiceCall';

export const GemieChatContent = withVoiceCall(TextChatContent, 'GemieChatContent');
export const GemieChatSheet = withVoiceCall(TextChatSheet, 'GemieChatSheet');
export const GemieChatScreen = withVoiceCall(TextChatScreen, 'GemieChatScreen');
