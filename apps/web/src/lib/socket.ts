import type { ClientMessage, ServerMessage } from '@harv/shared';

// The one WebSocket to the Harv server. Stores subscribe to the messages they care about.
type MessageListener = (msg: ServerMessage) => void;
type ConnectionListener = (connected: boolean) => void;

const messageListeners = new Set<MessageListener>();
const connectionListeners = new Set<ConnectionListener>();
let socket: WebSocket | null = null;
let started = false;

/** Returns a function that stops listening (components unsubscribe when they unmount). */
export function onServerMessage(listener: MessageListener): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export function onConnectionChange(listener: ConnectionListener): void {
  connectionListeners.add(listener);
}

/** Returns false when not connected, so callers can tell the user. */
export function sendMessage(msg: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** Fires with the close code each time the connection drops . */
const closeListeners = new Set<(code: number) => void>();
export function onSocketClosed(listener: (code: number) => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

export function startSocket(): void {
  if (started) return;
  started = true;
  let delay = 500;

  const connect = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.onopen = () => {
      delay = 500;
      connectionListeners.forEach((l) => l(true));
    };
    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch (err) {
        console.error('harv: a message that isn’t JSON', err);
        return;
      }
      // One store that throws must not keep the message from the rest (the full review, U16).
      messageListeners.forEach((l) => {
        try {
          l(msg);
        } catch (err) {
          console.error(`harv: a listener failed on ${msg.type}`, err);
        }
      });
    };
    socket.onclose = (event) => {
      connectionListeners.forEach((l) => l(false));
      closeListeners.forEach((l) => l(event.code));
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();
}
