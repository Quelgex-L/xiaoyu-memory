# 小瑜记忆系统（xiaoyu-memory）

在 `dsh-whale-soul` 之外叠加的**独立记忆扩展层**：向量混合检索、双层情绪、冲突确认、暗号触发、自动关联建链、空闲梦境整理、遗留记忆迁移、3D 记忆星图。

- 独立 ESM 包，**不改 `node_modules` 里的 whale-soul 源码**，插件更新不会被抹掉。
- 零原生依赖：元数据用内置 `node:sqlite`，向量索引是纯 JS 余弦相似度；embedding 走本地 Ollama。
- 数据与 whale-soul v1 记忆分开存放；删掉扩展层数据目录即可回滚到纯 whale-soul。

## 当前状态（v0.1.0，2026-11-09 核验）

自测 **36 项全部通过**，全程跑在临时目录，不写真实库。

| 模块 | 实现 |
|---|---|
| 本地存储 | `node:sqlite` 元数据库 + 纯 JS 余弦向量索引（`vectors.json`） |
| embedding | Ollama `nomic-embed-text`（768 维）；不可用时降级哈希向量，并与真实 embedding **分空间隔离**，不混入同一索引 |
| 混合召回 | 向量 0.55 + 标签/文本 bigram 重合 0.25 + 时间近因 0.10 + 重要度 0.10；置顶 ×2.0 加权；带超时护栏，Ollama 卡住不拖慢回复 |
| 自动写入 | `session/event` 采集用户输入与回复，`turn/end` 后规则抽取入库（本地规则，不耗云端额度） |
| 双层情绪 | 即时事件流（mood / valence -1~1 / arousal 0~1）+ 24h / 7d / 30d 长期趋势（主导心境、平均效价、压力倾向），趋势段注入 system prompt |
| 冲突确认 | 同稳定键矛盾或改口 → 新记忆进 `conflict` 待确认区，旧记忆保持 `active`；注册 `xiaoyu_resolve_conflict` 工具，用户确认后由模型调用裁决 |
| 暗号触发 | 配置词表启动时幂等入库；命中后召回整组人设/关系记忆 |
| 关联建链 | 向量近邻（自适应均值+2σ 阈值、每节点 top-5）+ 共享标签自动建边；重建前清空旧派生边 |
| 空闲整理 | 空闲 5 分钟触发：标题指纹/稳定键合并近似重复、半衰期降级冷藏、归档淡化；输出整理日志 |
| 遗留迁移 | 旧 `galaxy-data.json` + `vectors.json` 幂等迁入新库；dry-run 预览计数，`--write` 才落库，首次导入前自动备份 |
| 历史回填 | 解压 zstd 会话抽取长期记忆价值条目，按消息 id 游标幂等，寒暄/系统提示/工具日志不入库 |
| 3D 星图 | 纯 Canvas 伪 3D 投影：自动旋转、拖拽旋转、滚轮缩放、透视深度；节点亮度=重要度+近因+调用次数+情绪强度；点击查看详情 |
| 导出回滚 | 一键导出记忆/边/暗号 JSON 备份；删除扩展层目录即回滚 |

## 目录结构

```
xiaoyu-memory/
├── package.json
├── cordis.patch.yml          # DSH 插件注册片段
├── config.json               # 配置（模型、半衰期、触发词、整理阈值等）
├── LICENSE
├── README.md
├── scripts/
│   ├── start-ollama.sh       # 启动 Ollama 并预拉取模型
│   └── health-check.mjs       # Ollama / embedding 连通性自检
├── src/
│   ├── index.js              # 插件入口：钩子 + 写入队列 + 服务 API + 模型工具
│   ├── config.js             # 配置加载（路径展开、深合并、缓存）
│   ├── selftest.js           # 隔离自测（临时目录）
│   ├── store/
│   │   ├── meta-db.js        # SQLite 元数据（记忆/情绪事件/边/暗号/meta）
│   │   ├── vector-index.js   # 纯 JS 余弦索引（含 __meta 语义空间）
│   │   └── embedding.js      # Ollama + 哈希降级 + 本地任务模型调用口
│   ├── engine/
│   │   ├── extract.js        # 值不值得记 / 分类 / 指纹 / 情绪推断前置
│   │   ├── recall.js         # 混合召回（bigram 文本重合 + 向量）
│   │   ├── emotion.js        # 双层情绪 + 趋势聚合 + 情绪事件补齐
│   │   ├── conflict.js       # 冲突检测与裁决
│   │   ├── triggers.js       # 暗号种子与召回
│   │   ├── consolidation.js   # 空闲整理（合并/降级/归档）
│   │   ├── backfill.js       # 历史 zstd 会话回填
│   │   ├── migrate-legacy.js # 旧遗留层迁移（幂等、可 dry-run）
│   │   ├── build-links.js    # 自动建边（自适应阈值 + top-K）
│   │   ├── build-galaxy.js   # 星图数据导出 + 复制 3D 页面
│   │   └── export-backup.js  # 记忆/边/暗号 JSON 备份
│   └── web/
│       └── galaxy.html        # 3D 记忆星图页面
```

## 数据位置

- 元数据库：`~/.dsh/whale-soul/memory/vector/meta.sqlite`
- 向量索引：`~/.dsh/whale-soul/memory/vector/vectors.json`
- 星图数据：`~/.dsh/whale-soul/memory/vector/galaxy-data.{json,js}` 与 `galaxy.html`
- 备份：`~/.dsh/whale-soul/memory/vector/backup-memories-*.json`
- whale-soul 原有 v1 记忆：`~/.dsh/whale-soul/memory/`（不动）

## 命令

### 自测（安全，不碰真实库）

```bash
cd xiaoyu-memory
npm test          # node src/selftest.js
```

### 历史会话回填（先 dry-run 看清单）

```bash
npm run backfill            # 默认 dry-run，配置在 config.json backfill.dryRun
# 确认后改 config.json backfill.dryRun=false 再跑一次
```

### 旧遗留层迁移

```bash
npm run migrate-legacy            # dry-run 预览：节点/边/向量计数、已存在跳过数
node src/engine/migrate-legacy.js --write   # 确认后真实落库（自动备份旧文件）
```

### 重建关联边与星图

```bash
npm run links     # 自适应阈值 + 每节点 top-5，重建前清空旧派生边
npm run galaxy    # 导出 galaxy-data.json / .js，并把 3D 页面复制到数据目录
```

### 备份记忆

```bash
npm run backup    # 导出 backup-memories-<时间戳>.json
```

### 打开记忆星图

```bash
npm run galaxy
open ~/.dsh/whale-soul/memory/vector/galaxy.html
```

页面先读同目录 `galaxy-data.js`（脚本标签，`file://` 双击可用），读不到再 `fetch galaxy-data.json`，都没有才显示演示数据并提示先导出。

## 接入 DSH（qqbot profile）

> 前置：本机 Ollama 已装好 `nomic-embed-text`、`qwen2.5:7b`；Node ≥ 22.12。

1. 打包本地扩展：

   ```bash
   cd xiaoyu-memory
   npm pack
   ```

2. 装进 qqbot profile（pnpm 转发）：

   ```bash
   dsh plugin --profile qqbot add xiaoyu-memory/xiaoyu-memory-0.1.1.tgz
   ```

3. 在 `~/.dsh/profiles/qqbot/cordis.patch.yml` 注册条目（与 whale-soul 同级）：

   ```yaml
   - id: xiaoyu-memory
     name: xiaoyu-memory
     config:
       enabled: true
       configPath: "./config.json"
   ```

4. 重启 DSH / 重启 qqbot 会话生效。启动日志应出现 `[xiaoyu-memory] 启动完成：...`。

### 卸载 / 回滚

```bash
dsh plugin --profile qqbot remove xiaoyu-memory
# 删除 patch.yml 里的 xiaoyu-memory 条目
# 如不再保留扩展层数据：删除 ~/.dsh/whale-soul/memory/vector/ 下本层生成的文件
```

## 验收用例（逐条可验证）

1. 写入偏好记忆（如"奶茶三分糖"），重启进程仍能召回；置顶/核心类型不被整理流程清除。
2. 写入情绪事件可查即时情绪；按 7 天/30 天窗口聚合出长期趋势与主导心境，趋势段进入上下文。
3. 同一偏好键先说喜欢、再说不喜欢：标记冲突并保留两条，待确认，不静默覆盖；确认后用 `xiaoyu_resolve_conflict` 保留正确一条。
4. 空闲整理合并近似重复、降级过期细节、归档淡化条目，并写出整理日志 meta。
5. 口语化提问（"上次说的奶茶那个事"）可经向量+字面混合召回，不要求原文关键词完全匹配。
6. 命中暗号（"小瑜"/"鲸鱼娘"）召回整组人设/关系记忆。
7. 星图本地打开可见节点与关联边，可旋转/缩放，点击显示详情与来源。
8. Ollama 不在线时：写入、整理、字面召回仍跑通，向量通道降级且不阻塞回复。
9. 回填历史：偏好/约定/重要经历可召回；寒暄、系统提示、工具日志未进入长期记忆。
10. 备份 JSON 可导出；删除扩展层目录即回到纯 whale-soul 状态。

## 已知取舍与残留风险

- **规则抽取为主**：显式陈述（喜好/身份/边界/约定/关系/工作）可入库；隐含信息需要本地小模型补。`runTaskPrompt` 调用口已留（`embedding.js`），当前默认未每条消息调模型，避免 16G 内存与延迟压力。
- **冲突判定是启发式**：同稳定键下的否定词对立 + 改口检测，不做深度语义推理；复杂歧义仍需人工确认。
- **中文 embedding 区分度一般**：nomic 对中文短句两两余弦中位数偏高，因此建边用自适应阈值 + top-K，而不是固定相似度。
- **多宿主适配层未做**：当前是 DSH Cordis 插件形态；引擎模块为纯函数，可被其他宿主复用，但本地 HTTP 侧车尚未暴露。
- **多角色隔离**：`space/persona/subject` 字段与按空间召回已就位，但尚未在多角色并行会话下做串线测试。
- **版本耦合**：插件事件契约对齐当前 DSH 0.2.1-rc.3 系列；宿主大版本升级后需复测钩子签名。
- **云端片段**：本地存储，但注入主对话模型的记忆片段会发给已配置的云端 provider（与 whale-soul 一致）。

## 模型分工

| 环节 | 模型 | 耗云端额度 |
|---|---|---|
| 主对话 | 云端 DeepSeek-V4-Flash | 是 |
| embedding | 本地 Ollama nomic-embed-text | 否 |
| 记忆杂活（预留） | 本地 qwen2.5:7b | 否 |
| 抽取/检索/打分/情绪统计 | 本地规则 | 否 |
