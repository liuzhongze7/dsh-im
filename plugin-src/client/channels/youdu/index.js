import * as React from 'react';

import { h } from '../../i18n.js';
import youduLogo from './youdu_logo.png';
import { CredentialActionIcon } from '../../credential-binding.js';
import {
  BotStatusMeta,
  ChannelListHeading,
  LastMessageErrorSummary,
} from '../../channel-card-meta.js';
import { WorkspaceEditor } from '../../workspace-editor.js';
import { AgentPresetEditor } from '../../agent-preset.js';
import { ContextEnhancementEditor } from '../../context-enhancement.js';
import { AccessPolicySettingsPage } from '../../access-policy-settings.js';
import { normalizeAccessPolicy } from '../../../../src/channels/shared/access-policy.mjs';
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

// 开放模式、命令默认关闭的编辑基线：当 bot 尚未配置访问策略时，用作编辑器初始值，
// 使页面可直接展开编辑（与服务端未配置时的闭合默认保持一致）。
const ACCESS_EDITOR_BASELINE = Object.freeze({
  direct: Object.freeze({
    mode: 'open',
    open: Object.freeze({ defaultCanExecuteCommands: false, commandPermissionOverrides: Object.freeze([]) }),
    allowlist: Object.freeze({ users: Object.freeze([]) }),
  }),
  group: Object.freeze({
    mode: 'open',
    open: Object.freeze({ defaultCanExecuteCommands: false, commandPermissionOverrides: Object.freeze([]) }),
    allowlist: Object.freeze({ users: Object.freeze([]) }),
  }),
});

function accessSceneSummary(sceneValue, sceneLabel) {
  const mode = sceneValue?.mode === 'allowlist' ? '白名单' : '开放';
  const users = sceneValue?.mode === 'allowlist'
    ? (sceneValue?.allowlist?.users ?? [])
    : (sceneValue?.open?.commandPermissionOverrides ?? []);
  const command = sceneValue?.mode === 'allowlist'
    ? (users.length === 0 ? '仅白名单用户可发消息' : `${users.length} 个白名单用户`)
    : (sceneValue?.open?.defaultCanExecuteCommands === false ? '命令默认关闭' : '命令默认开启');
  return `${sceneLabel}：${mode}（${command}）`;
}

function accessSummaryText(policy) {
  if (!policy) return '未配置（默认：开放模式，命令默认关闭）';
  return `${accessSceneSummary(policy.direct, '私聊')} | ${accessSceneSummary(policy.group, '群聊')}`;
}

function AccessPolicyInlineEditor({ account, rpcCall, onSaved, disabled }) {
  const [expanded, setExpanded] = React.useState(false);
  const policy = normalizeAccessPolicy(account?.accessPolicy);
  return h('div', { className: 'ydt-accessInline' },
    h('div', { className: 'ydt-accessInlineHead' },
      h('div', { className: 'ydt-accessInlineSummary' },
        h('span', { className: 'ydt-accessInlineLabel' }, '访问策略'),
        h('strong', null, accessSummaryText(policy))),
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton ydt-accessInlineToggle',
        disabled,
        'aria-expanded': expanded,
        onClick: () => setExpanded((value) => !value),
      }, expanded ? '收起' : '编辑')),
    expanded
      ? h('div', { className: 'ydt-accessInlineBody' },
          h(AccessPolicySettingsPage, {
            channel: 'youdu',
            account: { ...account, accessPolicy: policy ?? ACCESS_EDITOR_BASELINE },
            rpcCall,
            onSaved: (saved) => onSaved?.(saved),
          }))
      : null);
}

/**
 * 编辑既有接入的连接信息。botId 由接入时确定、不可修改；服务器地址与 secret 留空表示保持不变，
 * 便于在连接失败（地址/密钥填错）时直接修正，而不必删除后重新接入。
 */
function ConnectionEditor({ account, disabled, onSave, onCancel }) {
  const [host, setHost] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [owner, setOwner] = React.useState(account?.ownerUserId ?? '');
  const [error, setError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await onSave({
        sourceBotId: account.sourceBotId,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(host.trim() ? { wsHost: host.trim() } : {}),
        ownerUserId: owner.trim(),
      });
      onCancel?.();
    } catch (cause) {
      setError(presentError(cause));
    } finally {
      setSaving(false);
    }
  };
  const masked = account?.bot?.wsHostMasked ?? '已保存';
  return h('form', { className: 'ydt-connectionEditor', onSubmit: submit },
    field('机器人 botId（不可修改）', {
      value: account?.sourceBotId ?? '',
      readOnly: true,
      disabled: true,
    }),
    field('服务器地址', {
      value: host,
      onChange: (e) => setHost(e.target.value),
      placeholder: `留空表示不修改（当前 ${masked}）`,
      maxLength: 256,
    }),
    field('机器人 secret', {
      type: 'password',
      value: secret,
      onChange: (e) => setSecret(e.target.value),
      placeholder: '留空表示不修改',
      maxLength: 1024,
    }),
    field('允许的私聊用户 ID (可选)', {
      value: owner,
      onChange: (e) => setOwner(e.target.value),
      placeholder: '留空表示不限制（*）',
      maxLength: 128,
    }),
    error ? h('p', { className: 'dim-credentialError', role: 'alert' },
      error.message ?? String(error)) : null,
    h('div', { className: 'dim-credentialActions dim-viewActions' },
      h('button', {
        type: 'submit',
        className: 'ddt-button',
        'data-kind': 'primary',
        disabled: saving || disabled,
      }, saving ? '正在保存…' : '保存连接信息'),
      h('button', {
        type: 'button',
        className: 'ddt-button',
        onClick: onCancel,
        disabled: saving,
      }, '取消')));
}

function BrandMark() {
  return h('div', { className: 'ydt-brandMark', 'aria-hidden': 'true' },
    h('img', { src: youduLogo, alt: '', width: 64, height: 64 }));
}

function BotAvatar() {
  return h('div', { className: 'ydt-avatar dim-botAvatar', 'aria-hidden': 'true' },
    h('img', { src: youduLogo, alt: '', width: 34, height: 34 }));
}

function LoadingView() {
  return h('div', {
    className: 'dim-surfaceCard dim-loadingView',
    'aria-busy': 'true',
    'aria-label': '正在读取有度机器人列表',
  },
  h('div', { className: 'dim-spinner', 'aria-hidden': 'true' }),
  h('span', null, '正在读取有度连接状态…'));
}

function EmptyView({ onStart }) {
  return h('section', { className: 'dim-surfaceCard' },
    h('div', { className: 'ydt-empty dim-emptyView' },
      h('div', { className: 'ydt-emptyCopy dim-emptyCopy' },
        h('div', { className: 'dim-stateLabel' },
          h('span', { className: 'dim-stateDot' }),
          h('span', null, '尚未接入机器人')),
        h('h3', null, '接入第一个有度机器人'),
        h('p', null, '填写有度机器人服务器地址、botId 与密钥，即可把有度消息接入 DeepSeek Harness。'),
        h('div', { className: 'dim-viewActions' },
          h(Button, { kind: 'primary', onClick: onStart }, '手动接入机器人'))),
      h('div', { className: 'ydt-emptyBrand dim-emptyBrand', 'aria-hidden': 'true' }, h(BrandMark))));
}

function PageError({ error, onRetry }) {
  return h('section', { className: 'dim-surfaceCard' },
    h('div', { className: 'dim-inlineError', role: 'alert' },
      h('div', null,
        h('h3', null, '无法读取有度机器人'),
        h('p', null, error.message),
        error.code ? h('span', { className: 'dim-errorCode' }, error.code) : null,
        h('div', { className: 'dim-viewActions' },
          h(Button, { kind: 'primary', onClick: onRetry }, '重新读取')))));
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
  rpcCall,
  onReconnect,
  onWorkspaceSave,
  onAgentPresetSave,
  onContextEnhancementSave,
  onAccessPolicySaved,
  onConnectionSave,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}) {
  const [editingConnection, setEditingConnection] = React.useState(false);
  const tone = account.connected ? 'success' : account.state === 'error' ? 'error' : 'warning';
  const stateLabel = account.connected ? '运行正常' : account.state === 'connecting' ? '正在连接' : '连接未就绪';
  const summary = account.error?.message ?? (account.connected ? null : account.health.summary);
  const disabled = Boolean(busy);
  return h('article', { className: 'ddt-card dim-botCard', 'data-bot-id': account.botId },
    h('div', { className: 'ddt-cardBody dim-botCardBody' },
      h('div', { className: 'ddt-accountTop dim-botCardTop' },
        h('div', { className: 'ydt-accountIdentity dim-botIdentity' },
          h(BotAvatar),
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
          }))),
      h(AccessPolicyInlineEditor, {
        account,
        rpcCall,
        disabled,
        onSaved: onAccessPolicySaved,
      }),
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
      editingConnection
        ? h('div', { className: 'ydt-connectionPanel' },
            h('h4', { className: 'ydt-connectionTitle' }, '编辑连接信息'),
            h(ConnectionEditor, {
              account,
              disabled,
              onSave: (payload) => onConnectionSave?.(payload),
              onCancel: () => setEditingConnection(false),
            }))
        : null,
      h('div', { className: 'ddt-accountFooter dim-cardFooter' },
        h('div', { className: 'dim-cardFooterLayout' },
          h('div', { className: 'ddt-actions dim-cardActions' },
            h(Button, { className: 'dim-cardAction', onClick: onReconnect, disabled }, busy === 'reconnect' ? '检查中…' : account.connected ? '检查连接' : '重试连接'),
            h(Button, {
              className: 'dim-cardAction',
              onClick: () => setEditingConnection((value) => !value),
              disabled,
              'aria-expanded': editingConnection,
            }, editingConnection ? '收起编辑' : '编辑连接'),
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
  const [busyByBot, setBusyByBot] = React.useState({});
  const [feedbackByBot, setFeedbackByBot] = React.useState({});
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [credentialOpen, setCredentialOpen] = React.useState(false);
  const [credentialBusy, setCredentialBusy] = React.useState(false);
  const [credentialError, setCredentialError] = React.useState(null);
  const [pageError, setPageError] = React.useState(null);

  const [wsHost, setWsHost] = React.useState('');
  const [botId, setBotId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [ownerUserId, setOwnerUserId] = React.useState('');

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
      setPageError(null);
    } catch (cause) {
      if (silent) {
        setModel((current) => ({ ...current, statusError: presentError(cause) }));
      } else {
        setPageError(presentError(cause));
      }
    }
  }, [invoke]);

  React.useEffect(() => { void refresh({ silent: false }); }, [refresh]);

  // 每 15s 静默刷新，保证状态不过期。
  React.useEffect(() => {
    if (model.phase !== 'ready') return undefined;
    const timer = window.setInterval(async () => {
      await refresh({ silent: true });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [model.phase, refresh]);

  const bind = async (event) => {
    event.preventDefault();
    if (credentialBusy) return;
    setCredentialBusy(true);
    setCredentialError(null);
    setPageError(null);
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
    setPageError(null);
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
      setPageError(presentError(cause));
    }
  };

  const saveBotSetting = async (endpoint, bot, payload, label) => {
    setPageError(null);
    setBusyFor(bot.botId, label);
    try {
      const snapshot = normalizeSnapshot(await invoke(endpoint, {
        botId: bot.botId,
        ...payload,
      }));
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
      setFeedbackByBot((current) => ({ ...current, [bot.botId]: '已保存。' }));
    } catch (cause) {
      setPageError(presentError(cause));
    } finally {
      setBusyFor(bot.botId, false);
    }
  };

  const openCredential = () => {
    setCredentialOpen(true);
    setCredentialError(null);
  };

  const updateBotAccessPolicy = (botId, policy) => {
    setModel((current) => ({
      ...current,
      bots: current.bots.map((bot) => (bot.botId === botId ? { ...bot, accessPolicy: policy } : bot)),
    }));
    setFeedbackByBot((current) => ({ ...current, [botId]: '已保存。' }));
  };

  // 编辑既有接入的连接信息：地址/secret 留空表示不修改（host 侧 upsert 保持原值）。
  // 失败时抛出，由卡片内联表单展示错误，不整页报错。
  const saveConnection = async (bot, payload) => {
    setBusyFor(bot.botId, 'connection');
    try {
      const snapshot = normalizeSnapshot(await invoke(YOUDU_ENDPOINTS.attachBot, {
        botId: payload.sourceBotId,
        ...(payload.secret ? { secret: payload.secret } : {}),
        ...(payload.wsHost ? { wsHost: payload.wsHost } : {}),
        ownerUserId: payload.ownerUserId,
      }));
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
      setFeedbackByBot((current) => ({ ...current, [bot.botId]: '连接信息已保存。' }));
    } finally {
      setBusyFor(bot.botId, false);
    }
  };

  const content = model.phase === 'loading'
    ? h(LoadingView)
    : pageError
      ? h(PageError, { error: pageError, onRetry: () => refresh({ silent: false }) })
      : model.bots.length === 0
        ? h(EmptyView, { onStart: openCredential })
        : h('ul', { className: 'dim-botList', role: 'list' },
            model.bots.map((bot) => h('li', { key: bot.botId, className: 'dim-botCard dim-surfaceCard' },
              h(AccountCard, {
                account: bot,
                busy: busyByBot[bot.botId] ?? false,
                feedback: feedbackByBot[bot.botId],
                removing: removeTarget === bot.botId,
                rpcCall: invoke,
                onReconnect: () => runBotAction(YOUDU_ENDPOINTS.reconnectBot, bot),
                onWorkspaceSave: (workspace) => saveBotSetting(YOUDU_ENDPOINTS.setWorkspace, bot, { workspace }, 'workspace'),
                onAgentPresetSave: (agentPreset) => saveBotSetting(YOUDU_ENDPOINTS.setAgentPreset, bot, { agentPreset }, 'preset'),
                onContextEnhancementSave: (config) => saveBotSetting(YOUDU_ENDPOINTS.setContextEnhancement, bot, { config }, 'context'),
                onAccessPolicySaved: (policy) => updateBotAccessPolicy(bot.botId, policy),
                onConnectionSave: (payload) => saveConnection(bot, payload),
                onRequestRemove: () => setRemoveTarget(bot.botId),
                onConfirmRemove: () => runBotAction(YOUDU_ENDPOINTS.deleteBot, bot),
                onCancelRemove: () => setRemoveTarget(null),
              }))));

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
              placeholder: 'push.example.com',
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

    content);
}
