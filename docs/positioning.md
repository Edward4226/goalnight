# goalnight — Positioning v1

> 这份文档锁定 goalnight 的核心叙事、差异化卖点、tagline 库。
> README / 首发 X 帖 / HN Show / 官网文案都从这里取词。

---

## Core Narrative（核心叙事）

Codex `/goal` 是给长任务做的"自动续轮"模式。它工作得很好——但有一个细节：
撞到 5h token quota 时，它会**自动暂停**。然后就这样停着，等用户回来恢复。

如果用户在场，这很合理。但如果是过夜场景：

- 用户睡着了 8 小时，跨过 ~1.6 个 quota 周期
- 实际只用了第一个周期就停了
- 剩下的 0.6 个周期不会被用上

**goalnight 就是补这个过夜场景的工具。**

它在 quota 重置那一秒自动接力 codex 的 `/goal` session，醒来给一份 30 秒看懂的报告，把用户睡觉时段的 token 用满。

---

## What goalnight does that official `/goal` doesn't

官方 `/goal` 工程很扎实，覆盖了大部分情况。goalnight 在它之上补四件事，**针对"用户睡着了"这个特殊窗口**：

- 帮用户**估算**：8 小时睡眠时间能匹配多少 token budget、能跑几个 milestone
- **主动接力**：quota 重置那一秒自动 resume，跨多个 5h 周期推进
- **晨间报告**：醒来 30 秒看懂——什么完成了、什么阻塞了、什么需要你拍板
- **决策缓存**：模型遇到拍板点不擅自决策，记下来让用户早上一并审

这四件事都是"用户在场"的工具不需要、"用户睡着"的工具必须有的功能。

---

## Five Differentiators（5 个差异化卖点）

| 编号 | Pillar | 一句话 | 对手能跟进吗 |
|---|---|---|---|
| 1 | 🌙 **Sleep Budget Algorithm** | 输入 "8h"，自动算出对应的 token budget 与 milestone 数量 | 不会（结构性利益冲突） |
| 2 | 🔄 **Cross-Period Auto-Resume** | quota 重置那一秒自动接力，跨越多个 5h 周期推进 | 不会（同上） |
| 3 | 📢 **Pause / Approval Notifications** | 任何阻塞（quota / approval / decision）即刻跨平台通知 | 短期不会（不是优先级） |
| 4 | ☀️ **Morning Brief** | 醒来一屏看到：成功/失败、token 用量、待你拍板的事 | 不会（同理心型设计） |
| 5 | 🤝 **Decisions Awaiting** | 模型遇到决策点不擅自决策，记下来让你拍板 | 不会（同上） |

**5 个卖点中 4 个是 OpenAI 结构性不会做的事**。我们的护城河不是工程，是**立场**。

---

## Tagline 库

按用途分。每个 launch 渠道挑一句。

**主 tagline（README 首屏 + 官网）**：
> **set a goal, go to bed, wake up to a PR.**

**情绪开篇（README 第二行）**：
> For when your Codex token quota refreshes while you sleep
> — and you'd rather not waste it.

**HN / Show HN 标题候选**：
- "Show HN: goalnight — an OSS layer that uses your Codex token quota while you sleep"
- "Show HN: I made my Codex /goal mode actually finish overnight"
- "goalnight: stop wasting the Codex tokens that refresh while you sleep"

**X 首帖候选（短）**：
- "your Codex tokens refresh every 5h.
   you sleep 8h.
   guess where the extra 3h goes.
   
   → goalnight.dev"

- "Codex /goal 给你自动续轮。
   但它撞 quota 就死等到天亮。
   
   goalnight 让它在 quota 重置时自动接力。
   
   you sleep. it ships."

**Slogan / hover lines**：
- "the overnight shift for your codex."
- "your tokens don't sleep."
- "don't let your tokens sleep with you."
- "goalnight everybody!"（mascot 旁边小字）

**Show HN / 投放渠道候选**：
- "Show HN: goalnight — overnight goal execution for Codex CLI"
- "Show HN: I built a Codex plugin that picks up where /goal pauses overnight"

---

## User Profile（目标用户）

**Primary**：Codex Plus / Pro / Team 订阅用户
- 每周 quota 至少用到 60%（说明工作量大）
- 有长任务推进需求（feature 开发、重构、迁移、测试覆盖）
- 睡前想丢任务给 AI 跑（"睡觉时也能进度"的渴望）
- 在 X / HN / Reddit 上分享工具的人（GTM 病毒源）

**Secondary**：试图把 AI agent 跑成 autopilot 的工程师
- Ralph Wiggum loop 玩家
- 多 agent orchestration 探索者
- 想要 "agent + budget + observability" 的人

**反向用户画像**（不是给他们的）：
- 偶尔用 Codex 的人（quota 用不完，没痛点）
- 不愿意装 plugin 的人（CLI 都嫌重）
- 只用 ChatGPT 不用 Codex 的人

---

## README First-Screen Copy（v1 草案）

```markdown
# 🌙 goalnight

> set a goal, go to bed, wake up to a PR.

Codex `/goal` is great. But when it hits your 5h quota, it just stops.
You sleep 8h. Your tokens refresh at hour 5. They sit there. They expire.

goalnight is an open-source Codex plugin that:

- 🌙 calculates how much token budget your sleep can afford
- 🔄 auto-resumes when quota refreshes (across multiple 5h periods)
- 📢 wakes you with a notification only if something actually needs you
- ☀️ shows you a morning brief: what shipped, what's blocked, what needs your call
- 📊 displays a cozy localhost dashboard so you can peek any time

Install:

\`\`\`bash
codex plugin marketplace add Edward4226/goalnight
codex plugin add goalnight@goalnight
\`\`\`

Then, before bed:

\`\`\`bash
gn 8h "implement user-profile feature with tests"
\`\`\`

That's it. Open `http://localhost:8888` to peek progress, or run `gn brief` when you wake up.

---

🦉 *Crafted by someone who got tired of watching token quotas evaporate overnight.*
```

---

## What This Is NOT（明确边界）

防止 brand 漂移：

- ❌ 不是另一个 Codex 替代品
- ❌ 不是 SaaS（完全本地、零云、零账号）
- ❌ 不是 Web 应用（只是 localhost dashboard）
- ❌ 不是企业版工具（个人开发者 first）
- ❌ 不是 LLM 包装（我们只做 Codex 的扩展）
- ❌ 不是 agent framework（不重新发明轮子）

---

## Brand Voice（写文案时的语气）

- 实在，不卖弄
- 工程师对工程师说话
- 自嘲 ok（"your tokens don't sleep"）
- **绝不**：油腻、blockchain 风、营销 emoji 泛滥、过度承诺
- **保留**：1-2 个 emoji（🌙 ☀️ 是 brand 的）

---

## Versioning Statement

- **v0.1**：MVP，macOS-first, dashboard read-only, 1 个 mascot 概念
- **v0.2**：跨平台 notification + dashboard 交互 + Linux/Windows 完整支持
- **v1.0**：Codex Plugin Directory 上架 + 商业版可能性评估
