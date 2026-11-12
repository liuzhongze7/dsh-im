import * as React from 'react';

import {
  GROUP_HISTORY_LIMIT_MAX,
  GROUP_HISTORY_LIMIT_MIN,
  groupHistoryActive,
  normalizeGroupHistoryConfig,
  validateGroupHistoryConfig,
} from '../../src/channels/shared/group-history.mjs';
import { h } from './i18n.js';

const TITLE = '群聊上下文';
const SAVE_ERROR = '群聊上下文保存失败，请重试。';

const HELP_LABEL = '查看缓存条数说明';

// 说明文案与共享模块的边界、默认值保持一致（0 关闭、默认 50、上限 200）。
const HELP = Object.freeze({
  usage: '缓存群里没有 @ 机器人的最近消息，机器人被 @ 时把这些消息作为上下文一起交给模型。只作用于群聊。',
  limit: '0 表示不缓存；默认 50 条，可填 0 到 200 之间的整数。',
  storage: '缓存在内存中、重启即清空。',
  groupAccess: '被群访问规则拒绝的群不缓存。',
});

/** 触发按钮上的状态标签：开关开启且条数大于 0 才算生效。 */
export function groupHistoryLabel(config) {
  const normalized = normalizeGroupHistoryConfig(config);
  if (!groupHistoryActive(normalized)) return '未开启';
  return `开启 · 最近 ${normalized.limit} 条`;
}

/** 只接受非负整数字面量；空、小数、负数与非数字交给严格校验报错。 */
function parsedLimit(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/u.test(text) ? Number(text) : Number.NaN;
}

function GroupHistoryIcon({ kind = 'history' }) {
  const path = kind === 'close' ? 'M6 6l12 12M6 18 18 6'
    : kind === 'chevron' ? 'm9 5 7 7-7 7'
      : 'M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9M12 7.5V12l3.2 1.9';
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, h('path', { d: path }));
}

function GroupHistoryDialog({ config, disabled, onSave, onClose, returnFocusRef, id }) {
  // 已打开的弹窗持有自己的草稿；状态刷新不得覆盖未保存的编辑。
  const [draft, setDraft] = React.useState(() => {
    const normalized = normalizeGroupHistoryConfig(config);
    return { enabled: normalized.enabled, limit: String(normalized.limit) };
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const savingRef = React.useRef(false);
  const dialogRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const titleId = React.useId();
  const helpId = React.useId();
  const limitId = React.useId();
  const busy = disabled || saving;

  React.useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.focus?.();
    const keepFocus = (event) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target)) dialogRef.current.focus();
    };
    globalThis.document?.addEventListener?.('focusin', keepFocus);
    return () => {
      mountedRef.current = false;
      globalThis.document?.removeEventListener?.('focusin', keepFocus);
      queueMicrotask(() => returnFocusRef.current?.focus?.());
    };
  }, [returnFocusRef]);

  const change = (key, value) => {
    if (busy || savingRef.current) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const cancel = () => {
    if (!savingRef.current) onClose();
  };

  const save = async () => {
    if (busy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    dialogRef.current?.focus?.();
    try {
      const next = validateGroupHistoryConfig({
        enabled: draft.enabled,
        limit: parsedLimit(draft.limit),
      });
      await onSave(next);
      if (mountedRef.current) onClose();
    } catch (cause) {
      if (mountedRef.current) setError(cause?.message ?? SAVE_ERROR);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return h('div', {
    className: 'dim-contextBackdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget) cancel(); },
  }, h('section', {
    id,
    ref: dialogRef,
    className: 'dim-contextDialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': helpId,
    'aria-busy': saving,
    tabIndex: -1,
    onKeyDown: (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll?.(
        'button:not(:disabled), input:not(:disabled)',
      );
      if (!controls?.length) {
        event.preventDefault();
        dialogRef.current?.focus?.();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = globalThis.document?.activeElement;
      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === dialogRef.current)) {
        event.preventDefault();
        first.focus();
      }
    },
  },
  h('header', { className: 'dim-contextHeader' },
    h('div', { className: 'dim-contextHeaderTitle' },
      h('h3', { id: titleId }, TITLE)),
    h('button', {
      type: 'button', className: 'dim-contextClose', 'aria-label': '关闭弹窗',
      disabled: busy, onClick: cancel,
    }, h(GroupHistoryIcon, { kind: 'close' }))),
  h('fieldset', {
    className: 'dim-contextSection dim-contextScope',
    'aria-label': TITLE,
    disabled: busy,
  },
  h('label', { className: 'dim-contextSwitchRow' },
    h('span', { className: 'dim-contextSwitchLabel' }, h('span', null, '启用')),
    h('input', {
      type: 'checkbox', role: 'switch', className: 'dim-contextSwitch',
      checked: draft.enabled,
      disabled: busy,
      onChange: (event) => change('enabled', event.target.checked),
    })),
  h('div', { className: 'dim-contextScopeBlock' },
    h('div', { className: 'dim-contextEditorHeader' },
      h('span', { className: 'dim-contextEditorTitle' },
        h('label', { htmlFor: limitId }, '缓存条数'),
        h('span', { className: 'dim-contextHelp' },
          h('button', {
            type: 'button', className: 'dim-contextHelpButton', disabled: busy,
            'aria-label': HELP_LABEL, 'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', {
            id: helpId,
            className: 'dim-contextTooltip dim-contextGuidanceTooltip',
            role: 'tooltip',
          },
          h('strong', null, '使用说明'),
          h('span', null, HELP.usage),
          h('strong', null, '生效规则'),
          h('span', null, HELP.limit),
          h('strong', null, '缓存位置'),
          h('span', null, HELP.storage),
          h('strong', null, '群访问规则'),
          h('span', null, HELP.groupAccess))))),
    h('input', {
      id: limitId,
      className: 'dim-contextLimit',
      type: 'number',
      inputMode: 'numeric',
      min: GROUP_HISTORY_LIMIT_MIN,
      max: GROUP_HISTORY_LIMIT_MAX,
      step: 1,
      value: draft.limit,
      disabled: busy,
      'aria-describedby': helpId,
      onChange: (event) => change('limit', event.target.value),
    }))),
  error ? h('p', { className: 'dim-contextError', role: 'alert' }, error) : null,
  h('footer', { className: 'dim-contextFooter' },
    h('button', { type: 'button', disabled: busy, onClick: cancel }, '取消'),
    h('button', {
      type: 'button', className: 'dim-contextSave', disabled: busy,
      onClick: () => { void save(); },
    }, saving ? '正在保存…' : '保存'))));
}

export function GroupHistoryEditor({ config, disabled = false, onSave }) {
  const [open, setOpen] = React.useState(false);
  const entryRef = React.useRef(null);
  const dialogId = React.useId();
  const statusId = React.useId();
  const label = groupHistoryLabel(config);

  return h(React.Fragment, null,
    h('button', {
      type: 'button', ref: entryRef, className: 'dim-contextEntry', disabled,
      'aria-label': TITLE, 'aria-describedby': statusId,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined,
      onClick: () => setOpen(true),
    }, h(GroupHistoryIcon),
    h('span', { className: 'dim-contextLabel' }, TITLE),
    h('span', {
      id: statusId, className: 'dim-contextStatus',
      'data-active': label !== '未开启', 'aria-live': 'polite',
    }, label),
    h(GroupHistoryIcon, { kind: 'chevron' })),
    open ? h(GroupHistoryDialog, {
      id: dialogId, config, disabled, onSave,
      onClose: () => setOpen(false), returnFocusRef: entryRef,
    }) : null);
}
