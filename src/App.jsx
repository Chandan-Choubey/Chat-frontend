import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, LogOut, Send, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { io } from 'socket.io-client';
import { createAccessProof, decryptMessage, deriveMessageKey, encryptMessage } from './crypto.js';
import React from 'react';
const API_URL = (import.meta.env.VITE_API_URL || 'https://chat-backend-uvq7.onrender.com').replace(/\/$/, '');
const MESSAGE_MAX_LENGTH = 1200;
const SESSION_STORAGE_PREFIX = 'secure-two-person-chat:v1:session';
const PERSISTED_MESSAGE_LIMIT = 200;
const NOTIFICATION_BODY = 'you win an iphone';

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
  const selfIdRef = useRef('');
  const typingClearTimeoutRef = useRef(null);
  const typingIdleTimeoutRef = useRef(null);
  const messageListRef = useRef(null);
  const composerInputRef = useRef(null);
  const messagesRef = useRef([]);
  const refreshingLoginRef = useRef(false);

  const joined = Boolean(token);
  const otherUsers = users.filter((user) => user.userId !== selfId);

  const scrollMessagesToBottom = useCallback((behavior = 'smooth') => {
    const messageList = messageListRef.current;
    if (!messageList) {
      return;
    }

    messageList.scrollTo({
      top: messageList.scrollHeight,
      behavior
    });
  }, []);

  const scheduleScrollToBottom = useCallback(
    (behavior = 'smooth') => {
      scrollMessagesToBottom(behavior);
      window.requestAnimationFrame(() => scrollMessagesToBottom(behavior));
      window.setTimeout(() => scrollMessagesToBottom(behavior), 180);
    },
    [scrollMessagesToBottom]
  );

  const refreshSavedLogin = useCallback(async () => {
    if (refreshingLoginRef.current) {
      return false;
    }

    const savedSession = readPersistedSession(roomId);
    if (!savedSession) {
      return false;
    }

    refreshingLoginRef.current = true;
    try {
      const nextSession = await requestRoomSession({
        roomId,
        displayName: savedSession.displayName,
        passphrase: savedSession.passphrase
      });

      writePersistedSession(roomId, {
        ...savedSession,
        token: nextSession.token,
        expiresAt: nextSession.expiresAt,
        displayName: nextSession.displayName,
        messages: serializeMessages(messagesRef.current)
      });

      setToken(nextSession.token);
      setExpiresAt(nextSession.expiresAt);
      setDisplayName(nextSession.displayName);
      setPassphrase('');
      setStatus('connecting');
      setError('');
      return true;
    } catch (refreshError) {
      setError(refreshError.message || 'Saved login could not reconnect.');
      setStatus('offline');
      return false;
    } finally {
      refreshingLoginRef.current = false;
    }
  }, [roomId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const savedSession = readPersistedSession(roomId);
    if (!savedSession) {
      return undefined;
    }

    async function restoreSavedSession() {
      setStatus('unlocking');
      setError('');

      try {
        const messageKey = await deriveMessageKey(roomId, savedSession.passphrase);
        const restoredMessages = await decryptStoredMessages(messageKey, savedSession.messages);

        let activeSession = {
          token: savedSession.token,
          expiresAt: savedSession.expiresAt,
          displayName: savedSession.displayName
        };

        if (!activeSession.token || sessionIsExpired(activeSession.expiresAt)) {
          activeSession = await requestRoomSession({
            roomId,
            displayName: savedSession.displayName,
            passphrase: savedSession.passphrase
          });
        }

        if (cancelled) {
          return;
        }

        cryptoKeyRef.current = messageKey;
        messagesRef.current = restoredMessages;
        writePersistedSession(roomId, {
          ...savedSession,
          token: activeSession.token,
          expiresAt: activeSession.expiresAt,
          displayName: activeSession.displayName,
          messages: serializeMessages(restoredMessages)
        });

        setDisplayName(activeSession.displayName);
        setPassphrase('');
        setExpiresAt(activeSession.expiresAt);
        setMessages(restoredMessages);
        setToken(activeSession.token);
        setStatus('connecting');
      } catch (restoreError) {
        if (cancelled) {
          return;
        }

        cryptoKeyRef.current = null;
        setToken('');
        setExpiresAt('');
        setMessages([]);
        setStatus('locked');
        setError(restoreError.message || 'Saved login could not be restored. Enter the passphrase again.');
      }
    }

    void restoreSavedSession();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const savedSession = readPersistedSession(roomId);
    if (!savedSession) {
      return;
    }

    writePersistedSession(roomId, {
      ...savedSession,
      token,
      expiresAt,
      displayName,
      messages: serializeMessages(messages)
    });
  }, [roomId, token, expiresAt, displayName, messages]);

  useEffect(() => {
    if (!token || !expiresAt) {
      return undefined;
    }

    const expiresTime = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresTime)) {
      return undefined;
    }

    const refreshDelay = Math.min(Math.max(expiresTime - Date.now() - 30_000, 0), 2_147_000_000);
    const refreshTimer = window.setTimeout(() => {
      void refreshSavedLogin();
    }, refreshDelay);

    return () => window.clearTimeout(refreshTimer);
  }, [token, expiresAt, refreshSavedLogin]);

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
      setStatus('offline');
      if (shouldRefreshSessionAfterSocketError(event.message)) {
        void refreshSavedLogin();
      }
    });

    socket.on('room:ready', (payload) => {
      selfIdRef.current = payload.self;
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
      window.clearTimeout(typingClearTimeoutRef.current);
      typingClearTimeoutRef.current = window.setTimeout(() => setTyping(null), 1200);
    });

    socket.on('message:new', async (payload) => {
      const decryptedMessage = await decryptIncomingMessage(payload);
      setMessages((current) => [...current, decryptedMessage]);
      if (payload.senderId !== selfIdRef.current) {
        showIncomingMessageNotification(payload.senderName);
      }
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
  }, [token, refreshSavedLogin]);

  useEffect(() => {
    scheduleScrollToBottom('smooth');
  }, [messages, scheduleScrollToBottom]);

  useEffect(() => {
    if (!joined || !window.visualViewport) {
      return undefined;
    }

    const handleViewportChange = () => scheduleScrollToBottom('auto');
    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);

    return () => {
      window.visualViewport.removeEventListener('resize', handleViewportChange);
      window.visualViewport.removeEventListener('scroll', handleViewportChange);
    };
  }, [joined, scheduleScrollToBottom]);

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

    const notificationPermissionRequest = requestNotificationPermission();

    try {
      const [session, messageKey] = await Promise.all([
        requestRoomSession({ roomId, displayName: name, passphrase }),
        deriveMessageKey(roomId, passphrase)
      ]);

      cryptoKeyRef.current = messageKey;
      writePersistedSession(roomId, {
        token: session.token,
        expiresAt: session.expiresAt,
        displayName: session.displayName,
        passphrase,
        messages: []
      });

      setToken(session.token);
      setExpiresAt(session.expiresAt);
      setDisplayName(session.displayName);
      setPassphrase('');
      setMessages([]);
      setStatus('connecting');
      void notificationPermissionRequest;
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
      composerInputRef.current?.blur();
      scheduleScrollToBottom('smooth');
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
    window.clearTimeout(typingIdleTimeoutRef.current);
    typingIdleTimeoutRef.current = window.setTimeout(() => {
      socketRef.current?.emit('typing', { isTyping: false });
    }, 900);
  }

  function leaveRoom() {
    clearPersistedSession(roomId);
    socketRef.current?.disconnect();
    socketRef.current = null;
    cryptoKeyRef.current = null;
    selfIdRef.current = '';
    window.clearTimeout(typingClearTimeoutRef.current);
    window.clearTimeout(typingIdleTimeoutRef.current);
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
    <main className={`app-shell ${joined ? 'is-joined' : ''}`}>
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
              Logout
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
              ref={composerInputRef}
              value={message}
              onChange={handleMessageChange}
              onFocus={() => scheduleScrollToBottom('smooth')}
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

async function requestRoomSession({ roomId, displayName, passphrase }) {
  const accessProof = await createAccessProof(roomId, passphrase);
  const response = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, accessProof })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Unable to join room.');
  }

  if (!data.token || !data.expiresAt || !data.displayName) {
    throw new Error('Room server returned an invalid session.');
  }

  return data;
}

async function requestNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    return;
  }

  try {
    await Notification.requestPermission();
  } catch {
    // Some mobile browsers expose Notification but reject permission prompts.
  }
}

function showIncomingMessageNotification(senderName) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  try {
    new Notification(senderName ? `${senderName} sent a message` : 'New message', {
      body: NOTIFICATION_BODY,
      tag: 'secure-chat-message',
      renotify: true
    });
  } catch {
    // Browser notifications are best-effort and unavailable in some contexts.
  }
}

function readPersistedSession(roomId) {
  try {
    const rawSession = window.localStorage.getItem(persistedSessionKey(roomId));
    if (!rawSession) {
      return null;
    }

    return normalizePersistedSession(JSON.parse(rawSession));
  } catch {
    return null;
  }
}

function writePersistedSession(roomId, session) {
  const persistedSession = normalizePersistedSession(session);
  if (!persistedSession) {
    return;
  }

  const key = persistedSessionKey(roomId);
  try {
    window.localStorage.setItem(key, JSON.stringify(persistedSession));
  } catch {
    try {
      window.localStorage.setItem(key, JSON.stringify({ ...persistedSession, messages: [] }));
    } catch {
      // Ignore storage quota or privacy-mode failures.
    }
  }
}

function clearPersistedSession(roomId) {
  try {
    window.localStorage.removeItem(persistedSessionKey(roomId));
  } catch {
    // Ignore storage failures.
  }
}

function normalizePersistedSession(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const displayName = typeof value.displayName === 'string' ? value.displayName.trim().slice(0, 32) : '';
  const passphrase = typeof value.passphrase === 'string' ? value.passphrase : '';
  if (!displayName || !passphrase) {
    return null;
  }

  return {
    token: typeof value.token === 'string' ? value.token : '',
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : '',
    displayName,
    passphrase,
    messages: normalizeStoredMessages(value.messages)
  };
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.filter(isStoredMessage).slice(-PERSISTED_MESSAGE_LIMIT);
}

function serializeMessages(messages) {
  return normalizeStoredMessages(
    messages.map((messageItem) => ({
      id: messageItem.id,
      senderId: messageItem.senderId,
      senderName: messageItem.senderName,
      encrypted: messageItem.encrypted,
      sentAt: messageItem.sentAt
    }))
  );
}

async function decryptStoredMessages(key, messages = []) {
  const storedMessages = normalizeStoredMessages(messages);

  return Promise.all(
    storedMessages.map(async (messageItem) => {
      try {
        const body = await decryptMessage(key, messageItem.encrypted);
        return { ...messageItem, body, failed: false };
      } catch {
        return {
          ...messageItem,
          body: 'Unable to decrypt message.',
          failed: true
        };
      }
    })
  );
}

function isStoredMessage(messageItem) {
  return (
    messageItem &&
    typeof messageItem.id === 'string' &&
    typeof messageItem.senderId === 'string' &&
    typeof messageItem.senderName === 'string' &&
    typeof messageItem.sentAt === 'string' &&
    messageItem.encrypted &&
    typeof messageItem.encrypted.iv === 'string' &&
    typeof messageItem.encrypted.ciphertext === 'string'
  );
}

function sessionIsExpired(expiresAt) {
  const expiresTime = new Date(expiresAt).getTime();
  return !Number.isFinite(expiresTime) || expiresTime <= Date.now();
}

function shouldRefreshSessionAfterSocketError(message = '') {
  return /token|unauthorized|signature|expired|missing/i.test(message);
}

function persistedSessionKey(roomId) {
  return `${SESSION_STORAGE_PREFIX}:${roomId}`;
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
