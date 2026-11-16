import { Button } from '@oxy.so/bloom/button';
import { useTranslation } from '@/shared/i18n/use-translation';

import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';

/**
 * The agent screen's header: edit (owner only), chat (when this person may
 * talk to it), its computer (when it has one), share.
 *
 * A private agent is in the catalogue for everyone but answers only its own
 * account (`canReachAgent` in the API): for anyone else its thread is "Agent
 * not found". Offering Chat there was a button that led to a dead end — on a
 * Pixel 8a it flashed "Agent not found" and seemed to do nothing (#608,
 * `docs/native-validation.mdx`).
 *
 * There used to be a "More" menu with two items, and neither did anything
 * (#608, rule 6). "Report" was a toast saying the report was submitted — no
 * request left the device, because no API route accepts one. "Bookmark" wrote
 * the id to AsyncStorage, and the only reader of that list was this same menu
 * deciding which icon to draw: no screen listed, sorted or filtered by it. Both
 * come back when there is something real behind them.
 */
export function AgentHeaderActions({
  isOwner,
  canChat,
  hasComputer = false,
  onEdit,
  onChat,
  onShare,
  onComputer,
}: {
  isOwner: boolean;
  /** A public agent, or this person's own. */
  canChat: boolean;
  /**
   * The agent holds the `computer` grant and this person may use it: its
   * computer view is theirs to open (it only ever shows THEIR computer with
   * the agent).
   */
  hasComputer?: boolean;
  onEdit: () => void;
  onChat: () => void;
  onShare: () => void;
  onComputer?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Button.Group accessibilityLabel={t('pages.agents.agentActions')}>
      {isOwner ? <Button onPress={onEdit}>{t('agents.edit')}</Button> : null}
      {canChat ? <Button onPress={onChat}>{t('agents.chat')}</Button> : null}
      {hasComputer && onComputer ? (
        <Button onPress={onComputer}>{t('agents.computer.open')}</Button>
      ) : null}
      <Button
        iconOnly
        leadingIcon={RiShare2Line}
        accessibilityLabel={t('agents.share')}
        onPress={onShare}
      />
    </Button.Group>
  );
}
