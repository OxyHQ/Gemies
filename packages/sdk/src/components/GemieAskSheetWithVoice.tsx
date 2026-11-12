/**
 * The ask sheet with the voice call: what the root entry's `GemieAskProvider` imports and
 * `@gemies/sdk/ask` loads with the first `ask`. `@gemies/sdk/ask/text` loads `GemieAskSheet`
 * itself, which never reaches the call.
 */

import { GemieAskSheet as TextAskSheet } from './GemieAskSheet';
import { withVoiceCall } from './voice/withVoiceCall';

export const GemieAskSheet = withVoiceCall(TextAskSheet, 'GemieAskSheet');
