import * as React from 'react';

import { h } from '../../i18n.js';
import youduLogo from './youdu-logo.js';
import { CredentialActionIcon } from '../../credential-binding.js';
import {
  BotStatusMeta,
  ChannelListHeading,
  LastMessageErrorSummary,
} from '../../channel-card-meta.js';
import { WorkspaceEditor } from '../../workspace-editor.js';
import { AgentPresetEditor } from '../../agent-preset.js';
import { ContextEnhancementEditor } from '../../context-enhancement.js';
import { GroupHistoryEditor } from '../../group-history.js';
import { AccessPolicySettingsPage } from '../../access-policy-settings.js';
import { normalizeAccessPolicy } from '../../../../src/channels/shared/access-policy.mjs';
import {
  emptyGroupAccess,
  normalizeGroupAccess,
  resolveGroupAccessRule,
  validateGroupAccess,
} from '../../../../src/channels/youdu/group-access.mjs';
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
  const direct = accessSceneSummary(policy.direct, '私聊');
  const group = accessSceneSummary(policy.group, '群聊');
  return `${direct} | ${group}`;
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
            // AccessPolicySettingsPage 自己调用 unwrapRpcResult，必须传未拆包的 rpcCall。
            rpcCall,
            onSaved: (saved) => onSaved?.(saved),
          }))
      : null);
}

/**
 * 按群访问设置：为具体群配置“谁能聊”（对齐 openclaw 的 groups[chatId].allowFrom）。
 * 未配置的群沿用上面的群聊访问设置，因此默认行为与之前完全一致。
 */
const GROUP_ACCESS_MODE_OPTIONS = Object.freeze([
  { value: 'inherit', label: '沿用群聊访问设置' },
  { value: 'open', label: '允许所有人' },
  { value: 'allowlist', label: '仅名单内用户' },
  { value: 'disabled', label: '忽略该群' },
]);

const GROUP_ACCESS_MODE_LABELS = Object.freeze(Object.fromEntries(
  GROUP_ACCESS_MODE_OPTIONS.map((option) => [option.value, option.label]),
));

function groupAccessRows(account) {
  const document = normalizeGroupAccess(account?.groupAccess) ?? emptyGroupAccess();
  const rows = [];
  const seen = new Set();
  for (const group of Array.isArray(account?.knownGroups) ? account.knownGroups : []) {
    const chatId = typeof group?.chatId === 'string' ? group.chatId : '';
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    const rule = resolveGroupAccessRule(document, chatId);
    rows.push({
      chatId,
      name: typeof group?.name === 'string' ? group.name.trim() : '',
      observed: true,
      lastSeenAt: typeof group.lastSeenAt === 'number' ? group.lastSeenAt : null,
      messages: Number.isSafeInteger(group.messages) ? group.messages : 0,
      mode: rule?.mode ?? 'inherit',
      users: (rule?.users ?? []).join(', '),
    });
  }
  for (const [chatId, rule] of Object.entries(document.groups)) {
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    rows.push({
      chatId,
      name: '',
      observed: false,
      lastSeenAt: null,
      messages: 0,
      mode: rule.mode,
      users: (rule.users ?? []).join(', '),
    });
  }
  return rows;
}

function groupAccessSummary(account) {
  const document = normalizeGroupAccess(account?.groupAccess);
  const entries = document ? Object.entries(document.groups) : [];
  if (entries.length === 0) return '未按群配置（所有群沿用群聊访问设置）';
  const counts = { open: 0, allowlist: 0, disabled: 0, inherit: 0 };
  for (const [, rule] of entries) counts[rule.mode] = (counts[rule.mode] ?? 0) + 1;
  const parts = [];
  if (counts.allowlist) parts.push(`${counts.allowlist} 个群仅名单内用户`);
  if (counts.open) parts.push(`${counts.open} 个群允许所有人`);
  if (counts.disabled) parts.push(`${counts.disabled} 个群被忽略`);
  return parts.length > 0 ? parts.join('，') : '未按群配置（所有群沿用群聊访问设置）';
}

function GroupAccessEditor({ account, rpcCall, onSaved, disabled }) {
  const [expanded, setExpanded] = React.useState(false);
  const [rows, setRows] = React.useState(() => groupAccessRows(account));
  const [manual, setManual] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const accountKey = `${account?.botId ?? ''}:${JSON.stringify(account?.groupAccess ?? null)}:${(account?.knownGroups ?? []).length}`;

  React.useEffect(() => {
    setRows(groupAccessRows(account));
  }, [accountKey]);

  const patchRow = (chatId, patch) => {
    setRows((current) => current.map((row) => (row.chatId === chatId ? { ...row, ...patch } : row)));
    setFeedback(null);
  };

  const addManual = () => {
    const chatId = manual.trim();
    if (!chatId) return;
    setRows((current) => (current.some((row) => row.chatId === chatId)
      ? current
      : [...current, {
        chatId, name: '', observed: false, lastSeenAt: null, messages: 0, mode: 'allowlist', users: '',
      }]));
    setManual('');
    setFeedback(null);
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setFeedback(null);
    setSaving(true);
    try {
      const groups = {};
      for (const row of rows) {
        const chatId = row.chatId.trim();
        if (!chatId || row.mode === 'inherit') continue;
        const users = row.mode === 'allowlist'
          ? row.users.split(/[,，、\s]+/u).map((value) => value.trim()).filter(Boolean)
          : [];
        groups[chatId] = row.mode === 'allowlist' ? { mode: 'allowlist', users } : { mode: row.mode };
      }
      const document = validateGroupAccess({ version: 1, groups });
      if (typeof rpcCall !== 'function') throw new Error('按群访问设置暂不可用。');
      const snapshot = normalizeSnapshot(await rpcCall(YOUDU_ENDPOINTS.setGroupAccess, {
        botId: account.botId,
        groupAccess: Object.keys(groups).length > 0 ? document : null,
      }));
      onSaved?.(snapshot);
      setFeedback({ tone: 'success', message: '按群访问设置已保存。' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error?.message || '按群访问设置保存失败，请稍后重试。',
      });
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'ydt-accessInline' },
    h('div', { className: 'ydt-accessInlineHead' },
      h('div', { className: 'ydt-accessInlineSummary' },
        h('span', { className: 'ydt-accessInlineLabel' }, '按群访问'),
        h('strong', null, groupAccessSummary(account))),
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton ydt-accessInlineToggle',
        disabled,
        'aria-expanded': expanded,
        onClick: () => setExpanded((value) => !value),
      }, expanded ? '收起' : '编辑')),
    expanded
      ? h('form', { className: 'ydt-groupAccess', onSubmit: (event) => void save(event) },
          h('p', { className: 'ydt-groupAccessHint' },
            '为具体群指定谁能与机器人对话。未单独配置的群沿用上面的「群聊」访问设置；'
            + '「仅名单内用户」可填有度用户 ID（数字）或账号名（如 zhangsan），用逗号分隔。'),
          rows.length === 0
            ? h('p', { className: 'ydt-groupAccessHint' },
                '机器人还没有收到过群消息，暂时无法列出群；可以在下面手动填群 ID。')
            : h('ul', { className: 'ydt-groupAccessList', role: 'list' },
                rows.map((row) => h('li', { key: row.chatId, className: 'ydt-groupAccessRow' },
                  h('div', { className: 'ydt-groupAccessId' },
                    row.name
                      ? h('span', { className: 'ydt-groupAccessName' }, row.name)
                      : null,
                    h('code', { title: row.chatId }, row.chatId),
                    h('span', { className: 'ydt-groupAccessMeta' },
                      row.observed
                        ? `${row.messages} 条消息`
                          + (row.lastSeenAt ? ' · 最近 ' + checkedTime(row.lastSeenAt) : '')
                        : '手动添加')),
                  h('select', {
                    className: 'ydt-groupAccessMode',
                    value: row.mode,
                    disabled: saving || disabled,
                    onChange: (event) => patchRow(row.chatId, { mode: event.target.value }),
                  }, GROUP_ACCESS_MODE_OPTIONS.map((option) => h('option', {
                    key: option.value,
                    value: option.value,
                  }, option.label))),
                  row.mode === 'allowlist'
                    ? h('input', {
                        className: 'ydt-groupAccessUsers',
                        value: row.users,
                        disabled: saving || disabled,
                        placeholder: '用户 ID 或账号名，逗号分隔',
                        autoCapitalize: 'none',
                        autoCorrect: 'off',
                        spellCheck: false,
                        onChange: (event) => patchRow(row.chatId, { users: event.target.value }),
                      })
                    : h('span', { className: 'ydt-groupAccessMeta' },
                        GROUP_ACCESS_MODE_LABELS[row.mode] ?? ''),
                  row.observed
                    ? null
                    : h('button', {
                        type: 'button',
                        className: 'dim-deliveryButton',
                        disabled: saving,
                        onClick: () => setRows((current) => current.filter((item) => item.chatId !== row.chatId)),
                      }, '删除')))),
          h('div', { className: 'ydt-groupAccessAdd' },
            h('input', {
              className: 'ydt-groupAccessUsers',
              value: manual,
              disabled: saving || disabled,
              placeholder: '群 ID，例如 {0798E01E-...}',
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
              onChange: (event) => setManual(event.target.value),
            }),
            h(Button, { onClick: addManual, disabled: saving || disabled || !manual.trim() }, '添加群')),
          feedback
            ? h('div', {
                className: 'ddt-summary dim-cardFeedback',
                role: 'status',
                'aria-live': 'polite',
              }, feedback.message)
            : null,
          h('div', { className: 'dim-viewActions' },
            h(Button, { kind: 'primary', onClick: (event) => void save(event), disabled: saving || disabled },
              saving ? '正在保存…' : '保存按群设置')))
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
  rawRpcCall,
  onReconnect,
  onWorkspaceSave,
  onAgentPresetSave,
  onContextEnhancementSave,
  onGroupHistorySave,
  onAccessPolicySaved,
  onGroupAccessSaved,
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
        rpcCall: rawRpcCall ?? rpcCall,
        disabled,
        onSaved: onAccessPolicySaved,
      }),
      h(GroupAccessEditor, {
        account,
        rpcCall,
        disabled,
        onSaved: onGroupAccessSaved,
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
      h(GroupHistoryEditor, {
        config: account.groupHistory,
        disabled,
        onSave: onGroupHistorySave,
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
    pageError: null,
    statusError: null,
  });
  const [busyByBot, setBusyByBot] = React.useState({});
  const [feedbackByBot, setFeedbackByBot] = React.useState({});
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [credentialOpen, setCredentialOpen] = React.useState(false);
  const [credentialBusy, setCredentialBusy] = React.useState(false);
  const [credentialError, setCredentialError] = React.useState(null);
  const mounted = React.useRef(true);

  React.useEffect(() => () => { mounted.current = false; }, []);

  const [wsHost, setWsHost] = React.useState('');
  const [botId, setBotId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [ownerUserId, setOwnerUserId] = React.useState('');

  const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
    return unwrapRpcResult(await rpcCall(endpoint, payload, signal));
  }, [rpcCall]);

  // 读取状态加超时：Host 重启后旧页面的 RPC 通道可能已经断开，没有超时会一直转圈。
  const statusWithTimeout = React.useCallback(async (signal, timeoutMs = 20_000) => {
    let timer;
    try {
      return await Promise.race([
        invoke(YOUDU_ENDPOINTS.status, {}, signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('读取有度连接状态超时，请刷新页面后重试。');
            error.code = 'youdu-status-timeout';
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, [invoke]);

  const refresh = React.useCallback(async ({ silent = true, signal } = {}) => {
    if (!silent) setModel((current) => ({ ...current, phase: 'loading', pageError: null }));
    try {
      const snapshot = normalizeSnapshot(await statusWithTimeout(signal));
      if (!mounted.current || signal?.aborted) return;
      setModel((current) => ({
        ...current,
        phase: 'ready',
        revision: snapshot.revision,
        bots: snapshot.bots,
        totals: snapshot.totals,
        pageError: null,
        statusError: null,
      }));
    } catch (cause) {
      // 卸载 / 定时器清理导致的中止不算失败，也不要写状态。
      if (!mounted.current || signal?.aborted || cause?.name === 'AbortError') return;
      const presented = presentError(cause);
      // 首屏加载或显式重试失败 → 整页错误视图（带「重新读取」）；
      // 后台静默刷新失败 → 保留已有列表，只在顶部给一条可重试的提示。
      setModel((current) => (current.phase === 'loading' || !silent
        ? { ...current, phase: 'error', pageError: presented, statusError: null }
        : { ...current, statusError: presented }));
    }
  }, [statusWithTimeout]);

  React.useEffect(() => {
    const controller = new AbortController();
    void refresh({ silent: false, signal: controller.signal });
    return () => controller.abort();
  }, [refresh]);

  // 每 15s 静默刷新，保证状态不过期；组件卸载时连同在途请求一起中止。
  React.useEffect(() => {
    if (model.phase !== 'ready') return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void refresh({ silent: true, signal: controller.signal });
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [model.phase, refresh]);

  const bind = async (event) => {
    event.preventDefault();
    if (credentialBusy) return;
    setCredentialBusy(true);
    setCredentialError(null);
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
      // 单个机器人的操作失败只在这张卡片内联提示，不把整页打成错误视图。
      setFeedbackByBot((current) => ({
        ...current,
        [botIdValue]: `操作失败：${presentError(cause).message}`,
      }));
    }
  };

  const saveBotSetting = async (endpoint, bot, payload, label) => {
    setBusyFor(bot.botId, label);
    try {
      const snapshot = normalizeSnapshot(await invoke(endpoint, {
        botId: bot.botId,
        ...payload,
      }));
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready', statusError: null }));
      setFeedbackByBot((current) => ({ ...current, [bot.botId]: '已保存。' }));
    } catch (cause) {
      setFeedbackByBot((current) => ({
        ...current,
        [bot.botId]: `保存失败：${presentError(cause).message}`,
      }));
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

  const updateBotGroupAccess = (botId, snapshot) => {
    if (snapshot) {
      setModel((current) => ({ ...current, ...snapshot, phase: 'ready' }));
    }
    setFeedbackByBot((current) => ({ ...current, [botId]: '按群访问设置已保存。' }));
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
    : model.phase === 'error'
      ? h(PageError, {
          error: model.pageError ?? { message: '无法读取连接状态' },
          onRetry: () => refresh({ silent: false }),
        })
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
                rawRpcCall: rpcCall,
                onReconnect: () => runBotAction(YOUDU_ENDPOINTS.reconnectBot, bot),
                onWorkspaceSave: (workspace) => saveBotSetting(YOUDU_ENDPOINTS.setWorkspace, bot, { workspace }, 'workspace'),
                onAgentPresetSave: (agentPreset) => saveBotSetting(YOUDU_ENDPOINTS.setAgentPreset, bot, { agentPreset }, 'preset'),
                onContextEnhancementSave: (config) => saveBotSetting(YOUDU_ENDPOINTS.setContextEnhancement, bot, { config }, 'context'),
                onGroupHistorySave: (config) => saveBotSetting(YOUDU_ENDPOINTS.setGroupHistory, bot, { config }, 'context'),
                onAccessPolicySaved: (policy) => updateBotAccessPolicy(bot.botId, policy),
                onGroupAccessSaved: (snapshot) => updateBotGroupAccess(bot.botId, snapshot),
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

    model.statusError && model.phase === 'ready'
      ? h('div', { className: 'dim-statusNotice', role: 'alert' },
          h('span', null, `状态刷新失败：${model.statusError.message}`),
          h(Button, { size: 'small', onClick: () => refresh({ silent: true }) }, '立即重试'))
      : null,

    content);
}
