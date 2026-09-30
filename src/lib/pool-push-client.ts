import {
  buildSubscribeFrame,
  computePushReconnectDelay,
  parsePushServerMessage,
} from './pool-push-protocol';
import type { PoolStateResponse } from '@/components/Pool/types';

/**
 * Minimal structural surface of the browser WebSocket that the push client
 * uses. Tests inject a fake; production passes the real WebSocket.
 */
export interface PushSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface PoolPushClientEvents {
  /** Fires on connect and on every disconnect, including stop(). */
  onConnectionChange(connected: boolean): void;
  /** Fires for each pool-state frame addressed to this client's pool. */
  onState(state: PoolStateResponse): void;
}

function defaultCreateSocket(url: string): PushSocketLike {
  // The DOM WebSocket handler types are narrower than the structural
  // interface; the runtime shape is what the client relies on.
  return new WebSocket(url) as unknown as PushSocketLike;
}

/**
 * One subscription socket for one pool, with reconnect backoff.
 *
 * Framework-free so it is unit-testable in node: the socket factory and
 * the reconnect-delay function are injectable. The React hook
 * (usePoolStatePush) is thin glue over this plus react-query.
 */
export class PoolPushClient {
  private socket: PushSocketLike | null = null;
  private closed = true;
  private connected = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly poolAddress: string,
    private readonly events: PoolPushClientEvents,
    private readonly createSocket: (url: string) => PushSocketLike = defaultCreateSocket,
    private readonly reconnectDelay: (attempt: number) => number = computePushReconnectDelay,
  ) {}

  /** Opens the socket. No-op if already started. */
  start(): void {
    if (!this.closed) return;
    this.closed = false;
    this.connect();
  }

  /** Closes the socket and cancels any pending reconnect. Idempotent. */
  stop(): void {
    if (this.closed && this.socket === null && this.reconnectTimer === null) return;
    this.closed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.setConnected(false);
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }

  private setConnected(value: boolean): void {
    if (value === this.connected) return;
    this.connected = value;
    this.events.onConnectionChange(value);
  }

  private connect(): void {
    if (this.closed) return;
    let socket: PushSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.onDown();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.attempt = 0;
      this.setConnected(true);
      try {
        socket.send(buildSubscribeFrame([this.poolAddress]));
      } catch {
        // A send failure surfaces as close/error, which reconnects.
      }
    };
    socket.onmessage = (ev) => {
      if (this.closed || this.socket !== socket) return;
      const msg = parsePushServerMessage(String(ev.data));
      if (!msg || msg.poolAddress !== this.poolAddress) return;
      this.events.onState(msg.state);
    };
    const down = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onDown();
    };
    // Browsers fire error and then close for the same failure; `down`
    // tolerates both because the first call clears this.socket.
    socket.onclose = down;
    socket.onerror = down;
  }

  private onDown(): void {
    if (this.closed) return;
    this.setConnected(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
