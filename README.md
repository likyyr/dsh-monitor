# dsh-monitor（监工）

DSH 插件：在每个 agent step（一次工具调用结束、下一次思考之前）按规则清单检查当前会话，命中就在下一个动作前注入一句话。不命中不注入、不加 token。

```
【监工·红线】D1：危险命令，先确认目标路径再执行。
```

注入走 `agent/pre-step` + 带 `source` 的注入消息，界面显示为折叠的「上下文注入 · monitor」，**不进用户交流区**，也不拦截、不拒绝任何调用——它只提醒，硬拦不归它管。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 事实采集与注入：从会话消息/工具调用 + 文件系统探针算出 `facts`，交 `rules.js` 判定，命中则注入 |
| `rules.js` | 判定引擎：`when` 的 all/any/not 求值、`op` 比较、sev 排序、冷却与次数控制 |
| `probe.js` | 文件系统探针：进度文件、`_tmp/raw`、memory 目录的 mtime/size，同步小文件读取 |
| `test/selftest.mjs` | 自测 19 条（判定、冷却、次数、once、D6 判据） |
| `tools/verify-backup.py` | 核对 GitHub 备份与本地是否逐字节一致：`python tools/verify-backup.py --clone`（真克隆一遍再删） |
| `docs/DETAIL.md` | 详细说明：规则写法、可用事实、配置项、边界 |
| `rules/monitor-rules.json` | 规则清单范本（27 条），运行时可指向任意路径（仓库里用 ASCII 名，避免跨平台文件名编码问题） |

## 装法

1. 把本目录放到 profile 能读到的位置，例如 `<插件目录>`。
2. profile 的 `cordis.patch.yml` 加一段：

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

3. 重启 DSH。
4. 自测：`node test/selftest.mjs` → `通过 19 / 19`。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `rulesPath` | — | 规则清单 JSON 路径；**每步比对 mtime，改完立即生效，不用重启** |
| `workspace` | — | 探针基准目录（`_tmp/进度-<日期>.md`、`_tmp/raw`、memory 目录都在它下面找） |
| `maxInjections` | `0` | 单会话注入上限；**0 / 缺省 / 非正数＝不限次数** |
| `cooldownMs` | `1200000` | 同一条规则的最小间隔（20 分钟）；`once: true` 的规则一整个会话只报一次 |

## 规则写法

```json
{
  "id": "A4",
  "sev": 1,
  "when": { "all": [
    { "fact": "calls.total", "op": ">=", "value": 20 },
    { "fact": "progress.exists", "op": "==", "value": false }
  ]},
  "say": "A4：调用 20 次了，还没有 _tmp\\进度-<今天>.md，先建。",
  "once": true
}
```

- `sev`：0 红线 / 1 红线 / 2 提醒 / 3 提示。**同一时刻只报一条**，sev 小的优先，同级按 id 排序。
- `when` 支持 `all` / `any` / `not` 嵌套；`op` 支持 `== != >= <= > < contains matches notMatches`。
- `once: true`：这条规则整场会话只报一次（B5 用）。

### 可用事实

| 事实 | 含义 |
|---|---|
| `calls.total` | 本会话工具调用总数 |
| `calls.byTool.<工具名>` | 某工具调用次数 |
| `calls.sinceWrite` | 距最近一次写文件的调用数（write/edit/shell 重定向、heredoc、cp、tee 都算写） |
| `replies.count` | 助手已发出的回复条数（GUI 会话不发 QQ 也能判"吭声了没"） |
| `progress.exists` / `.size` / `.ageMin` | 进度文件存在、字节数、几分钟没更新 |
| `raw.count` / `.totalBytes` / `.maxBytes` | 今日 `_tmp/raw` 文件数、总字节、最大单文件 |
| `elapsedMin` / `sinceQQMin` | 本轮分钟数 / 距上次 `qq_notify` 分钟数 |
| `date.crossedMidnight` | 会话起始日与今天是否不同 |
| `text.userLast` / `text.userAll` / `text.commands` / `text.assistant` | 最近一条用户消息 / 全部用户消息 / 命令行 / 助手回复合并文本 |
| `text.commandsWrite` / `text.writePaths` | 命令里像写的片段 / 写过的路径 |
| `writes.afterUser` / `text.writesRecent` | 最近一条用户消息之后写了几次 / 写过哪些路径（只看本轮，避免历史误报） |
| `lastUser.question` | 用户最近一条是不是问句（问号或「能不能/怎么/是不是/你看呢」这类） |
| `claim.memory` / `claim.run` | 助手回复里是否声称"记卡了""跑过了" |
| `hasTool` | 特殊节点：`{"fact":"hasTool","value":"subagent"}` 判是否用过 |

### 现有的 20 条

| 级别 | id | 触发 |
|---|---|---|
| 0 | D1 | 危险命令（`rm -rf`、`del /f /s /q`、递归强删等） |
| 0 | D2 | 在写系统/配置目录 |
| 0 | D4 | 在改会话日志文件 |
| 0 | E4 | 在改监管件本身（规则清单/插件代码） |
| 1 | A1 | 业务活但还没跑 workbrief |
| 1 | A4 | 20 次调用还没有进度文件 |
| 1 | A5 | 进度文件不到 200 字节，像应付的 |
| 1 | C2 | 门禁命令带 `|| true` 吞错误 |
| 1 | D5 | 跨天了，进度文件该按新日期建 |
| 1 | E3 | 说交付了，但没 present 也没发文件 |
| 1 | E5 | 说记进卡了，memory 目录 60 分钟内没有变化 |
| 1 | F1 | 拿时间当理由（"时间紧""你在等"） |
| 2 | B1 | 抓了几次外网还没往 `_tmp/raw` 落盘 |
| 2 | B2 | raw 里都是空壳文件 |
| 2 | B3 | 连续 15 步没写任何文件 |
| 2 | B5 | 40 次调用还没拆子代理（只报一次） |
| 2 | B8 | 进度文件 25 分钟没更新 |
| 2 | D6 | 12 次调用还没吭声（按 `replies.count` 判） |
| 2 | D7 | 25 分钟没报进度（按 `qq_notify` 判） |
| 2 | E6 | 说跑过/核过，这场会话却没有任何验证调用 |
| 1 | G1 | 用户这轮在问（「能不能/怎么/是不是」），却已经动手写文件 |
| 1 | G2 | 本轮改过 xlsx，没跑 `check_xlsx_style.py`（加行要整行搬格式） |
| 1 | G3 | 本轮改过 xlsx 且声称核过，没跑 `verify_workbook.py` |
| 1 | G4 | 本轮改过 docx，没转图看版面（`docx2pdf.py --png`） |
| 1 | G5 | 改了插件代码 / profile 配置，没重启 |
| 2 | G6 | 60 次调用还没跑 `closure_check.py`（收尾清场） |
| 2 | G7 | 口径自己定了却没交给用户确认 |

## 更新记录

- **v0.2.1（2026-11-18）**
  - 新增 7 条规则 G1~G7：问句先答、xlsx 格式门禁、xlsx 换路重算、docx 目视检查、改插件必须重启、收尾清场、口径不自己定
  - 新增事实 `writes.afterUser`、`text.writesRecent`、`lastUser.question`——G2~G5 只看**本轮**写入，不吃历史（上线当天就误报过一次，当场收窄）
  - 脚本名统计补 `check_xlsx_style`、`dsh-restart`
  - 自测 24/24

- **v0.1.1（2026-11-18）**
  - `maxInjections: 0`＝不限次数（原来固定 8 次，长会话会提前闭嘴）
  - 新增 `once`：单条规则整场只报一次，B5 已启用
  - 修 B3 误报：命令行写文件（heredoc、`>`、`cp`、`tee`、`Set-Content`）现在也算"写了文件"
  - 修 D2 误报：`2>/dev/null`、`2>&1` 这类良性重定向不再被当成写操作；纯读命令里出现 `C:\Program Files` 不再判写
  - 新增事实 `replies.count`，D6 从"发过 QQ"改成"发过回复"，GUI 会话同样有效
  - 自测 19/19
- **v0.1.0** 初版：判定引擎 + 探针 + 20 条规则

## 边界

- 只做提醒，不拦截。
- 判断不了语义正确性（引了真节但口径选错看不出来），也判断不了"这句话是不是在放水"。
- 规则和代码都是本机明文文件，谁都能改；它提高的是"跑偏被看见"的概率，不是焊死的墙。

## License

MIT
