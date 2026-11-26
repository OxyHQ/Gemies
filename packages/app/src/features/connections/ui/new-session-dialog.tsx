import {
  isSessionFolder,
  useExternalSessions,
} from '@/features/connections/runtime/use-external-sessions';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Dialog } from '@oxy.so/bloom/dialog';
import { List } from '@oxy.so/bloom/list';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

const K = 'settings.connections.externalAgents.session';

/**
 * Opens a session with an external agent (Gemies ADR 0043): a new conversation that works in a
 * folder on the agent's computer. The person picks one of the folders its sessions worked in lately
 * or types a path; the conversation is made, its folder registered, and the chat opens on it.
 *
 * Gemies only asks for the folder. The computer decides, and refuses one its owner did not allow
 * there (`gemies allow`), which the chat then says in the agent's own words.
 */
export function NewSessionDialog({
  agentId,
  name,
  open,
  onClose,
}: {
  agentId: string;
  /** The agent's name, for the title. */
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { folders, open: openSession, opening } = useExternalSessions(agentId);
  const [folder, setFolder] = useState('');
  const [touched, setTouched] = useState(false);
  const [starting, setStarting] = useState(false);

  const valid = isSessionFolder(folder);
  const close = () => {
    setFolder('');
    setTouched(false);
    onClose();
  };

  const begin = async () => {
    setTouched(true);
    if (!valid || starting) return;
    setStarting(true);
    try {
      const conversationId = await openSession(folder);
      close();
      router.push(`/(app)/c/${conversationId}`);
    } catch (err) {
      console.error('Failed to open the session:', err);
      toast.error(t(`${K}.startFailed`));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={`${t(`${K}.title`)} · ${name}`}
      actions={[
        {
          label: t(`${K}.start`),
          disabled: !valid || starting || opening,
          shouldCloseOnPress: false,
          onPress: () => void begin(),
        },
      ]}
    >
      <View className="gap-4">
        <View className="gap-2">
          <TextFieldInput
            label={t(`${K}.folderLabel`)}
            placeholder={t(`${K}.folderPlaceholder`)}
            value={folder}
            onValueChange={setFolder}
            invalid={touched && !valid}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {touched && !valid ? (
            <Muted>{t(`${K}.invalid`)}</Muted>
          ) : (
            <Muted>{t(`${K}.folderHint`)}</Muted>
          )}
        </View>
        {folders.length > 0 ? (
          <List
            accessibilityLabel={t(`${K}.recent`)}
            style={{ width: '100%' }}
            items={folders.map((recent) => ({
              id: recent,
              title: recent,
              label: recent,
              onPress: () => {
                setFolder(recent);
                setTouched(false);
              },
            }))}
          />
        ) : null}
      </View>
    </Dialog>
  );
}
