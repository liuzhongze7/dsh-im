# Group chat context

Open **Group chat context** on a Youdu bot card to choose whether the plugin caches recent group messages that did not mention the bot, and how many of them to keep, then **Save** to apply immediately. It is on by default with the latest 50 messages; set the limit to 0 or switch it off to stop caching. Neither action reconnects the bot or recreates sessions.

When enabled, group messages that did not address the bot are remembered in chat order; when someone mentions the bot, the plugin prepends them to the current message as a context block before handing it to the model:

```text
<dsh_im_group_history note="...">
[2026-09-10 14:12] 张三: 下午三点评审，谁去
[2026-09-10 14:13] 李四: 我去
</dsh_im_group_history>

[Current message - respond to this]
帮我整理一下
```

That batch is consumed when the turn ends, so it is never injected twice — those messages are already part of the current Harness Session. Group messages that arrive during the turn stay for the next one. The cache only applies to group chats: direct messages, commands, approvals, and question answers keep their existing control paths, and unmentioned group messages still never trigger a reply by themselves.

## Images and files

Images, files, voice notes, and videos posted without mentioning the bot are **downloaded through the same media interface used for message attachments** into a temporary directory inside that bot's workspace:

```text
<workspace>/.dsh-im/group-context/<group>/<20260910-141230-messageId>/01-photo.png
```

When the bot is mentioned, the history block is followed by an attachment manifest: **the manifest is rebuilt from disk on every injection**, listing this group's recent message attachments within the retention window (latest 10 by default, tunable through `groupContextRecentLimit`):

```text
<dsh_im_group_history note="...">
[2026-09-10 14:12] 张三: [图片] photo.png
</dsh_im_group_history>
<dsh_im_group_files>
{"description":"Attachments staged for this group from earlier messages; paths are relative to the current Harness workspace. Older attachments stay in the same directory and can be listed on demand.","directory":".dsh-im/group-context/{0798E01E-...}","files":[{"name":"photo.png","path":".dsh-im/group-context/.../01-photo.png","sender":"张三","time":"2026-09-10 14:12"}]}
</dsh_im_group_files>

[Current message - respond to this]
这张图什么意思
```

Because the manifest comes from disk rather than memory, it still works **after a plugin restart** (the text cache is empty but the files remain), **after an earlier turn already consumed a manifest**, and when a download is slower than the staging wait (the file shows up on the next mention). The block also tells the model that the directory exists, so it can list it, read the files, or move them wherever they are needed.

| Situation | Behavior |
| --- | --- |
| Download succeeded | History line plus a manifest with name, workspace-relative path, sender, and time |
| Download failed | The text placeholder stays and the reply is unaffected |
| Download slower than the wait | Missing from this turn's manifest, listed once it lands |
| Redelivered message | Downloaded only once |
| Group rejected by access rules, feature off, or limit 0 | Nothing is downloaded or written |
| Direct messages | Keep the existing inbound-file pipeline, unrelated to this cache |

Attachment count and size are not capped beyond the ordinary message limits. The files are temporary and age out by retention: seven days by default, configurable through the plugin's `groupContextRetentionHours` (`-1` keeps them forever, `0` deletes on the next sweep). Sweeping shares the staging path: every new attachment write also sweeps expired directories at most once per interval (six hours by default, `groupContextSweepIntervalMs`), so an idle bot defers the sweep until the next write.

## Boundaries and defaults

| Item | Behavior |
| --- | --- |
| When it applies | The switch is on and the limit is greater than 0; the limit ranges from 0 to 200 and defaults to 50. |
| What is cached | Only messages the group rules allow to reach the bot: the per-group rule, the shared group access settings, and the owner check, resolved exactly like an addressed message. Rejected groups and senders are never cached. |
| Per message | The body is truncated to 300 characters (marked with `…`) and folded into a single line. |
| Per injection | At most 4000 characters; the oldest entries are dropped first so the newest stay closest to the current message. |
| Storage | In-process memory, per conversation, cleared on plugin restart. Nothing is written to disk or to the settings file. |
| Redelivery | A platform redelivery of the same message is not cached twice. |

Group chat context only fills in "what happened in the group before the bot was woken". It does not replace Harness Session history and is unrelated to `/history`, which reads the Harness Session history bound to the current direct chat (at most 5 entries). It can be combined with **Context enhancement**; the injected order is the group context block, then the current message with its `<dsh_im_source>` block.

## Privacy

Cached group message bodies, sender display names, and timestamps are sent to the current model with the triggering message and stay in the current Harness Session history. Turning the feature off stops future caching and injection; it does not erase what is already in history. If a group carries content that should not reach the model, switch the feature off or stop the bot from receiving messages in that group.

Only the Youdu channel wires this feature today; the other channels keep their existing behavior.
