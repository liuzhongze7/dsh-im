export const YOUDU_STYLE_ID = 'xmanrui-dsh-im-youdu-settings';

const CSS = String.raw`
.dim-page, .ydt-* { --ddt-accent: #1f7bff; --ddt-accent-deep: #0f5bd6; --ddt-accent-wash: #e8f1ff; }
.ydt-brandMark {
  display: flex; align-items: center; justify-content: center;
  width: 96px; height: 96px; border-radius: 20px;
  background: linear-gradient(135deg, #e8f1ff 0%, #d4e4ff 100%);
}
.ydt-brandMark img { display: block; width: 56px; height: 56px; object-fit: contain; }
.ydt-empty { display: flex; gap: 28px; align-items: center; justify-content: space-between; }
.ydt-emptyCopy { flex: 1 1 auto; min-width: 0; }
.ydt-emptyBrand { flex-shrink: 0; }
.ydt-accountIdentity { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ydt-avatar {
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 10px;
  background: linear-gradient(135deg, #e8f1ff 0%, #d4e4ff 100%);
  overflow: hidden;
}
.ydt-avatar img { display: block; width: 26px; height: 26px; object-fit: contain; }
.ydt-accessMode {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 0; margin-bottom: 8px;
}
.ydt-accessMode span { opacity: 0.65; font-size: 13px; }
.ydt-accessMode strong { font-weight: 600; }
.ydt-accessInline {
  border: 1px solid var(--dim-border, rgba(0,0,0,0.08));
  border-radius: 12px;
  background: var(--dim-surface-raised, #fff);
  padding: 12px 14px;
  margin: 4px 0 12px;
}
.ydt-accessInlineHead {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.ydt-accessInlineSummary { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ydt-accessInlineLabel { opacity: 0.65; font-size: 12px; }
.ydt-accessInlineSummary strong { font-size: 13px; font-weight: 600; line-height: 1.35; word-break: break-word; }
.ydt-accessInlineToggle {
  flex-shrink: 0; white-space: nowrap;
}
.ydt-accessInlineBody {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--dim-border, rgba(0,0,0,0.08));
}
.ydt-connectionPanel {
  border: 1px solid var(--dim-border, rgba(0,0,0,0.08));
  border-radius: 12px;
  background: var(--dim-surface-raised, #fff);
  padding: 12px 14px;
  margin: 4px 0 12px;
}
.ydt-connectionTitle { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.ydt-connectionEditor { display: grid; gap: 10px; }
.ydt-connectionEditor input[readonly] { opacity: 0.65; }
.ydt-groupAccess { display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dim-border, rgba(0,0,0,0.08)); }
.ydt-groupAccessHint { margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.7; }
.ydt-groupAccessList { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.ydt-groupAccessRow {
  display: grid; grid-template-columns: minmax(0, 1.4fr) 150px minmax(0, 1fr) auto;
  align-items: center; gap: 8px;
}
.ydt-groupAccessId { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ydt-groupAccessId code { font-size: 12px; word-break: break-all; }
.ydt-groupAccessMeta { font-size: 11px; opacity: 0.65; }
.ydt-groupAccessMode, .ydt-groupAccessUsers {
  min-width: 0; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dim-border, rgba(0,0,0,0.12));
  background: var(--dim-surface, #fff); color: inherit; font: inherit; font-size: 12px;
}
.ydt-groupAccessAdd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
@media (max-width: 720px) {
  .ydt-groupAccessRow { grid-template-columns: minmax(0, 1fr); }
}
`;

export function installYouduStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${YOUDU_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = YOUDU_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
