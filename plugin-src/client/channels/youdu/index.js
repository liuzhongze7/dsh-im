import * as React from 'react';

import { h } from '../../i18n.js';
import { CredentialActionIcon } from '../../credential-binding.js';
import {
  connectionTestFeedback,
  normalizeSnapshot,
  presentError,
  unwrapRpcResult,
  YOUDU_ENDPOINTS,
} from './api.js';

// 参考飞书「手动接入」的样式：使用共享 dim-* / ddt-* 类。
const Button = React.forwardRef(function Button(
  { children, kind = 'secondary', size, className = '', ...props },
  ref,
) {
  return h('button', {
    ...props,
    ref,
    type: 'button',
    className: `ddt-button ${className}`.trim(),
    'data-kind': kind,
    'data-size': size,
  }, h('span', null, children));
});

function field(labelText, inputProps, extra) {
  return h('label', { className: 'dim-credentialField' },
    h('span', null, labelText),
    h('input', {
      autoCapitalize: 'none',
      autoCorrect: 'off',
      spellCheck: false,
      autoComplete: 'off',
      ...inputProps,
    }),
    extra ?? null);
}

export function YouduSettingsTab({ rpcCall }) {
  const [model, setModel] = React.useState({
    phase: 'loading',
    revision: 0,
    bots: [],
    totals: { configured: 0, connected: 0 },
  });
  const [credentialOpen, setCredentialOpen] = React.useState(false);
  const [credentialBusy, setCredentialBusy] = React.useState(false);
  const [credentialError, setCredentialError] = React.useState(null);

  const [wsHost, setWsHost] = React.useState('');
  const [botId, setBotId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [ownerUserId, setOwnerUserId] = React.useState('');

  const [error, setError] = React.useState(null);
  const [testNotice, setTestNotice] = React.useState(null);

  const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
    return unwrapRpcResult(await rpcCall(endpoint, payload, signal));
  }, [rpcCall]);

  const refresh = React.useCallback(async ({ silent = true } = {}) => {
    if (!silent) setModel((current) => ({ ...current, phase: 'loading' }));
    try {
      const snapshot = normalizeSnapshot(await invoke(YOUDU_ENDPOINTS.status));
      setModel((current) => ({
        ...current,
        phase: 'ready',
        revision: snapshot.revision,
        bots: snapshot.bots,
        totals: snapshot.totals,
      }));
      setError(null);
    } catch (cause) {
      setError(presentError(cause));
    }
  }, [invoke]);

  React.useEffect(() => { void refresh({ silent: false }); }, [refresh]);

  const bind = async (event) => {
    event.preventDefault();
    if (credentialBusy) return;
    setCredentialBusy(true);
    setCredentialError(null);
    setError(null);
    try {
      const snapshot = normalizeSnapshot(await invoke(YOUDU_ENDPOINTS.attachBot, {
        wsHost,
        botId,
        secret,
        ownerUserId: ownerUserId || undefined,
      }));
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
      setCredentialOpen(false);
      setSecret('');
    } catch (cause) {
      setCredentialError(presentError(cause));
    } finally {
      setCredentialBusy(false);
    }
  };

  const runBotAction = async (endpoint, bot) => {
    setError(null);
    setTestNotice(null);
    try {
      if (endpoint === YOUDU_ENDPOINTS.connectionTest) {
        const result = await invoke(endpoint, { botId: bot.botId });
        setTestNotice(connectionTestFeedback(result));
      } else {
        const snapshot = normalizeSnapshot(await invoke(endpoint, { botId: bot.botId }));
        setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
        if (endpoint === YOUDU_ENDPOINTS.deleteBot) {
          setTestNotice(null);
          await refresh({ silent: true });
        }
      }
    } catch (cause) {
      setError(presentError(cause));
    }
  };

  const botList = model.bots.length === 0
    ? h('p', { className: 'dim-emptyCopy' }, '还没有接入任何有度机器人。')
    : h('ul', { className: 'dim-botList', role: 'list' },
        model.bots.map((bot) => h('li', { key: bot.botId, className: 'dim-botCard dim-surfaceCard' },
          h('div', { className: 'dim-botIdentity' },
            h('div', { className: 'dim-botName' },
              h('h3', null, bot.bot.name),
              h('p', { title: bot.bot.wsHostMasked }, bot.bot.wsHostMasked ?? '服务器已安全保存')),
            h('span', { className: 'dim-healthPill', 'data-tone': bot.connected ? 'success' : bot.state === 'connecting' ? 'warning' : 'error' },
              bot.state === 'connected' ? '连接正常' : bot.state === 'connecting' ? '连接中' : bot.state === 'error' ? '异常' : '离线')),
          bot.error ? h('div', { className: 'dim-inlineError', role: 'alert' }, bot.error.message) : null,
          bot.lastMessageError ? h('div', { className: 'dim-inlineError', role: 'alert' }, bot.lastMessageError.message) : null,
          h('div', { className: 'dim-cardActions' },
            h(Button, { onClick: () => runBotAction(YOUDU_ENDPOINTS.connectionTest, bot) }, '检查连接'),
            h(Button, { onClick: () => runBotAction(YOUDU_ENDPOINTS.reconnectBot, bot) }, '重连'),
            h(Button, { kind: 'danger', onClick: () => runBotAction(YOUDU_ENDPOINTS.deleteBot, bot) }, '移除接入')),
        )));

  return h('section', { className: 'dim-page', 'aria-label': '有度机器人设置' },
    h('div', { className: 'dim-bindActions' },
      h(Button, {
        kind: 'credential',
        size: 'small',
        className: 'dim-credentialButton',
        onClick: () => { setCredentialOpen((value) => !value); setCredentialError(null); },
        disabled: credentialBusy,
        'aria-pressed': credentialOpen,
        'aria-label': '手动接入有度机器人',
      }, credentialOpen ? '收起凭据' : '手动接入')),

    credentialOpen
      ? h('section', { className: 'dim-surfaceCard dim-credentialPanel' },
          h('h3', { className: 'dim-credentialTitle' }, '手动接入有度机器人'),
          h('form', { className: 'dim-credentialForm', onSubmit: bind },
            field('服务器地址', {
              value: wsHost,
              onChange: (e) => setWsHost(e.target.value),
              placeholder: 'internal.cindacode.com',
              maxLength: 256,
            }),
            field('机器人 botId', {
              value: botId,
              onChange: (e) => setBotId(e.target.value),
              placeholder: '有度机器人 ID',
              maxLength: 128,
            }),
            field('机器人 secret', {
              type: 'password',
              value: secret,
              onChange: (e) => setSecret(e.target.value),
              placeholder: '机器人密钥',
              maxLength: 1024,
            }),
            field('允许的私聊用户 ID (可选)', {
              value: ownerUserId,
              onChange: (e) => setOwnerUserId(e.target.value),
              placeholder: '或留空为 *',
              maxLength: 128,
            }),
            credentialError ? h('p', { className: 'dim-credentialError', role: 'alert' },
              credentialError.message ?? String(credentialError)) : null,
            h('div', { className: 'dim-credentialActions dim-viewActions' },
              h('button', {
                type: 'submit',
                className: 'ddt-button',
                'data-kind': 'primary',
                disabled: credentialBusy || !wsHost.trim() || !botId.trim() || !secret.trim(),
              }, credentialBusy ? '正在接入…' : '接入机器人'),
              h('button', {
                type: 'button',
                className: 'ddt-button',
                onClick: () => { setCredentialOpen(false); setCredentialError(null); },
                disabled: credentialBusy,
              }, '取消'))))
      : null,

    error ? h('div', { className: 'dim-inlineError', role: 'alert' }, error.message) : null,
    testNotice ? h('div', { className: 'dim-cardFeedback', role: 'status' }, testNotice) : null,
    model.phase === 'loading' ? h('p', null, '正在读取连接状态…') : botList);
}
