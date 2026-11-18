# 监工（dsh-monitor）

## 它做什么

在每个 agent step（一次工具调用结束、下一次思考开始之前）拿**规则清单**检查当前会话，命中就在下一个动作前注入一句话：

```
【监工·红线】A4：调用已经 8 次，还没有 _tmp\进度-<今天>.md，先建。
```

注入走 `agent/pre-step` + 带 `source` 的用户消息，界面上显示为折叠的「上下文注入 · monitor」，**不进用户交流区**。不命中时不注入、不加 token。

## 规则清单在哪

`<插件目录>\rules\monitor-rules.json`（默认路径，可在插件配置里改 `rulesPath`）。

**改这个文件即可增删改规则，插件每步比对 mtime，变了立即重载——不用重装、不用重启。**

## 规则怎么写

```json
{
  "id": "A4",
  "sev": 1,
  "when": { "all": [
    { "fact": "calls.total", "op": ">=", "value": 8 },
    { "fact": "progress.exists", "op": "==", "value": false }
  ]},
  "say": "A4：调用已经 8 次，还没有进度文件，先建。"
}
```

- `sev`：0/1 红线、2 提醒、3 提示。**同一时刻只报一条**，按 `sev` 小者优先，同级按 id 排序。
- `when` 支持 `all` / `any` / `not` 嵌套。
- `op` 支持 `== != >= <= > < contains matches notMatches`。

### 可用事实（fact）

| 事实 | 含义 |
|---|---|
| `calls.total` | 本会话工具调用总数 |
| `calls.byTool.<工具名>` | 某工具调用次数，如 `calls.byTool.workbrief` |
| `calls.sinceWrite` | 距最近一次写文件的调用数（write/edit 与命令行写—— heredoc、`>`、`cp`、`tee`、`Set-Content` ——都算写） |
| `replies.count` | 助手已发出的回复条数（GUI 会话不发 QQ 也能判"吭声了没"） |
| `progress.exists` / `.size` / `.ageMin` | 进度文件是否存在、字节数、几分钟没更新 |
| `raw.count` / `.totalBytes` / `.maxBytes` | 今日 `_tmp/raw` 文件数、总字节、最大单文件字节 |
| `elapsedMin` | 本轮已进行分钟数 |
| `sinceQQMin` | 距上次 `qq_notify` 的分钟数 |
| `date.crossedMidnight` | 会话开始日与今天是否不同 |
| `text.userAll` / `text.commands` / `text.assistant` | 用户消息 / 命令 / 助手回复的合并文本 |
| `hasTool` | 特殊节点，`{"fact":"hasTool","value":"subagent"}` 判断是否调用过 |

## 配置项（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-monitor
      name: 'dsh-monitor'
      config:
        enabled: true
        rulesPath: '<插件目录>\rules\monitor-rules.json'
        workspace: '<你的工作区>'
        maxInjections: 0
        cooldownMs: 1200000
```

- `maxInjections`：单会话最多注入几次；**0 / 缺省 / 非正数＝不限次数**。`cooldownMs` 已能防刷屏，长会话别设小值。
- `cooldownMs`：同一规则的最小间隔，默认 20 分钟。
- 规则里写 `"once": true`：这条规则整场会话只报一次（B5 就是这么配的）。

## 边界

- 只做**提醒**，不拦截、不拒绝任何调用。
- 判断不了语义正确性（引了真节但口径选错看不出来），也判断不了"这句话是不是在放水"这种绕弯的。
- 规则文件和插件代码都是本机文件，谁都能改；它提高的是"跑偏被看见"的概率，不是焊死的墙。
