import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), createConversation: vi.fn() }));
vi.mock('@/shared/api/client', () => ({ default: { get: api.get, post: api.post } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@gemies/sdk/runtime', () => ({
  useCreateConversation: () => ({ run: api.createConversation, isPending: false }),
}));

const { isAllowedFolder, isSessionFolder, useExternalSessions } = await import(
  '../use-external-sessions'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current!: ReturnType<typeof useExternalSessions>;
  function Probe() {
    current = useExternalSessions('agent-1');
    return null;
  }
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  // The folders query settles, and the hook renders again with them.
  for (let waited = 0; waited < 100 && current.loadingFolders; waited++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  return () => current;
}

beforeEach(() => {
  api.get.mockImplementation(async (url: string) =>
    url.endsWith('/terminal-sessions')
      ? { data: { sessions: [], roots: ['/home/ana/code'] } }
      : { data: { folders: ['/home/ana/app', '/home/ana/api'] } },
  );
  api.post.mockResolvedValue({ data: {} });
  api.createConversation.mockResolvedValue({ id: 'conv-9' });
});

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

describe('isSessionFolder', () => {
  it('accepts the absolute paths the API accepts', () => {
    for (const path of ['/home/ana/app', '/', '~', '~/app', 'C:\\Users\\ana', 'd:/code', ' /x ']) {
      expect(isSessionFolder(path)).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const path of [
      '',
      '  ',
      'app',
      './app',
      '../app',
      '~ana/app',
      'C:app',
      'a'.repeat(2000),
    ]) {
      expect(isSessionFolder(path)).toBe(false);
    }
  });
});

describe('isAllowedFolder', () => {
  const roots = ['/home/ana/code', '/srv/work/'];

  it('accepts a root and anything under it', () => {
    for (const folder of ['/home/ana/code', '/home/ana/code/app/', '/srv/work/x']) {
      expect(isAllowedFolder(folder, roots)).toBe(true);
    }
  });

  it('refuses a folder outside, a sibling that starts alike, and a parent', () => {
    for (const folder of ['/home', '/home/ana', '/home/ana/codex', '/etc']) {
      expect(isAllowedFolder(folder, roots)).toBe(false);
    }
  });

  it('judges nothing it cannot: no roots known, a home or drive path, a root it cannot compare', () => {
    expect(isAllowedFolder('/anywhere', [])).toBe(true);
    expect(isAllowedFolder('~/app', roots)).toBe(true);
    expect(isAllowedFolder('C:\\work', roots)).toBe(true);
    expect(isAllowedFolder('/home', ['~/code'])).toBe(true);
  });
});

describe('useExternalSessions', () => {
  it('reads the folders its computer allows, and none when the computer cannot say', async () => {
    const hook = await mount();
    expect(api.get).toHaveBeenCalledWith('/agents/external/agent-1/terminal-sessions');
    expect(hook().allowedFolders).toEqual(['/home/ana/code']);
    act(() => renderer?.unmount());
    renderer = null;
    api.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/terminal-sessions')) throw new Error('503');
      return { data: { folders: [] } };
    });
    expect((await mount())().allowedFolders).toEqual([]);
  });

  it('reads the recent folders of that agent', async () => {
    const hook = await mount();
    expect(api.get).toHaveBeenCalledWith('/agents/external/agent-1/folders');
    expect(hook().folders).toEqual(['/home/ana/app', '/home/ana/api']);
  });

  it('makes the conversation, registers its folder, and answers the conversation id', async () => {
    const hook = await mount();
    let id = '';
    await act(async () => {
      id = await hook().open('  ~/app ');
    });
    expect(id).toBe('conv-9');
    expect(api.createConversation).toHaveBeenCalledExactlyOnceWith({ agentId: 'agent-1' });
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/agents/external/agent-1/sessions', {
      conversationId: 'conv-9',
      cwd: '~/app',
    });
    // The folder is now a recent one: that list is read again.
    expect(api.get.mock.calls.filter(([url]) => String(url).endsWith('/folders'))).toHaveLength(2);
  });

  it('opens nothing for a path that is not absolute', async () => {
    const hook = await mount();
    await act(async () => {
      await expect(hook().open('app')).rejects.toThrow('invalid_folder');
    });
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('fails, rather than answering an id, when the folder cannot be registered', async () => {
    api.post.mockRejectedValue(new Error('conversation_in_use'));
    const hook = await mount();
    await act(async () => {
      await expect(hook().open('/home/ana/app')).rejects.toThrow('conversation_in_use');
    });
  });
});
