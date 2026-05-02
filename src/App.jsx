import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, LogOut, Send, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { io } from 'socket.io-client';
import { createAccessProof, decryptMessage, deriveMessageKey, encryptMessage } from './crypto.js';
import React from 'react';
const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const MESSAGE_MAX_LENGTH = 1200;

export default function App() {
  const roomId = useMemo(getRoomIdFromPath, []);
  const [displayName, setDisplayName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [selfId, setSelfId] = useState('');
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [typing, setTyping] = useState(null);
  const [status, setStatus] = useState('locked');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const socketRef = useRef(null);
  const cryptoKeyRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const messageListRef = useRef(null);

  const joined = Boolean(token);
  const otherUsers = users.filter((user) => user.userId !== selfId);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 4
    });

    socketRef.current = socket;
    setStatus('connecting');

    socket.on('connect', () => {
      setStatus('connected');
      setError('');
    });

    socket.on('connect_error', (event) => {
      setError(event.message || 'Unable to connect.');
      leaveRoom();
    });

    socket.on('room:ready', (payload) => {
      setSelfId(payload.self);
      setUsers(payload.users || []);
      setStatus('connected');
    });

    socket.on('room:presence', (payload) => {
      setUsers(payload.users || []);
    });

    socket.on('typing', (payload) => {
      if (!payload.isTyping) {
        setTyping(null);
        return;
      }

      setTyping(payload);
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = window.setTimeout(() => setTyping(null), 1200);
    });

    socket.on('message:new', async (payload) => {
      const decryptedMessage = await decryptIncomingMessage(payload);
      setMessages((current) => [...current, decryptedMessage]);
    });

    socket.on('message:error', (payload) => {
      setError(payload.error || 'Message was rejected.');
    });

    socket.on('disconnect', () => {
      setStatus('offline');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: 'smooth'
    });
  }, [messages]);

  async function handleJoin(event) {
    event.preventDefault();
    setError('');
    setStatus('unlocking');

    const name = displayName.trim();
    if (!name || !passphrase) {
      setError('Display name and passphrase are required.');
      setStatus('locked');
      return;
    }

    try {
      const [accessProof, messageKey] = await Promise.all([
        createAccessProof(roomId, passphrase),
        deriveMessageKey(roomId, passphrase)
      ]);

      const response = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(roomId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name, accessProof })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Unable to join room.');
      }

      cryptoKeyRef.current = messageKey;
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      setDisplayName(data.displayName);
      setPassphrase('');
      setMessages([]);
      setStatus('connecting');
    } catch (joinError) {
      cryptoKeyRef.current = null;
      setError(joinError.message || 'Unable to join room.');
      setStatus('locked');
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !socketRef.current || !cryptoKeyRef.current || sending) {
      return;
    }

    setSending(true);
    setError('');

    try {
      const encrypted = await encryptMessage(cryptoKeyRef.current, text);
      socketRef.current.emit('message:send', { encrypted });
      socketRef.current.emit('typing', { isTyping: false });
      setMessage('');
      setTyping(null);
    } catch {
      setError('Unable to encrypt this message.');
    } finally {
      setSending(false);
    }
  }

  function handleMessageChange(event) {
    const nextMessage = event.target.value.slice(0, MESSAGE_MAX_LENGTH);
    setMessage(nextMessage);

    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit('typing', { isTyping: nextMessage.trim().length > 0 });
    window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socketRef.current?.emit('typing', { isTyping: false });
    }, 900);
  }

  function leaveRoom() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    cryptoKeyRef.current = null;
    setToken('');
    setExpiresAt('');
    setSelfId('');
    setUsers([]);
    setMessages([]);
    setMessage('');
    setTyping(null);
    setStatus('locked');
  }

  async function decryptIncomingMessage(payload) {
    try {
      const body = await decryptMessage(cryptoKeyRef.current, payload.encrypted);
      return { ...payload, body, failed: false };
    } catch {
      return {
        ...payload,
        body: 'Unable to decrypt message.',
        failed: true
      };
    }
  }

  return (
    <main className="app-shell">
      <aside className="room-panel" aria-label="Room access">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <div>
            <p className="eyebrow">Secure room</p>
            <h1>Two-person chat</h1>
          </div>
        </div>

        <div className="room-meta">
          <span className="meta-label">Route</span>
          <span className="room-code">/chat/{roomId}</span>
        </div>

        {!joined ? (
          <form className="join-form" onSubmit={handleJoin}>
            <label>
              <span>Display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value.slice(0, 32))}
                autoComplete="name"
                maxLength={32}
                placeholder="Your name"
              />
            </label>

            <label>
              <span>Passphrase</span>
              <input
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="current-password"
                type="password"
                placeholder="Room passphrase"
              />
            </label>

            <button className="primary-button" type="submit" disabled={status === 'unlocking'}>
              <Lock size={18} />
              {status === 'unlocking' ? 'Opening room' : 'Enter room'}
            </button>
          </form>
        ) : (
          <div className="session-panel">
            <div className="status-line">
              <span className={`status-dot ${status}`} />
              <span>{statusLabel(status)}</span>
            </div>
            <div className="expiry">Token expires {formatTime(expiresAt)}</div>
            <button className="secondary-button" type="button" onClick={leaveRoom}>
              <LogOut size={18} />
              Leave
            </button>
          </div>
        )}

        {error ? <p className="error-text">{error}</p> : null}

        <div className="participants-block">
          <div className="section-title">
            <UsersRound size={18} />
            <span>Participants</span>
          </div>
          <div className="participant-list">
            {users.length === 0 ? (
              <p className="muted">No active participants</p>
            ) : (
              users.map((user) => (
                <div className="participant" key={user.userId}>
                  <UserRound size={16} />
                  <span>{user.displayName}</span>
                  {user.userId === selfId ? <strong>You</strong> : null}
                </div>
              ))
            )}
          </div>
        </div>
      </aside>

      <section className="chat-panel" aria-label="Chat messages">
        <header className="chat-header">
          <div>
            <p className="eyebrow">End-to-end encrypted</p>
            <h2>{otherUsers.length > 0 ? otherUsers.map((user) => user.displayName).join(', ') : 'Private room'}</h2>
          </div>
          <div className="seat-count">{users.length}/2</div>
        </header>

        <div className="messages" ref={messageListRef}>
          {joined ? (
            messages.length > 0 ? (
              messages.map((item) => (
                <article
                  className={`message ${item.senderId === selfId ? 'mine' : 'theirs'} ${item.failed ? 'failed' : ''}`}
                  key={item.id}
                >
                  <div className="message-topline">
                    <span>{item.senderId === selfId ? 'You' : item.senderName}</span>
                    <time dateTime={item.sentAt}>{formatTime(item.sentAt)}</time>
                  </div>
                  <p>{item.body}</p>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <Lock size={28} />
                <p>Room opened. Messages appear here.</p>
              </div>
            )
          ) : (
            <div className="empty-state">
              <Lock size={28} />
              <p>Enter the passphrase to open this room.</p>
            </div>
          )}
        </div>

        <footer className="composer-block">
          <div className="typing-line">
            {typing && typing.userId !== selfId ? `${typing.displayName} is typing` : '\u00a0'}
          </div>
          <form className="composer" onSubmit={handleSend}>
            <textarea
              value={message}
              onChange={handleMessageChange}
              disabled={!joined || status !== 'connected'}
              maxLength={MESSAGE_MAX_LENGTH}
              rows={2}
              placeholder={joined ? 'Write a message' : 'Room locked'}
            />
            <button
              className="send-button"
              type="submit"
              disabled={!joined || !message.trim() || status !== 'connected' || sending}
              title="Send message"
              aria-label="Send message"
            >
              <Send size={20} />
            </button>
          </form>
        </footer>
      </section>
    </main>
  );
}

function getRoomIdFromPath() {
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments[0] === 'chat' && segments[1]) {
    return decodeURIComponent(segments[1]);
  }

  return 'private-room';
}

function statusLabel(status) {
  const labels = {
    locked: 'Locked',
    unlocking: 'Opening',
    connecting: 'Connecting',
    connected: 'Connected',
    offline: 'Offline'
  };

  return labels[status] || status;
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

