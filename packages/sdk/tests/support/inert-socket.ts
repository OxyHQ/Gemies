import { vi } from 'vitest';

/**
 * No suite opens a real socket. `GemieRuntimeProvider` holds the account's realtime connection
 * (`src/realtime`) wherever a signed-in session is mocked, and a real Socket.IO client would dial
 * the test's fake API and keep reconnecting after the suite ended. This one connects nowhere;
 * `tests/realtime/connection.test.ts` replaces it with a fake it drives.
 */
vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = {
      connected: false,
      active: false,
      on: () => socket,
      off: () => socket,
      emit: () => socket,
      connect: () => socket,
      disconnect: () => socket,
      removeAllListeners: () => socket,
    };
    return socket;
  },
}));
