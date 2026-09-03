import * as React from 'react';

import { h } from '../../i18n.js';
import { CredentialActionIcon } from '../../credential-binding.js';
import {
  BotSettingsButton,
  BotStatusMeta,
  ChannelListHeading,
  LastMessageErrorSummary,
} from '../../channel-card-meta.js';
import { WorkspaceEditor } from '../../workspace-editor.js';
import { AgentPresetEditor } from '../../agent-preset.js';
import { ContextEnhancementEditor } from '../../context-enhancement.js';
import {
  connectionTestFeedback,
  normalizeSnapshot,
  presentError,
  unwrapRpcResult,
  YOUDU_ENDPOINTS,
} from './api.js';

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

function checkedTime(value) {
  if (!value) return '尚未检查';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(value));
  } catch {
    return '刚刚';
  }
}

function accessModeLabel(account) {
  const policy = account.accessPolicy ?? {};
  const mode = policy.direct?.mode ?? 'open';
  const commands = policy.direct?.open?.defaultCanExecuteCommands === false
    ? '命令默认关闭'
    : '命令默认开启';
  return mode === 'allowlist' ? `白名单模式（${commands}）` : `开放模式（${commands}）`;
}

function RemoveConfirmation({ account, busy, onConfirm, onCancel }) {
  return h('div', { className: 'ddt-confirm dim-confirm', role: 'alertdialog' },
    h('strong', null, `从 DeepSeek Harness 移除“${account.bot.name}”？`),
    h('p', null, '这会停止消息连接，并删除本机保存的凭据、机器人配置及会话映射。有度平台中的机器人不会被自动删除。'),
    h('div', { className: 'ddt-actions dim-viewActions' },
      h(Button, { onClick: onCancel, disabled: busy }, '保留机器人'),
      h(Button, { kind: 'danger', onClick: onConfirm, disabled: busy }, busy ? '正在移除…' : '确认移除接入')));
}

function AccountCard({
  account,
  busy,
  feedback,
  removing,
  onReconnect,
  onWorkspaceSave,
  onAgentPresetSave,
  onContextEnhancementSave,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}) {
  const tone = account.connected ? 'success' : account.state === 'error' ? 'error' : 'warning';
  const stateLabel = account.connected ? '运行正常' : account.state === 'connecting' ? '正在连接' : '连接未就绪';
  const summary = account.error?.message ?? (account.connected ? null : account.health.summary);
  const disabled = Boolean(busy);
  return h('article', { className: 'ddt-card dim-botCard', 'data-bot-id': account.botId },
    h('div', { className: 'ddt-cardBody dim-botCardBody' },
      h('div', { className: 'ddt-accountTop dim-botCardTop' },
        h('div', { className: 'ddt-accountIdentity dim-botIdentity' },
          h('div', { className: 'dim-botName' },
            h('h3', null, account.bot.name),
            h('p', { title: account.bot.wsHostMasked }, account.bot.wsHostMasked ?? '服务器已安全保存'))),
        h('div', { className: 'dim-botCardTools' },
          h(BotStatusMeta, {
            className: 'ddt-health',
            dotClassName: 'ddt-dot',
            tone,
            stateLabel,
            lastCheckedAt: account.health.lastCheckedAt,
            formatCheckedTime: checkedTime,
          }),
          h(BotSettingsButton, {
            channel: 'youdu',
            botId: account.botId,
            botName: account.bot.name,
            connected: account.connected,
            accessPolicy: account.accessPolicy,
          }))),
      h('div', { className: 'dim-botAccessMode' },
        h('span', null, '访问模式'),
        h('strong', null, accessModeLabel(account))),
      h(WorkspaceEditor, {
        workspace: account.workspace,
        disabled,
        onSave: onWorkspaceSave,
      }),
      h(AgentPresetEditor, {
        agentPreset: account.agentPreset,
        disabled,
        onSave: onAgentPresetSave,
      }),
      h(ContextEnhancementEditor, {
        config: account.contextEnhancement,
        disabled,
        onSave: onContextEnhancementSave,
      }),
      h('div', { className: 'ddt-accountFooter dim-cardFooter' },
        h('div', { className: 'dim-cardFooterLayout' },
          h('div', { className: 'ddt-actions dim-cardActions' },
            h(Button, { className: 'dim-cardAction', onClick: onReconnect, disabled }, busy === 'reconnect' ? '检查中…' : account.connected ? '检查连接' : '重试连接'),
            h(Button, { className: 'dim-cardAction', kind: 'danger', onClick: onRequestRemove, disabled }, '移除接入')),
          summary ? h('div', { className: 'ddt-summary dim-cardSummary' }, summary) : null,
          account.lastMessageError ? h(LastMessageErrorSummary, {
            className: 'ddt-summary',
            error: account.lastMessageError,
          }) : null,
          feedback ? h('div', {
            className: 'ddt-summary dim-cardFeedback',
            role: 'status',
            'aria-live': 'polite',
          }, feedback) : null))),
    removing ? h(RemoveConfirmation, {
      account, busy: busy === 'delete', onConfirm: onConfirmRemove, onCancel: onCancelRemove,
    }) : null);
}

export function YouduSettingsTab({ rpcCall }) {
  const [model, setModel] = React.useState({
    phase: 'loading',
    revision: 0,
    bots: [],
    totals: { configured: 0, connected: 0 },
  });
  const [busy, setBusy] = React.useState(false);
  const [busyByBot, setBusyByBot] = React.useState({});
  const [feedbackByBot, setFeedbackByBot] = React.useState({});
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [credentialOpen, setCredentialOpen] = React.useState(false);
  const [credentialBusy, setCredentialBusy] = React.useState(false);
  const [credentialError, setCredentialError] = React.useState(null);

  const [wsHost, setWsHost] = React.useState('');
  const [botId, setBotId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [ownerUserId, setOwnerUserId] = React.useState('');

  const [error, setError] = React.useState(null);

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

  const setBusyFor = (botId, value) => {
    setBusyByBot((current) => ({ ...current, [botId]: value }));
  };

  const runBotAction = async (endpoint, bot, payload = {}) => {
    setError(null);
    const botIdValue = bot.botId;
    try {
      if (endpoint === YOUDU_ENDPOINTS.connectionTest) {
        const result = await invoke(endpoint, { botId: botIdValue });
        setFeedbackByBot((current) => ({ ...current, [botIdValue]: connectionTestFeedback(result) }));
      } else if (endpoint === YOUDU_ENDPOINTS.deleteBot) {
        await invoke(endpoint, { botId: botIdValue });
        setRemoveTarget(null);
        await refresh({ silent: true });
      } else if (endpoint === YOUDU_ENDPOINTS.reconnectBot) {
        await invoke(endpoint, { botId: botIdValue });
        await refresh({ silent: true });
      } else {
        const snapshot = normalizeSnapshot(await invoke(endpoint, {
          botId: botIdValue,
          ...payload,
        }));
        setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
      }
    } catch (cause) {
      setError(presentError(cause));
    }
  };

  const saveBotSetting = async (endpoint, bot, payload, label) => {
    setError(null);
    setBusyFor(bot.botId, label);
    try {
      const snapshot = normalizeSnapshot(await invoke(endpoint, {
        botId: bot.botId,
        ...payload,
      }));
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
      setFeedbackByBot((current) => ({ ...current, [bot.botId]: '已保存。' }));
    } catch (cause) {
      setError(presentError(cause));
    } finally {
      setBusyFor(bot.botId, false);
    }
  };

  const botList = model.bots.length === 0
    ? h('p', { className: 'dim-emptyCopy' }, '还没有接入任何有度机器人。')
    : h('ul', { className: 'dim-botList', role: 'list' },
        model.bots.map((bot) => (
          h('li', { key: bot.botId, className: 'dim-botCard dim-surfaceCard' },
            h(AccountCard, {
              account: bot,
              busy: busyByBot[bot.botId] ?? false,
              feedback: feedbackByBot[bot.botId],
              removing: removeTarget === bot.botId,
              onReconnect: () => runBotAction(YOUDU_ENDPOINTS.reconnectBot, bot),
              onWorkspaceSave: (workspace) => saveBotSetting(YOUDU_ENDPOINTS.setWorkspace, bot, { workspace }, 'workspace'),
              onAgentPresetSave: (agentPreset) => saveBotSetting(YOUDU_ENDPOINTS.setAgentPreset, bot, { agentPreset }, 'preset'),
              onContextEnhancementSave: (config) => saveBotSetting(YOUDU_ENDPOINTS.setContextEnhancement, bot, { config }, 'context'),
              onRequestRemove: () => setRemoveTarget(bot.botId),
              onConfirmRemove: () => runBotAction(YOUDU_ENDPOINTS.deleteBot, bot),
              onCancelRemove: () => setRemoveTarget(null),
            })))))

  return h('section', { className: 'dim-page', 'aria-label': '有度机器人设置' },
    h(ChannelListHeading, {
      className: 'ddt-channel',
      title: '有度机器人',
      connectionLabel: '有度机器人消息通道',
    }),
    h('div', { className: 'dim-bindActions' },
      h(Button, {
        kind: 'credential',
        size: 'small',
        className: 'dim-credentialButton',
        onClick: () => { setCredentialOpen((value) => !value); setCredentialError(null); },
        disabled: credentialBusy,
        'aria-pressed': credentialOpen,
        'aria-label': '手动接入有度机器人',
      }, h(CredentialActionIcon), credentialOpen ? '收起凭据' : '手动接入')),

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
    model.phase === 'loading' ? h('p', null, '正在读取连接状态…') : botList);
}
