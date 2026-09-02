import * as React from 'react';

import {
  connectionTestFeedback,
  normalizeSnapshot,
  presentError,
  unwrapRpcResult,
  YOUDU_ENDPOINTS,
} from './api.js';

const h = React.createElement;

function button(textValue, className, onClick, disabled) {
  return h('button', {
    type: 'button',
    className,
    onClick,
    disabled: disabled || undefined,
  }, textValue);
}

export function YouduSettingsTab({ rpcCall }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [testMessage, setTestMessage] = React.useState(null);

  const [botId, setBotId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [wsHost, setWsHost] = React.useState('');
  const [ownerUserId, setOwnerUserId] = React.useState('');

  const refresh = React.useCallback(async () => {
    try {
      const value = unwrapRpcResult(await rpcCall(YOUDU_ENDPOINTS.status));
      setSnapshot(normalizeSnapshot(value));
      setError(null);
    } catch (err) {
      setError(presentError(err));
    } finally {
      setLoading(false);
    }
  }, [rpcCall]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const attach = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const value = unwrapRpcResult(await rpcCall(YOUDU_ENDPOINTS.attachBot, {
        botId,
        secret,
        wsHost,
        ownerUserId: ownerUserId || undefined,
      }));
      setSnapshot(normalizeSnapshot(value));
      setSecret('');
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  };

  const runBotAction = async (endpoint, bot) => {
    setBusy(true);
    setError(null);
    try {
      if (endpoint === YOUDU_ENDPOINTS.connectionTest) {
        const result = unwrapRpcResult(await rpcCall(endpoint, { botId: bot.botId }));
        setTestMessage(connectionTestFeedback(result));
      } else {
        const value = unwrapRpcResult(await rpcCall(endpoint, { botId: bot.botId }));
        setSnapshot(normalizeSnapshot(value));
        if (endpoint === YOUDU_ENDPOINTS.deleteBot) {
          setTestMessage(null);
          await refresh();
        }
      }
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  };

  const attachForm = h('form', { className: 'youdu-attach', onSubmit: attach },
    h('h3', null, '接入有度机器人'),
    h('fieldset', { disabled: busy },
      h('label', null, h('span', null, '服务器地址'), h('input', {
        type: 'text', value: wsHost, placeholder: 'push.example.com 或 host:7443',
        onChange: (e) => setWsHost(e.target.value),
      })),
      h('label', null, h('span', null, '机器人 botId'), h('input', {
        type: 'text', value: botId, placeholder: '有度机器人 ID',
        onChange: (e) => setBotId(e.target.value),
      })),
      h('label', null, h('span', null, '机器人 secret'), h('input', {
        type: 'password', value: secret, placeholder: '机器人密钥',
        onChange: (e) => setSecret(e.target.value),
      })),
      h('label', null, h('span', null, '允许的私聊用户 ID (可选)'), h('input', {
        type: 'text', value: ownerUserId, placeholder: '或留空为 *',
        onChange: (e) => setOwnerUserId(e.target.value),
      })),
      button('接入', 'youdu-primary', undefined, busy),
    ));

  const botList = React.useMemo(() => {
    const bots = snapshot?.bots ?? [];
    if (bots.length === 0) return h('p', { className: 'youdu-empty' }, '还没有接入任何有度机器人。');
    return h('ul', { className: 'youdu-bots' }, bots.map((bot) => h('li', { key: bot.botId, className: `youdu-bot youdu-bot-${bot.state}` },
      h('div', { className: 'youdu-botHead' },
        h('strong', null, bot.bot.name),
        h('span', { className: 'youdu-botHost' }, bot.bot.wsHostMasked),
        h('span', { className: 'youdu-botState' }, bot.state === 'connected' ? '连接正常' : bot.state === 'connecting' ? '连接中' : bot.state === 'error' ? '异常' : '离线')),
      h('div', { className: 'youdu-botHealth' }, bot.health.summary),
      bot.error ? h('div', { className: 'youdu-botError' }, bot.error.message) : null,
      bot.lastMessageError ? h('div', { className: 'youdu-botError' }, bot.lastMessageError.message) : null,
      h('div', { className: 'youdu-botActions' },
        button('检查连接', 'youdu-action', () => runBotAction(YOUDU_ENDPOINTS.connectionTest, bot), busy),
        button('重连', 'youdu-action', () => runBotAction(YOUDU_ENDPOINTS.reconnectBot, bot), busy),
        button('移除', 'youdu-action youdu-danger', () => runBotAction(YOUDU_ENDPOINTS.deleteBot, bot), busy)),
    )));
  }, [snapshot, busy]);

  return h('section', { className: 'youdu-settings' },
    h('header', { className: 'youdu-head' },
      h('h2', null, '有度'),
      h('p', null, '通过 WebSocket 长连接把有度机器人接入 DeepSeek Harness。')),
    error ? h('div', { className: 'youdu-error' }, error.message) : null,
    testMessage ? h('div', { className: 'youdu-test' }, testMessage) : null,
    loading ? h('p', null, '加载中…') : botList,
    attachForm);
}
