import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { PoolStateResponse } from './components/Pool/types';
import {
  parsePushClientMessage,
  type PushClientMessage,
} from './lib/pool-push-protocol';

/**
 * WebSocket push server for the pool-state indexer.
 *
 * Browsers open a socket and send:
 *   { "type": "subscribe", "pools": ["<base58>", ...] }
 * After every indexer sample pass the indexer calls broadcast() with the
 * fresh state; only clients subscribed to that pool receive it.
 *
 * No auth is enforced: pool state is public. The `verifyClient` option is
 * the seam for adding auth later (e.g. check a signed token against the
 * HTTP upgrade request); when it rejects, the socket is closed with 4401.
 */
export type PushClientVerifier = (
  req: IncomingMessage,
) => boolean | Promise<boolean>;

export interface PoolStateBroadcasterOptions {
  verifyClient?: PushClientVerifier;
  /** Called with server errors (e.g. EADDRINUSE); unset errors are swallowed. */
  onError?: (err: Error) => void;
}

export class PoolStateBroadcaster {
  private readonly wss: WebSocketServer;
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private readonly verifyClient?: PushClientVerifier;

  constructor(port: number, options: PoolStateBroadcasterOptions = {}) {
    this.verifyClient = options.verifyClient;
    const onError = options.onError;
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      void this.handleConnection(ws, req);
    });
    this.wss.on('error', (err: Error) => {
      if (onError) {
        try {
          onError(err);
        } catch {
          /* never let logging break the indexer */
        }
      }
    });
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    if (this.verifyClient) {
      let ok = false;
      try {
        ok = await this.verifyClient(req);
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          ws.close(4401, 'unauthorized');
        } catch {
          /* ignore */
        }
        return;
      }
    }
    this.subscriptions.set(ws, new Set());
    ws.on('message', (data: unknown) => {
      const msg = parsePushClientMessage(String(data));
      if (!msg) return; // malformed frames are ignored, never fatal
      this.applySubscription(ws, msg);
    });
    const drop = () => {
      this.subscriptions.delete(ws);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  private applySubscription(ws: WebSocket, msg: PushClientMessage): void {
    const set = this.subscriptions.get(ws);
    if (!set) return;
    if (msg.type === 'subscribe') {
      for (const p of msg.pools) set.add(p);
    } else {
      for (const p of msg.pools) set.delete(p);
    }
  }

  /**
   * Send a fresh state to every client subscribed to this pool.
   * Never throws: a broken socket is dropped on its next close event.
   */
  broadcast(poolAddress: string, state: PoolStateResponse): void {
    let payload: string;
    try {
      payload = JSON.stringify({ type: 'pool-state', poolAddress, state });
    } catch {
      return;
    }
    for (const [ws, pools] of this.subscriptions) {
      if (!pools.has(poolAddress) || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        /* drop on next close */
      }
    }
  }

  /** Number of currently connected clients (for logging/tests). */
  get connectionCount(): number {
    return this.subscriptions.size;
  }

  /** Close all client sockets and the listening server. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.subscriptions.keys()) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      this.subscriptions.clear();
      this.wss.close(() => resolve());
    });
  }
}
