import { readFile, rename } from 'node:fs/promises';
import { validateAgentPresetId } from '../shared/agent-preset.mjs';
import { normalizeAccessPolicy } from '../shared/access-policy.mjs';
import { validateBotAlias } from '../shared/bot-alias.mjs';
import { validateContextEnhancementConfig } from '../shared/context-enhancement.mjs';
import { normalizeGroupHistoryConfig } from '../shared/group-history.mjs';
import { normalizeModelSelection } from '../shared/model-setting.mjs';
import { normalizeGroupAccess } from './group-access.mjs';

function storedAlias(value) {
  try {
    return validateBotAlias(value);
  } catch {
    return '';
  }
}

function storedContextEnhancement(value) {
  try {
    return value ? validateContextEnhancementConfig(value) : null;
  } catch {
    return null;
  }
}

/**
 * 把旧版 YouduSettingsStore（`bots/settings.json`）里的每 bot 设置迁到共享
 * BotWorkspaceStore 与按群设置存储，成功后把旧文件改名为 `.migrated`。
 *
 * 旧文件不存在时返回 false；文件存在但损坏时直接抛错——静默丢设置比启动失败
 * 更难排查，宁可让用户看到明确的迁移错误。
 */
export async function migrateLegacyYouduSettings({
  legacyPath,
  workspaces,
  groups,
  defaultAgentPreset = null,
}) {
  let document;
  try {
    document = JSON.parse(await readFile(legacyPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const bots = document?.bots;
  if (document?.version !== 1 || !bots || typeof bots !== 'object' || Array.isArray(bots)) {
    return false;
  }
  for (const [botId, value] of Object.entries(bots)) {
    if (!botId || !value || typeof value !== 'object') continue;
    const agentPreset = validateAgentPresetId(value.agentPreset ?? defaultAgentPreset);
    const accessPolicy = normalizeAccessPolicy(value.accessPolicy);
    await workspaces.ensure(botId, {
      ...(typeof value.workspace === 'string' ? { workspace: value.workspace } : {}),
      defaultAgentPreset: agentPreset,
      ...(accessPolicy ? { initialAccessPolicy: accessPolicy } : {}),
    });
    const model = normalizeModelSelection(value.model);
    if (model) await workspaces.setModel(botId, model);
    const alias = storedAlias(value.alias);
    if (alias) await workspaces.setAlias(botId, alias);
    const contextEnhancement = storedContextEnhancement(value.contextEnhancement);
    if (contextEnhancement) await workspaces.setContextEnhancement(botId, contextEnhancement);
    const groupAccess = normalizeGroupAccess(value.groupAccess);
    if (groupAccess) await groups.setGroupAccess(botId, groupAccess);
    if (value.groupHistory) {
      await groups.setGroupHistory(botId, normalizeGroupHistoryConfig(value.groupHistory));
    }
  }
  await rename(legacyPath, `${legacyPath}.migrated`);
  return true;
}

/**
 * 把旧版 YouduDeliveryStore（`bots/delivery.json`）里的投递目标搬进共享
 * BotWorkspaceStore，成功后把旧文件改名为 `.migrated`。
 *
 * 目标形态与共享 store 一致（`{name, kind, route, sessionSync?}`），因此逐条
 * createDeliveryTarget + setDeliveryTargetSessionSync 即可；bot 不存在时跳过。
 */
export async function migrateLegacyYouduDeliveryTargets({ legacyPath, workspaces, knownBotIds = [] }) {
  let document;
  try {
    document = JSON.parse(await readFile(legacyPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const bots = document?.bots;
  if (!bots || typeof bots !== 'object' || Array.isArray(bots)) return false;
  // 有 bot 还不在 config 里（用户暂时删掉、以后再接入）时保留旧文件：
  // 一旦改名，这些目标就再也迁不回来了。重复迁移是安全的（冲突只忽略）。
  const deferred = Object.keys(bots).some((botId) => !knownBotIds.includes(botId));
  for (const [botId, targets] of Object.entries(bots)) {
    if (!knownBotIds.includes(botId)) continue;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) continue;
    for (const [targetId, target] of Object.entries(targets)) {
      if (!target || typeof target !== 'object') continue;
      try {
        await workspaces.createDeliveryTarget(botId, {
          targetId,
          name: target.name,
          kind: target.kind,
          route: target.route,
        });
      } catch (error) {
        // 已存在的目标（重复迁移）不阻断其余条目。
        if (error?.code !== 'target-conflict') throw error;
      }
      const conversationKey = target.sessionSync?.conversationKey;
      if (typeof conversationKey === 'string' && conversationKey) {
        await workspaces.setDeliveryTargetSessionSync(botId, targetId, conversationKey);
      }
    }
  }
  if (deferred) return false;
  await rename(legacyPath, `${legacyPath}.migrated`);
  return true;
}
