import { validateGroupHistoryConfig } from '../../../../src/channels/shared/group-history.mjs';

export const SET_GROUP_HISTORY_ENDPOINT = 'bot.group-history.set';

export function validGroupHistoryPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Reflect.ownKeys(payload).length !== 2
      || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'config')
      || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    validateGroupHistoryConfig(payload.config);
    return true;
  } catch {
    return false;
  }
}
