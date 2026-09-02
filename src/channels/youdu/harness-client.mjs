import { HarnessClient } from '../shared/harness-client.mjs';

export class YouduHarnessClient extends HarnessClient {
  constructor(options) {
    super({
      ...options,
      rpcIdPrefix: 'youdu',
      logPrefix: 'dsh-youdu',
    });
  }
}
