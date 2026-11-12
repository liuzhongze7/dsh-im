// English translations (youdu area). Keys are exact Chinese literals passed to t().
export default {
  '有度机器人凭据缺失，请移除后重新接入。':
    'The Youdu bot credentials are missing. Remove the bot and connect it again.',
  '有度机器人已接入，消息连接暂未就绪。':
    'The Youdu bot is connected, but the message connection is not ready yet.',
  '有度机器人已连接 DeepSeek Harness。': 'The Youdu bot is connected to DeepSeek Harness.',
  '有度机器人凭据被拒绝，请更新机器人密钥后重新连接。': 'The YouDu bot credentials were rejected. Update the bot secret and reconnect.',
  '有度群名「{name}」对应多个群：{candidates}。请改用群 ID。': 'The YouDu group name "{name}" matches several groups: {candidates}. Use the group ID instead.',
  '有度用户名「{name}」对应多个联系人：{candidates}。请改用用户 ID 或账号名。': 'The YouDu user name "{name}" matches several contacts: {candidates}. Use the user ID or account name instead.',
  '找不到有度的群「{name}」。请先让群里有消息，或直接填写群 ID。': 'YouDu group "{name}" is unknown. Let the group receive a message first, or enter the group ID.',
  '找不到有度的联系人「{name}」。请先让对方私聊机器人，或直接填写数字用户 ID。': 'YouDu contact "{name}" is unknown. Ask that person to message the bot first, or enter the numeric user ID.',
  '请填写有度投递目标：用户 ID、昵称、群 ID 或群名。': 'Enter a YouDu delivery target: user ID, nickname, group ID or group name.',
  '有度投递目标只支持私聊或群聊。': 'YouDu delivery targets support direct chats and groups only.',
  '有度机器人与 DeepSeek Harness 连接正常。':
    'The Youdu bot is connected to DeepSeek Harness and working normally.',
  '有度机器人尚未连接': 'The Youdu bot is not connected yet',
  '有度机器人尚未收到任何私聊，无法发送测试消息。':
    'The Youdu bot has not received any direct message yet, so a test message cannot be sent.',
  '有度 WebSocket 长连接运行正常': 'The Youdu WebSocket connection is healthy',
  '有度连接未就绪，插件会自动重试': 'The Youdu connection is not ready; the plugin retries automatically',
  '有度连接未就绪，插件会自动重试。': 'The Youdu connection is not ready; the plugin retries automatically.',
  '有度连接仍未就绪，请稍后重试。':
    'The Youdu connection is still not ready. Try again later.',
  '有度连接当前离线': 'The Youdu connection is currently offline',
  '有度交互问题发送失败。': 'Could not send the Youdu interaction question.',
  '结果文件「{name}」已生成，但暂时未能通过有度发送，请稍后重试。':
    'The result file "{name}" was generated but could not be sent through Youdu yet. Try again later.',
  '当前机器人未配置所有者，无法使用该命令。请在设置页配置 ownerUserId 后重试。':
    'This bot has no configured owner, so the command is unavailable.'
    + ' Set ownerUserId on the settings page and try again.',
  '有度机器人': 'Youdu bot',
};
