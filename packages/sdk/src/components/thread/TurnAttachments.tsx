/**
 * A turn's attachments, drawn as the thread draws every attachment: a photo sent inline, and a file
 * kept in Oxy Files — attached in the app, or media that arrived on a channel (a gemie's Telegram
 * bot, a connected account), which says what it was there.
 *
 * - An image is the photo, and a channel's sticker is a sticker (its still, for an animated one).
 * - A voice note or audio is a voice message that plays, with its transcript under it.
 * - Anything else is a file chip that opens the file.
 *
 * A file is private to its person: its URL is the one Oxy answers the signed-in caller
 * (`useFileDownloadUrl`), never a public one. One component for every turn, so a channel's media
 * and the app's own attachments are drawn the same way.
 */

import {
  FileMessage,
  ImageMessage,
  StickerMessage,
  VoiceMessage,
} from '@oxy.so/bloom/message-media';
import { useFileDownloadUrl, useOxy } from '@oxy.so/services/ui/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { useLabels } from '../../lib/labels';
import { loadExpoAudio } from '../../lib/deferred/expo-audio';
import {
  getAttachmentsFromContent,
  type MessageContent,
  type TurnAttachment,
} from '../../lib/content-utils';
import { Image } from '../Image';

type Tone = 'incoming' | 'outgoing';
/** The bubble's tone, and its own foreground when the app paints a custom bubble. */
interface Paint {
  tone: Tone;
  onColor?: string;
}
type FileAttachment = Extract<TurnAttachment, { type: 'file' }>;

/** A waveform for a voice note whose samples were never measured: steady, from its id. */
export function placeholderWaveform(seed: string, bars = 32): number[] {
  let h = 0;
  for (const char of seed) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0;
  return Array.from({ length: bars }, (_, i) => {
    h = (Math.imul(h ^ (h >>> 13), 0x5bd1e995) + i) | 0;
    return 0.25 + ((h >>> 0) % 1000) / 1600;
  });
}

function useFileUrl(fileId: string): string | null {
  const { oxyServices } = useOxy();
  return useFileDownloadUrl(oxyServices, fileId).url;
}

function StoredImage({ file, tone, onColor }: { file: FileAttachment } & Paint) {
  const { t } = useLabels();
  const url = useFileUrl(file.fileId);
  if (file.kind === 'sticker') {
    // A sticker IS its meaning: its words name it for a screen reader.
    return url ? (
      <StickerMessage
        source={url}
        tone={tone}
        onColor={onColor}
        size={128}
        accessibilityLabel={file.description ?? t('chat.attachment.sticker')}
      />
    ) : (
      <View className="size-32 rounded-xl bg-surface-secondary" />
    );
  }
  return url ? (
    <ImageMessage
      source={url}
      tone={tone}
      onColor={onColor}
      maxWidth={240}
      maxHeight={280}
      accessibilityLabel={file.description ?? t('chat.attachment.photo')}
      onPress={() => void Linking.openURL(url)}
    />
  ) : (
    <View className="h-40 w-60 rounded-2xl bg-surface-secondary" />
  );
}

function StoredVoice({ file, tone, onColor }: { file: FileAttachment } & Paint) {
  const { t } = useLabels();
  const url = useFileUrl(file.fileId);
  const samples = useMemo(() => placeholderWaveform(file.fileId), [file.fileId]);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const player = useRef<{ play(): void; pause(): void; remove(): void } | null>(null);
  useEffect(() => () => player.current?.remove(), []);

  const toggle = async () => {
    if (!url) return;
    if (player.current && playing) {
      player.current.pause();
      setPlaying(false);
      return;
    }
    if (!player.current) {
      const { createAudioPlayer } = await loadExpoAudio();
      const created = createAudioPlayer({ uri: url });
      created.addListener('playbackStatusUpdate', (status) => {
        setPosition(status.currentTime);
        if (status.didJustFinish) {
          setPlaying(false);
          setPosition(0);
          created.seekTo(0);
        }
      });
      player.current = created;
    }
    player.current.play();
    setPlaying(true);
  };

  return (
    <VoiceMessage
      tone={tone}
      onColor={onColor}
      samples={samples}
      duration={file.durationSeconds ?? 0}
      position={position}
      playing={playing}
      onPlayPress={() => void toggle()}
      transcript={file.transcript}
      transcribeLabel={t('chat.attachment.transcribe')}
      hideTranscriptLabel={t('chat.attachment.hideTranscript')}
      accessibilityLabel={file.description ?? t('chat.attachment.voice')}
    />
  );
}

function StoredFile({ file, tone, onColor }: { file: FileAttachment } & Paint) {
  const url = useFileUrl(file.fileId);
  return (
    <FileMessage
      tone={tone}
      onColor={onColor}
      name={file.filename}
      mimeType={file.mime}
      accessibilityLabel={file.description ?? file.filename}
      onPress={url ? () => void Linking.openURL(url) : undefined}
    />
  );
}

function Attachment({ item, tone, onColor }: { item: TurnAttachment } & Paint) {
  if (item.type === 'inline-image') {
    return (
      <View className="size-[120px] overflow-hidden rounded-xl">
        <Image source={{ uri: item.url }} className="h-full w-full" contentFit="cover" />
      </View>
    );
  }
  if (item.mime.startsWith('image/')) {
    return <StoredImage file={item} tone={tone} onColor={onColor} />;
  }
  if (item.mime.startsWith('audio/')) {
    return <StoredVoice file={item} tone={tone} onColor={onColor} />;
  }
  return <StoredFile file={item} tone={tone} onColor={onColor} />;
}

/** The turn's attachments, or nothing when it has none. */
export function TurnAttachments({
  content,
  tone = 'incoming',
  onColor,
}: {
  content: MessageContent | null | undefined;
  tone?: Tone;
  onColor?: string;
}) {
  const runs = attachmentRuns(getAttachmentsFromContent(content));
  if (runs.length === 0) return null;
  return (
    <View className="gap-2">
      {runs.map((run) =>
        Array.isArray(run) ? (
          <View key={`images:${run[0]?.url}`} className="flex-row flex-wrap gap-2">
            {run.map((item) => (
              <Attachment key={item.url} item={item} tone={tone} onColor={onColor} />
            ))}
          </View>
        ) : (
          <Attachment key={run.fileId} item={run} tone={tone} onColor={onColor} />
        ),
      )}
    </View>
  );
}

type InlineImage = Extract<TurnAttachment, { type: 'inline-image' }>;

/**
 * The attachments in the order they were sent, the pictures next to each other drawn as one row.
 * Drawing every picture first put a document sent between two photos after both of them.
 */
function attachmentRuns(items: readonly TurnAttachment[]): Array<InlineImage[] | FileAttachment> {
  const runs: Array<InlineImage[] | FileAttachment> = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (item.type === 'file') runs.push(item);
    else if (Array.isArray(last)) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

/** Whether a turn has anything to draw as an attachment. */
export function hasAttachments(content: MessageContent | null | undefined): boolean {
  return getAttachmentsFromContent(content).length > 0;
}
