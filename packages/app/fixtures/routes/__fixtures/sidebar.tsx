/** Real sidebar presentation and menu content, with fixture-only data and controlled callbacks. */
import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import { AgentRowAvatar, reactAgentRow } from '@/shell/agent-row-avatar';
import { GemieRowMenu, type GemieRowHandlers } from '@/shell/sidebar-gemie-menu';
import { SidebarView } from '@/shell/sidebar';
import { AiChatContainer, AiChatShell } from '@oxy.so/bloom/ai-chat';
import { AvatarGroup } from '@oxy.so/bloom/avatar-group';
import { Button } from '@oxy.so/bloom/button';
import type { ConversationSidebarProps } from '@oxy.so/bloom/conversation-sidebar';
import { RiMenuLine } from '@oxy.so/bloom/icons/RiMenuLine';
import { List } from '@oxy.so/bloom/list';
import { PageHeader } from '@oxy.so/bloom/page-header';
import type { SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DATE = '2026-11-16T12:00:00.000Z';
const agents: Agent[] = ['Pepe', 'Mira', 'Luna'].map((name, index) => ({
  _id: `fixture-${index}`,
  identity: { source: 'local', name, color: 'violet' },
  character: { preset: 'blue_beret', color: 'violet' },
  ownerOxyAccountId: 'fixture-owner',
  name,
  handle: name.toLowerCase(),
  color: 'violet',
  tagline: 'Ready to help',
  description: '',
  author: 'fixture-owner',
  authorName: 'Fixture',
  category: 'general',
  tags: [],
  rating: 0,
  reviewCount: 0,
  usageCount: 0,
  hireCount: 0,
  maxConcurrentThreads: 4,
  price: null,
  capabilityGrants: ['computer'],
  skills: [],
  knowledge: [],
  isFeatured: false,
  isTrending: false,
  isPublished: false,
  status: 'active',
  access: 'private',
  createdAt: DATE,
  updatedAt: DATE,
}));
const spaces: Space[] = [
  {
    id: 'fixture-space',
    name: 'Research',
    instructions: '',
    conversationId: 'fixture-room',
    memberAgentIds: [],
    createdAt: DATE,
    updatedAt: DATE,
  },
];
interface FixtureWindow {
  __aliaFixture?: { sidebar?: { events: () => string[]; open: () => void } };
}

export default function SidebarFixture() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('fixture-0');
  const [navOpen, setNavOpen] = useState(false);
  const events = useRef<string[]>([]);
  const [lastEvent, setLastEvent] = useState('Choose a Gemie');
  const record = useCallback((event: string) => {
    events.current.push(event);
    setLastEvent(event);
  }, []);
  useEffect(() => {
    const fixtureWindow = window as unknown as FixtureWindow;
    fixtureWindow.__aliaFixture = {
      ...fixtureWindow.__aliaFixture,
      sidebar: { events: () => [...events.current], open: () => setNavOpen(true) },
    };
    return () => {
      delete fixtureWindow.__aliaFixture?.sidebar;
    };
  }, []);
  const handlers = useMemo<GemieRowHandlers>(
    () => ({
      openProfile: (agent) => record(`profile:${agent._id}`),
      edit: (agent) => record(`edit:${agent._id}`),
      openComputer: (agent) => record(`computer:${agent._id}`),
      share: (agent) => record(`share:${agent._id}`),
      setPaused: (agent, paused) => record(`paused:${agent._id}:${paused}`),
      askDelete: (agent) => record(`delete:${agent._id}`),
      move: (agent, space) => record(`move:${agent._id}:${space}`),
    }),
    [record],
  );
  const rows = useMemo<SidebarTreeItem[]>(
    () =>
      agents.map((agent) => ({
        key: agent._id,
        label: agent.name ?? agent._id,
        description: agent.tagline,
        leading: (
          <AgentRowAvatar
            agentId={agent._id}
            character={{ preset: 'blue_beret', color: 'violet' }}
            size={36}
          />
        ),
        onPrefetch: () => record(`prefetch:${agent._id}`),
        contextMenu: <GemieRowMenu agent={agent} isOwner spaces={spaces} handlers={handlers} />,
      })),
    [handlers, record],
  );
  const props: ConversationSidebarProps = {
    conversations: [],
    labels: { empty: '' },
    onSelect: (id) => record(`select:${id}`),
    query,
    onQueryChange: setQuery,
    selectedTreeItem: active,
    onTreeItemPress: (item) => {
      reactAgentRow(item.key);
      setActive(item.key);
      record(`navigate:${item.key}`);
      setNavOpen(false);
    },
    tree: [
      {
        key: 'agents',
        label: 'Your Gemies',
        items: rows.filter((row) => row.label.toLowerCase().includes(query.toLowerCase())),
      },
      {
        key: 'spaces',
        label: 'Spaces',
        folders: [
          {
            key: 'research',
            label: 'Research',
            items: [
              {
                key: 'group',
                label: 'Working together',
                description: 'Pepe, Mira and Luna',
                leading: (
                  <AvatarGroup
                    layout="conversation"
                    size={36}
                    motion="always"
                    items={agents.map((agent) => ({
                      id: agent._id,
                      name: agent.name ?? agent._id,
                      kind: 'bot',
                      character: { preset: 'blue_beret', color: 'violet' },
                    }))}
                  />
                ),
              },
            ],
          },
        ],
      },
    ],
  };
  return (
    <AiChatShell
      sidebar={(shell) => <SidebarView props={props} shell={shell} />}
      mobileSidebar={<SidebarView props={props} mobile />}
      navOpen={navOpen}
      onNavOpenChange={setNavOpen}
    >
      <AiChatContainer
        header={
          <PageHeader
            title="Gemies"
            leading={
              <Button
                icon={RiMenuLine}
                accessibilityLabel="Open navigation"
                onPress={() => setNavOpen(true)}
              />
            }
          />
        }
      >
        <List
          items={[
            {
              id: 'event',
              title: lastEvent,
              supporting: 'Fixture callbacks only; no account or server mutations.',
            },
          ]}
        />
      </AiChatContainer>
    </AiChatShell>
  );
}
