import { createElement } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * A turn as a chat bubble: the person's at the end in the agent's colour with its icons on the
 * side facing the thread, a reply at the start with its icons after it. The icons are the three of
 * the chat this is modelled on (react, reply, more) and appear on hover.
 */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
          ReactModule.createElement(name, props, children),
      ]),
    );
  },
}));

vi.mock('react-native', async () => ({
  ...(await import('../../support/style-stubs')).reactNativeStyles,
  ...(await hosts('View', 'Pressable', 'Text')),
  Platform: { OS: 'web' },
}));
vi.mock('@oxy.so/bloom/dropdown-menu', async () => {
  const items = await hosts('DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent');
  const ReactModule = await import('react');
  return {
    ...items,
    DropdownMenuItem: ({
      children,
      ...props
    }: Record<string, unknown> & { children?: React.ReactNode }) =>
      ReactModule.createElement('DropdownMenuItem', props, children),
  };
});
vi.mock('@oxy.so/bloom/hooks', async () => {
  const ReactModule = await import('react');
  return {
    useInteractionState: () => {
      const [state, setState] = ReactModule.useState(false);
      return { state, onIn: () => setState(true), onOut: () => setState(false) };
    },
  };
});
vi.mock('@oxy.so/bloom/chat-composer', async () => await hosts('ReactionPicker'));
vi.mock('@oxy.so/bloom/theme', async () => ({
  ...(await import('../../support/style-stubs')).bloomTokenStyles,
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
  useTheme: () => ({
    colors: {
      backgroundSecondary: '#eee',
      text: '#111',
      textSecondary: '#666',
      primary: '#009957',
      primaryForeground: '#ffffff',
    },
  }),
}));
vi.mock('../../../src/components/icons/RiEmojiPicker', () => ({ RiEmojiPicker: () => null }));
vi.mock('../../../src/components/icons/RiMoreDots', () => ({ RiMoreDots: () => null }));
vi.mock('../../../src/components/icons/RiReplyLine', () => ({ RiReplyLine: () => null }));
vi.mock('../../../src/lib/labels', () => ({ useLabels: () => ({ t: (key: string) => key }) }));

import { ChatBubble } from '../../../src/components/thread/ChatBubble';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const Glyph = () => null;
const action = (key: string, onPress = vi.fn()) => ({
  key,
  label: key,
  icon: Glyph as never,
  onPress,
});
const is = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;
/** A node's style as React Native draws it: its style array merged in order. */
const styleOf = (node: ReactTestInstance): Record<string, unknown> =>
  Object.assign({}, ...[node.props.style].flat(Number.POSITIVE_INFINITY).filter(Boolean));

function mount(
  side: 'user' | 'reply',
  extra: {
    react?: ReturnType<typeof action>[];
    menu?: ReturnType<typeof action>[];
    onReply?: () => void;
    reactions?: string[];
    onReact?: (emoji: string) => void;
  } = {},
) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <ChatBubble side={side} {...extra}>
        {createElement('View', { testID: 'words' })}
      </ChatBubble>,
    );
  });
  return renderer.root;
}
/** The whole turn: it carries the hover handlers. */
const outer = (root: ReactTestInstance) => root.findAll((n) => is(n, 'View'))[0]!;
/** The line of icons and bubble inside it. */
const row = (root: ReactTestInstance) =>
  root.find((n) => is(n, 'View') && styleOf(n).flexDirection === 'row' && styleOf(n).gap === 8);
/** The icons: 2 apart. */
const isGroup = (n: ReactTestInstance) => is(n, 'View') && styleOf(n).gap === 2;
const group = (root: ReactTestInstance) => root.find(isGroup);
/** The pills, on the bubble's lower edge. */
const isPillRow = (n: ReactTestInstance) => is(n, 'View') && styleOf(n).marginTop === -10;
const labels = (root: ReactTestInstance) =>
  root.findAll((n) => is(n, 'Pressable')).map((b) => b.props.accessibilityLabel);

describe('ChatBubble', () => {
  it("puts the person's bubble at the end in the theme's primary, icons first", () => {
    const root = mount('user', { onReply: vi.fn() });
    expect(styleOf(row(root)).justifyContent).toBe('flex-end');
    const children = row(root).children as ReactTestInstance[];
    expect(styleOf(children[0]!).gap).toBe(2);
    expect(styleOf(children[1]!)).toMatchObject({
      backgroundColor: '#009957',
      borderRadius: 24,
      paddingHorizontal: 16,
      paddingVertical: 12,
      maxWidth: '80%',
    });
  });

  it('puts a reply at the start in a neutral bubble, 8px tall, icons after it', () => {
    const root = mount('reply', { onReply: vi.fn() });
    expect(styleOf(row(root)).justifyContent).toBe('flex-start');
    const children = row(root).children as ReactTestInstance[];
    // The neutral bubble: Bloom's popover token, as `bg-background-tertiary-default` drew it.
    expect(styleOf(children[0]!)).toMatchObject({ backgroundColor: 'popover', paddingVertical: 8 });
    expect(styleOf(children[1]!).gap).toBe(2);
  });

  it('shows the icons only while the row is hovered', () => {
    const root = mount('reply', { onReply: vi.fn() });
    expect(styleOf(group(root)).opacity).toBe(0);
    expect(group(root).props.pointerEvents).toBe('none');
    act(() => outer(root).props.onPointerEnter());
    expect(styleOf(group(root)).opacity).toBe(1);
    expect(group(root).props.pointerEvents).toBe('auto');
    act(() => outer(root).props.onPointerLeave());
    expect(styleOf(group(root)).opacity).toBe(0);
  });

  it('has the three icons of the chat it is modelled on, in order: react, reply, more', () => {
    const root = mount('reply', {
      onReact: vi.fn(),
      menu: [action('copy')],
      onReply: vi.fn(),
    });
    expect(labels(root)).toEqual([
      'chat.reactToMessage',
      'chat.replyToMessage',
      'chat.moreActions',
    ]);
  });

  it('opens the emoji bar under react, and a pick reacts', () => {
    const onReact = vi.fn();
    const root = mount('reply', { onReact });
    const picker = root.find((n) => is(n, 'ReactionPicker'));
    act(() => picker.props.onSelectEmoji('🎉'));
    expect(onReact).toHaveBeenCalledWith('🎉');
  });

  it('keeps the rest of the turn under more, and quotes the turn on reply', () => {
    const copy = vi.fn();
    const reply = vi.fn();
    const root = mount('reply', {
      menu: [action('like'), action('copy', copy)],
      onReply: reply,
    });
    const items = root.findAll((n) => is(n, 'DropdownMenuItem'));
    expect(items.map((i) => i.props.children)).toEqual(['like', 'copy']);
    act(() => items[1]!.props.onPress());
    expect(copy).toHaveBeenCalledOnce();
    const replyButton = root
      .findAll((n) => is(n, 'Pressable'))
      .find((b) => b.props.accessibilityLabel === 'chat.replyToMessage')!;
    act(() => replyButton.props.onPress());
    expect(reply).toHaveBeenCalledOnce();
  });

  it('draws the reactions as pills on the bubble’s lower edge, and a pill takes its reaction back', () => {
    const onReact = vi.fn();
    const root = mount('user', { reactions: ['👍', '🎉'], onReact });
    const pills = root
      .findAll((n) => is(n, 'Pressable'))
      .filter((n) => String(n.props.accessibilityLabel).startsWith('chat.reaction'));
    expect(pills).toHaveLength(2);
    act(() => pills[0]!.props.onPress());
    expect(onReact).toHaveBeenCalledWith('👍');
    expect(styleOf(root.find(isPillRow)).justifyContent).toBe('flex-end');
  });

  it('draws no pill row without reactions', () => {
    const root = mount('reply');
    expect(root.findAll(isPillRow)).toHaveLength(0);
  });

  it('draws only the icons the turn can use: the person has no vote to cast on a question', () => {
    const root = mount('user', { menu: [action('copy')], onReply: vi.fn() });
    expect(labels(root)).toEqual(['chat.replyToMessage', 'chat.moreActions']);
  });

  it('draws no icon group when there is nothing to offer', () => {
    const root = mount('reply');
    expect(root.findAll(isGroup)).toHaveLength(0);
  });
});
