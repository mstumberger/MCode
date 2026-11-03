# Continuous module contract

领域切片试点（E2）：预算准入、节奏触发、决策队列与候选选择的**纯策略**。
移植自 Huanxing-Lab/Cotaya（Apache-2.0，CT-04/05/06/07），完整语义见其源文件
头部注释；接入计划见 `docs/superpowers/plans/2026-10-29-cotaya-continuous-evaluation-plan.md`。

## 边界与不变量（类型表达不了、由本契约锁定）

- 本模块当前只有 domain 层：纯函数、无 IO、不读时钟（时刻由调用方注入）。
  application/adapters（sqlite 存储、supervisor、wire）与 `IContinuousService`
  服务面在 workspace lease 与 owner/lease 语义对齐（E3）后再评估引入，
  在此之前不得在本目录添加任何非纯 domain 文件。
- 预算金额一律整数微美元；`unknown` 行按预留值计入，不静默清零（§9）。
  准入判定的唯一实现是 `evaluateBudgetAdmission`；日窗口的唯一实现是
  `dayWindowFor`（DST 安全：Intl 取本地日期键 + 毫秒轴二分，不用 ±24h 近似）。
- 继续确认 grant 是**增量**：只增加受影响上限，不重置已消耗量，不扩大日额度（§6.1）。
- 候选分类是**双检查**：操作能力（allowed/forbidden 路径）先行且独立于模型标签；
  模型分类不是授权，未知类别默认进入决策（unknownToDecision 锁定）。
- pending Decision 永不暂停 Program（`decisionBlocksProgram` 恒 false 是锁定规则）；
  阻塞只经 `decisionBlocksCandidate` 的 candidateIds/paths 局部命中，
  capability 刻意不单独阻塞（否则 capability 级决策默认覆盖整个候选面）。
- 决策重复发现按 fingerprint 合并：首见身份稳定、终态不重开、来源按 cycleId 去重、
  blockingScope 取并集（仍然局部）；resolve/dismiss 携带 version 乐观并发，
  同答重放幂等、旧 version 或异答拒绝。
- 触发键幂等：manual 用请求 ID、scheduled 用 Program/revision/到期时间三元组；
  错过多轮只唤醒一次，不补跑（§10）。
- 候选选择排序 `impact×confidence/effort`，并列按 fingerprint 字典序稳定；
  forbidden/越界/被阻塞进 deferred（带原因），名额不够的合格候选不进 deferred。

## 公共面

`contract.ts` 是唯一公共入口：domain 策略函数与领域类型。调用方（未来的
application 层或测试）不得 import `domain/` 内部路径。

## 来源与致谢

实现与语义注释源自 Huanxing-Lab/Cotaya（zai-org/ZCode 的 Apache-2.0 衍生），
按 Apache-2.0 §4 保留其版权与许可声明；移植时保持文件内容一致以便后续同步，
本地新增仅限本契约文件、模块注册与测试。
